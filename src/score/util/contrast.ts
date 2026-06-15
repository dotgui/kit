/**
 * WCAG 2.2 contrast math, computed from markup — no rendering.
 *
 * Parses the color formats that appear in .gui (#rgb, #rgba, #rrggbb,
 * #rrggbbaa, rgb()/rgba()) into linear luminance, and applies the WCAG 2.2
 * ratio formula. Returns null when a value cannot be resolved to a flat color
 * (gradients, image fills, unresolved refs) — honest uncertainty per P15,
 * never a fabricated ratio.
 */

export interface RGB {
  r: number
  g: number
  b: number
  a: number
}

export function parseColor(input: string | undefined | null): RGB | null {
  if (!input) return null
  const s = input.trim().toLowerCase()

  // hex
  if (s.startsWith('#')) {
    const hex = s.slice(1)
    const expand = (h: string) =>
      h.length === 3 || h.length === 4
        ? h.split('').map((c) => c + c).join('')
        : h
    const h = expand(hex)
    if (h.length === 6 || h.length === 8) {
      const r = parseInt(h.slice(0, 2), 16)
      const g = parseInt(h.slice(2, 4), 16)
      const b = parseInt(h.slice(4, 6), 16)
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
      if ([r, g, b].every((n) => !Number.isNaN(n))) return { r, g, b, a }
    }
    return null
  }

  // rgb() / rgba()
  const m = s.match(/^rgba?\(([^)]+)\)$/)
  if (m) {
    const parts = m[1].split(/[,/\s]+/).filter(Boolean)
    if (parts.length >= 3) {
      const chan = (p: string) =>
        p.endsWith('%') ? Math.round((parseFloat(p) / 100) * 255) : parseFloat(p)
      const r = chan(parts[0])
      const g = chan(parts[1])
      const b = chan(parts[2])
      const a = parts[3] !== undefined ? parseFloat(parts[3]) : 1
      if ([r, g, b].every((n) => !Number.isNaN(n))) return { r, g, b, a }
    }
  }

  return null
}

/** sRGB channel → linear, per WCAG. */
function lin(c: number): number {
  const cs = c / 255
  return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4)
}

export function relativeLuminance(c: RGB): number {
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
}

/**
 * Composite a foreground color (which may be translucent) over a background,
 * so contrast reflects what the eye actually sees.
 */
function over(fg: RGB, bg: RGB): RGB {
  const a = fg.a
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  }
}

export function contrastRatio(fg: RGB, bg: RGB): number {
  const f = relativeLuminance(over(fg, bg))
  const b = relativeLuminance(bg)
  const lighter = Math.max(f, b)
  const darker = Math.min(f, b)
  return (lighter + 0.05) / (darker + 0.05)
}
