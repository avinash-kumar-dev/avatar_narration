/**
 * Host benchmark: how many avatar frames per second can this machine draw?
 * Spends no Spatius credits (no audio, no Motion Server session).
 *
 *   npm run bench                       # defaults
 *   BENCH_BACKEND=webgl npm run bench   # force the WebGL renderer
 *   BENCH_W=640 BENCH_H=360 npm run bench
 *
 * A host can record in real time only if fps is comfortably above 25.
 */
import { chromium } from 'playwright'
import { config } from '../src/config.js'
import { launchArgs, mintSessionToken, startWebServer, stopWebServer } from '../src/render.js'

const seconds = Number(process.env.BENCH_SECONDS ?? 20)
const w = Number(process.env.BENCH_W ?? 1280)
const h = Number(process.env.BENCH_H ?? 720)
const backend = process.env.BENCH_BACKEND ?? config.renderBackend
const extra = (process.env.BENCH_ARGS ?? '').split(/\s+/).filter(Boolean)

await startWebServer()
const browser = await chromium.launch({ headless: true, args: [...launchArgs(), ...extra] })
try {
  const page = await browser.newPage({ viewport: { width: w, height: h } })
  page.on('pageerror', (e) => console.log('page error:', e.message))
  if (backend === 'webgl') {
    await page.addInitScript(
      "Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true })",
    )
  }
  const url = new URL(`http://127.0.0.1:${config.viteInternalPort}/`)
  url.searchParams.set('appId', config.spatius.appId)
  url.searchParams.set('avatarId', config.spatius.avatarId)
  url.searchParams.set('region', config.spatius.region)
  url.searchParams.set('sessionToken', await mintSessionToken())
  url.searchParams.set('bench', '1')
  url.searchParams.set('benchSeconds', String(seconds))
  url.searchParams.set('w', String(w))
  url.searchParams.set('h', String(h))
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__benchResult !== undefined, undefined, { timeout: (seconds + 120) * 1000 })
  const r = await page.evaluate(() => window.__benchResult)
  console.log(`BENCH ${w}x${h} backend-req=${backend} extra=[${extra.join(' ')}] =>`, JSON.stringify(r))
} finally {
  await browser.close()
  await stopWebServer()
  process.exit(0)
}
