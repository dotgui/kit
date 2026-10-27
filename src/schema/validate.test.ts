import { describe, expect, test } from 'bun:test'
import { validate } from './validate'

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
