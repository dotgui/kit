import { describe, expect, test } from 'bun:test'
import { validate, parseVersion, SUPPORTED_VERSION } from './validate'

const codes = (r: { errors: { code: string }[] }) => r.errors.map((e) => e.code)
const warningCodes = (r: { warnings: { code: string }[] }) => r.warnings.map((e) => e.code)

describe('asset references (RFC-0043)', () => {
  test('a data: URI is an error in 0.3 at any size, on a node or a token', () => {
    const onNode = validate('<gui version="0.3"><col w="10"><img src="data:image/png;base64,AA==" w="1" h="1" /></col></gui>')
    expect(codes(onNode)).toContain('DATA_URI')
    const inToken = validate('<gui version="0.3"><tokens><color name="hero" value="#000000" /><string name="bg" value="url(data:image/png;base64,AA==)" /></tokens><col w="10" /></gui>')
    expect(inToken.errors.concat(inToken.warnings).map((e) => e.message).join('\n')).toContain("token 'bg' holds a data: URI")
  })

  test('a document written before the rule only warns', () => {
    const r = validate('<gui version="0.2"><col w="10"><img src="data:image/png;base64,AA==" w="1" h="1" /></col></gui>')
    expect(codes(r)).not.toContain('DATA_URI')
    expect(warningCodes(r)).toContain('DATA_URI')
  })

  test('a standalone 0.3 document references assets only by absolute URL', () => {
    const local = '<gui version="0.3"><col w="10"><img src="assets/hero.webp" w="1" h="1" /></col></gui>'
    expect(codes(validate(local, { standalone: true }))).toContain('LOCAL_ASSET_IN_STANDALONE')
    // The same markup inside a package is fine: the path is the package's.
    expect(codes(validate(local))).not.toContain('LOCAL_ASSET_IN_STANDALONE')

    const remote = '<gui version="0.3"><col w="10"><img src="https://example.com/hero.webp" w="1" h="1" /><frame w="1" h="1" mask-src="https://example.com/m.svg" /></col></gui>'
    expect(codes(validate(remote, { standalone: true }))).not.toContain('LOCAL_ASSET_IN_STANDALONE')
  })

  test('a token that resolves to a local path counts as one', () => {
    const r = validate('<gui version="0.3"><tokens><string name="hero" value="assets/hero.webp" /></tokens><col w="10"><img src="$hero" w="1" h="1" /></col></gui>', { standalone: true })
    expect(codes(r)).toContain('LOCAL_ASSET_IN_STANDALONE')
  })

  test('bare 0.2 markup predates the standalone form and keeps working', () => {
    const r = validate('<gui version="0.2"><col w="10"><img src="assets/hero.webp" w="1" h="1" /></col></gui>', { standalone: true })
    expect(codes(r)).not.toContain('LOCAL_ASSET_IN_STANDALONE')
  })
})

describe('slots (RFC-0044)', () => {
  const doc = (instance: string, version = '0.3', extra = '') => `<gui version="${version}">
    <components>
      <component id="comp-tab"><row><text value="Tab" /></row></component>
      <component-set id="compset-item">
        <variant id="item-a"><row><text value="A" /></row></variant>
        <variant id="item-b"><row><text value="B" /></row></variant>
      </component-set>
      <component id="comp-screen">
        <col w="390">
          <col slot="body" gap="8" />
          <row slot="tabs" slot-accept="compset-item comp-tab" slot-min="2" slot-max="3" />
        </col>
      </component>
      ${extra}
    </components>
    <col w="390">${instance}</col>
  </gui>`

  test('a correct fill passes', () => {
    const r = validate(doc(`<instance component="comp-screen">
      <slot name="body"><text value="Anything" /><col w="10" /></slot>
      <slot name="tabs"><instance component="item-a" /><instance component="comp-tab" /></slot>
    </instance>`))
    expect(r.errors).toEqual([])
  })

  test('filling an undeclared slot, twice, or without a name is an error', () => {
    const r = validate(doc(`<instance component="comp-screen">
      <slot name="nope"><text value="x" /></slot>
      <slot name="body"><text value="x" /></slot>
      <slot name="body"><text value="y" /></slot>
      <slot><text value="z" /></slot>
    </instance>`))
    const messages = r.errors.map((e) => e.message).join('\n')
    expect(messages).toContain("fills slot 'nope', which the component does not declare")
    expect(messages).toContain("fills slot 'body' twice")
    expect(messages).toContain('has a <slot> without a name')
  })

  test('an instance holds only slots, and a slot only sits in an instance', () => {
    const r = validate(doc(`<instance component="comp-screen"><text value="bare" /></instance><slot name="body" />`))
    const codes = r.errors.map((e) => e.code)
    expect(codes).toContain('SLOT_FILL')
    expect(codes).toContain('SLOT_MISPLACED')
  })

  test('slot-accept takes instances of the named components, sets expanded', () => {
    const r = validate(doc(`<instance component="comp-screen">
      <slot name="tabs"><instance component="item-b" /><text value="loose" /><instance component="comp-screen" /></slot>
    </instance>`))
    const messages = r.errors.filter((e) => e.code === 'SLOT_ACCEPT').map((e) => e.message)
    expect(messages).toHaveLength(2)
    expect(messages.join('\n')).toContain('but was given a <text>')
    expect(messages.join('\n')).toContain("but was given an instance of 'comp-screen'")
  })

  test('slot-min and slot-max advise but do not fail', () => {
    const r = validate(doc(`<instance component="comp-screen"><slot name="tabs"><instance component="item-a" /></slot></instance>`))
    expect(r.errors).toEqual([])
    expect(r.warnings.map((w) => w.message).join('\n')).toContain('fewer than slot-min 2')
  })

  test('a slot declaration is checked where it is declared', () => {
    const extra = `<component id="comp-bad">
      <col slot="root">
        <col slot="outer"><row slot="inner" /></col>
        <text slot="label" value="x" />
        <col slot="outer" />
      </col>
    </component>`
    const messages = validate(doc('<col w="10" />', '0.3', extra)).errors.map((e) => e.message).join('\n')
    expect(messages).toContain("a slot may not be the component's root")
    expect(messages).toContain("slot 'inner' is declared inside another slot")
    expect(messages).toContain("slot 'label' is on a <text>")
    expect(messages).toContain("slot 'outer' is declared twice")
  })

  test('a component inside its own slot content is an error', () => {
    const r = validate(doc(`<instance component="comp-screen"><slot name="body"><instance component="comp-screen" /></slot></instance>`))
    expect(r.errors.map((e) => e.code)).toContain('SLOT_SELF')
  })

  test('in a 0.2 document the slot rules only warn', () => {
    const r = validate(doc(`<instance component="comp-screen"><slot name="nope"><text value="x" /></slot></instance>`, '0.2'))
    expect(r.errors.map((e) => e.code)).not.toContain('SLOT_FILL')
    expect(r.warnings.map((e) => e.code)).toContain('SLOT_FILL')
  })
})

describe('version gate (spec points)', () => {
  const at = (v: string) => validate(`<gui version="${v}"><col w="10" /></gui>`)
  const gateCodes = (v: string) => at(v).errors.map((e) => e.code).filter((c) => c === 'UNSUPPORTED_VERSION')

  test('every point up to the supported one is read, a bare chapter as its start', () => {
    for (const v of ['0.1', '0.2', '0.3', '0.3.0', '0.3.1', SUPPORTED_VERSION]) {
      expect(gateCodes(v)).toEqual([])
      expect(at(v).warnings.map((w) => w.code)).not.toContain('UNKNOWN_VERSION')
    }
  })

  test('a later point or chapter is refused by name', () => {
    const [major, minor, patch] = parseVersion(SUPPORTED_VERSION)!
    const next = `${major}.${minor}.${patch + 1}`
    const r = at(next)
    expect(r.valid).toBe(false)
    expect(r.errors.map((e) => e.message).join('\n')).toContain(`reads documents up to version ${SUPPORTED_VERSION}`)
    expect(gateCodes('0.4')).toHaveLength(1)
    // No spec has been 1.0; a file that says so is mislabelled by its producer.
    expect(gateCodes('1.0')).toHaveLength(1)
  })

  test('something that is not a version is refused', () => {
    expect(gateCodes('soon')).toHaveLength(1)
    expect(gateCodes('0.3.4.1')).toHaveLength(1)
  })
})

describe('typed props (RFC-0034)', () => {
  const comp = (props: string, version = '0.3') => validate(`<gui version="${version}">
    <components>
      <component id="comp-card">
        <props>${props}</props>
        <col w="200"><text id="label" value="x" /><text id="note" value="y" /><rect id="surface" w="10" h="10" /></col>
      </component>
    </components>
    <col w="10"><instance component="comp-card" /></col>
  </gui>`)
  const codes = (r: { errors: { code: string }[] }) => r.errors.map((e) => e.code)

  test('every data type with its bind is accepted', () => {
    const r = comp(`
      <prop name="label" type="string" target="label" />
      <prop name="align" type="string" target="label" bind="align" />
      <prop name="off" type="boolean" target="surface" />
      <prop name="bg" type="color" target="surface" />
      <prop name="ring" type="color" target="surface" bind="stroke" />
      <prop name="pic" type="image" target="surface" />
      <prop name="icon" type="component" target="surface" />
      <prop name="r" type="number" target="surface" bind="radius" />
      <prop name="ts" type="style" target="label" bind="text-style" />
      <prop name="both" type="color" target="label note" />`)
    expect(r.errors).toEqual([])
  })

  test('number and style need bind, and a style bind names a style slot', () => {
    const r = comp(`
      <prop name="r" type="number" target="surface" />
      <prop name="ts" type="style" target="label" />
      <prop name="bad" type="style" target="label" bind="radius" />`)
    expect(codes(r).filter((c) => c === 'PROP_NO_BIND')).toHaveLength(2)
    expect(codes(r)).toContain('INVALID_PROP_BIND')
  })

  test('target may be omitted only by a string prop named for one <text> id', () => {
    expect(comp('<prop name="label" type="string" />').errors).toEqual([])
    expect(codes(comp('<prop name="title" type="string" />'))).toContain('PROP_NO_TARGET')
    expect(codes(comp('<prop name="label" type="color" />'))).toContain('PROP_NO_TARGET')
  })

  test('an unknown type fails; the 0.1 names only warn', () => {
    expect(codes(comp('<prop name="x" type="enum" target="label" />'))).toContain('INVALID_PROP_TYPE')
    const legacy = comp('<prop name="label" type="text" target="label" />')
    expect(legacy.errors).toEqual([])
    expect(legacy.warnings.map((w) => w.code)).toContain('LEGACY_PROP_TYPE')
  })

  test('in a 0.2 document the prop rules only warn', () => {
    const r = comp('<prop name="r" type="number" target="surface" />', '0.2')
    expect(codes(r)).not.toContain('PROP_NO_BIND')
  })
})
