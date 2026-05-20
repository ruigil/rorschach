import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:3000/',
  pretendToBeVisual: true,
})

const win = dom.window as any

const props = [
  'window', 'document', 'navigator', 'HTMLElement', 'customElements',
  'CustomEvent', 'Event', 'EventTarget', 'MutationObserver',
  'Node', 'DocumentFragment', 'ShadowRoot', 'HTMLTemplateElement',
  'CSSStyleSheet', 'requestAnimationFrame', 'cancelAnimationFrame',
  'getComputedStyle', 'matchMedia', 'ResizeObserver', 'IntersectionObserver',
  'DOMParser', 'XMLSerializer', 'Image', 'Audio',
  'Document', 'Element', 'Text', 'Comment',
  'NodeFilter', 'Range',
  'CSSStyleDeclaration',
  'SyntaxError', 'TypeError', 'Error',
  'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'InputEvent',
]

for (const prop of props) {
  if (win[prop] !== undefined) {
    (globalThis as any)[prop] = win[prop]
  }
}

if (typeof globalThis.localStorage === 'undefined') {
  (globalThis as any).localStorage = win.localStorage
}

if (typeof globalThis.crypto === 'undefined') {
  (globalThis as any).crypto = { randomUUID: () => Math.random().toString(36).slice(2) }
}

if (typeof globalThis.WebSocket === 'undefined') {
  (globalThis as any).WebSocket = class MockWebSocket {
    static OPEN = 1
    static CLOSED = 3
    readyState = MockWebSocket.OPEN
    send() {}
    close() {}
    addEventListener() {}
    removeEventListener() {}
  }
}

if (typeof globalThis.location === 'undefined') {
  (globalThis as any).location = win.location
}

;(globalThis as any).marked = {
  use: () => {},
  parse: (text: string) => text,
}
;(globalThis as any).katex = {
  renderToString: (tex: string) => `<span class="math">${tex}</span>`,
}
;(globalThis as any).hljs = {
  highlightElement: () => {},
}
