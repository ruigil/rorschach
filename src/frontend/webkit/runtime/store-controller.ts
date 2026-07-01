import { type ReactiveController, type ReactiveControllerHost } from 'lit'
import { store, type NamespaceRegistry } from './store.js'

export class StoreController<
  N extends keyof NamespaceRegistry,
  K extends keyof NamespaceRegistry[N],
> implements ReactiveController {
  private _unsub?: () => void
  public value: NamespaceRegistry[N][K]

  constructor(
    private host: ReactiveControllerHost,
    private path: [N, K],
  ) {
    this.host.addController(this)
    this.value = store.namespace(path[0]).get(path[1])
  }

  hostConnected() {
    this._unsub = store.namespace(this.path[0]).subscribe(this.path[1], (val) => {
      this.value = val
      this.host.requestUpdate()
    })
  }

  hostDisconnected() {
    this._unsub?.()
  }
}
