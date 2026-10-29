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

```
<course folder>/
  slides_png/slide_1.png, slide_2.png, ...
  audio_en/slide_1.mp3, slide_2.mp3, ...      (or voiceover_per_slide/)
```

```bash
# the avatar service must be running only if some avatar videos still have to be made
API_URL=http://127.0.0.1:3000 API_KEY=$API_KEY npm run compose -- "path/to/course folder"
```

Steps, each skipped when its output already exists (so a re-run costs nothing):

1. normalizes each audio's loudness → `audio_en_loud/`
2. renders each avatar video through the service → `avatar_videos_loud/` (spends Spatius credits)
3. composites and joins the slides → `<folder name>_avatar.mp4` (1920x1080)

Options: `--corner top-right|top-left|bottom-right|bottom-left` (default `top-right`), `--size <circle diameter px>` (default `280`), `--out <file.mp4>`.

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
