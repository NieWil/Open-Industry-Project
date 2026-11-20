import { describe, expect, it } from 'vitest'
import { addressDirection, canonicalAddress, looksLikeAddress, parseDirectAddress } from './iecAddress'

describe('IEC direct addresses', () => {
  it('canonicalises case, the implied bit size and leading zeros', () => {
    expect(canonicalAddress('%ix100.0')).toBe('%IX100.0')
    expect(canonicalAddress('%I100.0')).toBe('%IX100.0')
    expect(canonicalAddress('%QX007.7')).toBe('%QX7.7')
    expect(canonicalAddress(' %iw3 ')).toBe('%IW3')
    expect(canonicalAddress('%QD0010')).toBe('%QD10')
  })

  it('reads area, size and fields', () => {
    expect(parseDirectAddress('%IX2.5')).toEqual({ area: 'I', size: 'X', fields: [2, 5], text: '%IX2.5' })
    expect(parseDirectAddress('%MW12')).toEqual({ area: 'M', size: 'W', fields: [12], text: '%MW12' })
  })

  it('refuses shapes the targets do not use, saying what is wrong', () => {
    expect(parseDirectAddress('%IX8')).toEqual({ error: "a bit address is byte.bit, like %IX0.3; '%IX8' has no bit" })
    expect(parseDirectAddress('%IX1.2.3')).toEqual({ error: "a bit address is byte.bit, like %IX0.3; '%IX1.2.3' has more than two levels" })
    expect(parseDirectAddress('%IX0.8')).toEqual({ error: "bit 8 does not exist in a byte (0-7): '%IX0.8'" })
    expect(parseDirectAddress('%IW1.2')).toEqual({ error: "a word address is one number, like %IW4; '%IW1.2' has 2" })
    expect(parseDirectAddress('%I*')).toMatchObject({ error: expect.stringMatching(/incomplete address, which only a VAR_CONFIG can complete/) })
    expect(parseDirectAddress('%ZX0.0')).toMatchObject({ error: expect.stringMatching(/is not a direct address/) })
    expect(canonicalAddress('Motor')).toBeNull()
  })

  it('tells an address-looking tag apart from a name', () => {
    expect(looksLikeAddress('%IX0.0')).toBe(true)
    expect(looksLikeAddress('%nonsense')).toBe(true)
    expect(looksLikeAddress('Cell1/Motor')).toBe(false)
  })

  it('names the direction from the PLC side', () => {
    const at = (s: string) => {
      const a = parseDirectAddress(s)
      if ('error' in a) throw new Error(a.error)
      return addressDirection(a)
    }
    expect([at('%IX0.0'), at('%QW1'), at('%MD2')]).toEqual(['input', 'output', 'memory'])
  })
})
