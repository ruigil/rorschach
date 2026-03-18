// ─── Compute worker for parallel-example.ts ──────────────────────────────────
//
// Receives { id, payload: { steps, multiplier } }, simulates a multi-step
// computation with progress reporting, and posts back the final result.
//
// Worker script contract:
//   self.postMessage({ type: 'progress', id, pct, note? })   — optional, zero or more
//   self.postMessage({ type: 'reply',    id, result })        — terminal success
//   self.postMessage({ type: 'error',    id, error })         — terminal failure

type Payload = { steps: number; multiplier: number }

self.onmessage = async ({ data }: MessageEvent<{ id: string; payload: Payload }>) => {
  const { id, payload: { steps, multiplier } } = data
  try {
    let acc = 0
    for (let i = 1; i <= steps; i++) {
      await Bun.sleep(80) // simulate work per step
      acc += i * multiplier
      self.postMessage({
        type: 'progress',
        id,
        pct: Math.round((i / steps) * 100),
        note: `step ${i}/${steps}`,
      })
    }
    self.postMessage({ type: 'reply', id, result: acc })
  } catch (err) {
    self.postMessage({ type: 'error', id, error: String(err) })
  }
}
