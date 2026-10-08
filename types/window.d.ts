// Hooks shared between the server (src/render.ts drives them through
// page.evaluate) and the render page (web/main.ts sets them).
export {}

declare global {
  interface Window {
    __directModeReady?: boolean
    __directModeAvatarLoaded?: boolean
    __directModeError?: string
    __directModeSend?: (base64Pcm: string, end: boolean) => void
    __directModeStop?: (tailMs?: number) => void
    __directModeVideoBlob?: Blob
    __directModeDone?: boolean
    /** stepped mode: the server provides this to receive each rendered PNG frame, in order. */
    __saveFrame?: (index: number, base64Png: string) => Promise<void>
    __directModeRunStepped?: (totalFrames: number) => void
    __directModeStepped?: { frame: number; total: number }
    __benchResult?: {
      frames: number
      seconds: number
      fps: number
      medianMs: number
      p95Ms: number
      maxBlobBytes: number
      backend: string | null
    }
    __directModeStats?: {
      exportCalls: number
      nullBlobs: number
      frames: number
      maxBlobBytes: number
      backend: string | null
    }
  }
}
