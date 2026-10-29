/**
 * The render pipeline: PCM audio in, avatar MP4 out.
 *
 * Flow: mint a short-lived Spatius session token, open the render page (web/)
 * in headless Chromium, click through the browser's user-gesture requirement,
 * feed the audio to the SDK in ~25s chunks, wait for it to play out in real
 * time while the page records the canvas plus the SDK's own audio output, then
 * encode that recording to MP4 with ffmpeg.
 *
 * Renders in real time: an N-second clip takes about N seconds plus ~1 minute
 * of startup/encode. The timings and chunk size below were all tuned against
 * real renders; see the notes on each.
 */
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { avatarkitVitePlugin } from '@spatius/avatarkit/vite'
import { chromium, type Page } from 'playwright'
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { config } from './config.js'

const exec = promisify(execFile)

export const FFMPEG = ffmpegInstaller.path

/** Spatius Direct Mode input format: mono PCM16 little-endian at this rate. */
export const SAMPLE_RATE = 16_000
export const BYTES_PER_SECOND = SAMPLE_RATE * 2
/** The SDK animates at a fixed 25fps internally; recording faster adds nothing. */
const FPS = 25
const VIEWPORT = { width: 1280, height: 720 }

/**
 * Audio goes to the SDK in ~25s chunks, fired back to back with no pacing.
 * Two alternatives were tried and rejected: one giant send() rendered the
 * right length but froze reliably near the tail (the service falls slightly
 * behind real time on a huge batch and the lag compounds), and tiny
 * real-time-paced chunks froze ~2s out of every ~4s (each call is a network
 * round trip).
 */
const CHUNK_SEC = 25
/** Recording keeps running this long after the audio ends, so the last word is not clipped. */
const TAIL_MS = 2500
const CONNECT_TIMEOUT_MS = 60_000
/** Recent browser output kept per attempt, dumped to the log if the attempt fails. */
const BROWSER_LOG_LINES = 40
/**
 * Output sanity checks, applied before encoding. The page counts the frames it
 * received from the SDK; a host that cannot render the avatar still produces a
 * "valid" MP4 (an empty background) unless this catches it. Measured: a blank
 * avatar frame is a ~21KB PNG, a real one 300-400KB+; a healthy render delivers
 * about one frame per 40ms, a CPU-only host about one per 2-5s.
 */
const MIN_REAL_FRAME_BYTES = 100_000
/** Stepped mode holds the last frame (and pads the audio) this long, so the clip does not end on the last syllable. */
const STEPPED_TAIL_SEC = 1.5
const MIN_FRAME_RATIO = 0.5

const LAUNCH_ARGS = [
  '--use-gl=angle',
  '--enable-webgl',
  '--ignore-gpu-blocklist',
  // The SDK renders through WebGPU.
  '--enable-unsafe-webgpu',
  '--autoplay-policy=no-user-gesture-required',
  // A headless tab is still throttled like a backgrounded one by default,
  // which starves the render loop on long clips.
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]

/** Built-in flags plus anything from CHROMIUM_EXTRA_ARGS. */
export const launchArgs = () => [...LAUNCH_ARGS, ...config.chromiumExtraArgs]

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/* ------------------------------------------------------------------------ */
/* Audio                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * Decodes any audio ffmpeg can read to raw mono PCM16 @16kHz.
 * `maxSeconds` bounds the decode so a hostile or huge file cannot fill the disk.
 */
export async function decodeToPcm16(inputPath: string, outPcmPath: string, maxSeconds: number): Promise<void> {
  try {
    await exec(
      FFMPEG,
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-i', inputPath,
        '-vn',
        '-t', String(maxSeconds),
        '-f', 's16le',
        '-acodec', 'pcm_s16le',
        '-ar', String(SAMPLE_RATE),
        '-ac', '1',
        '-y', outPcmPath,
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    )
  } catch (err) {
    throw new Error(ffmpegMessage(err))
  }
}

/** Last lines of ffmpeg's stderr, with file paths scrubbed (messages reach API clients). */
function ffmpegMessage(err: unknown): string {
  const stderr = (err as { stderr?: string }).stderr?.trim()
  const tail = stderr ? stderr.split('\n').slice(-3).join(' | ') : ''
  return (tail || (err instanceof Error ? err.message : 'ffmpeg failed')).replace(/(?:\/[^\s:|]+)+/g, '<path>')
}

/* ------------------------------------------------------------------------ */
/* Internal page server                                                      */
/* ------------------------------------------------------------------------ */

let vite: ViteDevServer | undefined

/**
 * Serves web/ to the headless browser. One server for the whole process,
 * bound to loopback only (it is never meant to be reachable from outside).
 * Vite is used because the SDK ships a plugin that serves its WASM correctly.
 */
export async function startWebServer(): Promise<void> {
  vite = await createViteServer({
    root: fileURLToPath(new URL('../web', import.meta.url)),
    configFile: false,
    logLevel: 'warn',
    plugins: [avatarkitVitePlugin()],
    server: { host: '127.0.0.1', port: config.viteInternalPort, strictPort: true },
  })
  await vite.listen()
  // Make Vite discover and pre-bundle the SDK now, not in the middle of the
  // first job (a mid-load "dependencies optimized, reloading" would break it).
  await vite.transformRequest('/main.ts').catch(() => {})
}

export async function stopWebServer(): Promise<void> {
  await vite?.close()
  vite = undefined
}

/**
 * Launches and closes the browser once, at boot, so a missing Chromium
 * install is a clear startup error rather than a failure on the first job.
 */
export async function preflightBrowser(): Promise<void> {
  try {
    const browser = await chromium.launch({ headless: true, args: launchArgs() })
    await browser.close()
  } catch (err) {
    throw new Error(
      `Cannot launch headless Chromium (${err instanceof Error ? err.message.split('\n')[0] : err}). ` +
        'Run "npm run setup:browser" (on Linux add --with-deps for system libraries).',
    )
  }
}

/* ------------------------------------------------------------------------ */
/* Spatius                                                                   */
/* ------------------------------------------------------------------------ */

export async function mintSessionToken(): Promise<string> {
  const { region, apiKey } = config.spatius
  const res = await fetch(`https://console.${region}.spatius.ai/v1/console/session-tokens`, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expireAt: Math.floor(Date.now() / 1000) + 3600 }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Spatius session-token request failed (${res.status}): ${body.slice(0, 300)}`)
  }
  const data = (await res.json()) as { sessionToken?: string }
  if (!data.sessionToken) throw new Error('Spatius session-token response had no sessionToken field')
  return data.sessionToken
}

/* ------------------------------------------------------------------------ */
/* Render                                                                    */
/* ------------------------------------------------------------------------ */

/** A failure with a stable, machine-readable code (surfaces as the job's errorCode). */
export class RenderError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export interface RenderUpdate {
  stage: string
  /** 0..1, only while recording. */
  progress?: number
}

export interface RenderOptions {
  /** Raw PCM16 mono @16kHz, as produced by decodeToPcm16(). */
  pcmPath: string
  /** Where the MP4 goes; transparent outputs are written next to it. */
  outPath: string
  /** `#rrggbb` painted behind the avatar, or `transparent` (stepped mode only). */
  background: string
  signal: AbortSignal
  onUpdate: (u: RenderUpdate) => void
  log: (msg: string) => void
}

/** Output files of one render, keyed by format (`mp4`, or `webm`/`mov` when transparent). */
export type RenderOutputs = Partial<Record<VideoFormat, string>>
export type VideoFormat = 'mp4' | 'webm' | 'mov'

export const TRANSPARENT = 'transparent'

/**
 * Renders one narration. If the avatar fails to load in time it tries once
 * more: that stage happens before the Motion Server connection is opened and
 * before any audio is sent, and a slow first fetch of the avatar assets is the
 * likeliest transient. Any later failure (connecting, insufficientBalance,
 * recording) is NOT retried, since repeating it would spend more credits and
 * rarely help.
 */
export async function renderVideo(opts: RenderOptions): Promise<RenderOutputs> {
  try {
    return await renderOnce(opts)
  } catch (err) {
    if (err instanceof WaitTimeoutError && err.flag === '__directModeAvatarLoaded' && !opts.signal.aborted) {
      opts.log('avatar load timed out, retrying once')
      return await renderOnce(opts)
    }
    throw err
  }
}

async function renderOnce(opts: RenderOptions): Promise<RenderOutputs> {
  const { pcmPath, outPath, background, signal, onUpdate, log } = opts
  if (!vite) throw new Error('web server not started')

  const pcm = await readFile(pcmPath)
  const speechSec = pcm.length / BYTES_PER_SECOND

  const recent: string[] = []
  const note = (line: string) => {
    recent.push(line)
    if (recent.length > BROWSER_LOG_LINES) recent.shift()
    if (config.logBrowser) log(line)
  }

  onUpdate({ stage: 'minting-token' })
  const sessionToken = await mintSessionToken()

  onUpdate({ stage: 'launching-browser' })
  const browser = await chromium.launch({ headless: true, args: launchArgs() })
  const workDir = await mkdtemp(join(tmpdir(), 'avatar-narration-'))
  // Closing the browser makes every pending page call reject, which is how
  // a cancel or timeout interrupts a render that is mid-wait.
  const onAbort = () => void browser.close().catch(() => {})
  signal.addEventListener('abort', onAbort, { once: true })

  try {
    if (signal.aborted) throw new Error('aborted')
    const page = await browser.newPage({ viewport: VIEWPORT, acceptDownloads: true })
    if (config.renderBackend === 'webgl') {
      // The SDK uses WebGPU only if navigator.gpu exists; without it, it falls
      // back to its WebGL renderer. Must be in place before the page's scripts run.
      // A string, not a function: tsx/esbuild injects a `__name` helper into
      // serialized functions that does not exist in the page.
      await page.addInitScript(
        "Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true })",
      )
    }
    // Spatius telemetry/flag endpoints fail routinely and are irrelevant noise.
    const noisy = (u: string) => /spatialwalk\.(top|ai)/.test(u)
    page.on('pageerror', (e) => note(`page error: ${e.message}`))
    page.on('console', (m) => note(`[browser ${m.type()}] ${m.text()}`))
    page.on('requestfailed', (r) => {
      if (!noisy(r.url())) note(`[request failed] ${r.url()} ${r.failure()?.errorText}`)
    })
    page.on('response', (r) => {
      if (!r.ok() && !noisy(r.url())) note(`[http ${r.status()}] ${r.url()}`)
    })

    // 127.0.0.1, not localhost: the page server is bound to IPv4 loopback only.
    const url = new URL(`http://127.0.0.1:${config.viteInternalPort}/`)
    url.searchParams.set('appId', config.spatius.appId)
    url.searchParams.set('avatarId', config.spatius.avatarId)
    url.searchParams.set('region', config.spatius.region)
    url.searchParams.set('sessionToken', sessionToken)
    url.searchParams.set('fps', String(FPS))
    url.searchParams.set('sampleRate', String(SAMPLE_RATE))
    url.searchParams.set('bgColor', background)
    url.searchParams.set('mode', config.renderMode)

    onUpdate({ stage: 'loading-avatar' })
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded' })

    // The click handler is only registered once the avatar has loaded; clicking
    // earlier is a silent no-op and the render would hang forever.
    await waitFor(page, '__directModeAvatarLoaded', 'avatar to load', config.avatarLoadTimeoutMs)

    onUpdate({ stage: 'connecting' })
    // A real click: initializeAudioContext() requires a genuine user gesture.
    await page.click('#start-btn')
    await waitFor(page, '__directModeReady', 'avatar to connect', CONNECT_TIMEOUT_MS)

    onUpdate({ stage: 'sending-audio' })
    const chunkBytes = Math.floor(BYTES_PER_SECOND * CHUNK_SEC)
    for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
      const isLast = offset + chunkBytes >= pcm.length
      const b64 = pcm.subarray(offset, offset + chunkBytes).toString('base64')
      await page.evaluate(([data, end]) => window.__directModeSend?.(data as string, end as boolean), [b64, isLast])
    }

    if (config.renderMode === 'stepped') {
      return await renderStepped({ page, pcmPath, outPath, workDir, background, speechSec, signal, onUpdate, log })
    }

    // send() returns as soon as the SDK has buffered the audio; playback (and
    // the avatar's motion) still takes real wall-clock time.
    onUpdate({ stage: 'recording', progress: 0 })
    const playbackStart = Date.now()
    const playbackEnd = playbackStart + speechSec * 1000
    while (Date.now() < playbackEnd) {
      if (signal.aborted) throw new Error('aborted')
      await sleep(Math.min(1000, playbackEnd - Date.now()))
      onUpdate({ stage: 'recording', progress: Math.min(1, (Date.now() - playbackStart) / (speechSec * 1000)) })
    }

    onUpdate({ stage: 'saving-recording' })
    const downloadPromise = page.waitForEvent('download', { timeout: 60_000 })
    // Attach a handler now so a rejection while we await other things is not "unhandled".
    downloadPromise.catch(() => {})
    await page.evaluate((tail) => window.__directModeStop?.(tail), TAIL_MS)
    await waitFor(page, '__directModeDone', 'recording to finish', 30_000)
    const stats = await page.evaluate(() => window.__directModeStats)
    const expectedFrames = speechSec * FPS
    log(`capture stats: ${JSON.stringify(stats)} (expected ~${Math.round(expectedFrames)} frames)`)
    if (!stats || stats.maxBlobBytes < MIN_REAL_FRAME_BYTES) {
      throw new RenderError(
        'blank_video',
        `the avatar was never drawn (largest captured frame: ${stats?.maxBlobBytes ?? 0} bytes). ` +
          `This host cannot render the avatar; a GPU is required (renderer backend: ${stats?.backend ?? 'unknown'}).`,
      )
    }
    if (stats.frames < expectedFrames * MIN_FRAME_RATIO) {
      throw new RenderError(
        'render_too_slow',
        `the renderer delivered only ${stats.frames} of ~${Math.round(expectedFrames)} frames, ` +
          `too slow to record in real time. A GPU is required (renderer backend: ${stats.backend ?? 'unknown'}).`,
      )
    }

    // A real browser download streamed straight to disk. Returning the video
    // through page.evaluate() would serialize the whole recording as JSON and
    // OOM the renderer on clips of a few minutes.
    const hasBlob = await page.evaluate(() => {
      const blob = window.__directModeVideoBlob
      if (!blob) return false
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'clip.webm'
      document.body.appendChild(a)
      a.click()
      a.remove()
      return true
    })
    if (!hasBlob) throw new Error('the page produced no recording')
    const webmPath = join(workDir, 'clip.webm')
    await (await downloadPromise).saveAs(webmPath)
    await browser.close().catch(() => {})

    onUpdate({ stage: 'encoding' })
    await encodeMp4(webmPath, outPath)
    return { mp4: outPath }
  } catch (err) {
    // Without this a failed render leaves only the one-line error; the
    // browser's own output is what explains a hang or a rejected session.
    if (!signal.aborted && recent.length > 0) log(`last browser output before failure:\n${recent.join('\n')}`)
    throw err
  } finally {
    signal.removeEventListener('abort', onAbort)
    await browser.close().catch(() => {})
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** How long a job may run before it is aborted. */
export function jobTimeoutMs(audioSeconds: number): number {
  if (config.renderMode === 'stepped') {
    // Slowest acceptable host (STEPPED_MIN_FPS) plus startup, encode and one avatar-load retry.
    return (audioSeconds * (FPS / config.steppedMinFps) + 600) * 1000
  }
  // Real-time playback + ~1 min startup/encode, plus room for one avatar-load retry.
  return (audioSeconds + 420) * 1000
}

interface SteppedArgs {
  page: Page
  pcmPath: string
  outPath: string
  workDir: string
  background: string
  speechSec: number
  signal: AbortSignal
  onUpdate: (u: RenderUpdate) => void
  log: (msg: string) => void
}

/**
 * Stepped rendering: the page draws one frame at a time (see runStepped in
 * web/main.ts) and each PNG is piped straight into ffmpeg, which paints the
 * background, adds the source audio and encodes as the frames arrive. Frame k
 * is the avatar at audio time k/25 by construction, so the original audio is
 * muxed in at offset zero.
 */
async function renderStepped(a: SteppedArgs): Promise<RenderOutputs> {
  const { page, signal, onUpdate, log } = a
  const totalFrames = Math.max(1, Math.floor(a.speechSec * FPS))
  const transparent = a.background === TRANSPARENT
  // Transparent: frames go to a lossless master first, which is then encoded
  // once per delivery format (each needs a different codec for its alpha).
  const masterPath = join(a.workDir, 'master.mkv')
  const encoder = transparent ? spawnFrameEncoder(masterArgs(masterPath)) : spawnFrameEncoder(mp4Args(a.pcmPath, a.outPath, a.background))

  let saved = 0
  let maxBytes = 0
  let firstFrameAt = 0
  await page.exposeFunction('__saveFrame', async (index: number, b64: string) => {
    const png = Buffer.from(b64, 'base64')
    if (index !== saved) throw new Error(`frames arrived out of order (got ${index}, expected ${saved})`)
    if (!firstFrameAt) firstFrameAt = Date.now()
    maxBytes = Math.max(maxBytes, png.length)
    await encoder.write(png)
    saved++
  })

  try {
    onUpdate({ stage: 'rendering-frames', progress: 0 })
    await page.evaluate((n) => window.__directModeRunStepped?.(n), totalFrames)

    for (;;) {
      if (signal.aborted) throw new Error('aborted')
      const state = await page.evaluate(() => ({ done: window.__directModeDone === true, error: window.__directModeError }))
      if (state.error) throw new Error(`Direct Mode failed: ${state.error}`)
      if (state.done) break

      onUpdate({ stage: 'rendering-frames', progress: saved / totalFrames })
      // Fail early on a host that would never finish in time, instead of
      // grinding through an hour of rendering to find out.
      if (saved >= 30) {
        const fps = saved / Math.max(1, (Date.now() - firstFrameAt) / 1000)
        if (fps < config.steppedMinFps) {
          throw new RenderError(
            'render_too_slow',
            `this host renders only ${fps.toFixed(2)} frames/s (minimum ${config.steppedMinFps}); ` +
              `a ${a.speechSec.toFixed(0)}s narration would take too long. Use a faster or GPU host.`,
          )
        }
      }
      await sleep(500)
    }

    const seconds = (Date.now() - firstFrameAt) / 1000
    log(`stepped render: ${saved} frames in ${seconds.toFixed(0)}s (${(saved / Math.max(seconds, 1)).toFixed(1)} fps), largest frame ${maxBytes} bytes`)
    if (maxBytes < MIN_REAL_FRAME_BYTES) {
      throw new RenderError(
        'blank_video',
        `the avatar was never drawn (largest frame: ${maxBytes} bytes). This host cannot render the avatar.`,
      )
    }
    onUpdate({ stage: 'encoding' })
    await encoder.end()
  } catch (err) {
    encoder.kill()
    throw err
  }

  if (!transparent) return { mp4: a.outPath }
  const dir = dirname(a.outPath)
  const outputs: RenderOutputs = { webm: join(dir, 'narration.webm') }
  // HEVC-with-alpha needs Apple's VideoToolbox encoder, so only a macOS host can make it.
  if (process.platform === 'darwin') outputs.mov = join(dir, 'narration.mov')
  for (const [format, path] of Object.entries(outputs) as [VideoFormat, string][]) {
    try {
      await exec(FFMPEG, transparentArgs(format, masterPath, a.pcmPath, path), { maxBuffer: 4 * 1024 * 1024 })
    } catch (err) {
      throw new Error(`encoding ${format} failed: ${ffmpegMessage(err)}`)
    }
  }
  return outputs
}

const PNG_PIPE_INPUT = ['-f', 'image2pipe', '-c:v', 'png', '-framerate', String(FPS), '-i', 'pipe:0']
const PCM_INPUT = (pcmPath: string) => ['-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', pcmPath]
const TAIL_PAD = `tpad=stop_mode=clone:stop_duration=${STEPPED_TAIL_SEC}`

/** PNG frames on stdin + the PCM file, composited onto a solid color, to the final MP4. */
function mp4Args(pcmPath: string, outPath: string, background: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error',
    // Solid background the transparent avatar frames are composited onto.
    '-f', 'lavfi', '-i', `color=c=0x${background.slice(1)}:s=${VIEWPORT.width}x${VIEWPORT.height}:r=${FPS}`,
    ...PNG_PIPE_INPUT,
    ...PCM_INPUT(pcmPath),
    '-filter_complex',
    `[0:v][1:v]overlay=shortest=1,${TAIL_PAD},format=yuv420p[v];` + `[2:a]apad=pad_dur=${STEPPED_TAIL_SEC}[a]`,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-crf', '18', '-r', String(FPS), '-vsync', 'cfr',
    '-c:a', 'aac', '-b:a', '192k',
    '-shortest', '-movflags', '+faststart', '-y', outPath,
  ]
}

/** PNG frames on stdin to a lossless RGBA master (video only), keeping the avatar's alpha. */
function masterArgs(masterPath: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error',
    ...PNG_PIPE_INPUT,
    '-vf', `${TAIL_PAD},format=bgra`,
    '-c:v', 'ffv1', '-r', String(FPS), '-vsync', 'cfr', '-y', masterPath,
  ]
}

/**
 * Master + PCM to one transparent delivery file. No single small format
 * carries alpha everywhere: VP9 WebM covers Chrome/Firefox/Edge, HEVC-with-
 * alpha MOV covers Safari/Apple devices and most editors on macOS.
 */
function transparentArgs(format: VideoFormat, masterPath: string, pcmPath: string, outPath: string): string[] {
  const codec =
    format === 'webm'
      ? // auto-alt-ref must be off or libvpx drops the alpha plane.
        ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-crf', '30', '-b:v', '0', '-row-mt', '1',
          '-deadline', 'good', '-cpu-used', '2', '-auto-alt-ref', '0', '-c:a', 'libopus', '-b:a', '128k']
      : ['-c:v', 'hevc_videotoolbox', '-pix_fmt', 'bgra', '-alpha_quality', '0.9', '-b:v', '3M', '-tag:v', 'hvc1',
          '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart']
  return [
    '-hide_banner', '-loglevel', 'error',
    '-i', masterPath,
    ...PCM_INPUT(pcmPath),
    '-filter_complex', `[1:a]apad=pad_dur=${STEPPED_TAIL_SEC}[a]`,
    '-map', '0:v', '-map', '[a]',
    ...codec,
    '-shortest', '-y', outPath,
  ]
}

/** ffmpeg reading PNG frames on stdin (args from mp4Args/masterArgs). */
function spawnFrameEncoder(args: string[]) {
  const child = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-2000)
  })
  child.stdin.on('error', () => {}) // EPIPE if ffmpeg dies; surfaced through `exited`
  const exited = new Promise<void>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`encoding failed: ${ffmpegMessage({ stderr })}`))
    })
  })
  exited.catch(() => {}) // observed via end()/write(); avoid an unhandled rejection if killed
  return {
    async write(png: Buffer): Promise<void> {
      if (child.stdin.destroyed || child.exitCode !== null) throw new Error(`encoding stopped: ${ffmpegMessage({ stderr })}`)
      if (!child.stdin.write(png)) await once(child.stdin, 'drain')
    },
    async end(): Promise<void> {
      child.stdin.end()
      await exited
    },
    kill(): void {
      child.kill('SIGKILL')
    },
  }
}

type PageFlag = '__directModeAvatarLoaded' | '__directModeReady' | '__directModeDone'

class WaitTimeoutError extends Error {
  constructor(
    readonly flag: PageFlag,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Polls a flag the render page sets on `window`. Also fails fast if the page
 * reported an error (a Spatius rejection such as insufficientBalance shows up
 * here, and waiting out the full timeout would hide it).
 */
async function waitFor(page: Page, flag: PageFlag, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await page.evaluate((f) => ({ ok: window[f] === true, error: window.__directModeError }), flag)
    if (state.error) throw new Error(`Direct Mode failed: ${state.error}`)
    if (state.ok) return
    await sleep(250)
  }
  const status = await page.evaluate(() => document.getElementById('status')?.textContent ?? '').catch(() => '')
  throw new WaitTimeoutError(flag, `timed out waiting for ${what} (page status: ${status || 'unknown'})`)
}

async function encodeMp4(webmPath: string, outPath: string): Promise<void> {
  try {
    await exec(
      FFMPEG,
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-i', webmPath,
        '-map', '0:v:0',
        '-map', '0:a:0',
        '-c:v', 'libx264',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        // The raw webm carries the manual capture pump's timestamps, which
        // passed straight through as ~1000fps once; force a constant 25.
        '-r', String(FPS),
        '-vsync', 'cfr',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-shortest',
        // Moves the index to the front so the file can start playing before
        // it has fully downloaded.
        '-movflags', '+faststart',
        '-y', outPath,
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    )
  } catch (err) {
    throw new Error(`encoding failed: ${ffmpegMessage(err)}`)
  }
}
