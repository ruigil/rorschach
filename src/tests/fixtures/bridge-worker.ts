// ─── Fixture worker for worker-bridge tests ───
//
// Accepts { id, payload } where payload is:
//   { op: 'echo',    value: T }              → replies with { result: T }
//   { op: 'progress', value: T, steps: n }   → emits n progress ticks, then replies
//   { op: 'fail',    error: string }          → posts error
//

type Payload =
  | { op: 'echo';     value: unknown }
  | { op: 'progress'; value: unknown; steps: number }
  | { op: 'fail';     error: string }

self.onmessage = async ({ data }: MessageEvent<{ id: string; payload: Payload }>) => {
  const { id, payload } = data
  try {
    if (payload.op === 'echo') {
      self.postMessage({ type: 'reply', id, result: payload.value })
      return
    }

    if (payload.op === 'progress') {
      for (let i = 1; i <= payload.steps; i++) {
        self.postMessage({ type: 'progress', id, pct: (i / payload.steps) * 100 })
      }
      self.postMessage({ type: 'reply', id, result: payload.value })
      return
    }

    if (payload.op === 'fail') {
      throw new Error(payload.error)
    }
  } catch (err) {
    self.postMessage({ type: 'error', id, error: String(err) })
  }
}
