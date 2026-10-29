import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from './config.js'
import { RenderError, jobTimeoutMs, renderVideo, type RenderOutputs, type VideoFormat } from './render.js'

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface Logger {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

interface Job {
  id: string
  status: JobStatus
  stage: string
  /** 0..1 while recording, otherwise null. */
  progress: number | null
  audioSeconds: number
  background: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
  error?: string
  errorCode?: string
  dir: string
  pcmPath: string
  videoPath: string
  /** Files produced by a successful render, keyed by format. */
  videos: RenderOutputs
  abort?: AbortController
  /** Why the abort happened, so a timeout is not reported as a generic failure. */
  abortReason?: 'timeout' | 'cancelled' | 'shutdown'
}

export interface PublicJob {
  id: string
  status: JobStatus
  stage: string
  progress: number | null
  audioSeconds: number
  background: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  error?: string
  errorCode?: string
  /** The default download (first entry of `videos`). */
  videoUrl?: string
  /** Every produced format: `mp4`, or `webm` and `mov` for a transparent background. */
  videos?: Partial<Record<VideoFormat, string>>
}

export class QueueFullError extends Error {}

const iso = (ms?: number) => (ms ? new Date(ms).toISOString() : undefined)

/**
 * In-memory job registry plus a small FIFO queue. State does not survive a
 * restart (job directories are wiped at startup), which is fine for a render
 * service whose callers poll for a result minutes after submitting.
 */
export class JobManager {
  private jobs = new Map<string, Job>()
  private queue: string[] = []
  private running = new Set<string>()
  private sweeper?: NodeJS.Timeout

  constructor(private readonly log: Logger) {}

  private get root() {
    return join(config.dataDir, 'jobs')
  }

  async init(): Promise<void> {
    await rm(this.root, { recursive: true, force: true })
    await mkdir(this.root, { recursive: true })
    this.sweeper = setInterval(() => void this.sweep(), 60_000)
    this.sweeper.unref()
  }

  stats() {
    return { queued: this.queue.length, running: this.running.size }
  }

  hasCapacity(): boolean {
    return this.queue.length < config.maxQueuedJobs
  }

  /** Reserves an id and its directory; the upload is written there before enqueue(). */
  async reserve(): Promise<{ id: string; dir: string; uploadPath: string; pcmPath: string }> {
    const id = randomUUID()
    const dir = join(this.root, id)
    await mkdir(dir, { recursive: true })
    return { id, dir, uploadPath: join(dir, 'upload.bin'), pcmPath: join(dir, 'input.pcm') }
  }

  async discard(dir: string): Promise<void> {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }

  enqueue(args: { id: string; dir: string; pcmPath: string; audioSeconds: number; background: string }): PublicJob {
    if (!this.hasCapacity()) throw new QueueFullError('queue is full')
    const job: Job = {
      ...args,
      status: 'queued',
      stage: 'queued',
      progress: null,
      createdAt: Date.now(),
      videoPath: join(args.dir, 'narration.mp4'),
      videos: {},
    }
    this.jobs.set(job.id, job)
    this.queue.push(job.id)
    this.log.info(`job ${job.id} queued (${job.audioSeconds.toFixed(1)}s audio)`)
    this.pump()
    return this.toPublic(job)
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id)
  }

  toPublic(job: Job): PublicJob {
    const succeeded = job.status === 'succeeded'
    const formats = Object.keys(job.videos) as VideoFormat[]
    const urls = Object.fromEntries(formats.map((f) => [f, `/jobs/${job.id}/video?format=${f}`]))
    return {
      id: job.id,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      audioSeconds: Number(job.audioSeconds.toFixed(2)),
      background: job.background,
      createdAt: iso(job.createdAt)!,
      startedAt: iso(job.startedAt),
      finishedAt: iso(job.finishedAt),
      error: job.error,
      errorCode: job.errorCode,
      videoUrl: succeeded ? `/jobs/${job.id}/video` : undefined,
      videos: succeeded ? urls : undefined,
    }
  }

  /** Cancels a queued/running job, or deletes a finished one. Returns false if unknown. */
  async remove(id: string): Promise<boolean> {
    const job = this.jobs.get(id)
    if (!job) return false

    if (job.status === 'queued') {
      this.queue = this.queue.filter((q) => q !== id)
    } else if (job.status === 'running') {
      job.abortReason = 'cancelled'
      job.abort?.abort(new Error('cancelled'))
      // run() removes the directory and deregisters when the render unwinds.
      return true
    }
    this.jobs.delete(id)
    await this.discard(job.dir)
    return true
  }

  async shutdown(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper)
    for (const id of this.running) {
      const job = this.jobs.get(id)
      if (job) {
        job.abortReason = 'shutdown'
        job.abort?.abort(new Error('shutdown'))
      }
    }
    // Give aborted renders a moment to close their browsers.
    const deadline = Date.now() + 8000
    while (this.running.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  }

  private pump(): void {
    while (this.running.size < config.maxConcurrentJobs && this.queue.length > 0) {
      const id = this.queue.shift()!
      const job = this.jobs.get(id)
      if (!job) continue
      this.running.add(id)
      void this.run(job).finally(() => {
        this.running.delete(id)
        this.pump()
      })
    }
  }

  private async run(job: Job): Promise<void> {
    job.status = 'running'
    job.startedAt = Date.now()
    job.stage = 'starting'
    const abort = new AbortController()
    job.abort = abort
    const timer = setTimeout(() => {
      job.abortReason = 'timeout'
      abort.abort(new Error('timeout'))
    }, jobTimeoutMs(job.audioSeconds))

    this.log.info(`job ${job.id} started`)
    try {
      job.videos = await renderVideo({
        pcmPath: job.pcmPath,
        outPath: job.videoPath,
        background: job.background,
        signal: abort.signal,
        onUpdate: (u) => {
          job.stage = u.stage
          job.progress = u.progress ?? null
        },
        log: (m) => this.log.info(`job ${job.id}: ${m}`),
      })
      job.status = 'succeeded'
      job.stage = 'done'
      job.progress = null
      this.log.info(`job ${job.id} succeeded in ${((Date.now() - job.startedAt) / 1000).toFixed(0)}s`)
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      if (job.abortReason === 'cancelled') {
        // remove() already decided this job's fate; just drop it.
        this.jobs.delete(job.id)
        await this.discard(job.dir)
        this.log.info(`job ${job.id} cancelled`)
        return
      }
      job.status = 'failed'
      job.stage = 'failed'
      job.progress = null
      if (job.abortReason === 'timeout') {
        job.error = 'render timed out'
        job.errorCode = 'timeout'
      } else if (job.abortReason === 'shutdown') {
        job.error = 'service shut down during render'
        job.errorCode = 'shutdown'
      } else {
        job.error = raw
        job.errorCode =
          err instanceof RenderError
            ? err.code
            : /insufficientBalance/i.test(raw)
              ? 'insufficient_balance'
              : 'render_failed'
      }
      this.log.error(`job ${job.id} failed: ${job.error}`)
    } finally {
      clearTimeout(timer)
      job.abort = undefined
      job.finishedAt = Date.now()
      // The decoded audio is no longer needed; only the MP4 (if any) is kept.
      await rm(job.pcmPath, { force: true }).catch(() => {})
    }
  }

  /** Deletes finished jobs (and their MP4) once they are older than the TTL. */
  private async sweep(): Promise<void> {
    const cutoff = Date.now() - config.jobTtlMs
    for (const job of this.jobs.values()) {
      if (job.finishedAt && job.finishedAt < cutoff) {
        this.jobs.delete(job.id)
        await this.discard(job.dir)
        this.log.info(`job ${job.id} expired and deleted`)
      }
    }
  }
}
