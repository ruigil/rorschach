// Coding plugin UI module.
//
// Defines the r-doc-workspace custom element and exports a reduceFrame
// that handles docWorkspace frames. The docs window is artifact-driven,
// not mode-driven — it opens when a docWorkspace frame arrives, not when
// coding mode activates. The reducer calls host.openWindow('docs') on
// each frame.

import { RDocWorkspace } from './r-doc-workspace.js'
import { store } from '@rorschach/frontend/webkit/store.js'
import type { PluginHostActions } from '@rorschach/frontend/webkit/host-types.js'

export { RDocWorkspace }

export interface DocsState {
  currentDocArtifact: string | null
}

store.namespace<DocsState>('docs').init({ currentDocArtifact: null })

export function reduceFrame(frame: any, host: PluginHostActions) {
  console.log('docs plugin received frame', frame)
  if (frame.type === 'docWorkspace') {
    console.log('docs plugin opening workspace for artifact:', frame.artifactName)
    store.namespace<DocsState>('docs').set('currentDocArtifact', frame.artifactName)
    host.openWindow('docs')
  }
}
