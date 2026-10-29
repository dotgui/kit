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
    expect(gateCodes(`${major}.${minor + 1}`)).toHaveLength(1)
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

describe('platform and source on <gui> (RFC-0036)', () => {
  const warnings = (xml: string) => validate(xml).warnings.map((w) => w.code)

  test('both are accepted on the root', () => {
    const r = validate('<gui version="0.3.6" name="Checkout" platform="ios" source="figma"><col w="10" /></gui>')
    expect(r.errors).toEqual([])
    expect(r.warnings.map((w) => w.code)).not.toContain('UNKNOWN_PLATFORM')
  })

  test('a platform outside the recommended list warns, never fails', () => {
    const r = validate('<gui version="0.3.6" platform="iso"><col w="10" /></gui>')
    expect(r.valid).toBe(true)
    expect(r.warnings.map((w) => w.code)).toContain('UNKNOWN_PLATFORM')
  })

  test('<meta> is obsolete from 0.3.6 and fine before it', () => {
    const meta = '<meta source="figma" source-node="1:2" exported-at="2026-01-01T00:00:00Z" />'
    expect(warnings(`<gui version="0.3.6">${meta}<col w="10" /></gui>`)).toContain('OBSOLETE_META')
    expect(warnings(`<gui version="0.3.5">${meta}<col w="10" /></gui>`)).not.toContain('OBSOLETE_META')
    expect(validate(`<gui version="0.3.6">${meta}<col w="10" /></gui>`).valid).toBe(true)
  })
})

describe('identity (RFC-0046)', () => {
  const codes = (r: ReturnType<typeof validate>) => r.errors.map((e) => e.code)
  const tabbar = (target: string, v = '0.3.7') => `<gui version="${v}">
  <components>
    <component id="comp-tab-item"><row id="tab"><text id="label" value="Tab" /></row></component>
    <component id="comp-tabbar">
      <props><prop name="first-label" type="string" target="${target}" /></props>
      <row id="bar" gap="8">
        <instance id="tab-1" component="comp-tab-item" />
        <instance id="tab-2" component="comp-tab-item" />
      </row>
    </component>
  </components>
  <col w="390"><instance component="comp-tabbar" first-label="Library" /></col>
</gui>`

  test('a path through an instance resolves', () => {
    expect(validate(tabbar('tab-1/label')).errors).toEqual([])
    expect(validate(tabbar('tab-1/label tab-2/label')).errors).toEqual([])
  })

  test('a target that does not resolve is an error from 0.3.7', () => {
    for (const target of ['missing', 'tab-1/missing', 'bar/label', 'tab-9/label']) {
      expect(codes(validate(tabbar(target)))).toContain('UNRESOLVED_TARGET')
    }
    const before = validate(tabbar('missing', '0.3.6'))
    expect(before.valid).toBe(true)
    expect(before.warnings.map((w) => w.code)).toContain('UNRESOLVED_TARGET')
  })

  test('ids are lowercase kebab-case and unique within a scope', () => {
    expect(codes(validate('<gui version="0.3.7"><col w="10" id="saveButton" /></gui>'))).toContain('INVALID_ID')
    expect(codes(validate('<gui version="0.3.7"><col w="10"><text id="title" value="a" /><text id="title" value="b" /></col></gui>'))).toContain('DUPLICATE_ID')
  })

  test('scopes are separate: the screen and each component body', () => {
    const r = validate(`<gui version="0.3.7">
  <components>
    <component id="comp-a"><row><text id="title" value="A" /></row></component>
    <component id="comp-b"><row><text id="title" value="B" /></row></component>
  </components>
  <col w="10" id="screen"><text id="title" value="Screen" /><instance id="a" component="comp-a" /></col>
</gui>`)
    expect(r.errors).toEqual([])
  })

  test('slot content belongs to the scope that wrote it', () => {
    const r = validate(`<gui version="0.3.7">
  <components><component id="comp-card"><col slot="body" /></component></components>
  <col w="10"><text id="title" value="a" /><instance component="comp-card"><slot name="body"><text id="title" value="b" /></slot></instance></col>
</gui>`)
    expect(codes(r)).toContain('DUPLICATE_ID')
  })

  test('component ids are declared once', () => {
    expect(codes(validate('<gui version="0.3.7"><components><component id="comp-a"><row /></component><component id="comp-a"><row /></component></components><col w="10" /></gui>'))).toContain('DUPLICATE_COMPONENT_ID')
  })

  test('source-id needs source on the root', () => {
    expect(validate('<gui version="0.3.7" source="figma" source-id="1:2"><col w="10" source-id="1:3" /></gui>').errors).toEqual([])
    expect(codes(validate('<gui version="0.3.7"><col w="10" source-id="1:3" /></gui>'))).toContain('SOURCE_ID_NO_SOURCE')
    // A file with no source-id needs no source.
    expect(validate('<gui version="0.3.7"><col w="10" /></gui>').errors).toEqual([])
  })
})

describe('detached-from (RFC-0035)', () => {
  const codes = (r: ReturnType<typeof validate>) => r.errors.map((e) => e.code)
  const doc = (body: string, v = '0.3.8') => `<gui version="${v}">
  <components>
    <component id="comp-heading"><col><text value="Heading" /></col></component>
    <component-set id="compset-tab-item">
      <variant id="comp-tab-item"><row><text value="Tab" /></row></variant>
      <variant id="comp-tab-item-active"><row><text value="Tab" /></row></variant>
    </component-set>
    <component id="comp-other"><row /></component>
    <component id="comp-tabbar"><col><row slot="tabs" slot-accept="compset-tab-item" /></col></component>
  </components>
  <col w="390">${body}</col>
</gui>`

  test('an origin naming a declared component or variant validates', () => {
    expect(validate(doc('<col detached-from="comp-heading"><text value="SEO" /></col>')).errors).toEqual([])
    expect(validate(doc('<row detached-from="comp-tab-item-active" />')).errors).toEqual([])
  })

  test('an origin that resolves nowhere is an error from 0.3.8', () => {
    expect(codes(validate(doc('<col detached-from="comp-missing" />')))).toContain('UNRESOLVED_DETACHED_FROM')
    // A set is not what a frame is detached from.
    expect(codes(validate(doc('<col detached-from="compset-tab-item" />')))).toContain('UNRESOLVED_DETACHED_FROM')
    const before = validate(doc('<col detached-from="comp-missing" />', '0.3.7'))
    expect(before.valid).toBe(true)
    expect(before.warnings.map((w) => w.code)).toContain('UNRESOLVED_DETACHED_FROM')
  })

  test('only layout containers carry it, and only instances carry component', () => {
    expect(codes(validate(doc('<instance component="comp-heading" detached-from="comp-heading" />')))).toContain('DETACHED_FROM_MISPLACED')
    expect(codes(validate(doc('<text value="x" detached-from="comp-heading" />')))).toContain('DETACHED_FROM_MISPLACED')
    expect(codes(validate(doc('<col component="comp-heading" />')))).toContain('COMPONENT_ON_NON_INSTANCE')
    expect(codes(validate(doc('<col component="comp-heading" />', '0.3.7')))).not.toContain('COMPONENT_ON_NON_INSTANCE')
  })

  test('slot-accept takes a container detached from an accepted component', () => {
    const fill = (child: string) => doc(`<instance component="comp-tabbar"><slot name="tabs">${child}</slot></instance>`)
    expect(validate(fill('<row detached-from="comp-tab-item-active"><text value="Hot" /></row>')).errors).toEqual([])
    expect(codes(validate(fill('<row detached-from="comp-other" />')))).toContain('SLOT_ACCEPT')
    expect(codes(validate(fill('<row />')))).toContain('SLOT_ACCEPT')
  })
})

describe('colors and dimensions (RFC-0033)', () => {
  const codes = (r: ReturnType<typeof validate>) => r.errors.map((e) => e.code)
  const warns = (r: ReturnType<typeof validate>) => r.warnings.map((w) => w.code)
  const at = (node: string, v = '0.3.9') => validate(`<gui version="${v}"><col w="390">${node}</col></gui>`)

  test('hex, rgba and oklch are valid everywhere a color goes', () => {
    for (const color of ['#FF0000', '#FF000080', 'rgba(255, 0, 0, 0.5)', 'oklch(0.6 0.2 250)', 'oklch(0.6 0.2 250 / 0.5)', 'oklch(60% 0.2 250)']) {
      expect(at(`<col w="10" h="10" fill="${color}" />`).errors).toEqual([])
    }
    expect(at('<col w="10" h="10" fill="linear-gradient(90deg, rgba(255, 255, 255, 0) 0%, oklch(0.6 0.2 250) 100%)" />').errors).toEqual([])
    const tokens = validate('<gui version="0.3.9"><tokens><color name="a" value="oklch(0.627 0.258 29.23)" /><color name="b" value="rgba(0, 0, 0, 0.4)" /></tokens><col w="10" fill="$a" /></gui>')
    expect(tokens.errors).toEqual([])
  })

  test('rgb() is drawn but warns with the hex to write', () => {
    const r = at('<col w="10" h="10" fill="linear-gradient(90deg, rgb(255,0,0) 0%, #FFFFFF 100%)" />')
    expect(r.errors).toEqual([])
    expect(r.warnings.find((w) => w.code === 'RGB_COLOR')?.message).toContain('#FF0000')
  })

  test('malformed colors are errors from 0.3.9', () => {
    for (const color of ['oklch(banana)', 'rgba(255, 0, 0)', 'rgba(300, 0, 0, 0.5)', 'oklch(1.5 0.2 250)']) {
      expect(codes(at(`<col w="10" h="10" fill="${color}" />`))).toContain('INVALID_COLOR')
    }
    expect(codes(at('<col w="10" h="10" fill="red" />'))).toContain('INVALID_FILL')
    expect(warns(at('<col w="10" h="10" fill="oklch(banana)" />', '0.3.8'))).toContain('INVALID_COLOR')
  })

  test('% is for sizes only; other units are errors from 0.3.9', () => {
    for (const node of ['<col w="50%" />', '<col max-width="80%" />', '<col w="fill" p="16 24" />']) {
      expect(at(node).errors).toEqual([])
    }
    for (const node of ['<col w="320px" />', '<col w="1.5rem" />', '<col w="100vw" />', '<col w="calc(100% - 16px)" />', '<col w="10" p="10%" />', '<col w="10" h="10" radius="50%" />']) {
      expect(codes(at(node))).toContain('INVALID_DIMENSION')
    }
    const before = at('<col w="320px" />', '0.3.8')
    expect(before.valid).toBe(true)
    expect(warns(before)).toContain('INVALID_DIMENSION')
  })
})

describe('fill and border (RFC-0022)', () => {
  const codes = (r: ReturnType<typeof validate>) => r.errors.map((e) => e.code)
  const warns = (r: ReturnType<typeof validate>) => r.warnings.map((w) => w.code)
  const at = (node: string, v = '0.3.10') => validate(`<gui version="${v}"><col w="390">${node}</col></gui>`)

  test('fill colors text and segments; color is obsolete from 0.3.10', () => {
    expect(at('<text value="a" fill="#111111" />').errors).toEqual([])
    expect(at('<text><segment value="a" fill="#111111" /></text>').errors).toEqual([])
    expect(codes(at('<text value="a" color="#111111" />'))).toContain('OBSOLETE_TEXT_COLOR')
    expect(codes(at('<text><segment value="a" color="#111111" /></text>'))).toContain('OBSOLETE_TEXT_COLOR')
    const before = at('<text value="a" color="#111111" />', '0.3.9')
    expect(before.valid).toBe(true)
    expect(warns(before)).toContain('OBSOLETE_TEXT_COLOR')
  })

  test('stroke attributes and <stroke> are obsolete; border is the outline', () => {
    expect(at('<col w="10" border="1 $line inside" />').errors.map((e) => e.code)).not.toContain('OBSOLETE_STROKE')
    expect(codes(at('<col w="10" stroke="#000000" stroke-width="2" />'))).toContain('OBSOLETE_STROKE')
    expect(codes(at('<col w="10"><appearance><stroke color="#000000" /></appearance></col>'))).toContain('OBSOLETE_STROKE')
    expect(warns(at('<col w="10" stroke="#000000" stroke-width="2" />', '0.3.9'))).toContain('OBSOLETE_STROKE')
  })

  test('<border> belongs inside <appearance>', () => {
    const inside = at('<col w="10"><appearance><border color="#000000" w="1" /></appearance></col>')
    expect(inside.errors).toEqual([])
    expect(warns(inside)).not.toContain('UNKNOWN_TAG')
    expect(codes(at('<col w="10"><border color="#000000" w="1" /></col>'))).toContain('BORDER_MISPLACED')
  })

  test('bind="stroke" is the old name for border-color', () => {
    const r = validate(`<gui version="0.3.10">
  <components><component id="comp-a">
    <props><prop name="edge" type="color" target="box" bind="stroke" /></props>
    <col id="box" w="10" border="1 #000000" />
  </component></components>
  <col w="10" />
</gui>`)
    expect(r.errors).toEqual([])
    expect(warns(r)).toContain('LEGACY_PROP_BIND')
  })
})

describe('clipping and masks (RFC-0028)', () => {
  const codes = (r: ReturnType<typeof validate>) => r.errors.map((e) => e.code)
  const warns = (r: ReturnType<typeof validate>) => r.warnings.map((w) => w.code)
  const at = (node: string, v = '0.3.11') => validate(`<gui version="${v}"><col w="390">${node}</col></gui>`)

  test('clip, the four clip-path shapes, and mask-src on containers validate', () => {
    for (const node of [
      '<frame w="96" h="96" radius="48" clip />',
      '<col w="10" clip-path="inset(10%)" />',
      '<col w="10" clip-path="circle(50% at 50% 50%)" />',
      '<col w="10" clip-path="ellipse(40% 30% at 50% 50%)" />',
      '<col w="10" clip-path="polygon(0% 0%, 100% 0%, 50% 100%)" />',
      '<group w="320" h="180" mask-src="https://example.com/blob.svg" mask-mode="luminance" mask-invert />',
    ]) {
      expect(at(node).errors).toEqual([])
    }
  })

  test('path(), url(), a bad mode, and mask attributes without mask-src are errors', () => {
    expect(codes(at(`<col w="10" clip-path="path('M0 0 L10 10')" />`))).toContain('INVALID_CLIP_PATH')
    expect(codes(at('<col w="10" clip-path="url(#m)" />'))).toContain('INVALID_CLIP_PATH')
    expect(codes(at('<group w="10" h="10" mask-src="https://example.com/m.svg" mask-mode="screen" />'))).toContain('INVALID_MASK_MODE')
    expect(codes(at('<col w="10" mask-x="4" />'))).toContain('MASK_WITHOUT_SRC')
    expect(codes(at('<text value="a" mask-src="https://example.com/m.svg" />'))).toContain('MASK_MISPLACED')
  })

  test('the mask flag and mask-composite are retired from 0.3.11', () => {
    expect(codes(at('<frame w="10" h="10"><col w="10" mask /></frame>'))).toContain('OBSOLETE_MASK')
    expect(codes(at('<group w="10" h="10" mask-src="https://example.com/m.svg" mask-composite="subtract" />'))).toContain('OBSOLETE_MASK')
    const before = at('<frame w="10" h="10"><col w="10" mask /></frame>', '0.3.10')
    expect(before.valid).toBe(true)
    expect(warns(before)).toContain('OBSOLETE_MASK')
  })
})

describe('descriptions (RFC-0057)', () => {
  const codes = (r: ReturnType<typeof validate>) => r.errors.map((e) => e.code)
  const warns = (r: ReturnType<typeof validate>) => r.warnings.map((w) => w.code)
  const d = 'description="Primary action. One per screen."'
  const full = (v = '0.4.3') => `<gui version="${v}">
  <tokens><color name="primary" value="#3B5BFD" ${d} /><number name="r" value="8" ${d} /><string name="s" value="x" ${d} /></tokens>
  <styles><text-style name="H1" font-size="32" ${d} /><fill-style name="Brand" value="#3B5BFD" ${d} /><effect-style name="E1" ${d}><effect type="drop-shadow" /></effect-style></styles>
  <components>
    <component id="comp-a" ${d}><row /></component>
    <component-set id="compset-b" ${d}><variant id="comp-b" ${d}><row /></variant></component-set>
  </components>
  <col w="390"><instance component="comp-a" description="a prop value, not the property" /></col>
</gui>`

  test('description is valid on every library item, and an instance prop named description is a prop', () => {
    const r = validate(full())
    expect(r.errors).toEqual([])
    expect(warns(r)).not.toContain('DESCRIPTION_MISPLACED')
  })

  test('anywhere else is an error from 0.4.3, a warning before', () => {
    expect(codes(validate(`<gui version="0.4.3"><col w="10" ${d} /></gui>`))).toContain('DESCRIPTION_MISPLACED')
    expect(codes(validate(`<gui version="0.4.3" ${d}><col w="10" /></gui>`))).toContain('DESCRIPTION_MISPLACED')
    const before = validate(`<gui version="0.4.2"><col w="10" ${d} /></gui>`)
    expect(before.valid).toBe(true)
    expect(warns(before)).toContain('DESCRIPTION_MISPLACED')
  })

  test('an empty description warns', () => {
    expect(warns(validate('<gui version="0.4.3"><tokens><color name="a" value="#000000" description="" /></tokens><col w="10" /></gui>'))).toContain('DESCRIPTION_EMPTY')
  })

  test('template on a document root validates', () => {
    expect(validate('<gui version="0.4.3" name="Settings — template" template><col w="10" /></gui>').errors).toEqual([])
  })
})

describe('linked libraries (RFC-0056)', () => {
  const codes = (r: ReturnType<typeof validate>) => r.errors.map((e) => e.code)
  const warns = (r: ReturnType<typeof validate>) => r.warnings.map((w) => w.code)
  const block = (inner: string, attrs = 'name="acme-ds" uid="7f3e" release="1.4.0" source="figma"') => `<library ${attrs}>${inner}</library>`
  const doc = (blocks: string, v = '0.4.4', own = '') => `<gui version="${v}">${own}${blocks}<col w="390" fill="$primary"><instance component="comp-button" /></col></gui>`
  const acme = block('<tokens><color name="primary" value="#3B5BFD" /></tokens><components><component id="comp-button" source-id="a2b9"><row fill="$primary" /></component></components>')

  test('a block resolves exactly as declarations written directly', () => {
    expect(validate(doc(acme)).errors).toEqual([])
  })

  test('the block rules', () => {
    expect(codes(validate(doc(acme, '0.4.3')))).toContain('LIBRARY_BLOCK_VERSION')
    expect(codes(validate(doc(block('<tokens />', 'name="x" release="1"'))))).toContain('LIBRARY_BLOCK_ATTR')
    expect(codes(validate(doc(acme + block('<col w="1" />', 'name="x" uid="u" release="1"'))))).toContain('LIBRARY_BLOCK_CONTENT')
    expect(codes(validate(doc(acme + block(block('<tokens />', 'name="y" uid="v" release="1"'), 'name="x" uid="u" release="1"'))))).toContain('LIBRARY_BLOCK_NESTED')
    expect(codes(validate(doc(block('<components><component id="comp-button" source-id="a2b9"><row /></component></components><tokens><color name="primary" value="#000000" /></tokens>', 'name="x" uid="u" release="1"'))))).toContain('SOURCE_ID_NO_SOURCE')
    expect(warns(validate(doc(block('<tokens><color name="primary" value="#3B5BFD" /></tokens><components><component id="comp-button"><row /></component></components>', 'name="x" uid="u" release="1" src="https://www.figma.com/file/abc"'))))).toContain('LIBRARY_SRC_SOURCE_TOOL')
  })

  test('names stay unique; identical mode axes are one axis', () => {
    expect(codes(validate(doc(acme, '0.4.4', '<tokens><color name="primary" value="#000000" /></tokens>')))).toContain('LIBRARY_BLOCK_REDECLARED')
    const theme = '<mode name="theme" values="light dark" default="light" />'
    const b2 = block(theme, 'name="base" uid="b" release="1"')
    expect(validate(doc(acme.replace('<tokens>', theme + '<tokens>') + b2)).errors).toEqual([])
    const other = block('<mode name="theme" values="light dark dim" default="light" />', 'name="base" uid="b" release="1"')
    expect(codes(validate(doc(acme.replace('<tokens>', theme + '<tokens>') + other)))).toContain('LIBRARY_BLOCK_REDECLARED')
  })
})
