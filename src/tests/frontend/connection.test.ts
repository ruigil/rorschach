import { describe, test, expect, beforeEach } from 'bun:test'

import { store } from '../../frontend/store.js'
import { resetStore } from '../helpers/frontend.js'
import { updateActiveStream, commitActiveStream, setMode, addLog } from '../../frontend/actions.js'

beforeEach(() => {
  resetStore()
})

describe('connection frame handlers (via actions)', () => {
  test('chunk appends text to active stream', () => {
    updateActiveStream({ isActive: true, text: '' })
    updateActiveStream({ text: store.get('activeStream').text + 'hello' })
    updateActiveStream({ text: store.get('activeStream').text + ' world' })
    expect(store.get('activeStream').text).toBe('hello world')
  })

  test('reasoningChunk appends to reasoning', () => {
    updateActiveStream({ isActive: true, reasoning: '' })
    updateActiveStream({ reasoning: store.get('activeStream').reasoning + 'step1' })
    updateActiveStream({ reasoning: store.get('activeStream').reasoning + ' step2' })
    expect(store.get('activeStream').reasoning).toBe('step1 step2')
  })

  test('done commits active stream as assistant message', () => {
    updateActiveStream({ isActive: true, text: 'final answer' })
    commitActiveStream()
    const msgs = store.get('messages')
    expect(msgs.length).toBe(1)
    expect(msgs[0]!.role).toBe('assistant')
    expect(msgs[0]!.text).toBe('final answer')
    expect(store.get('activeStream').isActive).toBe(false)
  })

  test('error commits as error role', () => {
    updateActiveStream({ isActive: true, text: 'partial' })
    commitActiveStream('error', 'connection lost')
    const msgs = store.get('messages')
    expect(msgs[0]!.role).toBe('error')
    expect(msgs[0]!.text).toBe('connection lost')
  })

  test('modeChanged updates currentMode', () => {
    setMode('planner', 'Planner')
    expect(store.get('currentMode')).toBe('planner')
    expect(store.get('currentModeDisplayName')).toBe('Planner')
  })

  test('log prepends to logs array', () => {
    addLog({ message: 'a' })
    addLog({ message: 'b' })
    expect(store.get('logs')[0]!.message).toBe('b')
    expect(store.get('logs')[1]!.message).toBe('a')
  })

  test('metrics sets actors and topics', () => {
    store.set('actors', [{ name: 'a', status: 'running', messagesProcessed: 1 }])
    store.set('topics', [{ topic: 't1', subscribers: ['s1'] }])
    expect(store.get('actors')).toHaveLength(1)
    expect(store.get('topics')).toHaveLength(1)
  })

  test('tool_registered adds to tools map', () => {
    store.set('tools', {})
    store.set('tools', { ...store.get('tools'), ['web_search']: { type: 'function' } })
    expect(store.get('tools')).toHaveProperty('web_search')
  })

  test('tool_unregistered removes from tools map', () => {
    store.set('tools', { web_search: {}, fetch_page: {} })
    const next = { ...store.get('tools') }
    delete next['web_search']
    store.set('tools', next)
    expect(store.get('tools')).not.toHaveProperty('web_search')
    expect(store.get('tools')).toHaveProperty('fetch_page')
  })

  test('sources are added to active stream', () => {
    updateActiveStream({ sources: [{ url: 'http://x.com', title: 'X' }] })
    expect(store.get('activeStream').sources).toHaveLength(1)
    expect(store.get('activeStream').sources[0]!.title).toBe('X')
  })

  test('attachments are added to active stream', () => {
    updateActiveStream({ attachments: [{ kind: 'image', data: 'data:img' }] })
    expect(store.get('activeStream').attachments).toHaveLength(1)
    expect(store.get('activeStream').attachments[0]!.kind).toBe('image')
  })
})
