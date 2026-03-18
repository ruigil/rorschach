// ─── Parse worker for parallel-example.ts (Part 1) ───────────────────────────
//
// Receives { id, payload: { input } }, uppercases the string, and posts back
// the result. Used as the worker script for the pool of worker bridges.

type Payload = { input: string }

self.onmessage = ({ data }: MessageEvent<{ id: string; payload: Payload }>) => {
  const { id, payload: { input } } = data
  try {
    self.postMessage({ type: 'reply', id, result: input.toUpperCase() })
  } catch (err) {
    self.postMessage({ type: 'error', id, error: String(err) })
  }
}
