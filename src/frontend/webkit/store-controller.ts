// ─── StoreController — Lit reactive controller bound to a namespace key ───
//
// Two-element path `[namespaceId, key]`. The namespace-state type `T` is
// passed explicitly by the caller — it cannot be inferred from a bare string
// namespace id. The typechecker enforces completeness: `K` must be a key of
// `T`, and `T` is only accessible via the explicit type arg, so any leftover
// single-key use fails `bun tsc --noEmit`.
//
//   new StoreController<ShellState, 'currentMode'>(this, ['shell', 'currentMode'])
//   new StoreController<WorkflowsState, 'currentGraph'>(this, ['workflows', 'currentGraph'])

import { type ReactiveController, type ReactiveControllerHost } from 'lit'
import { store } from './store.js'

export class StoreController<
  T extends object,
  K extends keyof T,
> implements ReactiveController {
  private _unsub?: () => void
  public value: T[K]

  constructor(
    private host: ReactiveControllerHost,
    private path: [string, K],
  ) {
    this.host.addController(this)
    this.value = store.namespace<T>(path[0]).get(path[1])
  }

  hostConnected() {
    this._unsub = store.namespace<T>(this.path[0]).subscribe(this.path[1], (val) => {
      this.value = val
      this.host.requestUpdate()
    })
  }

  hostDisconnected() {
    this._unsub?.()
  }
}
