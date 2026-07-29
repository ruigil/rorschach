import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mountClass, cleanup, mockStore } from '../helpers/frontend.js'
import { RConfigPanel } from '../../plugins/config/ui/r-config-panel.js'

beforeEach(cleanup)
afterEach(cleanup)

const mockSchema = [
  {
    id: 'cognitive.chatbot',
    title: 'Cognitive Chatbot',
    subtitle: 'llm chatbot configuration',
    tab: 'cognitive',
    configKey: 'chatbot',
    schema: {
      type: 'object',
      properties: {
        model: { type: 'string', default: 'nvidia-nemotron' },
        systemPrompt: { type: 'string', default: 'You mirror user tone.' },
      },
    },
  },
]

const mockValues = {
  chatbot: {
    model: 'nvidia-nemotron-3-ultra',
    systemPrompt: 'Reflect tone accurately.',
  },
}

const mockPlugins = [
  {
    id: 'config',
    version: '1.0.0',
    status: 'active',
    modulePath: './src/plugins/config/config.plugin.ts',
    health: { status: 'ok' },
  },
  {
    id: 'cognitive',
    version: '1.0.0',
    status: 'active',
    modulePath: './src/plugins/cognitive/cognitive.plugin.ts',
    health: { status: 'ok' },
  },
]

describe('r-config-panel', () => {
  test('renders navigation tree and handles plugin and section switching', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const urlStr = url.toString()
      if (urlStr.includes('config/schema')) {
        return new Response(JSON.stringify(mockSchema), { headers: { 'Content-Type': 'application/json' } })
      }
      if (urlStr.includes('config/plugins') || urlStr.includes('/plugins')) {
        return new Response(JSON.stringify(mockPlugins), { headers: { 'Content-Type': 'application/json' } })
      }
      if (urlStr.includes('config/values/cognitive') || urlStr.includes('config/cognitive')) {
        return new Response(JSON.stringify(mockValues), { headers: { 'Content-Type': 'application/json' } })
      }
      if (urlStr.includes('models')) {
        return new Response(JSON.stringify(['nvidia-nemotron-3-ultra|Nemotron']), { headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch

    mockStore('currentUserId', 'anonymous')
    mockStore('currentUserRoles', ['admin'])

    const el = (await mountClass(RConfigPanel)) as any
    await el.updateComplete

    await new Promise(r => setTimeout(r, 50))
    await el.updateComplete

    const root = el.shadowRoot || el

    // Check panel container and toolbar exist
    const panel = root.querySelector('r-panel')
    expect(panel).toBeTruthy()

    // Check tree component is mounted
    const tree = root.querySelector('r-tree') as any
    expect(tree).toBeTruthy()
    expect(tree.data.length).toBe(3) // Actions, Loaded Plugins, Parameters

    // Check initial state defaults to load-plugin view
    const loadTitle = root.querySelector('.add-form-title')
    expect(loadTitle).toBeTruthy()
    expect(loadTitle.textContent).toContain('Load Runtime Plugin')

    // 1. Simulate selecting a configuration section node in the sidebar tree
    tree.dispatchEvent(new CustomEvent('node-select', {
      detail: { node: { id: 'sec-cognitive.chatbot' } }
    }))
    await el.updateComplete
    expect(el.selectedNodeId).toBe('sec-cognitive.chatbot')
    expect(el.activeSectionId).toBe('cognitive.chatbot')

    // 2. Simulate editing a field value
    el.dispatchEvent(new CustomEvent('config-field-change', {
      detail: {
        sectionId: 'cognitive.chatbot',
        configKey: 'chatbot',
        key: 'model',
        value: 'nvidia-nemotron-5',
      }
    }))
    expect(el.currentValues.cognitive.chatbot.model).toBe('nvidia-nemotron-5')

    // 3. Verify that saving makes the correct PATCH request
    let patchCalled = false
    globalThis.fetch = (async (url: string | URL, init: any) => {
      const urlStr = url.toString()
      if (urlStr.includes('config/values/cognitive')) {
        expect(init.method).toBe('PATCH')
        const body = JSON.parse(init.body)
        expect(body.chatbot.model).toBe('nvidia-nemotron-5')
        patchCalled = true
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({}))
    }) as unknown as typeof fetch

    await el.save()
    expect(patchCalled).toBe(true)
  })

  test('save PATCHes only dirty fields and is disabled when clean', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const urlStr = url.toString()
      if (urlStr.includes('config/schema')) {
        return new Response(JSON.stringify(mockSchema), { headers: { 'Content-Type': 'application/json' } })
      }
      if (urlStr.includes('config/values/cognitive')) {
        return new Response(JSON.stringify(mockValues), { headers: { 'Content-Type': 'application/json' } })
      }
      if (urlStr.includes('models')) {
        return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch

    mockStore('currentUserId', 'anonymous')

    const el = (await mountClass(RConfigPanel)) as any
    await el.updateComplete
    await new Promise(r => setTimeout(r, 50))
    await el.updateComplete

    const root = el.shadowRoot || el
    const tree = root.querySelector('r-tree') as any
    tree.dispatchEvent(new CustomEvent('node-select', {
      detail: { node: { id: 'sec-cognitive.chatbot' } }
    }))
    await el.updateComplete

    // Clean state: Save/Reset disabled
    let saveBtn = root.querySelector('.btn-save') as HTMLButtonElement
    let resetBtn = root.querySelector('.btn-reset') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)
    expect(resetBtn.disabled).toBe(true)

    // Edit one field → buttons enable
    el.dispatchEvent(new CustomEvent('config-field-change', {
      detail: {
        sectionId: 'cognitive.chatbot',
        configKey: 'chatbot',
        key: 'model',
        value: 'nvidia-nemotron-5',
      }
    }))
    await el.updateComplete
    saveBtn = root.querySelector('.btn-save') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(false)

    // PATCH carries ONLY the dirty field — untouched values are not echoed
    let patchBody: any = null
    globalThis.fetch = (async (url: string | URL, init: any) => {
      const urlStr = url.toString()
      if (urlStr.includes('config/values/cognitive') && init?.method === 'PATCH') {
        patchBody = JSON.parse(init.body)
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch

    await el.save()
    expect(patchBody).toEqual({ chatbot: { model: 'nvidia-nemotron-5' } })

    // After save the panel is clean again → Save disabled
    await el.updateComplete
    saveBtn = root.querySelector('.btn-save') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)
  })
})
