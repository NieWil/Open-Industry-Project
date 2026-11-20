import { describe, expect, it } from 'vitest'
import { rankPaletteItems, scoreMatch, type PaletteItem } from './paletteItems'

function item(kind: PaletteItem['kind'], label: string, group = 'X'): PaletteItem {
  return {
    key: `${kind}:${label}`,
    kind,
    group,
    label,
    target: kind === 'command' ? { kind: 'command', id: label } : kind === 'part' ? { kind: 'part', id: label } : { kind: 'catalog', type: label },
  }
}

describe('scoreMatch tiers', () => {
  it('ranks exact over prefix over word-start over contains over scatter', () => {
    const exact = scoreMatch('Spur', 'spur')!
    const prefix = scoreMatch('Spur Conveyor', 'spur')!
    const wordStart = scoreMatch('Curved Spur', 'spur')!
    const contains = scoreMatch('Xspurx', 'spur')!
    const scatter = scoreMatch('Super Purple', 'spur')!
    expect(exact).toBeGreaterThan(prefix)
    expect(prefix).toBeGreaterThan(wordStart)
    expect(wordStart).toBeGreaterThan(contains)
    expect(contains).toBeGreaterThan(scatter)
  })

  it('is case-insensitive', () => {
    expect(scoreMatch('DIVERTER', 'div')).toBe(scoreMatch('diverter', 'DIV'))
  })

  it('returns null when a letter is missing', () => {
    expect(scoreMatch('Diverter', 'dzz')).toBeNull()
  })

  it('treats an empty query as a match on everything', () => {
    expect(scoreMatch('anything', '')).toBe(0)
  })

  it('finds a word start after a hyphen, a dot or an underscore', () => {
    expect(scoreMatch('oip.diverter', 'div')).toBe(800)
    expect(scoreMatch('box-spawner', 'spa')).toBe(800)
    expect(scoreMatch('lane_full', 'ful')).toBe(800)
  })

  it('prefers a tighter scatter over a looser one', () => {
    // 'dt' matches 2 apart in Date and 7 apart in Daylight, so Date is the better guess
    expect(scoreMatch('Date', 'dt')!).toBeGreaterThan(scoreMatch('Daylight', 'dt')!)
  })

  it('a contiguous hit always beats any scatter, however tight', () => {
    // guards against scoring these the same, which makes a 3-source list unreadable
    expect(scoreMatch('Xdt', 'dt')!).toBeGreaterThan(scoreMatch('Date', 'dt')!)
  })
})

describe('rankPaletteItems', () => {
  it('puts an exact part name above a command that merely contains the letters', () => {
    const hits = rankPaletteItems([item('command', 'Distraction Free Mode'), item('part', 'Diverter')], 'diverter')
    expect(hits[0]!.label).toBe('Diverter')
  })

  it('breaks a tie toward commands, then scene parts, then catalog', () => {
    const hits = rankPaletteItems([item('catalog', 'Spur'), item('part', 'Spur'), item('command', 'Spur')], 'spur')
    expect(hits.map((h) => h.kind)).toEqual(['command', 'part', 'catalog'])
  })

  it('prefers the shorter label when score and kind tie', () => {
    const hits = rankPaletteItems([item('part', 'Belt Conveyor Long'), item('part', 'Belt')], 'belt')
    expect(hits[0]!.label).toBe('Belt')
  })

  it('drops everything that does not match', () => {
    const hits = rankPaletteItems([item('command', 'Undo'), item('part', 'Diverter')], 'zzz')
    expect(hits).toEqual([])
  })

  it('returns everything for an empty query', () => {
    const all = [item('command', 'Undo'), item('part', 'Diverter'), item('catalog', 'Spur')]
    expect(rankPaletteItems(all, '')).toHaveLength(3)
  })

  it('caps parts so a big scene cannot crowd out the commands', () => {
    const parts = Array.from({ length: 300 }, (_, i) => item('part', `Belt Conveyor ${i}`))
    const hits = rankPaletteItems([item('command', 'Belt something'), ...parts], 'belt', 8)
    expect(hits.filter((h) => h.kind === 'part')).toHaveLength(8)
    expect(hits.some((h) => h.kind === 'command')).toBe(true)
  })

  it('never caps commands - the list is small and fixed', () => {
    const cmds = Array.from({ length: 30 }, (_, i) => item('command', `Command ${i}`))
    expect(rankPaletteItems(cmds, 'command', 8).filter((h) => h.kind === 'command')).toHaveLength(30)
  })

  it('caps each kind independently', () => {
    const parts = Array.from({ length: 20 }, (_, i) => item('part', `Belt ${i}`))
    const cat = Array.from({ length: 20 }, (_, i) => item('catalog', `Belt kit ${i}`))
    const hits = rankPaletteItems([...parts, ...cat], 'belt', 3)
    expect(hits.filter((h) => h.kind === 'part')).toHaveLength(3)
    expect(hits.filter((h) => h.kind === 'catalog')).toHaveLength(3)
  })

  it('searches the group too, so "view problems" finds the View command', () => {
    const hits = rankPaletteItems([item('command', 'Problems', 'View'), item('part', 'Pump')], 'view problems')
    expect(hits[0]!.label).toBe('Problems')
  })

  it('finds a translated row by its English alias, below an equal hit on the shown label', () => {
    const save: PaletteItem = { key: 'cmd:save', kind: 'command', group: 'File', label: 'Speichern', alias: 'Save', target: { kind: 'command', id: 'file.save' } }
    const shown: PaletteItem = { key: 'part:s', kind: 'part', group: 'Scene', label: 'Save', target: { kind: 'part', id: 's' } }
    expect(rankPaletteItems([save], 'save').map((i) => i.key)).toEqual(['cmd:save'])
    expect(rankPaletteItems([save], 'speich').map((i) => i.key)).toEqual(['cmd:save'])
    expect(rankPaletteItems([save, shown], 'save').map((i) => i.key)).toEqual(['part:s', 'cmd:save'])
  })

  it('a group hit never outranks a direct label hit', () => {
    // 'Scene' is the parts group; a command literally called "Scene Tree" must win the query 'scene'
    const hits = rankPaletteItems([item('part', 'Diverter', 'Scene'), item('command', 'Scene Tree', 'View')], 'scene')
    expect(hits[0]!.label).toBe('Scene Tree')
  })

  it('keeps a disabled command visible rather than filtering it out', () => {
    const stop: PaletteItem = { ...item('command', 'Stop'), disabled: true }
    expect(rankPaletteItems([stop], 'stop')).toHaveLength(1)
  })

  it('is deterministic across calls', () => {
    const all = [item('command', 'Copy'), item('part', 'Conveyor'), item('catalog', 'Curve')]
    expect(rankPaletteItems(all, 'c').map((h) => h.key)).toEqual(rankPaletteItems(all, 'c').map((h) => h.key))
  })
})
