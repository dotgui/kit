/**
 * gen-spec.ts — generates dotgui-core's spec.json from its canonical source.
 *
 * The SOURCE lives in core (`../core/schema/types.ts` + `spec.content.ts`); core
 * stays dependency-free. This generator lives in the kit because parsing the
 * types needs the TypeScript compiler, which the kit already depends on. It
 * reads core's source and writes the artifact back into core.
 *
 * Run from the kit: bun run gen:spec
 */

import ts from 'typescript'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { specContent, specCategoryOrder, type ContentEntry } from '../../core/schema/spec.content.ts'

const here = dirname(fileURLToPath(import.meta.url))
const typesPath = resolve(here, '../../core/schema/types.ts')
const outPath = resolve(here, '../../core/spec/spec.json')

const SKIP_ATTRS = new Set(['tag', 'children', 'appearance'])

const TYPE_ALIAS: Record<string, string> = {
  DimensionValue: 'dimension',
  ColorValue: 'color',
  FillValue: 'fill',
  GradientValue: 'gradient',
  GapValue: 'gap',
  TokenRef: 'token',
  AssetRef: 'asset',
  'ColorValue | TokenRef': 'color | token'
}

interface SpecAttr { name: string; type: string; required: boolean; description: string; enum?: string[] }

const program = ts.createProgram([typesPath], {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  strict: false,
  noEmit: true,
  skipLibCheck: true
})
const checker = program.getTypeChecker()
const source = program.getSourceFile(typesPath)
if (!source) throw new Error(`Could not load ${typesPath}`)

const interfaces = new Map<string, ts.InterfaceDeclaration>()
source.forEachChild(node => {
  if (ts.isInterfaceDeclaration(node)) interfaces.set(node.name.text, node)
})

function applyAlias(s: string): string {
  if (TYPE_ALIAS[s]) return TYPE_ALIAS[s]
  for (const [from, to] of Object.entries(TYPE_ALIAS)) {
    s = s.replace(new RegExp(`\\b${from}\\b`, 'g'), to)
  }
  return s
}

function typeText(prop: ts.Symbol, fallback: ts.Type): string {
  const decl = prop.declarations?.[0]
  if (decl && ts.isPropertySignature(decl) && decl.type) {
    return applyAlias(decl.type.getText().replace(/\s+/g, ' ').trim())
  }
  return applyAlias(checker.typeToString(fallback))
}

function enumValues(t: ts.Type): string[] | undefined {
  if (!t.isUnion()) return undefined
  const lits = t.types.filter(x => x.isStringLiteral()) as ts.StringLiteralType[]
  if (lits.length && lits.length === t.types.length) return lits.map(l => l.value)
  return undefined
}

function attrsFrom(ifaceName: string, opts: { onlyShared?: boolean } = {}): SpecAttr[] {
  const decl = interfaces.get(ifaceName)
  if (!decl) throw new Error(`Interface ${ifaceName} not found in types.ts`)
  const type = checker.getTypeAtLocation(decl)
  const out: SpecAttr[] = []
  for (const prop of checker.getPropertiesOfType(type)) {
    const propName = prop.getName()
    if (SKIP_ATTRS.has(propName)) continue
    const propDecl = prop.declarations?.[0]
    const declIface = propDecl?.parent && ts.isInterfaceDeclaration(propDecl.parent)
      ? propDecl.parent.name.text : undefined
    const isShared = declIface === 'VisualAttrs'
    if (opts.onlyShared ? !isShared : isShared) continue
    const pType = checker.getTypeOfSymbolAtLocation(prop, propDecl ?? decl)
    out.push({
      name: propName,
      type: typeText(prop, pType),
      required: !(prop.flags & ts.SymbolFlags.Optional),
      description: ts.displayPartsToString(prop.getDocumentationComment(checker)).trim(),
      enum: enumValues(pType)
    })
  }
  return out
}

const sharedAttributes = attrsFrom('FrameNode', { onlyShared: true })

function buildElement(entry: ContentEntry) {
  let attributes: SpecAttr[] = []
  let usesShared = false
  if (entry.source.startsWith('interface:')) {
    const ifaceName = entry.source.slice('interface:'.length)
    if (ifaceName === 'VisualAttrs') {
      attributes = sharedAttributes
    } else {
      attributes = attrsFrom(ifaceName)
      usesShared = true
    }
  } else {
    attributes = (entry.attributes ?? []).map(a => ({
      name: a.name, type: a.type, required: !!a.required, description: a.description
    }))
  }
  return {
    slug: entry.slug,
    tag: entry.tag ?? null,
    name: entry.name,
    navLabel: entry.navLabel ?? null,
    kind: entry.kind,
    category: entry.category,
    summary: entry.summary,
    description: entry.description,
    note: entry.note,
    mapsToFigma: entry.mapsToFigma,
    attributes,
    sharedAttrs: usesShared,
    example: entry.example,
    exampleLabel: entry.exampleLabel,
    exampleMode: entry.exampleMode ?? 'hl',
    related: entry.related,
    faq: entry.faq ?? [],
    hubHidden: !!entry.hubHidden
  }
}

const spec = {
  $generated: 'DO NOT EDIT — run `bun run gen:spec` in the kit. Source: core/schema/types.ts + spec.content.ts',
  formatVersion: '0.2',
  categoryOrder: specCategoryOrder,
  sharedAttributes,
  elements: specContent.map(buildElement)
}

writeFileSync(outPath, JSON.stringify(spec, null, 2) + '\n')
const attrCount = spec.elements.reduce((n, e) => n + e.attributes.length, 0)
console.log(`✓ core/spec/spec.json written: ${spec.elements.length} elements, ${attrCount} element attributes, ${sharedAttributes.length} shared attributes`)
