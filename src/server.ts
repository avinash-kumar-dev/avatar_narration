import { createHash, timingSafeEqual } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import multipart from '@fastify/multipart'
import Fastify from 'fastify'
import { config } from './config.js'
import { JobManager, QueueFullError } from './jobs.js'
import { BYTES_PER_SECOND, decodeToPcm16, preflightBrowser, startWebServer, stopWebServer } from './render.js'

const DEFAULT_BACKGROUND = '#ffffff'
const MIN_AUDIO_SECONDS = 0.5

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const app = Fastify({ logger: { level: config.logLevel } })
const jobs = new JobManager({
  info: (m) => app.log.info(m),
  warn: (m) => app.log.warn(m),
  error: (m) => app.log.error(m),
})

await app.register(multipart, {
  limits: { fileSize: config.maxUploadBytes, files: 1, fields: 5, fieldSize: 256 },
})

/* ---------------------------------- auth --------------------------------- */

const digest = (s: string) => createHash('sha256').update(s).digest()

function authorized(header: string | undefined, apiKeyHeader: string | undefined): boolean {
  if (!config.apiKey) return true
  const presented = apiKeyHeader ?? header?.replace(/^Bearer\s+/i, '')
  if (!presented) return false
  return timingSafeEqual(digest(presented), digest(config.apiKey))
}

app.addHook('onRequest', async (req) => {
  if (req.url === '/health') return
  const apiKeyHeader = req.headers['x-api-key']
  if (!authorized(req.headers.authorization, typeof apiKeyHeader === 'string' ? apiKeyHeader : undefined)) {
    throw new HttpError(401, 'unauthorized', 'missing or invalid API key')
  }
})

app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
  if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, message: err.message })
  // @fastify/multipart limit errors and other Fastify-originated 4xx.
  if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
    return reply.code(err.statusCode).send({ error: err.code ?? 'bad_request', message: err.message })
  }
  req.log.error(err)
  return reply.code(500).send({ error: 'internal_error', message: 'internal server error' })
})

/* --------------------------------- routes -------------------------------- */

app.get('/health', async () => ({ ok: true, ...jobs.stats() }))

/**
 * Submit a narration. multipart/form-data:
 *   audio       (file, required)  any format ffmpeg reads
 *   background  (text, optional)  #rrggbb, default #ffffff
 * Responds 202 immediately; poll GET /jobs/:id.
 */
app.post('/jobs', async (req, reply) => {
  if (!jobs.hasCapacity()) {
    reply.header('Retry-After', '30')
    throw new HttpError(429, 'queue_full', 'too many jobs queued, retry later')
  }

  const { id, dir, uploadPath, pcmPath } = await jobs.reserve()
  try {
    let background = DEFAULT_BACKGROUND
    let gotAudio = false

    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (part.fieldname !== 'audio' || gotAudio) {
          part.file.resume() // drain and ignore
          continue
        }
        await pipeline(part.file, createWriteStream(uploadPath))
        if (part.file.truncated) {
          throw new HttpError(413, 'file_too_large', `audio exceeds ${config.maxUploadBytes / 1024 / 1024} MB`)
        }
        gotAudio = true
      } else if (part.fieldname === 'background') {
        background = String(part.value).trim()
      }
    }

    if (!gotAudio) throw new HttpError(400, 'missing_audio', 'multipart field "audio" (a file) is required')
    if (!/^#[0-9a-fA-F]{6}$/.test(background)) {
      throw new HttpError(400, 'invalid_background', 'background must be a #rrggbb hex color')
    }

    // Decoding doubles as validation: not audio, or unreadable, fails here
    // with a 400, before the job is queued or any Spatius credit is spent.
    try {
      await decodeToPcm16(uploadPath, pcmPath, config.maxAudioSeconds + 1)
    } catch (err) {
      req.log.warn({ err: err instanceof Error ? err.message : err }, 'rejected upload: not decodable audio')
      throw new HttpError(400, 'invalid_audio', 'the uploaded file is not valid audio (unsupported format or corrupt)')
    }
    await rm(uploadPath, { force: true })

    const audioSeconds = (await stat(pcmPath)).size / BYTES_PER_SECOND
    if (audioSeconds < MIN_AUDIO_SECONDS) {
      throw new HttpError(400, 'audio_too_short', `audio must be at least ${MIN_AUDIO_SECONDS}s`)
    }
    if (audioSeconds > config.maxAudioSeconds) {
      throw new HttpError(422, 'audio_too_long', `audio must be at most ${config.maxAudioSeconds}s`)
    }

    const job = jobs.enqueue({ id, dir, pcmPath, audioSeconds, background })
    return reply.code(202).header('Location', `/jobs/${id}`).send(job)
  } catch (err) {
    await jobs.discard(dir)
    if (err instanceof QueueFullError) {
      reply.header('Retry-After', '30')
      throw new HttpError(429, 'queue_full', 'too many jobs queued, retry later')
    }
    throw err
  }
})

app.get<{ Params: { id: string } }>('/jobs/:id', async (req) => {
  const job = jobs.get(req.params.id)
  if (!job) throw new HttpError(404, 'not_found', 'no such job')
  return jobs.toPublic(job)
})

/** Streams the MP4, with Range support so it can be played/seeked in a <video> tag. */
app.get<{ Params: { id: string } }>('/jobs/:id/video', async (req, reply) => {
  const job = jobs.get(req.params.id)
  if (!job) throw new HttpError(404, 'not_found', 'no such job')
  if (job.status !== 'succeeded') throw new HttpError(409, 'not_ready', `job is ${job.status}`)

  const { size } = await stat(job.videoPath)
  reply.header('Content-Type', 'video/mp4').header('Accept-Ranges', 'bytes')

  const range = req.headers.range
  if (!range) return reply.header('Content-Length', size).send(createReadStream(job.videoPath))

  const m = /^bytes=(\d*)-(\d*)$/.exec(range)
  let start = m?.[1] ? Number(m[1]) : NaN
  let end = m?.[2] ? Number(m[2]) : NaN
  if (!m || (Number.isNaN(start) && Number.isNaN(end))) {
    return reply.code(416).header('Content-Range', `bytes */${size}`).send()
  }
  if (Number.isNaN(start)) {
    // "bytes=-N": the last N bytes.
    start = Math.max(0, size - end)
    end = size - 1
  } else if (Number.isNaN(end) || end >= size) {
    end = size - 1
  }
  if (start > end || start >= size) {
    return reply.code(416).header('Content-Range', `bytes */${size}`).send()
  }
  return reply
    .code(206)
    .header('Content-Range', `bytes ${start}-${end}/${size}`)
    .header('Content-Length', end - start + 1)
    .send(createReadStream(job.videoPath, { start, end }))
})

/** Cancels a queued/running job, or deletes a finished job and its MP4. */
app.delete<{ Params: { id: string } }>('/jobs/:id', async (req, reply) => {
  if (!(await jobs.remove(req.params.id))) throw new HttpError(404, 'not_found', 'no such job')
  return reply.code(204).send()
})

/* -------------------------------- lifecycle ------------------------------- */

let closing = false
async function shutdown(signal: string) {
  if (closing) return
  closing = true
  app.log.info(`${signal} received, shutting down`)
  await app.close()
  await jobs.shutdown()
  await stopWebServer()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

await preflightBrowser()
await jobs.init()
await startWebServer()
if (!config.apiKey) {
  app.log.warn('API_KEY is not set: anyone who can reach this port can start renders (paid Spatius credits)')
}
await app.listen({ host: config.host, port: config.port })
