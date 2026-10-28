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

const tabbar = (props: string, instance: string) => `<gui version="0.3.7">
  <components>
    <component id="comp-tab-item">
      <props><prop name="tint" type="color" target="dot" /></props>
      <row id="tab" gap="4"><rect id="dot" w="8" h="8" fill="#000000" /><text id="label" value="Tab" /></row>
    </component>
    <component id="comp-tabbar">
      <props>${props}</props>
      <row id="bar" gap="8">
        <instance id="tab-1" component="comp-tab-item" />
        <instance id="tab-2" component="comp-tab-item" tint="#00FF00" />
      </row>
    </component>
  </components>
  <col w="400">${instance}</col>
</gui>`

describe('prop targets through instances (RFC-0046)', () => {
  test('a path sets a node inside a nested instance', () => {
    const html = renderToHTML(tabbar(
      '<prop name="first-label" type="string" target="tab-1/label" /><prop name="second-label" type="string" target="tab-2/label" />',
      '<instance component="comp-tabbar" first-label="Library" second-label="Settings" />',
    ))
    expect(html).toContain('Library')
    expect(html).toContain('Settings')
    expect(html).not.toContain('>Tab<')
  })

  test('a value handed down a path wins over the nested instance\'s own', () => {
    const html = renderToHTML(tabbar(
      '<prop name="second-tint" type="color" target="tab-2/dot" />',
      '<instance component="comp-tabbar" second-tint="#FF0000" />',
    )).toLowerCase()
    expect(html).toMatch(/#ff0000|rgb\(255, 0, 0\)/)
    expect(html).not.toMatch(/#00ff00|rgb\(0, 255, 0\)/)
  })

  test('an instance\'s id and source-id are not treated as overrides', () => {
    const html = renderToHTML(tabbar('', '<instance id="nav" source-id="1:2" component="comp-tabbar" />'))
    expect(html).toContain('>Tab<')
  })
})
