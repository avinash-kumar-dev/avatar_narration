/**
 * Builds one narrated course video from a folder of slides + per-slide audio:
 * each slide full screen, the avatar in a circle in a corner, hard cuts
 * between slides.
 *
 *   npm run compose -- "task3/AIL_Track (1)"
 *   npm run compose -- <folder> --corner top-left --size 320
 *
 * Expected folder layout (slide numbers pair images with audio):
 *   slides_png/slide_1.png ...
 *   audio_en/slide_1.mp3 ...   (or voiceover_per_slide/)
 *
 * Steps, each skipped when its output already exists:
 *   1. loudness-normalize each audio  -> <audio dir>_loud/
 *   2. render each avatar video through the running avatar-narration
 *      service (API_URL, API_KEY)      -> avatar_videos_loud/
 *   3. composite + concatenate         -> <folder name>_avatar.mp4
 * Step 2 spends Spatius credits; avatar videos already on disk are reused,
 * so a folder that has them needs no running service.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { parseArgs } from 'node:util'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'

const exec = promisify(execFile)
const FFMPEG = ffmpegInstaller.path

const OUT_W = 1920
const OUT_H = 1080
const FPS = 25
/** Same settings as the course batches the avatar looked best with. */
const LOUDNORM = 'loudnorm=I=-16:TP=-3:LRA=11'
const AUDIO_DIRS = ['audio_en', 'voiceover_per_slide']
const CORNERS = ['top-right', 'top-left', 'bottom-right', 'bottom-left'] as const
type Corner = (typeof CORNERS)[number]

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    corner: { type: 'string', default: 'top-right' },
    /** Circle diameter in output pixels (1920x1080 frame). */
    size: { type: 'string', default: '280' },
    out: { type: 'string' },
  },
})

const folder = positionals[0] ? resolve(positionals[0]) : undefined
if (!folder) fail('usage: npm run compose -- <course folder> [--corner top-right] [--size 280] [--out file.mp4]')
const corner = values.corner as Corner
if (!CORNERS.includes(corner)) fail(`--corner must be one of ${CORNERS.join(', ')}`)
const diameter = Number(values.size)
if (!Number.isInteger(diameter) || diameter < 80 || diameter > 1000) fail('--size must be an integer between 80 and 1000')

const apiUrl = (process.env.API_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '')
const apiKey = process.env.API_KEY

const slidesDir = join(folder, 'slides_png')
const audioDirName = AUDIO_DIRS.find((d) => existsSync(join(folder, d)))
if (!existsSync(slidesDir)) fail(`no slides_png/ in ${folder}`)
if (!audioDirName) fail(`no audio folder (${AUDIO_DIRS.join(' or ')}) in ${folder}`)
const audioDir = join(folder, audioDirName)
const loudDir = join(folder, `${audioDirName}_loud`)
const avatarDir = join(folder, 'avatar_videos_loud')
const outPath = values.out ? resolve(values.out) : join(folder, `${basename(folder)}_avatar.mp4`)

const slides = await pairSlides()
console.log(`${slides.length} slides in ${folder}`)
await mkdir(loudDir, { recursive: true })
await mkdir(avatarDir, { recursive: true })

for (const s of slides) {
  if (!existsSync(s.loud)) {
    await ffmpeg(['-i', s.audio, '-af', LOUDNORM, '-ar', '44100', '-b:a', '128k', s.loud])
    console.log(`slide ${s.n}: normalized audio`)
  }
  if (existsSync(s.avatar)) {
    console.log(`slide ${s.n}: reusing ${s.avatar}`)
  } else {
    await renderAvatar(s.loud, s.avatar, `slide ${s.n}`)
  }
}

const work = await mkdtemp(join(tmpdir(), 'avatar-compose-'))
try {
  const g = geometry()
  const mask = join(work, 'mask.png')
  // Antialiased 1px edge, so the circle is not jagged.
  await ffmpeg([
    '-f', 'lavfi', '-i', `color=black:s=${g.avW}x${g.avH},format=gray`,
    '-vf', `geq=lum='255*clip(${g.r}+0.5-hypot(X-${g.cxInAv},Y-${g.cyInAv}),0,1)'`,
    '-frames:v', '1', mask,
  ])

  const list: string[] = []
  for (const s of slides) {
    const seconds = await durationOf(s.avatar)
    const seg = join(work, `seg_${s.n}.mp4`)
    await ffmpeg([
      '-loop', '1', '-t', String(seconds), '-i', s.slide,
      '-i', s.avatar,
      '-loop', '1', '-t', String(seconds), '-i', mask,
      '-filter_complex',
      `[0:v]scale=${OUT_W}:${OUT_H},setsar=1,fps=${FPS}[bg];` +
        // The pad keeps the top of the circle round when it reaches above the avatar frame.
        `[1:v]scale=${g.scaledW}:${g.scaledH},pad=${g.avW}:${g.avH}:0:${g.padTop}:white,format=rgba[av];` +
        `[2:v]format=gray,fps=${FPS}[m];[av][m]alphamerge[c];` +
        `[bg][c]overlay=${g.x}:${g.y}:eof_action=endall,format=yuv420p[v]`,
      '-map', '[v]', '-map', '1:a',
      '-t', String(seconds),
      '-c:v', 'libx264', '-crf', '18', '-r', String(FPS),
      // Every segment gets the same audio format, so they concatenate without re-encoding.
      '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '1',
      seg,
    ])
    list.push(`file '${seg.replace(/'/g, "'\\''")}'`)
    console.log(`slide ${s.n}: composed (${seconds.toFixed(2)}s)`)
  }

  const listPath = join(work, 'list.txt')
  await writeFile(listPath, list.join('\n'))
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', outPath])
  console.log(`done: ${outPath} (${(await durationOf(outPath)).toFixed(2)}s)`)
} finally {
  await rm(work, { recursive: true, force: true })
}

/* -------------------------------- helpers -------------------------------- */

interface Slide {
  n: number
  slide: string
  audio: string
  loud: string
  avatar: string
}

/** Pairs slide_N.png with slide_N.<audio>, by slide number. */
async function pairSlides(): Promise<Slide[]> {
  const num = (f: string) => Number(/slide_(\d+)\./.exec(f)?.[1] ?? NaN)
  const audios = new Map((await readdir(audioDir)).filter((f) => !Number.isNaN(num(f))).map((f) => [num(f), f]))
  const pngs = (await readdir(slidesDir)).filter((f) => f.endsWith('.png') && !Number.isNaN(num(f)))
  const slides = pngs
    .map((f) => {
      const n = num(f)
      const audio = audios.get(n)
      if (!audio) fail(`slide ${n} has no audio in ${audioDir}`)
      return {
        n,
        slide: join(slidesDir, f),
        audio: join(audioDir, audio),
        loud: join(loudDir, `slide_${n}.mp3`),
        avatar: join(avatarDir, `slide_${n}.mp4`),
      }
    })
    .sort((a, b) => a.n - b.n)
  if (slides.length === 0) fail(`no slide_N.png files in ${slidesDir}`)
  return slides
}

/**
 * Where the avatar goes. Proportions were measured from a hand-edited
 * reference: at a 280px circle the 1280x720 avatar is scaled to 518x292 and
 * the circle sits centred on her face, 118px below the top of that frame.
 */
function geometry() {
  const k = diameter / 280
  const r = diameter / 2
  const scaledW = even(518 * k)
  const scaledH = even(292 * k)
  const faceX = scaledW / 2
  const faceY = 118 * k
  const padTop = even(Math.max(0, r - faceY) + 2)
  const avW = scaledW
  const avH = scaledH + padTop
  const cxInAv = faceX
  const cyInAv = faceY + padTop
  const marginX = 48
  const marginY = 92
  const cx = corner.endsWith('right') ? OUT_W - marginX - r : marginX + r
  const cy = corner.startsWith('top') ? marginY + r : OUT_H - marginY - r
  return {
    r, scaledW, scaledH, padTop, avW, avH, cxInAv, cyInAv,
    x: Math.round(cx - cxInAv),
    y: Math.round(cy - cyInAv),
  }
}

function even(n: number): number {
  return Math.round(n / 2) * 2
}

/** Submits the audio to the avatar-narration service and downloads the MP4. */
async function renderAvatar(audioPath: string, outFile: string, label: string): Promise<void> {
  if (!apiKey) fail(`${label} needs an avatar video: set API_KEY (and API_URL) for a running avatar-narration service`)
  const headers = { Authorization: `Bearer ${apiKey}` }
  const form = new FormData()
  form.set('audio', new Blob([await readFile(audioPath)]), basename(audioPath))
  form.set('background', '#ffffff')

  for (let attempt = 1; attempt <= 3; attempt++) {
    const submit = await fetch(`${apiUrl}/jobs`, { method: 'POST', headers, body: form }).catch((e: Error) =>
      fail(`${label}: cannot reach the avatar service at ${apiUrl} (${e.message})`),
    )
    const job = (await submit.json()) as { id?: string; message?: string }
    if (!submit.ok || !job.id) fail(`${label}: service rejected the audio: ${job.message ?? submit.status}`)

    process.stdout.write(`${label}: rendering avatar`)
    let status: { status: string; error?: string; errorCode?: string }
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000))
      status = (await (await fetch(`${apiUrl}/jobs/${job.id}`, { headers })).json()) as typeof status
      if (status.status !== 'queued' && status.status !== 'running') break
      process.stdout.write('.')
    }
    process.stdout.write('\n')

    if (status.status === 'succeeded') {
      const video = await fetch(`${apiUrl}/jobs/${job.id}/video?format=mp4`, { headers })
      if (!video.ok) fail(`${label}: download failed (${video.status})`)
      await writeFile(outFile, Buffer.from(await video.arrayBuffer()))
      return
    }
    // Credits and hosts that cannot render will not fix themselves; a dropped
    // Spatius connection (render_failed) usually does.
    if (status.errorCode !== 'render_failed' || attempt === 3) fail(`${label}: render failed: ${status.error}`)
    console.log(`${label}: ${status.error} - retrying (${attempt}/3)`)
  }
}

async function durationOf(path: string): Promise<number> {
  // ffmpeg -i always exits non-zero without an output; the duration is on stderr.
  const { stderr } = await exec(FFMPEG, ['-hide_banner', '-i', path]).catch((e: { stderr: string }) => e)
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(stderr)
  if (!m) fail(`cannot read the duration of ${path}`)
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

async function ffmpeg(args: string[]): Promise<void> {
  try {
    await exec(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 16 * 1024 * 1024 })
  } catch (err) {
    fail(`ffmpeg failed: ${(err as { stderr?: string }).stderr?.trim() || String(err)}`)
  }
}

function fail(msg: string): never {
  console.error(`error: ${msg}`)
  process.exit(1)
}
