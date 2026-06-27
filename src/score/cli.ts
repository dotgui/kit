#!/usr/bin/env bun
/**
 * gui-score CLI — score a .gui or .guix file and print the CCAC report.
 *
 *   bun run src/cli.ts <file> [--json]
 *
 * This is a thin wrapper. The JS library (index.ts) is the real surface; the
 * CLI, the future Figma plugin, and gui-app are all thin consumers of it, per
 * RFC-0040. Scoring is fully local — no service, no corpus.
 */
import { readFileSync } from 'fs'
import { scorePackage } from './index'
import { isGateFailure, type ScoreReport } from './types'

function bar(score: number): string {
  const filled = Math.round(score / 5)
  return '█'.repeat(filled) + '░'.repeat(20 - filled)
}

function printLevel(name: string, level: ScoreReport[keyof ScoreReport]): void {
  if ('status' in level) {
    console.log(`  ${name.padEnd(13)} ${level.status.toUpperCase()}  (${level.reason})`)
    return
  }
  console.log(`  ${name.padEnd(14)} ${String(level.score).padStart(3)}  ${bar(level.score)}`)
  for (const a of level.audits) {
    // Inventory audits (Comprehensible) carry { role, path } — facts, not findings.
    if (typeof a.role === 'string') {
      console.log(`      role  ${a.role.padEnd(20)} ${a.path ?? ''}`)
      continue
    }
    const sev = (a.severity ?? 'info').toUpperCase().padEnd(5)
    console.log(`      ${sev} ${a.why ?? JSON.stringify(a)}`)
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const file = args.find((a) => !a.startsWith('--'))
  if (!file) {
    console.error('usage: gui-score <file.gui|file.guix> [--json]')
    process.exit(2)
  }

  const bytes = new Uint8Array(readFileSync(file))
  const out = scorePackage(bytes)

  if (json) {
    console.log(JSON.stringify(out, null, 2))
    process.exit(isGateFailure(out) ? 1 : 0)
  }

  if (isGateFailure(out)) {
    console.log(`\n  GATE FAILED: ${out.error}\n`)
    for (const d of out.details) {
      console.log(`      ${d.type ?? ''} ${d.ref ?? ''} ${d.path ?? ''} — ${d.reason}`)
    }
    console.log('')
    process.exit(1)
  }

  console.log(`\n  CCAC report for ${file}\n`)
  printLevel('Clean', out.clean)
  printLevel('Consistent', out.consistent)
  printLevel('Accessible', out.accessible)
  printLevel('Comprehensible', out.comprehensible)
  console.log('')
  process.exit(0)
}

main()
