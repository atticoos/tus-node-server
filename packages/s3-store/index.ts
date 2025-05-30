import os from 'node:os'
import fs, {promises as fsProm} from 'node:fs'
import stream, {promises as streamProm} from 'node:stream'
import type {Readable} from 'node:stream'
import http from 'node:http'

import AWS, {NoSuchKey, NotFound, S3, S3ClientConfig} from '@aws-sdk/client-s3'
import debug from 'debug'

import {DataStore, StreamSplitter, Upload} from '@tus/server'
import {ERRORS, TUS_RESUMABLE} from '@tus/server'

const log = debug('tus-node-server:stores:s3store')

function calcOffsetFromParts(parts?: Array<AWS.Part>) {
  // @ts-expect-error not undefined
  return parts && parts.length > 0 ? parts.reduce((a, b) => a + b.Size, 0) : 0
}

type Options = {
  // The preferred part size for parts send to S3. Can not be lower than 5MB or more than 500MB.
  // The server calculates the optimal part size, which takes this size into account,
  // but may increase it to not exceed the S3 10K parts limit.
  partSize?: number
  // Options to pass to the AWS S3 SDK.
  s3ClientConfig: S3ClientConfig & {bucket: string}
}

type MetadataValue = {
  file: Upload
  'upload-id': string
  'tus-version': string
}
// Implementation (based on https://github.com/tus/tusd/blob/master/s3store/s3store.go)
//
// Once a new tus upload is initiated, multiple objects in S3 are created:
//
// First of all, a new info object is stored which contains (as Metadata) a JSON-encoded
// blob of general information about the upload including its size and meta data.
// This kind of objects have the suffix ".info" in their key.
//
// In addition a new multipart upload
// (http://docs.aws.amazon.com/AmazonS3/latest/dev/uploadobjusingmpu.html) is
// created. Whenever a new chunk is uploaded to tus-node-server using a PATCH request, a
// new part is pushed to the multipart upload on S3.
//
// If meta data is associated with the upload during creation, it will be added
// to the multipart upload and after finishing it, the meta data will be passed
// to the final object. However, the metadata which will be attached to the
// final object can only contain ASCII characters and every non-ASCII character
// will be replaced by a question mark (for example, "Menü" will be "Men?").
// However, this does not apply for the metadata returned by the `_getMetadata`
// function since it relies on the info object for reading the metadata.
// Therefore, HEAD responses will always contain the unchanged metadata, Base64-
// encoded, even if it contains non-ASCII characters.
//
// Once the upload is finished, the multipart upload is completed, resulting in
// the entire file being stored in the bucket. The info object, containing
// meta data is not deleted.
//
// Considerations
//
// In order to support tus' principle of resumable upload, S3's Multipart-Uploads
// are internally used.
// For each incoming PATCH request (a call to `write`), a new part is uploaded
// to S3.
export class S3Store extends DataStore {
  private bucket: string
  private cache: Map<string, MetadataValue> = new Map()
  private client: S3
  private preferredPartSize: number
  public maxMultipartParts = 10_000 as const
  public minPartSize = 5_242_880 as const // 5MB

  constructor(options: Options) {
    super()
    const {partSize, s3ClientConfig} = options
    const {bucket, ...restS3ClientConfig} = s3ClientConfig
    this.extensions = [
      'creation',
      'creation-with-upload',
      'creation-defer-length',
      'termination',
    ]
    this.bucket = bucket
    this.preferredPartSize = partSize || 8 * 1024 * 1024
    this.client = new S3(restS3ClientConfig)
  }

  /**
   * Saves upload metadata to a `${file_id}.info` file on S3.
   * Please note that the file is empty and the metadata is saved
   * on the S3 object's `Metadata` field, so that only a `headObject`
   * is necessary to retrieve the data.
   */
  private async saveMetadata(upload: Upload, uploadId: string) {
    log(`[${upload.id}] saving metadata`)
    await this.client.putObject({
      Bucket: this.bucket,
      Key: `${upload.id}.info`,
      Body: JSON.stringify(upload),
      Metadata: {
        'upload-id': uploadId,
        'tus-version': TUS_RESUMABLE,
      },
    })
    log(`[${upload.id}] metadata file saved`)
  }

  /**
   * Retrieves upload metadata previously saved in `${file_id}.info`.
   * There's a small and simple caching mechanism to avoid multiple
   * HTTP calls to S3.
   */
  private async getMetadata(id: string): Promise<MetadataValue> {
    const cached = this.cache.get(id)
    if (cached?.file) {
      return cached
    }

    const {Metadata, Body} = await this.client.getObject({
      Bucket: this.bucket,
      Key: `${id}.info`,
    })
    const file = JSON.parse((await Body?.transformToString()) as string)
    this.cache.set(id, {
      'tus-version': Metadata?.['tus-version'] as string,
      'upload-id': Metadata?.['upload-id'] as string,
      file: new Upload({
        id,
        size: file.size ? Number.parseInt(file.size, 10) : undefined,
        offset: Number.parseInt(file.offset, 10),
        metadata: file.metadata,
      }),
    })
    return this.cache.get(id) as MetadataValue
  }

  private partKey(id: string, isIncomplete = false) {
    if (isIncomplete) {
      id += '.part'
    }

    // TODO: introduce ObjectPrefixing for parts and incomplete parts.
    // ObjectPrefix is prepended to the name of each S3 object that is created
    // to store uploaded files. It can be used to create a pseudo-directory
    // structure in the bucket, e.g. "path/to/my/uploads".
    return id
  }

  private async uploadPart(
    metadata: MetadataValue,
    readStream: fs.ReadStream | Readable,
    partNumber: number
  ): Promise<string> {
    const data = await this.client.uploadPart({
      Bucket: this.bucket,
      Key: metadata.file.id,
      UploadId: metadata['upload-id'],
      PartNumber: partNumber,
      Body: readStream,
    })
    log(`[${metadata.file.id}] finished uploading part #${partNumber}`)
    return data.ETag as string
  }

  private async uploadIncompletePart(
    id: string,
    readStream: fs.ReadStream | Readable
  ): Promise<string> {
    const data = await this.client.putObject({
      Bucket: this.bucket,
      Key: this.partKey(id, true),
      Body: readStream,
    })
    log(`[${id}] finished uploading incomplete part`)
    return data.ETag as string
  }

  private async getIncompletePart(id: string): Promise<Readable | undefined> {
    try {
      const data = await this.client.getObject({
        Bucket: this.bucket,
        Key: this.partKey(id, true),
      })
      return data.Body as Readable
    } catch (error) {
      if (error instanceof NoSuchKey) {
        return undefined
      }

      throw error
    }
  }

  private async getIncompletePartSize(id: string): Promise<number | undefined> {
    try {
      const data = await this.client.headObject({
        Bucket: this.bucket,
        Key: this.partKey(id, true),
      })
      return data.ContentLength
    } catch (error) {
      if (error instanceof NotFound) {
        return undefined
      }
      throw error
    }
  }

  private async deleteIncompletePart(id: string): Promise<void> {
    await this.client.deleteObject({
      Bucket: this.bucket,
      Key: this.partKey(id, true),
    })
  }

  private async prependIncompletePart(
    newChunkPath: string,
    previousIncompletePart: Readable
  ): Promise<number> {
    const tempPath = `${newChunkPath}-prepend`
    try {
      let incompletePartSize = 0

      const byteCounterTransform = new stream.Transform({
        transform(chunk, _, callback) {
          incompletePartSize += chunk.length
          callback(null, chunk)
        },
      })

      // write to temporary file, truncating if needed
      await streamProm.pipeline(
        previousIncompletePart,
        byteCounterTransform,
        fs.createWriteStream(tempPath)
      )
      // append to temporary file
      await streamProm.pipeline(
        fs.createReadStream(newChunkPath),
        fs.createWriteStream(tempPath, {flags: 'a'})
      )
      // overwrite existing file
      await fsProm.rename(tempPath, newChunkPath)

      return incompletePartSize
    } catch (err) {
      fsProm.rm(tempPath).catch(() => {
        /* ignore */
      })
      throw err
    }
  }

  /**
   * Uploads a stream to s3 using multiple parts
   */
  private async processUpload(
    metadata: MetadataValue,
    readStream: http.IncomingMessage | fs.ReadStream,
    currentPartNumber: number,
    offset: number
  ): Promise<number> {
    const size = metadata.file.size as number
    const promises: Promise<void>[] = []
    let pendingChunkFilepath: string | null = null
    let bytesUploaded = 0
    let currentChunkNumber = 0

    const splitterStream = new StreamSplitter({
      chunkSize: this.calcOptimalPartSize(size),
      directory: os.tmpdir(),
    })
      .on('chunkStarted', (filepath) => {
        pendingChunkFilepath = filepath
      })
      .on('chunkFinished', ({path, size: partSize}) => {
        pendingChunkFilepath = null

        const partNumber = currentPartNumber++
        const chunkNumber = currentChunkNumber++

        offset += partSize

        const isFirstChunk = chunkNumber === 0
        const isFinalPart = size === offset

        // eslint-disable-next-line no-async-promise-executor
        const deferred = new Promise<void>(async (resolve, reject) => {
          try {
            let incompletePartSize = 0
            // Only the first chunk of each PATCH request can prepend
            // an incomplete part (last chunk) from the previous request.
            if (isFirstChunk) {
              // If we received a chunk under the minimum part size in a previous iteration,
              // we used a regular S3 upload to save it in the bucket. We try to get the incomplete part here.

              const incompletePart = await this.getIncompletePart(metadata.file.id)
              if (incompletePart) {
                // We found an incomplete part, prepend it to the chunk on disk we were about to upload,
                // and delete the incomplete part from the bucket. This can be done in parallel.
                incompletePartSize = await this.prependIncompletePart(
                  path,
                  incompletePart
                )
                await this.deleteIncompletePart(metadata.file.id)
              }
            }

            const readable = fs.createReadStream(path)
            readable.on('error', reject)
            if (partSize + incompletePartSize >= this.minPartSize || isFinalPart) {
              await this.uploadPart(metadata, readable, partNumber)
            } else {
              await this.uploadIncompletePart(metadata.file.id, readable)
            }

            bytesUploaded += partSize
            resolve()
          } catch (error) {
            reject(error)
          } finally {
            fsProm.rm(path).catch(() => {
              /* ignore */
            })
          }
        })

        promises.push(deferred)
      })

    try {
      await streamProm.pipeline(readStream, splitterStream)
    } catch (error) {
      if (pendingChunkFilepath !== null) {
        try {
          await fsProm.rm(pendingChunkFilepath)
        } catch {
          log(`[${metadata.file.id}] failed to remove chunk ${pendingChunkFilepath}`)
        }
      }

      promises.push(Promise.reject(error))
    } finally {
      await Promise.all(promises)
    }

    return bytesUploaded
  }

  /**
   * Completes a multipart upload on S3.
   * This is where S3 concatenates all the uploaded parts.
   */
  private async finishMultipartUpload(metadata: MetadataValue, parts: Array<AWS.Part>) {
    const response = await this.client.completeMultipartUpload({
      Bucket: this.bucket,
      Key: metadata.file.id,
      UploadId: metadata['upload-id'],
      MultipartUpload: {
        Parts: parts.map((part) => {
          return {
            ETag: part.ETag,
            PartNumber: part.PartNumber,
          }
        }),
      },
    })
    return response.Location
  }

  /**
   * Gets the number of complete parts/chunks already uploaded to S3.
   * Retrieves only consecutive parts.
   */
  private async retrieveParts(
    id: string,
    partNumberMarker?: string
  ): Promise<Array<AWS.Part> | undefined> {
    const params: AWS.ListPartsCommandInput = {
      Bucket: this.bucket,
      Key: id,
      UploadId: this.cache.get(id)?.['upload-id'],
    }
    if (partNumberMarker) {
      params.PartNumberMarker = partNumberMarker
    }

    const data = await this.client.listParts(params)

    // INFO: NextPartNumberMarker should be undefined when there are no more parts to retrieve,
    // instead it keeps giving `0` so to prevent an infinite loop we check the number.
    if (data.NextPartNumberMarker && Number(data.NextPartNumberMarker) > 0) {
      return this.retrieveParts(id, data.NextPartNumberMarker).then((parts) => {
        if (parts && data.Parts) {
          return [...data.Parts, ...parts]
        }
        return data.Parts
      })
    }

    const parts = data.Parts

    if (parts && !partNumberMarker) {
      return (
        parts
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          .sort((a, b) => a.PartNumber! - b.PartNumber!)
          .filter((value, index) => value.PartNumber === index + 1)
      )
    }

    return parts
  }

  /**
   * Removes cached data for a given file.
   */
  private clearCache(id: string) {
    log(`[${id}] removing cached data`)
    this.cache.delete(id)
  }

  private calcOptimalPartSize(size: number): number {
    let optimalPartSize: number

    // When upload is smaller or equal to PreferredPartSize, we upload in just one part.
    if (size <= this.preferredPartSize) {
      optimalPartSize = size
    }
    // Does the upload fit in MaxMultipartParts parts or less with PreferredPartSize.
    else if (size <= this.preferredPartSize * this.maxMultipartParts) {
      optimalPartSize = this.preferredPartSize
      // The upload is too big for the preferred size.
      // We devide the size with the max amount of parts and round it up.
    } else {
      optimalPartSize = Math.ceil(size / this.maxMultipartParts)
    }

    return optimalPartSize
  }

  /**
   * Creates a multipart upload on S3 attaching any metadata to it.
   * Also, a `${file_id}.info` file is created which holds some information
   * about the upload itself like: `upload-id`, `upload-length`, etc.
   */
  public async create(upload: Upload) {
    log(`[${upload.id}] initializing multipart upload`)
    const request: AWS.CreateMultipartUploadCommandInput = {
      Bucket: this.bucket,
      Key: upload.id,
      Metadata: {'tus-version': TUS_RESUMABLE},
    }

    if (upload.metadata?.contentType) {
      request.ContentType = upload.metadata.contentType
    }

    const res = await this.client.createMultipartUpload(request)
    await this.saveMetadata(upload, res.UploadId as string)
    log(`[${upload.id}] multipart upload created (${res.UploadId})`)

    return upload
  }

  async read(id: string) {
    const data = await this.client.getObject({
      Bucket: this.bucket,
      Key: id,
    })
    return data.Body as Readable
  }

  /**
   * Write to the file, starting at the provided offset
   */
  public async write(
    readable: http.IncomingMessage | fs.ReadStream,
    id: string,
    offset: number
  ): Promise<number> {
    // Metadata request needs to happen first
    const metadata = await this.getMetadata(id)
    const parts = await this.retrieveParts(id)
    const partNumber = parts?.length ?? 0
    const nextPartNumber = partNumber + 1

    const bytesUploaded = await this.processUpload(
      metadata,
      readable,
      nextPartNumber,
      offset
    )

    const newOffset = offset + bytesUploaded

    if (metadata.file.size === newOffset) {
      try {
        const parts = await this.retrieveParts(id)
        await this.finishMultipartUpload(metadata, parts as Array<AWS.Part>)
        this.clearCache(id)
      } catch (error) {
        log(`[${id}] failed to finish upload`, error)
        throw error
      }
    }

    return newOffset
  }

  public async getUpload(id: string): Promise<Upload> {
    let metadata: MetadataValue
    try {
      metadata = await this.getMetadata(id)
    } catch (error) {
      log('getUpload: No file found.', error)
      throw ERRORS.FILE_NOT_FOUND
    }

    let offset = 0

    try {
      const parts = await this.retrieveParts(id)
      offset = calcOffsetFromParts(parts)
    } catch (error) {
      // Check if the error is caused by the upload not being found. This happens
      // when the multipart upload has already been completed or aborted. Since
      // we already found the info object, we know that the upload has been
      // completed and therefore can ensure the the offset is the size.
      // AWS S3 returns NoSuchUpload, but other implementations, such as DigitalOcean
      // Spaces, can also return NoSuchKey.
      if (error.Code === 'NoSuchUpload' || error.Code === 'NoSuchKey') {
        return new Upload({
          id,
          ...this.cache.get(id)?.file,
          offset: metadata.file.size as number,
          size: metadata.file.size,
          metadata: metadata.file.metadata,
        })
      }

      log(error)
      throw error
    }

    const incompletePartSize = await this.getIncompletePartSize(id)

    return new Upload({
      id,
      ...this.cache.get(id)?.file,
      offset: offset + (incompletePartSize ?? 0),
      size: metadata.file.size,
    })
  }

  public async declareUploadLength(file_id: string, upload_length: number) {
    const {file, 'upload-id': uploadId} = await this.getMetadata(file_id)
    if (!file) {
      throw ERRORS.FILE_NOT_FOUND
    }

    file.size = upload_length

    this.saveMetadata(file, uploadId)
  }

  public async remove(id: string): Promise<void> {
    try {
      const {'upload-id': uploadId} = await this.getMetadata(id)
      if (uploadId) {
        await this.client.abortMultipartUpload({
          Bucket: this.bucket,
          Key: id,
          UploadId: uploadId,
        })
      }
    } catch (error) {
      if (error?.code && ['NotFound', 'NoSuchKey', 'NoSuchUpload'].includes(error.Code)) {
        log('remove: No file found.', error)
        throw ERRORS.FILE_NOT_FOUND
      }
      throw error
    }

    await this.client.deleteObjects({
      Bucket: this.bucket,
      Delete: {
        Objects: [{Key: id}, {Key: `${id}.info`}],
      },
    })

    this.clearCache(id)
  }
}
