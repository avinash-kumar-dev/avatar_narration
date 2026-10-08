/**
 * Render page, loaded by headless Chromium (see src/render.ts). Runs Spatius
 * Direct Mode: connects straight to the Motion Server, plays the audio it is
 * fed, and records the avatar's canvas plus the SDK's own audio output into
 * one WebM, which the server then encodes to MP4.
 *
 * Not meant to be opened by hand: it is driven through the window.__* hooks
 * declared below.
 */
import { AvatarSDK, AvatarManager, AvatarView, DrivingServiceMode } from '@spatius/avatarkit'

function setStatus(s: string) {
  document.getElementById('status')!.textContent = s
}

/**
 * Taps the SDK's own Web Audio output instead of muxing the source audio in
 * afterwards. The SDK plays through `gainNode.connect(audioContext.destination)`
 * and that is the exact signal the animation clock is synced to. Muxing the
 * source file separately starts it at t=0, but real playback only starts once
 * the SDK pipeline is ready, which showed up as a ~2s lipsync offset. Tapping
 * the real output is aligned by construction, with no offset trim needed.
 *
 * Must run before the SDK creates its AudioContext (module load time, not
 * inside the click handler): wraps the global constructor so the instance the
 * SDK ends up using is the one we capture, then patches AudioNode.connect() to
 * fan any connection to `.destination` out to our own
 * MediaStreamAudioDestinationNode too. Web Audio nodes support several
 * simultaneous outputs, so real playback is undisturbed.
 */
const audioTap: { ctx: AudioContext | null; destination: MediaStreamAudioDestinationNode | null } = {
  ctx: null,
  destination: null,
}

/**
 * Stepped mode (`?mode=stepped`): for hosts that cannot draw frames in real
 * time (CPU-only). The SDK's whole playback clock is `audioContext.currentTime`
 * (the animation frame shown is floor(that * 25)), so instead of letting it run
 * with the wall clock we hand it a clock we advance one frame at a time, only
 * after the previous frame has been drawn and saved. Slower than real time, but
 * no frame is ever dropped.
 *
 * The real context is suspended so its sources never play or fire `onended`
 * (which would mark playback finished long before our slow clock gets there),
 * and `state`/`resume()` are faked so the SDK believes it is running.
 */
const STEPPED = new URLSearchParams(location.search).get('mode') === 'stepped'
/** The SDK animates at a fixed 25fps (APP_CONFIG.animation.fps); the frame shown is floor(audioTime * 25). */
const SDK_FPS = 25
const clock = { t: 0 }

;(() => {
  const OrigAudioContext = window.AudioContext
  class TappedAudioContext extends OrigAudioContext {
    constructor(...args: ConstructorParameters<typeof AudioContext>) {
      super(...args)
      audioTap.ctx = this
      audioTap.destination = this.createMediaStreamDestination()
      if (STEPPED) {
        Object.defineProperty(this, 'currentTime', { get: () => clock.t, configurable: true })
        Object.defineProperty(this, 'state', { get: () => 'running', configurable: true })
        this.resume = () => Promise.resolve()
        void OrigAudioContext.prototype.suspend.call(this)
      }
    }
  }
  // Intentional global override; must happen before the SDK's own `new AudioContext()`.
  window.AudioContext = TappedAudioContext

  const origConnect = AudioNode.prototype.connect as (...args: unknown[]) => unknown
  AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]) {
    const result = origConnect.apply(this, args)
    if (audioTap.ctx && audioTap.destination && args[0] === audioTap.ctx.destination) {
      origConnect.call(this, audioTap.destination)
    }
    return result
  } as typeof AudioNode.prototype.connect
})()

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',', 2)[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

async function main() {
  const params = new URLSearchParams(location.search)
  const appId = params.get('appId')!
  const avatarId = params.get('avatarId')!
  const region = params.get('region') || 'us-west'
  const sessionToken = params.get('sessionToken')!
  const fps = Number(params.get('fps') || '25')
  const sampleRate = Number(params.get('sampleRate') || '16000')

  try {
    setStatus('sdk:initializing')
    await AvatarSDK.initialize(appId, {
      region: region as 'us-west' | 'ap-northeast' | 'cn-beijing',
      drivingServiceMode: DrivingServiceMode.direct,
    })
    setStatus('sdk:initialized')
    AvatarSDK.setSessionToken(sessionToken)

    const stage = document.getElementById('stage') as HTMLDivElement
    setStatus('avatar:loading')
    const avatar = await AvatarManager.shared.load(avatarId, (progress: unknown) => {
      console.log('avatar load progress', JSON.stringify(progress))
    })
    setStatus('avatar:loaded')
    window.__directModeAvatarLoaded = true // the server waits for this before clicking #start-btn
    // AvatarView builds its own AvatarController internally (network layer
    // composed from AvatarSDK.initialize's drivingServiceMode), reached via
    // view.controller rather than constructed directly.
    const view = new AvatarView(avatar, stage)
    const controller = view.controller

    // Host benchmark (see scripts/bench.ts): times how fast this machine can
    // draw avatar frames. No audio is sent and no Motion Server session is
    // opened, so it spends no Spatius credits.
    if (params.get('bench') === '1') {
      const w = Number(params.get('w') || 0)
      const h = Number(params.get('h') || 0)
      if (w && h) {
        stage.style.width = `${w}px`
        stage.style.height = `${h}px`
      }
      const seconds = Number(params.get('benchSeconds') || '20')
      const times: number[] = []
      let maxBytes = 0
      const end = performance.now() + seconds * 1000
      while (performance.now() < end) {
        const t0 = performance.now()
        const blob = await view.exportBitmap()
        const dt = performance.now() - t0
        if (blob) {
          times.push(dt)
          maxBytes = Math.max(maxBytes, blob.size)
        }
      }
      const sorted = [...times].sort((a, b) => a - b)
      window.__benchResult = {
        frames: times.length,
        seconds,
        fps: times.length / seconds,
        medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
        p95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
        maxBlobBytes: maxBytes,
        backend: (AvatarSDK as unknown as { getRendererBackend?: () => string | null }).getRendererBackend?.() ?? null,
      }
      return
    }

    controller.onError = (err: unknown) => {
      window.__directModeError = JSON.stringify(err)
      setStatus('error')
    }
    controller.onConnectionState = (state: string) => setStatus(`connection:${state}`)

    // Deliberately NOT strictSync. It closes the startup lipsync gap, but it
    // also pauses BOTH audio and animation whenever frame delivery falls behind
    // mid-clip, and it starved for ~10s partway through a real render (dead
    // time in the final file, worse than the startup lag it fixed). The default
    // (audioIndependent: animation catches up, starvation is telemetry only,
    // audio never stalls) plus the priming utterance below handles the startup
    // gap without that risk.
    controller.onPlaybackStall = (stalled: boolean) => {
      console.log(`[direct-mode] playback ${stalled ? 'paused' : 'resumed'} (frame starvation)`)
    }

    /**
     * Renders `total` frames, one at a time, and hands each PNG to the server
     * through window.__saveFrame. Frame k is shown when the (hand-driven) audio
     * time is (k + 0.5) / 25; we only advance once the frame's animation data
     * has arrived from the Motion Server, so the SDK never falls back to idle.
     */
    const runStepped = async (total: number): Promise<void> => {
      const ctl = controller as unknown as {
        getKeyframes(): unknown[]
        getKeyframesOffset(): number
        getAudioTime(): number
        getIsPlaying(): boolean
      }
      const until = async (cond: () => boolean, ms: number, what: string) => {
        const deadline = performance.now() + ms
        while (!cond()) {
          if (window.__directModeError) throw new Error(window.__directModeError)
          if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`)
          await new Promise((r) => setTimeout(r, 20))
        }
      }
      const available = () => ctl.getKeyframes().length + ctl.getKeyframesOffset()
      // Internal SDK state, for diagnosing a frame that never renders.
      const internals = () => {
        const v = view as unknown as { lastRenderedFrameIndex?: number; transitionFrames?: unknown[]; isConversationActive?: boolean }
        const c = controller as unknown as { isFallbackMode?: boolean; isPlaying?: boolean }
        return JSON.stringify({
          audioTime: Number(ctl.getAudioTime().toFixed(4)),
          lastRendered: v.lastRenderedFrameIndex,
          transitionFrames: v.transitionFrames?.length,
          conversationActive: v.isConversationActive,
          fallback: c.isFallbackMode,
          playing: c.isPlaying,
          keyframes: ctl.getKeyframes().length,
          offset: ctl.getKeyframesOffset(),
        })
      }

      const sdkView = view as unknown as { lastRenderedFrameIndex?: number; transitionFrames?: unknown[] }

      await until(() => ctl.getIsPlaying() && available() > 0, 60_000, 'the first animation frames')
      let previous: string | null = null
      for (let k = 0; k < total; k++) {
        await until(() => available() > k, 120_000, `animation frame ${k}`)

        // The SDK's own loop keeps ticking between our steps and would draw
        // frames nobody captures (it renders its queued start-transition
        // frames on every tick, regardless of the clock). So rendering stays
        // paused, and exactly one render is allowed per step.
        //
        // At the start of speech the SDK queues a few transition frames, draws
        // them first, and treats those frame numbers as already shown. If that
        // covers this step and nothing is queued, no render will happen for
        // it, so repeat the previous image rather than wait for a frame that
        // is not coming.
        const transitionPending = (sdkView.transitionFrames?.length ?? 0) > 0
        const covered = typeof sdkView.lastRenderedFrameIndex === 'number' && sdkView.lastRenderedFrameIndex >= k
        clock.t += (k + 0.5) / SDK_FPS - ctl.getAudioTime()

        let png: string
        if (covered && !transitionPending && previous) {
          png = previous
        } else {
          const pending = view.exportBitmap() // armed first: resolves with the next frame drawn
          view.resumeRendering()
          const blob = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), 60_000))])
          view.pauseRendering()
          if (!blob) throw new Error(`frame ${k} was not rendered: ${internals()}`)
          png = await blobToBase64(blob)
          previous = png
        }
        if (k < 8) console.log(`[direct-mode] stepped frame ${k}: ${internals()}`)
        await window.__saveFrame!(k, png)
        window.__directModeStepped = { frame: k + 1, total }
      }
      view.resumeRendering()
      window.__directModeDone = true
    }

    // initializeAudioContext() must run inside a real user-interaction handler
    // per Spatius's docs; the server dispatches a genuine Playwright click on
    // #start-btn, which triggers this listener.
    document.getElementById('start-btn')!.addEventListener('click', async () => {
      try {
        await controller.initializeAudioContext()
        await controller.start()

        if (STEPPED) {
          // No priming and no recording here: frames are rendered on demand,
          // so the SDK's own render loop stays paused until a step asks for one.
          view.pauseRendering()
          window.__directModeSend = (b64: string, end: boolean) => {
            controller.send(base64ToBytes(b64).buffer as ArrayBuffer, end)
          }
          window.__directModeRunStepped = (total: number) => {
            void runStepped(total).catch((err) => {
              window.__directModeError = err instanceof Error ? err.message : String(err)
              setStatus('error')
            })
          }
          setStatus('ready')
          window.__directModeReady = true
          return
        }
        setStatus('priming')

        // A one-time per-connection cold-start cost (WebSocket handshake plus
        // the first motion round warming up on the driving service) lands on
        // whatever audio is first, as audio playing with no lip motion for the
        // first seconds. Sending a short, near-silent "priming" utterance first
        // absorbs that cost on throwaway content; recording (and the real audio)
        // only start afterwards, once the pipeline is warm.
        const PRIME_SEC = 1.5
        const primeSamples = Math.floor(sampleRate * PRIME_SEC)
        const primeBuf = new Int16Array(primeSamples)
        for (let i = 0; i < primeSamples; i++) primeBuf[i] = i % 2 === 0 ? 200 : -200
        controller.send(primeBuf.buffer, true)
        await new Promise((r) => window.setTimeout(r, 3000))
        setStatus('ready')

        window.__directModeSend = (base64Pcm: string, end: boolean) => {
          const binary = atob(base64Pcm)
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
          controller.send(bytes.buffer, end)
        }
        window.__directModeStop = (tailMs = 2000) => {
          controller.close()
          window.setTimeout(() => recorder.stop(), tailMs)
        }

        // --- Capture (started only after priming, so the clip never shows the
        // cold-start gap).
        //
        // Why not canvas.captureStream() straight off the avatar canvas: the
        // SDK canvas has a transparent background and video formats have no
        // alpha channel, so it records as black. Painting a solid color behind
        // it needs a 2D compositing step, and drawImage()'ing the SDK canvas
        // from our own timer comes back blank: the SDK renders through WebGPU,
        // whose canvas texture is invalidated as soon as each frame is
        // presented, with no WebGPU equivalent of WebGL's preserveDrawingBuffer.
        //
        // What works: view.exportBitmap(), the SDK's own capture method. It
        // calls canvas.toBlob() synchronously inside the render loop right
        // after renderFrame(), i.e. at the one moment the pixels are valid.
        // Each PNG is composited onto an opaque canvas filled with `bgColor`,
        // and that canvas is what gets recorded (manual-mode captureStream plus
        // requestFrame(): automatic mode silently stops delivering frames
        // under headless throttling).
        const canvas = stage.querySelector('canvas')!
        const bgColor = params.get('bgColor') || '#ffffff'

        const composite = document.createElement('canvas')
        composite.width = canvas.width
        composite.height = canvas.height
        const compositeCtx = composite.getContext('2d')!
        const track = composite.captureStream(0).getVideoTracks()[0] as MediaStreamTrack & {
          requestFrame?: () => void
        }

        // Counters the server reads after the recording to tell a healthy
        // render from one whose avatar never drew (the video would still
        // encode fine, as an empty background). A real avatar frame is a large
        // PNG; a blank one is tiny.
        const stats = { exportCalls: 0, nullBlobs: 0, frames: 0, maxBlobBytes: 0, backend: null as string | null }
        window.__directModeStats = stats
        let pendingSince = Date.now()
        const statsTimer = window.setInterval(() => {
          stats.backend = (AvatarSDK as unknown as { getRendererBackend?: () => string | null }).getRendererBackend?.() ?? null
          console.log(`[direct-mode] capture stats ${JSON.stringify({ ...stats, pendingMs: Date.now() - pendingSince })}`)
        }, 5000)

        let capturing = true
        ;(async () => {
          while (capturing) {
            stats.exportCalls++
            pendingSince = Date.now()
            const blob = await view.exportBitmap()
            if (!blob) {
              stats.nullBlobs++
              await new Promise((r) => window.setTimeout(r, 1000 / fps))
              continue
            }
            stats.frames++
            stats.maxBlobBytes = Math.max(stats.maxBlobBytes, blob.size)
            const bitmap = await createImageBitmap(blob)
            compositeCtx.fillStyle = bgColor
            compositeCtx.fillRect(0, 0, composite.width, composite.height)
            compositeCtx.drawImage(bitmap, 0, 0, composite.width, composite.height)
            bitmap.close()
            track.requestFrame?.()
          }
        })()

        // Real captured SDK audio, not the source file (see audioTap above).
        // Falls back to silent video rather than reintroducing the mux-offset
        // bug if the tap somehow never fired.
        const combinedTracks: MediaStreamTrack[] = [track]
        if (audioTap.destination) combinedTracks.push(...audioTap.destination.stream.getAudioTracks())
        else console.warn('[direct-mode] audio tap did not attach, recording will be silent')

        const recorder = new MediaRecorder(new MediaStream(combinedTracks), {
          mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
            ? 'video/webm;codecs=vp8,opus'
            : 'video/webm',
          videoBitsPerSecond: 8_000_000,
          audioBitsPerSecond: 192_000,
        })
        const chunks: Blob[] = []
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data)
        }
        recorder.onstop = () => {
          capturing = false
          window.clearInterval(statsTimer)
          stats.backend = (AvatarSDK as unknown as { getRendererBackend?: () => string | null }).getRendererBackend?.() ?? null
          window.__directModeVideoBlob = new Blob(chunks, { type: 'video/webm' })
          window.__directModeDone = true
          setStatus('done')
        }
        recorder.start(250)
        setStatus('recording')

        window.__directModeReady = true
      } catch (err) {
        window.__directModeError = err instanceof Error ? err.message : String(err)
        setStatus('error')
      }
    })
  } catch (err) {
    window.__directModeError = err instanceof Error ? err.message : String(err)
    setStatus('error')
  }
}

void main()
