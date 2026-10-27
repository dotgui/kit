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
