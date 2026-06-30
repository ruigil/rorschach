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

export type DocsState = {
  currentDocArtifact: string | null
};

store.namespace<DocsState>('docs').init(
  { currentDocArtifact: null },
  { persist: ['currentDocArtifact'] },
)

export const reduceFrame = (frame: any, host: PluginHostActions) => {
  if (frame.type === 'docWorkspace') {
    store.namespace<DocsState>('docs').set('currentDocArtifact', frame.artifactName)
    host.openView('docs')
  }
}
