import { describe, expect, it } from 'vitest'
import { compile, runnableSource } from '../../plc'
import { DEMO_CONTROLLER, DEMO_PROGRAM } from './demoScenes'

// MutingSeq, the demo's curtain muting block (demoScenes.ts), held on its own: the shipped program, driven through an
// opening's inputs (its curtain's OSSD and its two muting eyes, A1 the outer one), read at what the rest of the
// program sees (the run permit's clear term) and what lights the curtain's lamp. The run permit itself is left out of
// it: `running` latches, and the question here is what the block lets through, scan by scan. Every opening uses the
// same block the same way, so the case infeed's instance stands for all three, and the outfeed's is checked alongside.

const SCAN = 0.01 // the demo's MainTask period

type Eyes = { a1?: boolean; a2?: boolean; ossd?: boolean }

function opening(prefix: 'Case' | 'Out' = 'Case') {
  const p = compile(runnableSource(DEMO_PROGRAM, DEMO_CONTROLLER))
  const clearVar = prefix === 'Case' ? 'Main.caseClear' : 'Main.outClear'
  return (e: Eyes, scans = 1): { clear: unknown; muted: unknown } => {
    p.setInput(`${prefix}Curtain`, e.ossd ?? true)
    p.setInput(`${prefix}MuteA1`, e.a1 ?? false)
    p.setInput(`${prefix}MuteA2`, e.a2 ?? false)
    for (let i = 0; i < scans; i++) p.scan(SCAN)
    return { clear: p.get(clearVar), muted: p.get(`${prefix}Muted`) }
  }
}

describe('MutingSeq (the demo curtains\' muting)', () => {
  it.each(['Case', 'Out'] as const)('%s: mutes a load arriving the way loads do, and ends as soon as its tail is through the curtain', (prefix) => {
    const scan = opening(prefix)
    expect(scan({})).toEqual({ clear: true, muted: false })
    expect(scan({ a1: true }, 5)).toEqual({ clear: true, muted: false }) // the outer eye first
    expect(scan({ a1: true, a2: true }, 5)).toEqual({ clear: true, muted: true }) // then the inner: muted
    expect(scan({ a1: true, a2: true, ossd: false }, 5)).toEqual({ clear: true, muted: true }) // into the beams
    expect(scan({ a2: true, ossd: false }, 5)).toEqual({ clear: true, muted: true })
    expect(scan({ ossd: false }, 5)).toEqual({ clear: true, muted: true }) // off both eyes, still in the beams
    expect(scan({}, 2)).toEqual({ clear: true, muted: false }) // through: the curtain is clear again, muting over
    expect(scan({ ossd: false })).toEqual({ clear: false, muted: false }) // and the next break is a trip
  })

  it('trips on someone following a load in: the muting ended when the load\'s tail cleared the curtain', () => {
    const scan = opening()
    scan({ a1: true }, 5)
    scan({ a1: true, a2: true, ossd: false }, 5)
    scan({ ossd: false }, 5) // the load in the beams, past the eyes
    scan({}, 1) // its tail clears the curtain: one scan of daylight
    expect(scan({ ossd: false })).toEqual({ clear: false, muted: false }) // whoever is right behind it
  })

  it('keeps muting a load that has not reached the curtain yet, then ends it after it passes', () => {
    const scan = opening()
    scan({ a1: true }, 5)
    scan({ a1: true, a2: true }, 5)
    expect(scan({}, 20)).toEqual({ clear: true, muted: true }) // between the eyes and the curtain: a curtain it has not broken yet does not end it
    expect(scan({ ossd: false }, 5)).toEqual({ clear: true, muted: true })
    expect(scan({}, 2)).toEqual({ clear: true, muted: false })
  })

  it('trips on anything in the beams that did not arrive in sequence: a person, a box set down, a load coming the wrong way', () => {
    expect(opening()({ ossd: false })).toEqual({ clear: false, muted: false }) // meets the curtain before any eye
  })

  it('does not mute for both eyes blocked in the same scan: that was put there, not conveyed there', () => {
    const scan = opening()
    expect(scan({ a1: true, a2: true }, 5)).toEqual({ clear: true, muted: false })
    expect(scan({ a1: true, a2: true, ossd: false })).toEqual({ clear: false, muted: false })
  })

  it('does not mute when the outer eye clears before the inner one is reached: something shorter than their gap', () => {
    const scan = opening()
    scan({ a1: true }, 5)
    scan({}, 5) // gone from the outer eye, not yet at the inner: a person, not a load
    expect(scan({ a2: true }, 5)).toEqual({ clear: true, muted: false })
    expect(scan({ a2: true, ossd: false })).toEqual({ clear: false, muted: false })
  })

  it('ends a muting that outlasts MaxTime (30 s), trips, and needs both eyes clear before it can mute again', () => {
    const scan = opening()
    scan({ a1: true }, 5)
    expect(scan({ a1: true, a2: true, ossd: false }, 5)).toEqual({ clear: true, muted: true })
    expect(scan({ a2: true, ossd: false }, 2900)).toEqual({ clear: true, muted: true }) // parked, 29 s in
    expect(scan({ a2: true, ossd: false }, 200)).toEqual({ clear: false, muted: false }) // past 30 s: tripped
    scan({ a1: true, a2: true }, 5) // still there, so a fresh sequence is not accepted...
    expect(scan({ a1: true, a2: true, ossd: false })).toEqual({ clear: false, muted: false })
    scan({}, 2) // ...until both eyes have cleared
    scan({ a1: true }, 5)
    expect(scan({ a1: true, a2: true, ossd: false }, 5)).toEqual({ clear: true, muted: true })
  })
})
