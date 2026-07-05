import type { ShellState } from '../../frontend/shell/types.js'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { RView } from '../../frontend/shell/r-view.js'
import { store } from '../../frontend/webkit/runtime/store.js'
import { cleanup, mountClass } from '../helpers/frontend.js'
import { pluginHost } from '../../frontend/shell/plugin-host.js'
import '../../plugins/coding/ui/r-code-workspace.js'
import '../../plugins/workflows/ui/r-workflow-workspace.js'

const viewState = (id: string) => ({
  id,
  isOpen: true,
  params: {},
})

beforeEach(() => {
  cleanup()
  localStorage.clear()
  pluginHost.viewRegistry.set('code', {
    id: 'code', title: 'Code', icon: 'code', contentTag: 'r-code-workspace',
  })
  pluginHost.viewRegistry.set('workflows', {
    id: 'workflows', title: 'Workflows', icon: 'git-branch', contentTag: 'r-workflow-workspace',
  })
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  pluginHost.viewRegistry.clear()
})

describe('r-view', () => {
  test('renders the workflows workspace correctly', async () => {
    store.namespace<ShellState>('shell').set('views', {
      workflows: viewState('workflows'),
    })

    const el = await mountClass(RView, { viewId: 'workflows' }) as RView
    await el.updateComplete

    expect(el.querySelector('r-workflow-workspace')).toBeTruthy()
  })

  test('renders the code workspace correctly', async () => {
    store.namespace<ShellState>('shell').set('views', {
      code: viewState('code'),
    })

    const el = await mountClass(RView, { viewId: 'code' }) as RView
    await el.updateComplete

    expect(el.querySelector('r-code-workspace')).toBeTruthy()
  })
})
