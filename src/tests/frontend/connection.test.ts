import type { ShellState } from '../../frontend/shell/types.js'
import { describe, test, expect, beforeEach } from 'bun:test'

import { store } from '../../frontend/webkit/runtime/store.js'
import { resetStore } from '../helpers/frontend.js'
import { setMode } from '../../frontend/shell/view-actions.js'
import { updateActiveStream, commitActiveStream } from '../../frontend/shell/actions.js'
import { reduceFrame, type ObservabilityState } from '../../plugins/observability/ui/index.js'

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
    reduceFrame({ type: 'observability.log.entry', message: 'a' })
    reduceFrame({ type: 'observability.log.entry', message: 'b' })
    expect(store.namespace<ObservabilityState>('observe').get('logs')[0]!.message).toBe('b')
    expect(store.namespace<ObservabilityState>('observe').get('logs')[1]!.message).toBe('a')
  })

  test('metrics sets actors and topics', () => {
    reduceFrame({ type: 'observability.metrics.updated', actors: [{ name: 'a', status: 'running', messagesProcessed: 1 }] })
    reduceFrame({ type: 'observability.metrics.updated', topics: [{ topic: 't1', subscribers: ['s1'] }] })
    expect(store.namespace<ObservabilityState>('observe').get('actors')).toHaveLength(1)
    expect(store.namespace<ObservabilityState>('observe').get('topics')).toHaveLength(1)
  })

  test('scrambler_registered adds to scramblers map', () => {
    const descriptor = { urn: 'scr:leaf:tools.web_search', kind: 'leaf', description: 'Search the web', schema: {} }
    reduceFrame({ type: 'scramblers.registered', descriptor })
    expect(store.namespace<ObservabilityState>('observe').get('scramblers')['scr:leaf:tools.web_search']).toBeDefined()
  })

  test('scrambler_unregistered removes from scramblers map', () => {
    const desc1 = { urn: 'scr:leaf:tools.web_search', kind: 'leaf', description: '', schema: {} }
    const desc2 = { urn: 'scr:leaf:tools.fetch_page', kind: 'leaf', description: '', schema: {} }
    reduceFrame({ type: 'scramblers.registered', descriptor: desc1 })
    reduceFrame({ type: 'scramblers.registered', descriptor: desc2 })
    reduceFrame({ type: 'scramblers.unregistered', urn: 'scr:leaf:tools.web_search' })
    expect(store.namespace<ObservabilityState>('observe').get('scramblers')['scr:leaf:tools.web_search']).toBeUndefined()
    expect(store.namespace<ObservabilityState>('observe').get('scramblers')['scr:leaf:tools.fetch_page']).toBeDefined()
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
