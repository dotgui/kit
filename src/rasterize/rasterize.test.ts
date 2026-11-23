import { describe, expect, test } from 'bun:test'
import { zipSync, strToU8 } from 'fflate'
import { rasterize, renderPreview } from './index'
import { unpack } from '../package'

const MAGIC: Record<string, number[]> = { png: [0x89, 0x50, 0x4e, 0x47], jpeg: [0xff, 0xd8, 0xff], webp: [0x52, 0x49, 0x46, 0x46] }

describe('rasterize with the Rust renderer', () => {
  test('a package draws to each format, with no browser', async () => {
    const pkg = unpack(zipSync({ 'design.guix': strToU8('<gui version="0.4.4"><col w="120" h="40" fill="#3B5BFD" /></gui>') }))
    for (const format of ['png', 'webp', 'jpeg'] as const) {
      const { image, reason } = await rasterize(pkg, { format, network: false })
      expect(reason).toBeUndefined()
      expect([...image!.slice(0, MAGIC[format].length)]).toEqual(MAGIC[format])
    }
  })

  test('a multi-document package draws its primary document against its library', async () => {
    const pkg = unpack(zipSync({
      '01-home.guix': strToU8('<gui version="0.4.4"><col w="80" h="80" fill="$primary" /></gui>'),
      'library.guix': strToU8('<gui version="0.4.4"><tokens><color name="primary" value="#FF0000" /></tokens></gui>'),
    }))
    const { image, reason } = await rasterize(pkg, { format: 'png', network: false })
    expect(reason).toBeUndefined()
    expect(image!.length).toBeGreaterThan(100)
  })

  test('a standalone document draws too', async () => {
    const pkg = unpack(strToU8('<gui version="0.4.4"><col w="40" h="40" fill="#00FF00" /></gui>'))
    expect((await rasterize(pkg, { format: 'png', network: false })).image).toBeDefined()
  })

  test('a document that does not draw fails soft, and the preview falls back', async () => {
    const pkg = unpack(strToU8('<gui version="9.9"><col /></gui>'))
    const r = await rasterize(pkg, { network: false })
    expect(r.reason).toBe('render-failed')
    const preview = await renderPreview(pkg, { silent: true })
    expect(preview.placeholder).toBe(true)
  })
})
