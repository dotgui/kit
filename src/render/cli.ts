#!/usr/bin/env bun
/**
 * gui2html — convert a .gui file to a standalone HTML document.
 *
 * Usage:
 *   bun src/cli.ts input.gui              → writes output.html next to input
 *   bun src/cli.ts input.gui -o out.html  → writes to specified path
 *   bun src/cli.ts input.gui --stdout     → prints HTML to stdout
 *   bun src/cli.ts --help
 */

import { readFileSync, writeFileSync } from 'fs'
import { resolve, dirname, basename, extname } from 'path'
import { createRequire } from 'module'

// ─── arg parsing ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2)

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`
gui2html  ·  convert a .gui file to standalone HTML

Usage:
  gui2html <input.gui>                write <input>.html next to the source
  gui2html <input.gui> -o <out.html>  write to a specific path
  gui2html <input.gui> --stdout       print HTML to stdout

Options:
  -o, --out <path>   Output file path
  --stdout           Print to stdout instead of writing a file
  -h, --help         Show this help

Examples:
  gui2html design.gui
  gui2html design.gui -o preview.html
  gui2html design.gui --stdout | open -f -a Safari
`.trim())
  process.exit(0)
}

let inputPath: string | null = null
let outputPath: string | null = null
let toStdout = false

for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--stdout') { toStdout = true }
  else if (a === '-o' || a === '--out') { outputPath = args[++i] ?? null }
  else if (!a.startsWith('-')) { inputPath = a }
}

if (!inputPath) {
  console.error('gui2html: missing input file. Run with --help for usage.')
  process.exit(1)
}

// ─── read input ───────────────────────────────────────────────────────────────

const absInput = resolve(inputPath)
let guiCode: string
try {
  guiCode = readFileSync(absInput, 'utf8')
} catch {
  console.error(`gui2html: cannot read file: ${absInput}`)
  process.exit(1)
}

// .gui files may be ZIP archives (.guix inside). Detect and extract.
const ZIP_SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const rawBytes = readFileSync(absInput)
if (rawBytes.slice(0, 4).equals(ZIP_SIG)) {
  console.error(
    `gui2html: "${basename(inputPath)}" is a .guix archive (ZIP).\n` +
    `  Extract the XML first:  unzip -p "${inputPath}" design.guix | gui2html /dev/stdin`
  )
  process.exit(1)
}

// ─── render via happy-dom (headless DOM) ──────────────────────────────────────
// gui-render is a browser renderer — it needs a DOM.
// We use happy-dom as a lightweight headless env.

let htmlOutput: string

try {
  // Dynamically check for happy-dom; give a clear message if missing.
  const { Window } = await import('happy-dom').catch(() => {
    throw new Error(
      'happy-dom not found. Install it to use the CLI:\n  bun add -d happy-dom\nor use the browser API instead.'
    )
  })

  const window = new Window({ url: 'http://localhost', width: 1280, height: 960 })
  const document = window.document as unknown as Document

  // happy-dom v20 bug: Error subclasses not exposed on window by default
  ;(window as any).SyntaxError  = SyntaxError
  ;(window as any).TypeError    = TypeError
  ;(window as any).RangeError   = RangeError
  ;(window as any).Error        = Error

  // Polyfill ALL uppercase window globals into globalThis so gui-render and
  // its deps (panzoom) see them as native browser globals.
  // Note: DOM event types MUST come from happy-dom (not Bun builtins) so that
  // happy-dom's dispatchEvent accepts them — always override these.
  const alwaysOverride = new Set([
    'Event', 'CustomEvent', 'MouseEvent', 'PointerEvent', 'KeyboardEvent',
    'WheelEvent', 'TouchEvent', 'FocusEvent', 'InputEvent', 'UIEvent',
  ])
  for (const key of Object.keys(window as any)) {
    if (/^[A-Z]/.test(key) && (!(key in globalThis) || alwaysOverride.has(key))) {
      ;(globalThis as any)[key] = (window as any)[key]
    }
  }

  // Core globals
  ;(globalThis as any).document   = document
  ;(globalThis as any).window     = window
  ;(globalThis as any).DOMParser  = (window as any).DOMParser
  ;(globalThis as any).requestAnimationFrame = (fn: FrameRequestCallback) => { fn(0); return 0 }

  document.body.innerHTML = ''

  const { renderToHTML } = await import('./index.ts')
  htmlOutput = renderToHTML(guiCode)

  await window.happyDOM.close()
} catch (err: any) {
  // Fallback: emit a self-contained HTML that renders client-side
  // This works without any headless DOM dep — the HTML just imports gui-render from a CDN.
  console.warn(`gui2html: headless render unavailable (${err.message})\n  Falling back to client-side render wrapper.`)
  htmlOutput = clientSideFallback(guiCode)
}

// ─── write output ─────────────────────────────────────────────────────────────

if (toStdout) {
  process.stdout.write(htmlOutput)
} else {
  const dest = outputPath
    ? resolve(outputPath)
    : resolve(dirname(absInput), basename(absInput, extname(absInput)) + '.html')

  writeFileSync(dest, htmlOutput, 'utf8')
  console.log(`✓  ${dest}`)
}

// ─── client-side fallback ─────────────────────────────────────────────────────

function clientSideFallback(code: string): string {
  const escaped = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>gui preview</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #f0f0f0;
      display: flex; justify-content: center; align-items: flex-start;
      padding: 40px; min-height: 100vh;
    }
    #preview { width: 100%; height: 90vh; }
  </style>
</head>
<body>
<div id="preview"></div>
<textarea id="src" style="display:none">${escaped}</textarea>
<script type="module">
  // Decode the GUI source back from HTML entities
  const src = document.getElementById('src').value
  // Try local dist first, fall back to a relative path
  let renderFn
  try {
    const m = await import('./dist/gui-render.js')
    renderFn = m.render
  } catch {
    document.body.innerHTML = '<p style="color:red;padding:2rem">Could not load gui-render.js — run <code>bun run build</code> and serve this file from the gui-render directory.</p>'
    throw new Error('gui-render not found')
  }
  renderFn(src, document.getElementById('preview'))
</script>
</body>
</html>`
}
