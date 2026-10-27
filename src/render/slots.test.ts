import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

let renderToHTML: (code: string) => string
let window: any

beforeAll(async () => {
  // The same headless DOM setup the CLI uses.
  const { Window } = await import('happy-dom')
  window = new Window({ url: 'http://localhost', width: 1280, height: 960 })
  for (const key of ['SyntaxError', 'TypeError', 'RangeError', 'Error']) (window as any)[key] = (globalThis as any)[key]
  for (const key of Object.keys(window as any)) {
    if (/^[A-Z]/.test(key) && !(key in globalThis)) (globalThis as any)[key] = (window as any)[key]
  }
  ;(globalThis as any).document = window.document
  ;(globalThis as any).window = window
  ;(globalThis as any).DOMParser = (window as any).DOMParser
  ;(globalThis as any).requestAnimationFrame = (fn: FrameRequestCallback) => { fn(0); return 0 }
  ;({ renderToHTML } = await import('./index'))
})

afterAll(async () => {
  await window?.happyDOM.close()
})

const card = (instance: string) => `<gui version="0.3">
  <components>
    <component id="comp-card">
      <col w="200" gap="8">
        <text value="Header" />
        <col slot="body" gap="4"><text value="Fallback body" /></col>
        <row slot="actions" gap="4" fill="#123456" />
        <row slot="footer" fill="#654321"><text value="Default footer" /></row>
      </col>
    </component>
    <component id="comp-pill"><row><text value="Pill" /></row></component>
  </components>
  <col w="400">${instance}</col>
</gui>`

describe('slots in the HTML renderer (RFC-0044)', () => {
  test('a filled slot replaces its fallback, with local components expanded', () => {
    const html = renderToHTML(card(`
      <instance component="comp-card">
        <slot name="body"><text value="Inserted A" /><instance component="comp-pill" /></slot>
      </instance>`))
    expect(html).toContain('Inserted A')
    expect(html).toContain('Pill')
    expect(html).not.toContain('Fallback body')
  })

  test('an unfilled slot keeps its fallback', () => {
    const html = renderToHTML(card('<instance component="comp-card" />'))
    expect(html).toContain('Fallback body')
    expect(html).toContain('Default footer')
  })

  test('an empty slot leaves no box behind', () => {
    const html = renderToHTML(card('<instance component="comp-card" />')).toLowerCase()
    const shows = (hex: string, rgb: string) => html.includes(hex) || html.includes(rgb)
    expect(shows('#654321', 'rgb(101, 67, 33)')).toBe(true) // the filled footer is drawn…
    expect(shows('#123456', 'rgb(18, 52, 86)')).toBe(false) // …the empty actions row is not
  })
})

describe('typed props in the HTML renderer (RFC-0034)', () => {
  const doc = (props: string, instance: string) => `<gui version="0.3">
    <components>
      <component id="comp-chip">
        <props>${props}</props>
        <row><text id="label" value="Default label" /></row>
      </component>
    </components>
    <col w="200">${instance}</col>
  </gui>`

  test('a string prop named for one <text> id needs no target', () => {
    const html = renderToHTML(doc('<prop name="label" type="string" />', '<instance component="comp-chip" label="Implicit works" />'))
    expect(html).toContain('Implicit works')
    expect(html).not.toContain('Default label')
  })

  test('without a matching id, a target-less prop changes nothing', () => {
    const html = renderToHTML(doc('<prop name="title" type="string" />', '<instance component="comp-chip" title="Nowhere" />'))
    expect(html).toContain('Default label')
  })
})
