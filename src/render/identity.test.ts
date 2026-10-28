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

describe('detached-from in the HTML renderer (RFC-0035)', () => {
  test('it changes nothing on screen', () => {
    const doc = (attr: string) => `<gui version="0.3.8">
  <components><component id="comp-heading"><col><text value="Heading" /></col></component></components>
  <col w="400"><col ${attr} fill="#B9FF66" radius="7"><text value="Search engine" /></col></col>
</gui>`
    const strip = (html: string) => html.replace(/\s*data-[a-z-]+="[^"]*"/g, '').replace(/\s*detached-from="[^"]*"/g, '')
    expect(strip(renderToHTML(doc('detached-from="comp-heading"')))).toBe(strip(renderToHTML(doc(''))))
  })
})

describe('fill and border in the HTML renderer (RFC-0022)', () => {
  const doc = (props: string, instance: string) => `<gui version="0.3.10">
  <components><component id="comp-a">
    <props>${props}</props>
    <col id="box" w="40" h="40" border="2 #000000" />
  </component></components>
  <col w="400">${instance}</col>
</gui>`

  test('a color prop bound to border-color, or its old name stroke, recolors the border', () => {
    for (const bind of ['border-color', 'stroke']) {
      const html = renderToHTML(doc(`<prop name="edge" type="color" target="box" bind="${bind}" />`, '<instance component="comp-a" edge="#FF0000" />')).toLowerCase()
      expect(html).toMatch(/#ff0000|rgb\(255, 0, 0\)/)
    }
  })

  test('border longhands override the shorthand', () => {
    const html = renderToHTML('<gui version="0.3.10"><col w="400"><col w="40" h="40" border="2 #000000" border-color="#00FF00" /></col></gui>').toLowerCase()
    expect(html).toMatch(/#00ff00|rgb\(0, 255, 0\)/)
  })

  test('a border color with spaces stays one color', () => {
    const html = renderToHTML('<gui version="0.3.10"><col w="400"><col w="40" h="40" border="1 rgba(255, 0, 0, 0.5)" /></col></gui>').toLowerCase()
    expect(html).toMatch(/rgba\(255, ?0, ?0, ?0\.5\)/)
  })
})

describe('masks in the HTML renderer (RFC-0028)', () => {
  test('mask-invert cuts the shape out', () => {
    const doc = (attr: string) => `<gui version="0.3.11"><col w="400"><group w="100" h="100" mask-src="https://example.com/m.svg" ${attr}><col w="100" h="100" fill="#FF0000" /></group></col></gui>`
    expect(renderToHTML(doc('mask-invert'))).toMatch(/mask-composite:\s*exclude|-webkit-mask-composite:\s*xor/)
    expect(renderToHTML(doc(''))).not.toMatch(/mask-composite/)
  })
})

describe('description and template in the HTML renderer (RFC-0057)', () => {
  test('neither changes what is drawn', () => {
    const plain = renderToHTML('<gui version="0.4.3"><components><component id="comp-a"><row w="10" h="10" fill="#FF0000" /></component></components><col w="40"><instance component="comp-a" /></col></gui>')
    const described = renderToHTML('<gui version="0.4.3" template><components><component id="comp-a" description="Primary action."><row w="10" h="10" fill="#FF0000" /></component></components><col w="40"><instance component="comp-a" /></col></gui>')
    expect(described).toBe(plain)
  })
})
