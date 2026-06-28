import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mountClass, cleanup } from '../helpers/frontend.js'
import { RActorTree } from '../../frontend/webkit/r-actor-tree.js'

beforeEach(cleanup)
afterEach(cleanup)

describe('r-actor-tree', () => {
  test('renders empty state when no actors', async () => {
    const el = await mountClass(RActorTree) as any
    el.actors = []
    await el.updateComplete

    expect(el.querySelector('r-empty-state')).toBeTruthy()
  })

  test('renders actor nodes', async () => {
    const el = await mountClass(RActorTree) as any
    el.actors = [
      { name: 'system/chat', status: 'running', messagesProcessed: 10 },
      { name: 'system/planner', status: 'stopped', messagesProcessed: 5 },
    ]
    await el.updateComplete

    const tree = el.querySelector('r-tree')
    expect(tree).toBeTruthy()
    expect(tree.shadowRoot.textContent).toContain('chat')
    expect(tree.shadowRoot.textContent).toContain('planner')
  })

  test('renders nested actor hierarchy', async () => {
    const el = await mountClass(RActorTree) as any
    el.actors = [
      { name: 'system/parent/child', status: 'running', messagesProcessed: 1 },
    ]
    await el.updateComplete

    const tree = el.querySelector('r-tree')
    expect(tree).toBeTruthy()
    expect(tree.shadowRoot.textContent).toContain('parent')
    expect(tree.shadowRoot.textContent).toContain('child')
  })

  test('selected actor state is trackable', async () => {
    const el = await mountClass(RActorTree) as any
    el.actors = [
      { name: 'system/chat', status: 'running', messagesProcessed: 10 },
    ]
    await el.updateComplete

    expect(el._selectedActor).toBeNull()

    el._selectedActor = 'system/chat'
    await el.updateComplete

    expect(el._selectedActor).toBe('system/chat')
  })

  test('collapse/expand toggles children visibility', async () => {
    const el = await mountClass(RActorTree) as any
    el.actors = [
      { name: 'system/parent', status: 'running', messagesProcessed: 0 },
      { name: 'system/parent/child', status: 'running', messagesProcessed: 0 },
    ]
    await el.updateComplete

    const tree = el.querySelector('r-tree')
    expect(tree.shadowRoot.querySelector('.tree-children')).toBeTruthy()

    tree.shadowRoot.querySelector('.tree-chevron')!.click()
    await el.updateComplete

    expect(tree.shadowRoot.querySelector('.tree-children')).toBeNull()
  })

  test('shows message count', async () => {
    const el = await mountClass(RActorTree) as any
    el.actors = [
      { name: 'system/worker', status: 'running', messagesProcessed: 42 },
    ]
    await el.updateComplete

    const tree = el.querySelector('r-tree')
    expect(tree.shadowRoot.textContent).toContain('42')
  })
})
