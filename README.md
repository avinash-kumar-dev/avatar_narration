# avatar-narration

HTTP service: upload narration audio, get back a video of a Spatius avatar speaking it (synced lipsync). Solid-color background (MP4) or transparent background (WebM + MOV).

## Architecture

```
POST /jobs (audio file)
      │
      ▼
  job queue (src/jobs.ts) ── in memory, FIFO
      │
      ▼
  render pipeline (src/render.ts)
      │
      ├─ headless Chromium loads web/index.html + web/main.ts
      │    (connects to Spatius Direct Mode, plays the audio,
      │     captures avatar frames)
      │
      └─ ffmpeg encodes the captured frames + audio
           → MP4 (solid background)
           → WebM + MOV with alpha (transparent background)

GET /jobs/:id                      → poll status
GET /jobs/:id/video?format=<fmt>   → download (mp4 | webm | mov)
```

No LiveKit, no separate avatar server, no text-to-speech — you provide the audio.

Two render modes (`RENDER_MODE` env var):
- `realtime` (default) — records the avatar live while it plays. Needs a GPU.
- `stepped` — renders one frame at a time, slower but works on a CPU-only host (e.g. a plain Docker container). Required for a transparent background.

## Setup

```bash
npm install
npm run setup:browser       # downloads Chromium for Playwright (once)
cp .env.example .env        # fill in SPATIUS_APP_ID / SPATIUS_API_KEY / SPATIUS_AVATAR_ID / API_KEY
npm start
```

## Usage

Submit a narration:

```bash
curl -X POST http://localhost:3000/jobs \
  -H "Authorization: Bearer $API_KEY" \
  -F audio=@narration.mp3 \
  -F background='#ffffff'
```

Returns immediately with a job id:

```json
{ "id": "...", "status": "running", "stage": "starting" }
```

Poll until done:

```bash
curl http://localhost:3000/jobs/<id> -H "Authorization: Bearer $API_KEY"
```

```json
{ "status": "succeeded", "videoUrl": "/jobs/<id>/video" }
```

Download:

```bash
curl http://localhost:3000/jobs/<id>/video -H "Authorization: Bearer $API_KEY" -o out.mp4
```

Cancel/delete: `DELETE /jobs/<id>`. Health check (no auth): `GET /health`.

### Transparent background

Send `-F background=transparent` (needs `RENDER_MODE=stepped`). Instead of an MP4 you get two files with a real alpha channel, listed in the job's `videos`:

- `?format=webm` — VP9 WebM: Chrome, Firefox, Edge.
- `?format=mov` — HEVC-with-alpha MOV: Safari, Apple devices, Final Cut / Premiere / DaVinci on macOS. Only produced when the service runs on macOS (it needs Apple's encoder).

```bash
curl "http://localhost:3000/jobs/<id>/video?format=webm" -H "Authorization: Bearer $API_KEY" -o out.webm
```

For a plain MP4 that any editor can key out, use a green background instead: `-F background='#00ff00'`.

## Course videos (slides + avatar)

`npm run compose` turns a folder of slides and per-slide audio into one video: each slide full screen, the avatar in a circle in a corner, hard cuts between slides.

Slides are paired with audio by the **number in each file name**, so any naming works: `slide_1.png`, `1.png`, `Slide 01.jpg` and `page-1.webp` are all slide 1. Slide images: png, jpg, jpeg, webp (any size; non-16:9 slides are padded, not stretched). Audio: mp3, wav, m4a, aac, ogg, opus, flac. Every slide needs an audio file with the same number.

By default both folders are looked up inside the course folder:

```
<course folder>/
  slides_png/   (or slides/, images/)
  audio_en/     (or voiceover_per_slide/, audio/, voiceover/)
```

Or point at them anywhere with `--slides` and `--audio`; everything generated still goes into the course folder.

**1. Start the avatar service** (terminal 1; stepped mode is required for `--style cutout`):

```bash
RENDER_MODE=stepped npm start
```

Not needed if every avatar video for the folder already exists.

**2. Build the course video** (terminal 2; `API_KEY` = the service's `API_KEY` from `.env`):

```bash
# circle avatar, top-right
API_URL=http://127.0.0.1:3000 API_KEY=$API_KEY npm run compose -- "path/to/course folder"

# transparent cutout avatar, bottom-right
API_URL=http://127.0.0.1:3000 API_KEY=$API_KEY npm run compose -- "path/to/course folder" --style cutout

# slides and audio in other folders, any file names
API_URL=http://127.0.0.1:3000 API_KEY=$API_KEY npm run compose -- "path/to/work folder" --slides ~/deck/images --audio ~/deck/narration

# custom corner / size / output file
API_URL=http://127.0.0.1:3000 API_KEY=$API_KEY npm run compose -- "path/to/course folder" --corner top-left --size 320 --out course.mp4
```

**3. Stop the service** with Ctrl+C in terminal 1.

Steps, each skipped when its output already exists (so a re-run costs nothing):

1. normalizes each audio's loudness → `<audio folder name>_loud/`
2. renders each missing avatar video through the service → `avatar_videos_loud/` (circle) or `avatar_videos_transparent/` (cutout); spends Spatius credits
3. composites and joins the slides → `<folder name>_avatar.mp4` (1920x1080)

Options:

- `--style circle` (default) — white-background avatar cropped into a circle, top-right.
- `--style cutout` — transparent avatar, only her outline on the slide, standing on the bottom edge (bottom-right). Renders go to `avatar_videos_transparent/` (WebM) and take about 2x longer.
- `--corner top-right|top-left|bottom-right|bottom-left`, `--size <px>` (circle default `280`, cutout default `400`), `--out <file.mp4>`.
- `--slides <dir>`, `--audio <dir>` — input folders, if not inside the course folder.
- `--pad-color <name|#rrggbb>` — color of the bars around a non-16:9 slide (default `white`).

## Running in Docker

```bash
docker build -t avatar-narration .
docker run --rm --shm-size=1g -p 3000:3000 --env-file .env avatar-narration
```

**Host has a GPU:** use the default (`RENDER_MODE=realtime`).

**Host has no GPU** (e.g. a plain cloud VM): set these three env vars —

```bash
RENDER_MODE=stepped
RENDER_BACKEND=webgl
CHROMIUM_EXTRA_ARGS=--use-angle=gl-egl
```

Stepped mode is slower (roughly 2-3x the audio's own length to render) but produces a correct video on CPU alone.

## Configuration

Full list with defaults in [`.env.example`](.env.example).

## Development

```bash
npm run dev          # restart on change
npm run typecheck
npm run bench        # measure how many frames/sec this host can render
```

Layout: `src/` — Node service. `web/` — the page the headless browser loads. `types/` — shared `window` hook declarations.
