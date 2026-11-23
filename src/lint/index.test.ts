import { describe, expect, test } from 'bun:test'
import { lintMarkup } from './index'

const doc = (body: string, head = '') =>
  `<gui version="0.4.4" name="T">${head}<col w="390" fill="#FAFAFA" p="24" gap="16">${body}</col></gui>`

const messages = (xml: string, options = {}) => lintMarkup(xml, options).issues.map((issue) => `${issue.level}: ${issue.message}`)

describe('lint reads spec 0.4.4', () => {
  test('a component with slots, filled by an instance, is clean', () => {
    const xml = `<gui version="0.4.4" name="T">
      <components>
        <component id="comp-card" name="Card">
          <col w="fill" p="16" gap="8" fill="#FFFFFF" radius="12">
            <col slot="body" w="fill" gap="8" />
          </col>
        </component>
      </components>
      <col w="390" fill="#FAFAFA" p="24">
        <instance component="comp-card">
          <slot name="body"><text value="Hi" fill="#111111" /></slot>
        </instance>
      </col>
    </gui>`
    expect(lintMarkup(xml).errors).toEqual([])
  })

  test('an empty container without slot is still a spacer', () => {
    expect(messages(doc('<col h="16" />'))).toContainEqual(expect.stringContaining('empty spacer'))
  })

  test('rgba() and oklch() are colors; keywords are not; rgb() warns', () => {
    expect(lintMarkup(doc('<rect w="10" h="10" fill="rgba(0, 0, 0, 0.5)" /><rect w="10" h="10" fill="oklch(0.6 0.2 250 / 0.5)" />')).errors).toEqual([])
    expect(messages(doc('<rect w="10" h="10" fill="red" />'))).toContainEqual(expect.stringContaining('error: <rect> fill="red" is a CSS color keyword'))
    expect(messages(doc('<rect w="10" h="10" fill="rgb(0, 0, 0)" />'))).toContainEqual(expect.stringContaining('warn: <rect> fill="rgb(0, 0, 0)" uses rgb()'))
    expect(messages(doc('<rect w="10" h="10" fill="rgba(0, 0)" />'))).toContainEqual(expect.stringContaining('not a well-formed rgba() color'))
  })

  test('color on text is obsolete; fill is the color', () => {
    expect(messages(doc('<text value="Hi" color="#111111" />'))).toContainEqual(expect.stringContaining('warn: <text "Hi"> uses color='))
    expect(messages(doc('<text value="Hi" fill="#111111" />'))).toEqual([])
  })

  test('tokens from a <library> block or the package library count as declared', () => {
    const block = '<library name="ds" uid="u-1" release="1.0.0"><tokens><color name="ink" value="#111111" /></tokens></library>'
    expect(lintMarkup(doc('<text value="Hi" fill="$ink" />', block)).errors).toEqual([])
    const screen = doc('<text value="Hi" fill="$brand" />')
    expect(messages(screen)).toContainEqual(expect.stringContaining('$brand is referenced but not declared'))
    const library = '<gui version="0.4.4"><tokens><color name="brand" value="#3B5BFD" /></tokens></gui>'
    expect(lintMarkup(screen, { library }).errors).toEqual([])
  })

  test('a string prop on an <img> points at type="image"', () => {
    const xml = `<gui version="0.4.4" name="T"><components><component id="comp-a" name="A">
      <props><prop name="pic" type="string" target="pic" /></props>
      <col><img id="pic" src="https://example.org/a.png" w="10" h="10" /></col>
    </component></components><col w="390" fill="#FAFAFA"><instance component="comp-a" /></col></gui>`
    expect(messages(xml)).toContainEqual(expect.stringContaining('Use type="image"'))
  })
})
