/**
 * Builds one narrated course video from a folder of slides + per-slide audio:
 * each slide full screen, the avatar in a corner, hard cuts between slides.
 *
 * Two styles:
 *   circle (default)  white-background avatar cropped into a circle, top-right
 *   cutout            transparent avatar, only her outline on the slide,
 *                     standing on the bottom edge, bottom-right
 *
 *   npm run compose -- "task3/AIL_Track (1)"
 *   npm run compose -- <folder> --corner top-left --size 320
 *   npm run compose -- <folder> --style cutout
 *
 * Inputs: a folder of slide images and a folder of per-slide audio, paired by
 * the number in each file name (slide_1.png / 1.mp3 / page-01.jpg all mean
 * slide 1). By default both are looked up inside <folder> (slides_png/,
 * slides/ or images/; audio_en/, voiceover_per_slide/, audio/ or voiceover/);
 * --slides and --audio point anywhere else. Slides that are not 16:9 are
 * letterboxed, not stretched. Everything generated goes into <folder>.
 *
 *   npm run compose -- <folder> --slides ~/deck/images --audio ~/deck/narration
 *
 * Steps, each skipped when its output already exists:
 *   1. loudness-normalize each audio  -> <audio dir>_loud/
 *   2. render each avatar video through the running avatar-narration
 *      service (API_URL, API_KEY)      -> avatar_videos_loud/ (circle, MP4)
 *                                         avatar_videos_transparent/ (cutout, WebM)
 *   3. composite + concatenate         -> <folder name>_avatar.mp4
 * Step 2 spends Spatius credits; avatar videos already on disk are reused,
 * so a folder that has them needs no running service.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
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
const SLIDE_DIRS = ['slides_png', 'slides', 'images']
const AUDIO_DIRS = ['audio_en', 'voiceover_per_slide', 'audio', 'voiceover']
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp']
const AUDIO_EXTS = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.flac']
const CORNERS = ['top-right', 'top-left', 'bottom-right', 'bottom-left'] as const
type Corner = (typeof CORNERS)[number]
const STYLES = ['circle', 'cutout'] as const
type Style = (typeof STYLES)[number]

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    style: { type: 'string', default: 'circle' },
    corner: { type: 'string' },
    /** Avatar size: the circle diameter (circle) or 280 = the circle's scale (cutout), in 1920x1080 pixels. */
    size: { type: 'string' },
    out: { type: 'string' },
    slides: { type: 'string' },
    audio: { type: 'string' },
    /** Fills the bars around a slide that is not 16:9. */
    'pad-color': { type: 'string', default: 'white' },
  },
})

const folder = positionals[0] ? resolve(positionals[0]) : undefined
if (!folder) {
  fail(
    'usage: npm run compose -- <folder> [--slides <dir>] [--audio <dir>] [--style circle|cutout] ' +
      '[--corner top-right] [--size 280] [--pad-color white] [--out file.mp4]',
  )
}
const padColor = values['pad-color']!
if (!/^(#[0-9a-fA-F]{6}|[a-z]+)$/.test(padColor)) fail('--pad-color must be a color name or #rrggbb')
const style = values.style as Style
if (!STYLES.includes(style)) fail(`--style must be one of ${STYLES.join(', ')}`)
const cutout = style === 'cutout'
// A cutout's torso ends in a straight cut, which only looks right resting on the frame's bottom edge.
const corner = (values.corner ?? (cutout ? 'bottom-right' : 'top-right')) as Corner
if (!CORNERS.includes(corner)) fail(`--corner must be one of ${CORNERS.join(', ')}`)
const diameter = Number(values.size ?? (cutout ? 400 : 280))
if (!Number.isInteger(diameter) || diameter < 80 || diameter > 1000) fail('--size must be an integer between 80 and 1000')

const apiUrl = (process.env.API_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '')
const apiKey = process.env.API_KEY

const slidesDir = inputDir(values.slides, SLIDE_DIRS, 'slides')
const audioDir = inputDir(values.audio, AUDIO_DIRS, 'audio')
const loudDir = join(folder, `${basename(audioDir)}_loud`)
const avatarDir = join(folder, cutout ? 'avatar_videos_transparent' : 'avatar_videos_loud')
const avatarExt = cutout ? 'webm' : 'mp4'
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
  const g = cutout ? cutoutGeometry() : circleGeometry()
  const mask = join(work, 'mask.png')
  if (!cutout) {
    // Antialiased 1px edge, so the circle is not jagged.
    await ffmpeg([
      '-f', 'lavfi', '-i', `color=black:s=${g.avW}x${g.avH},format=gray`,
      '-vf', `geq=lum='255*clip(${g.r}+0.5-hypot(X-${g.cxInAv},Y-${g.cyInAv}),0,1)'`,
      '-frames:v', '1', mask,
    ])
  }

  const list: string[] = []
  for (const s of slides) {
    const seconds = await durationOf(s.avatar)
    const seg = join(work, `seg_${s.n}.mp4`)
    // Fit inside the frame and pad the rest, so a 4:3 or portrait slide is not stretched.
    const bg =
      `[0:v]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease,` +
      `pad=${OUT_W}:${OUT_H}:(ow-iw)/2:(oh-ih)/2:color=${padColor},setsar=1,fps=${FPS}[bg];`
    const place = `[bg][c]overlay=${g.x}:${g.y}:eof_action=endall,format=yuv420p[v]`
    const avatarInput = cutout
      ? // ffmpeg's built-in VP9 decoder drops the alpha plane; libvpx keeps it.
        ['-c:v', 'libvpx-vp9', '-i', s.avatar]
      : ['-i', s.avatar, '-loop', '1', '-t', String(seconds), '-i', mask]
    const filter = cutout
      ? bg + `[1:v]scale=${g.scaledW}:${g.scaledH},format=rgba[c];` + place
      : bg +
        // The pad keeps the top of the circle round when it reaches above the avatar frame.
        `[1:v]scale=${g.scaledW}:${g.scaledH},pad=${g.avW}:${g.avH}:0:${g.padTop}:white,format=rgba[av];` +
        `[2:v]format=gray,fps=${FPS}[m];[av][m]alphamerge[c];` +
        place
    await ffmpeg([
      '-loop', '1', '-t', String(seconds), '-i', s.slide,
      ...avatarInput,
      '-filter_complex', filter,
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

/** The --slides/--audio folder if given, else the first conventional one inside <folder>. */
function inputDir(given: string | undefined, conventional: string[], what: string): string {
  if (given) {
    const dir = resolve(given)
    if (!existsSync(dir)) fail(`--${what} folder does not exist: ${dir}`)
    return dir
  }
  const name = conventional.find((d) => existsSync(join(folder!, d)))
  if (!name) fail(`no ${what} folder in ${folder} (looked for ${conventional.join(', ')}); pass --${what} <dir>`)
  return join(folder!, name)
}

/**
 * Files in `dir` with one of `exts`, keyed by the last number in their name
 * (slide_1.png, 01.png, "Slide 1.png" are all slide 1).
 */
async function byNumber(dir: string, exts: string[], what: string): Promise<Map<number, string>> {
  const found = new Map<number, string>()
  for (const f of (await readdir(dir)).sort()) {
    const ext = extname(f).toLowerCase()
    if (!exts.includes(ext) || f.startsWith('.')) continue
    const digits = basename(f, extname(f)).match(/\d+/g)
    if (!digits) {
      console.log(`skipping ${what} without a number in its name: ${f}`)
      continue
    }
    const n = Number(digits[digits.length - 1])
    if (found.has(n)) fail(`two ${what} files for number ${n}: ${found.get(n)} and ${f}`)
    found.set(n, f)
  }
  return found
}

/** Pairs every slide image with the audio file of the same number. */
async function pairSlides(): Promise<Slide[]> {
  const images = await byNumber(slidesDir, IMAGE_EXTS, 'slide')
  const audios = await byNumber(audioDir, AUDIO_EXTS, 'audio')
  if (images.size === 0) fail(`no slide images (${IMAGE_EXTS.join(' ')}) in ${slidesDir}`)
  const missing = [...images.keys()].filter((n) => !audios.has(n))
  if (missing.length > 0) fail(`no audio in ${audioDir} for slide(s) ${missing.join(', ')}`)
  for (const n of audios.keys()) if (!images.has(n)) console.log(`ignoring audio ${audios.get(n)}: no slide ${n}`)

  return [...images.entries()]
    .sort(([a], [b]) => a - b)
    .map(([n, image]) => ({
      n,
      slide: join(slidesDir, image),
      audio: join(audioDir, audios.get(n)!),
      loud: join(loudDir, `slide_${n}.mp3`),
      avatar: join(avatarDir, `slide_${n}.${avatarExt}`),
    }))
}

/**
 * Where the avatar goes. Proportions were measured from a hand-edited
 * reference: at a 280px circle the 1280x720 avatar is scaled to 518x292 and
 * the circle sits centred on her face, 118px below the top of that frame.
 */
function circleGeometry() {
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

/**
 * Cutout placement: the whole transparent 16:9 avatar frame, scaled with the
 * same proportions as the circle style. Her shoulders span about the middle
 * 44% of that frame's width, so the corner margin is measured from her, not
 * from the empty frame edge. Bottom corners rest the torso cut on the frame edge.
 */
function cutoutGeometry() {
  const k = diameter / 280
  const scaledW = even(518 * k)
  const scaledH = even(292 * k)
  const halfBody = 0.22 * scaledW
  const marginX = 48
  const marginY = 92
  const cx = corner.endsWith('right') ? OUT_W - marginX - halfBody : marginX + halfBody
  return {
    r: 0, scaledW, scaledH, padTop: 0, avW: scaledW, avH: scaledH, cxInAv: 0, cyInAv: 0,
    x: Math.round(cx - scaledW / 2),
    y: corner.startsWith('top') ? marginY : OUT_H - scaledH,
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
  form.set('background', cutout ? 'transparent' : '#ffffff')

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
      const video = await fetch(`${apiUrl}/jobs/${job.id}/video?format=${avatarExt}`, { headers })
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
