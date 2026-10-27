import { describe, expect, test } from 'bun:test'
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import {
  unpack, pack, flatten, validateDocument, listDocuments, getDocument,
  isMultiDocument, setMarkup, setDocument, setLibrary, addAsset, info, InvalidMarkupError,
} from './index'

function zip(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {}
  for (const [name, text] of Object.entries(files)) entries[name] = strToU8(text)
  return zipSync(entries)
}

const LIBRARY = `<gui version="0.3" name="Library">
  <tokens><color name="primary" value="#007AFF" /></tokens>
  <styles><text-style name="Title" font-size="24" /></styles>
  <components><component id="comp-button"><text value="Go" /></component></components>
  <col w="900"><text text-style="Title" value="Buttons" /></col>
</gui>`

describe('single-document packages are untouched', () => {
  test('design.guix round-trips as before', () => {
    const xml = '<gui version="0.2"><col w="10" /></gui>'
    const pkg = unpack(zip({ 'design.guix': xml }))
    expect(pkg.xml).toBe(xml)
    expect(listDocuments(pkg)).toEqual(['design.guix'])
    expect(isMultiDocument(pkg)).toBe(false)
    expect(Object.keys(unzipSync(pack(pkg)))).toEqual(['design.guix'])
  })

  test('a lone document need not be called design.guix', () => {
    const pkg = unpack(zip({ 'hello.guix': '<gui version="0.2"><col w="10" /></gui>' }))
    expect(listDocuments(pkg)).toEqual(['hello.guix'])
    expect(validateDocument(pkg).valid).toBe(true)
    expect(Object.keys(unzipSync(pack(pkg)))).toEqual(['hello.guix'])
  })

  test('a package built by hand still packs as design.guix', () => {
    const files = unzipSync(pack({ xml: '<gui version="0.2"><col w="10" /></gui>', assets: {} }))
    expect(Object.keys(files)).toEqual(['design.guix'])
  })
})

describe('multi-document packages', () => {
  const bytes = zip({
    'library.guix': LIBRARY,
    '02-done.guix': '<gui version="0.3"><col w="390"><text text-style="Title" value="Done" /></col></gui>',
    '01-welcome.guix': '<gui version="0.3"><col w="390" fill="$primary"><instance component="comp-button" /></col></gui>',
    'nested/03-not-a-document.guix': '<gui version="0.3"><col w="10" /></gui>',
  })

  test('documents are in filename order, and the library is not one', () => {
    const pkg = unpack(bytes)
    expect(listDocuments(pkg)).toEqual(['01-welcome.guix', '02-done.guix'])
    expect(pkg.xml).toBe(getDocument(pkg, '01-welcome.guix')!)
    expect(pkg.library).toBe(LIBRARY)
    expect(info(pkg).documents).toEqual(['01-welcome.guix', '02-done.guix'])
    expect(info(pkg).hasLibrary).toBe(true)
  })

  test('pack keeps every document and the library', () => {
    const files = unzipSync(pack(unpack(bytes)))
    expect(Object.keys(files).sort()).toEqual(['01-welcome.guix', '02-done.guix', 'library.guix'])
    expect(strFromU8(files['library.guix'])).toBe(LIBRARY)
  })

  test('an edit to the primary document is what gets packed', () => {
    const pkg = unpack(bytes)
    const edited = '<gui version="0.3"><col w="200" fill="$primary" /></gui>'
    const files = unzipSync(pack(setMarkup(pkg, edited)))
    expect(strFromU8(files['01-welcome.guix'])).toBe(edited)
    expect(strFromU8(files['02-done.guix'])).toContain('Done')
  })

  test('a document uses what the library declares without importing it', () => {
    const pkg = unpack(bytes)
    for (const name of listDocuments(pkg)) {
      const result = validateDocument(pkg, name)
      expect(result.errors).toEqual([])
    }
    const flat = flatten(pkg, '01-welcome.guix')
    expect(flat).toContain('<color name="primary" value="#007AFF" />')
    expect(flat).toContain('<component id="comp-button">')
    expect(flat).not.toContain('w="900"') // the library's own page stays local
  })

  test('library blocks merge into the document blocks of the same tag', () => {
    const pkg = unpack(zip({
      'library.guix': LIBRARY,
      '01-a.guix': '<gui version="0.3"><tokens><color name="hero" value="#ff0000" /></tokens><col w="10" fill="$hero" /></gui>',
    }))
    const flat = flatten(pkg)
    expect(flat.match(/<tokens>/g)?.length).toBe(1)
    expect(flat).toContain('name="primary"')
    expect(flat).toContain('name="hero"')
    expect(validateDocument(pkg).valid).toBe(true)
  })

  test('redeclaring a library name is an error, not an override', () => {
    const pkg = unpack(zip({
      'library.guix': LIBRARY,
      '01-a.guix': `<gui version="0.3">
        <tokens><color name="primary" value="#ff0000" /></tokens>
        <components><component id="comp-button"><text value="x" /></component></components>
        <col w="10" />
      </gui>`,
    }))
    const messages = validateDocument(pkg).errors.map((e) => e.message).join('\n')
    expect(messages).toContain("token '$primary' is already declared by library.guix")
    expect(messages).toContain("component 'comp-button' is already declared")
  })

  test('a name that resolves nowhere is an error', () => {
    const pkg = unpack(zip({
      'library.guix': LIBRARY,
      '01-a.guix': '<gui version="0.3"><col w="10" fill="$missing"><text text-style="Nope" value="x" /></col></gui>',
    }))
    const codes = validateDocument(pkg).errors.map((e) => e.code)
    expect(codes).toContain('UNRESOLVED_TOKEN')
    expect(codes).toContain('UNRESOLVED_TEXT_STYLE')
  })

  test('every document in a multi-document package declares 0.3', () => {
    const pkg = unpack(zip({
      '01-a.guix': '<gui version="0.3"><col w="10" /></gui>',
      '02-b.guix': '<gui version="0.2"><col w="10" /></gui>',
    }))
    expect(validateDocument(pkg, '01-a.guix').valid).toBe(true)
    expect(validateDocument(pkg, '02-b.guix').errors.map((e) => e.code)).toContain('VERSION_BELOW_PACKAGE')
  })

  test('a library may be declarations only', () => {
    const pkg = unpack(zip({ 'design.guix': '<gui version="0.3"><col w="10" fill="$primary" /></gui>' }))
    const lib = '<gui version="0.3"><tokens><color name="primary" value="#000000" /></tokens></gui>'
    const next = setLibrary(pkg, lib)
    expect(validateDocument(next).valid).toBe(true)
    expect(() => setLibrary(pkg, '<gui version="0.3"><tokens><color name="x" value="nope" /></tokens></gui>')).toThrow(InvalidMarkupError)
  })

  test('setDocument refuses a document that breaks the package rules', () => {
    const pkg = unpack(bytes)
    expect(() => setDocument(pkg, '03-new.guix', '<gui version="0.2"><col w="10" /></gui>')).toThrow(InvalidMarkupError)
    const next = setDocument(pkg, '03-new.guix', '<gui version="0.3"><col w="10" fill="$primary" /></gui>')
    expect(listDocuments(next)).toEqual(['01-welcome.guix', '02-done.guix', '03-new.guix'])
  })
})

describe('standalone documents (RFC-0043)', () => {
  const local = '<gui version="0.3"><col w="10"><img src="assets/hero.webp" w="1" h="1" /></col></gui>'

  test('bare markup is read as a standalone document', () => {
    const pkg = unpack(strToU8(local))
    expect(pkg.standalone).toBe(true)
    expect(validateDocument(pkg).errors.map((e) => e.code)).toContain('LOCAL_ASSET_IN_STANDALONE')
  })

  test('the same markup in a package may use a local path', () => {
    const pkg = unpack(zip({ 'design.guix': local }))
    expect(pkg.standalone).toBeUndefined()
    expect(validateDocument(pkg).errors.map((e) => e.code)).not.toContain('LOCAL_ASSET_IN_STANDALONE')
  })

  test('adding a local asset promotes the document to a package', () => {
    const pkg = addAsset(unpack(strToU8(local)), 'hero.webp', new Uint8Array([1]))
    expect(pkg.standalone).toBeUndefined()
    expect(validateDocument(pkg).valid).toBe(true)
    expect(Object.keys(unzipSync(pack(pkg))).sort()).toEqual(['assets/hero.webp', 'design.guix'])
  })

  test('adding a second screen promotes it too', () => {
    const pkg = setDocument(unpack(strToU8('<gui version="0.3"><col w="10" /></gui>')), '02-next.guix', '<gui version="0.3"><col w="10" /></gui>')
    expect(pkg.standalone).toBeUndefined()
    expect(listDocuments(pkg)).toEqual(['02-next.guix', 'design.guix'])
  })
})
