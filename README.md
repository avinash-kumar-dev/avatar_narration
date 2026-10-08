# avatar-narration

HTTP service: upload narration audio, get back an MP4 of a Spatius avatar speaking it (synced lipsync, solid background).

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
      └─ ffmpeg encodes the captured frames + audio → MP4

GET /jobs/:id        → poll status
GET /jobs/:id/video  → download the MP4
```

No LiveKit, no separate avatar server, no text-to-speech — you provide the audio.

Two render modes (`RENDER_MODE` env var):
- `realtime` (default) — records the avatar live while it plays. Needs a GPU.
- `stepped` — renders one frame at a time, slower but works on a CPU-only host (e.g. a plain Docker container).

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
