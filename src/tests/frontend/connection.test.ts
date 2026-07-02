import type { ShellState } from '../../frontend/types/state.js'
import { describe, test, expect, beforeEach } from 'bun:test'

import { store } from '../../frontend/webkit/store.js'
import { resetStore } from '../helpers/frontend.js'
import { setMode } from '../../frontend/shell/view-actions.js'
import { updateActiveStream, commitActiveStream, addLog } from '../../frontend/shell/actions.js'

beforeEach(() => {
  resetStore()
})

describe('connection frame handlers (via actions)', () => {
  test('chunk appends text to active stream', () => {
    updateActiveStream({ isActive: true, text: '' })
    updateActiveStream({ text: store.namespace<ShellState>('shell').get('activeStream').text + 'hello' })
    updateActiveStream({ text: store.namespace<ShellState>('shell').get('activeStream').text + ' world' })
    expect(store.namespace<ShellState>('shell').get('activeStream').text).toBe('hello world')
  })

  test('reasoningChunk appends to reasoning', () => {
    updateActiveStream({ isActive: true, reasoning: '' })
    updateActiveStream({ reasoning: store.namespace<ShellState>('shell').get('activeStream').reasoning + 'step1' })
    updateActiveStream({ reasoning: store.namespace<ShellState>('shell').get('activeStream').reasoning + ' step2' })
    expect(store.namespace<ShellState>('shell').get('activeStream').reasoning).toBe('step1 step2')
  })

  test('done commits active stream as assistant message', () => {
    updateActiveStream({ isActive: true, text: 'final answer' })
    commitActiveStream()
    const msgs = store.namespace<ShellState>('shell').get('messages')
    expect(msgs.length).toBe(1)
    expect(msgs[0]!.role).toBe('assistant')
    expect(msgs[0]!.text).toBe('final answer')
    expect(store.namespace<ShellState>('shell').get('activeStream').isActive).toBe(false)
  })

  test('error commits as error role', () => {
    updateActiveStream({ isActive: true, text: 'partial' })
    commitActiveStream('error', 'connection lost')
    const msgs = store.namespace<ShellState>('shell').get('messages')
    expect(msgs[0]!.role).toBe('error')
    expect(msgs[0]!.text).toBe('connection lost')
  })

  test('modeChanged updates currentMode', () => {
    setMode('planner', 'Planner')
    expect(store.namespace<ShellState>('shell').get('currentMode')).toBe('planner')
    expect(store.namespace<ShellState>('shell').get('currentModeDisplayName')).toBe('Planner')
  })

  test('log prepends to logs array', () => {
    addLog({ message: 'a' })
    addLog({ message: 'b' })
    expect(store.namespace<ShellState>('shell').get('logs')[0]!.message).toBe('b')
    expect(store.namespace<ShellState>('shell').get('logs')[1]!.message).toBe('a')
  })

  test('metrics sets actors and topics', () => {
    store.namespace<ShellState>('shell').set('actors', [{ name: 'a', status: 'running', messagesProcessed: 1 }])
    store.namespace<ShellState>('shell').set('topics', [{ topic: 't1', subscribers: ['s1'] }])
    expect(store.namespace<ShellState>('shell').get('actors')).toHaveLength(1)
    expect(store.namespace<ShellState>('shell').get('topics')).toHaveLength(1)
  })

  test('tool_registered adds to tools map', () => {
    store.namespace<ShellState>('shell').set('tools', {})
    const schema = { type: 'function' as const, function: { name: 'web_search', description: 'Search the web', parameters: {} } }
    store.namespace<ShellState>('shell').set('tools', { ...store.namespace<ShellState>('shell').get('tools'), ['web_search']: schema })
    expect(store.namespace<ShellState>('shell').get('tools')).toHaveProperty('web_search')
  })

  test('tool_unregistered removes from tools map', () => {
    const schema1 = { type: 'function' as const, function: { name: 'web_search', description: '', parameters: {} } }
    const schema2 = { type: 'function' as const, function: { name: 'fetch_page', description: '', parameters: {} } }
    store.namespace<ShellState>('shell').set('tools', { web_search: schema1, fetch_page: schema2 })
    const next = { ...store.namespace<ShellState>('shell').get('tools') }
    delete next['web_search']
    store.namespace<ShellState>('shell').set('tools', next)
    expect(store.namespace<ShellState>('shell').get('tools')).not.toHaveProperty('web_search')
    expect(store.namespace<ShellState>('shell').get('tools')).toHaveProperty('fetch_page')
  })

  test('sources are added to active stream', () => {
    updateActiveStream({ sources: [{ url: 'http://x.com', title: 'X' }] })
    expect(store.namespace<ShellState>('shell').get('activeStream').sources).toHaveLength(1)
    expect(store.namespace<ShellState>('shell').get('activeStream').sources[0]!.title).toBe('X')
  })

  test('attachments are added to active stream', () => {
    updateActiveStream({ attachments: [{ kind: 'image', data: 'data:img' }] })
    expect(store.namespace<ShellState>('shell').get('activeStream').attachments).toHaveLength(1)
    expect(store.namespace<ShellState>('shell').get('activeStream').attachments[0]!.kind).toBe('image')
  })
})
