import 'dotenv/config'
import { resolve } from 'node:path'

function str(name: string, fallback?: string): string {
  const v = process.env[name]?.trim()
  if (v) return v
  if (fallback !== undefined) return fallback
  throw new Error(`Missing required env var ${name} (see .env.example)`)
}

function int(name: string, fallback: number, min = 1): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`)
  return n
}

const REGIONS = ['us-west', 'ap-northeast', 'cn-beijing'] as const
export type SpatiusRegion = (typeof REGIONS)[number]

function region(): SpatiusRegion {
  const v = str('SPATIUS_REGION', 'us-west')
  if (!(REGIONS as readonly string[]).includes(v)) {
    throw new Error(`SPATIUS_REGION must be one of ${REGIONS.join(', ')}, got "${v}"`)
  }
  return v as SpatiusRegion
}

function renderMode(): 'realtime' | 'stepped' {
  const v = str('RENDER_MODE', 'realtime')
  if (v !== 'realtime' && v !== 'stepped') throw new Error(`RENDER_MODE must be "realtime" or "stepped", got "${v}"`)
  return v
}

function renderBackend(): 'auto' | 'webgl' {
  const v = str('RENDER_BACKEND', 'auto')
  if (v !== 'auto' && v !== 'webgl') throw new Error(`RENDER_BACKEND must be "auto" or "webgl", got "${v}"`)
  return v
}

export const config = {
  port: int('PORT', 3000, 0),
  host: str('HOST', '0.0.0.0'),
  apiKey: process.env.API_KEY?.trim() || undefined,

  spatius: {
    appId: str('SPATIUS_APP_ID'),
    apiKey: str('SPATIUS_API_KEY'),
    avatarId: str('SPATIUS_AVATAR_ID'),
    region: region(),
  },

  maxConcurrentJobs: int('MAX_CONCURRENT_JOBS', 1),
  maxQueuedJobs: int('MAX_QUEUED_JOBS', 20),
  maxAudioSeconds: int('MAX_AUDIO_SECONDS', 600),
  maxUploadBytes: int('MAX_UPLOAD_MB', 100) * 1024 * 1024,
  jobTtlMs: int('JOB_TTL_MINUTES', 60) * 60_000,

  dataDir: resolve(str('DATA_DIR', './data')),
  avatarLoadTimeoutMs: int('AVATAR_LOAD_TIMEOUT_SECONDS', 120) * 1000,
  viteInternalPort: int('VITE_INTERNAL_PORT', 5199),
  /** Extra Chromium flags, space-separated (e.g. software-WebGPU flags for a GPU-less Linux host). */
  chromiumExtraArgs: (process.env.CHROMIUM_EXTRA_ARGS ?? '').split(/\s+/).filter(Boolean),
  /**
   * 'auto' lets the SDK pick (WebGPU when the browser has a usable adapter,
   * else WebGL). 'webgl' hides navigator.gpu so it uses WebGL, for hosts whose
   * software WebGPU accepts the work but draws nothing.
   */
  renderBackend: renderBackend(),
  /**
   * 'realtime' records the page while it plays (needs a GPU that can draw >25
   * frames/s). 'stepped' drives the SDK's clock by hand and renders one frame
   * at a time, slower than real time but correct on a CPU-only host.
   */
  renderMode: renderMode(),
  /** Stepped mode gives up early if the host renders slower than this (frames/s). */
  steppedMinFps: int('STEPPED_MIN_FPS', 2),
  logBrowser: process.env.LOG_BROWSER === '1',
  logLevel: str('LOG_LEVEL', 'info'),
} as const
