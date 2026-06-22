import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mountClass, cleanup } from '../helpers/frontend.js'
import { RTabs } from '../../frontend/webkit/r-tabs.js'

beforeEach(cleanup)
afterEach(cleanup)

describe('r-tabs', () => {
  test('dispatches tab-change event on button click', async () => {
    const el = await mountClass(RTabs)
    el.innerHTML = '<button data-tab="config">Config</button>'

    const events: string[] = []
    el.addEventListener('tab-change', (e: any) => events.push(e.detail.tab))

    el.querySelector('button')!.click()
    expect(events).toEqual(['config'])
  })

  test('dispatches tab-change with data-subtab', async () => {
    const el = await mountClass(RTabs)
    el.innerHTML = '<button data-subtab="metrics">Metrics</button>'

    const events: string[] = []
    el.addEventListener('tab-change', (e: any) => events.push(e.detail.tab))

    el.querySelector('button')!.click()
    expect(events).toEqual(['metrics'])
  })

  test('dispatches tab-change with data-config-tab', async () => {
    const el = await mountClass(RTabs)
    el.innerHTML = '<button data-config-tab="general">General</button>'

    const events: string[] = []
    el.addEventListener('tab-change', (e: any) => events.push(e.detail.tab))

    el.querySelector('button')!.click()
    expect(events).toEqual(['general'])
  })

  test('does not dispatch event when clicking non-button', async () => {
    const el = await mountClass(RTabs)
    el.innerHTML = '<span>not a button</span>'

    let fired = false
    el.addEventListener('tab-change', () => fired = true)

    el.querySelector('span')!.click()
    expect(fired).toBe(false)
  })

  test('does not dispatch event when button has no tab data', async () => {
    const el = await mountClass(RTabs)
    el.innerHTML = '<button>no tab</button>'

    let fired = false
    el.addEventListener('tab-change', () => fired = true)

    el.querySelector('button')!.click()
    expect(fired).toBe(false)
  })
})
