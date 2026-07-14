// Coding plugin UI module.
//
// Defines the r-doc-workspace custom element and exports a reduceFrame
// that handles docWorkspace frames. The docs view is artifact-driven,
// not mode-driven — it opens when a docWorkspace frame arrives, not when
// coding mode activates. The reducer calls host.openView('docs') on
// each frame.

import { RCodeWorkspace } from './r-code-workspace.js'
import { store, type PluginHostActions } from '@rorschach/webkit';

export { RCodeWorkspace }

export type CodeState = {
  currentDocArtifact: string | null
  cwd: string
  lastBashResponse: {
    cmdId: string
    stdout?: string
    stderr?: string
    exitCode: number
    error?: string
    cwd?: string
  } | null
  lastAutocompleteResponse: {
    cmdId: string
    files: string[]
  } | null
};

store.namespace<CodeState>('code').init(
  { currentDocArtifact: null, cwd: '/rorschach', lastBashResponse: null, lastAutocompleteResponse: null },
  { persist: ['currentDocArtifact', 'cwd'] },
)

export const reduceFrame = (frame: any, host: PluginHostActions) => {
  if (frame.type === 'code.workspace') {
    store.namespace<CodeState>('code').set('currentDocArtifact', frame.artifactName)
    host.openView('code')
  } else if (frame.type === 'coding.bash.response') {
    if (frame.cwd) {
      store.namespace<CodeState>('code').set('cwd', frame.cwd)
    }
    store.namespace<CodeState>('code').set('lastBashResponse', {
      cmdId: frame.cmdId,
      stdout: frame.stdout,
      stderr: frame.stderr,
      exitCode: frame.exitCode,
      error: frame.error,
      cwd: frame.cwd,
    })
  } else if (frame.type === 'coding.bash.autocomplete.response') {
    store.namespace<CodeState>('code').set('lastAutocompleteResponse', {
      cmdId: frame.cmdId,
      files: frame.files,
    })
  }
}

declare module '@rorschach/webkit/runtime/store.js' {
  interface NamespaceRegistry {
    code: CodeState
  }
}
