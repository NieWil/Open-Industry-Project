import { beforeEach, describe, expect, it } from 'vitest'
import { toLocalXZ } from '../../core/parts/partGeometry'
import { clearPackages, registerPackage } from '../../core/parts/partRegistry'
import type { PartPackage } from '../../core/parts/partPackage'
import type { PartInstance, SceneJSON } from '../../core/types'
import { DOCK_PANEL_TITLES } from '../dockLayout'
import { keyHint, withKeys } from '../keyHint'
import { INTERLOCK_LOGIC, INTERLOCK_PROGRAM, STOP_LINE, TUTORIAL_STEPS, type TutorialContext } from './steps'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'

// Guards the tutorial's viewport placement markers (the "drop it here" rings). The markers are
// derived from the conveyor's geometry, and conveyor families differ in local origin: a belt is
// tail-origin, the SDK roller bed centre-origin. `position + length` math tuned for a tail-origin
// bed floats the discharge-sensor marker a bed's half-length past the real end of a centre-origin
// one. These tests pin the markers to the part's actual footprint (via the core end-geometry seam),
// so an origin change surfaces here instead of silently misplacing the tour markers.

// A roller package matching the shipped SDK roller's shape (a centre-origin `conveys` deck + a
// length/width `face` handle), so conveyorEndsOf / partFootprint resolve exactly as in the app.
function registerRoller(): void {
  registerPackage({
    format: PACKAGE_FORMAT,
    id: 'oip.roller-conveyor',
    name: 'Roller Conveyor', conveyor: { bed: 'straight', surface: 'roller', speedParam: 'speed' },
    params: {
      length: { type: 'number', default: 4, min: 0.5, handle: { kind: 'face', axis: 'x' } },
      width: { type: 'number', default: 1.524, min: 0.2, max: 3, handle: { kind: 'face', axis: 'z' } },
      speed: { type: 'number', default: 1, min: -3, max: 3 },
    },
    behavior: 'definePart({ step(){} })',
    geometry: {
      kind: 'rig',
      links: [{ name: 'deck', shape: { kind: 'box', size: [3, 0.04, 1] }, conveys: true }],
      joints: [],
      bounds: { length: 4, width: 1.524, top: 0.9 },
    },
  } as unknown as PartPackage)
}

const LEN = 4
const WIDTH = 1.524

function roller(position: [number, number, number], rotationY: number): PartInstance {
  return {
    id: 'roller_1',
    type: 'part',
    packageId: 'oip.roller-conveyor',
    position,
    rotationY,
    params: { length: LEN, width: WIDTH },
  } as unknown as PartInstance
}

function hint(stepId: string, part: PartInstance): [number, number, number] | null {
  const step = TUTORIAL_STEPS.find((s) => s.id === stepId)
  if (!step?.placementHint) throw new Error(`step ${stepId} has no placementHint`)
  const scene = { parts: [part] } as unknown as SceneJSON
  const ctx = { state: { scene }, store: {}, controller: {} } as unknown as TutorialContext
  return step.placementHint(ctx)
}

/** the marker, expressed in the part's local frame, so on-the-bed checks are rotation-agnostic */
function local(part: PartInstance, mark: [number, number, number]): { x: number; z: number } {
  return toLocalXZ(part, mark[0], mark[2])
}

describe('tutorial placement markers stay on the SDK conveyor bed', () => {
  beforeEach(() => {
    clearPackages()
    registerRoller()
  })

  // exercise a plain and a yaw-rotated bed: transforming back to local must fall inside the
  // footprint in both, proving the world end-geometry + perpendicular math compose correctly.
  for (const rot of [0, Math.PI / 2, -Math.PI / 3]) {
    it(`box marker sits on the belt near the start (rot ${rot.toFixed(2)})`, () => {
      const part = roller([3, 0, -1], rot)
      const m = hint('place-box', part)!
      const l = local(part, m)
      expect(Math.abs(l.x)).toBeLessThanOrEqual(LEN / 2 + 1e-6) // on the bed lengthwise
      expect(Math.abs(l.z)).toBeLessThanOrEqual(WIDTH / 2 + 1e-6) // within the side rails
      expect(l.x).toBeLessThan(0) // upstream (back) half - "near the start"
      expect(m[1]).toBeCloseTo(part.position[1] + 0.25, 6) // just above the surface plane
    })

    it(`sensor marker sits on the belt near the discharge, over the +side rail (rot ${rot.toFixed(2)})`, () => {
      const part = roller([3, 0, -1], rot)
      const m = hint('add-sensor', part)!
      const l = local(part, m)
      // guards against a half-length past the end (tail-origin math: local x = length - 0.4 = 3.6 > 2)
      expect(l.x).toBeLessThanOrEqual(LEN / 2 + 1e-6) // not past the discharge end
      expect(l.x).toBeGreaterThan(0) // downstream (front) half
      expect(l.z).toBeGreaterThan(0) // the +side the sensor mounts on
      expect(Math.abs(l.z)).toBeLessThanOrEqual(WIDTH / 2 + 1e-6) // still over the bed, inside the rail
      expect(m[1]).toBeCloseTo(part.position[1] + 0.15, 6) // just above the surface plane
    })
  }

  it('the logic shown in the card is the logic the tour actually loads', () => {
    // The "Write the program" card shows the interlock rungs before its button writes them.
    // Teaching one thing and running another would be worse than showing nothing, so the
    // snippet is the same string the program embeds.
    const card = TUTORIAL_STEPS.find((s) => s.id === 'write-program')!
    expect(card.body).toContain(INTERLOCK_LOGIC)
    expect(INTERLOCK_PROGRAM).toContain(INTERLOCK_LOGIC)
    // and it must survive the card's paragraph split (blank lines) as one code block
    expect(INTERLOCK_LOGIC).not.toContain('\n\n')
    expect(card.body.split('\n\n')).toContain(INTERLOCK_LOGIC)
  })

  it('markers reflow with the part position (not pinned to the world origin)', () => {
    const a = local(roller([0, 0, 0], 0), hint('add-sensor', roller([0, 0, 0], 0))!)
    const b = local(roller([10, 0, 7], 0), hint('add-sensor', roller([10, 0, 7], 0))!)
    // same local-frame point regardless of where the bed sits in the world
    expect(a.x).toBeCloseTo(b.x, 6)
    expect(a.z).toBeCloseTo(b.z, 6)
  })
})

// The tour writes a program into the PLC panel, so it must show the user that panel. Guards against
// the write happening behind a full-screen dim, the closing run spotlighting Play (dimming the panel
// the card says to watch), and the copy naming it by the floating window's title rather than the
// tab a default layout shows. e2e/verify-tutorial-docked-plc.mjs checks the spotlight is on it.
describe('tutorial shows the PLC panel, not just names it', () => {
  const PANEL = '[data-tutorial="dock-st"]'
  const at = (id: string): number => {
    const i = TUTORIAL_STEPS.findIndex((s) => s.id === id)
    if (i < 0) throw new Error(`no step ${id}`)
    return i
  }

  it('the step after the program lands points at the panel', () => {
    expect(TUTORIAL_STEPS[at('write-program') + 1]!.target).toContain(PANEL)
  })

  it('a step that asks the user to watch the panel rings it without dimming it', () => {
    const watching = TUTORIAL_STEPS.filter((s) => /\bwatch\b/i.test(s.body) && s.body.includes('PLC'))
    expect(watching.map((s) => s.id)).toContain('watch-interlock')
    for (const s of watching) {
      expect(s.target, s.id).toContain(PANEL)
      expect(s.dim, s.id).toBe(false)
    }
  })

  it('the interlock is watched once Play is pressed, not while the card points at Play', () => {
    const run = TUTORIAL_STEPS[at('run-program')]!
    expect(run.target).toEqual(['[data-tutorial="play"]'])
    expect(run.done?.({ state: { running: true } } as unknown as TutorialContext)).toBe(true)
    expect(at('watch-interlock')).toBe(at('run-program') + 1)
  })

  it("names the panel by the dock's tab label", () => {
    const tab = `${DOCK_PANEL_TITLES.st} tab`
    expect(TUTORIAL_STEPS[at('write-program')]!.body).toContain(tab)
    expect(TUTORIAL_STEPS[at('plc-panel')]!.body).toContain(tab)
    for (const s of TUTORIAL_STEPS) expect(s.body, s.id).not.toContain('Structured Text panel')
  })

  // the program step brings the PLC tab forward in the dock the catalog shares, and the layout
  // persists: a replay opened with the catalog unmounted and nothing for "click X" to point at
  it('the placement steps bring the Parts catalog on screen', () => {
    for (const id of ['drop-conveyor', 'place-box', 'add-sensor']) {
      const revealed: string[] = []
      const store = { revealPanel: (p: string) => revealed.push(p) }
      TUTORIAL_STEPS[at(id)]!.onEnter?.({ store } as unknown as TutorialContext)
      expect(revealed, id).toEqual(['catalog'])
    }
  })

  // click-to-place re-arms after a drop, so a ghost sensor followed the cursor up to Play
  it('the beats before Play leave placing mode', () => {
    for (const id of ['press-play', 'run-program']) {
      const calls: string[] = []
      const store = { clearSelection: () => calls.push('deselect'), cancelPlacing: () => calls.push('cancel') }
      TUTORIAL_STEPS[at(id)]!.onEnter?.({ store } as unknown as TutorialContext)
      expect(calls, id).toEqual(['deselect', 'cancel'])
    }
  })
})

// Every step before "Change the program" writes the program for the user, and an edit to a running program does
// nothing until Reload, from a panel with no Run button to suggest it. So the step waits for the whole loop: the
// text edited, and the edit being what runs. e2e/verify-tutorial-edit-reload.mjs drives it on the real controller.
describe('tutorial has the user change the running program', () => {
  const step = TUTORIAL_STEPS.find((s) => s.id === 'edit-program')!
  const EDITED = INTERLOCK_PROGRAM.replace(STOP_LINE, 'Conveyor := TRUE;')
  const gate = (o: { running?: boolean; stProgram?: string; attached?: boolean; failure?: 'previous' | 'none' | null; outOfDate?: boolean }): boolean =>
    step.done!({
      state: { running: o.running ?? true, stProgram: o.stProgram ?? EDITED },
      controller: { programStatus: { attached: o.attached ?? true }, programAttachFailure: o.failure ?? null, programOutOfDate: o.outOfDate ?? false },
    } as unknown as TutorialContext)

  it('comes once the interlock has been watched, before Done', () => {
    const i = TUTORIAL_STEPS.indexOf(step)
    expect(TUTORIAL_STEPS[i - 1]!.id).toBe('watch-interlock')
    expect(TUTORIAL_STEPS[i + 1]!.id).toBe('done')
  })

  it('points at a line the program holds exactly once, shown as its own code block', () => {
    expect(INTERLOCK_PROGRAM.split(STOP_LINE)).toHaveLength(2)
    // the overlay renders a paragraph as code when it matches this (TutorialOverlay), so the prose around the line
    // must not, or it turns monospace too
    const code = step.body.split('\n\n').filter((p) => /VAR_|:=|END_IF/.test(p))
    expect(code).toEqual([STOP_LINE])
  })

  it('passes once the edited program is the one running', () => {
    expect(gate({})).toBe(true)
  })

  it("not while the tour's own program runs, however it is re-spaced", () => {
    expect(gate({ stProgram: INTERLOCK_PROGRAM })).toBe(false)
    expect(gate({ stProgram: `${INTERLOCK_PROGRAM.replace(/\n/g, '\r\n  ')}\n\n` })).toBe(false)
  })

  it('not while the edit waits for Reload', () => {
    expect(gate({ outOfDate: true })).toBe(false)
  })

  it('not when the edit failed to compile, whatever still runs', () => {
    expect(gate({ failure: 'previous' })).toBe(false)
    expect(gate({ failure: 'none', attached: false })).toBe(false)
  })

  it('not while stopped', () => {
    expect(gate({ running: false })).toBe(false)
  })

  it('brings the PLC tab forward and rings it without dimming the box it is about to move', () => {
    const revealed: string[] = []
    step.onEnter?.({ store: { revealPanel: (p: string) => revealed.push(p) } } as unknown as TutorialContext)
    expect(revealed).toEqual(['st'])
    expect(step.target).toContain('[data-tutorial="dock-st"]')
    expect(step.dim).toBe(false)
    expect(step.body).toContain(`${DOCK_PANEL_TITLES.st} tab`)
  })
})

// The tour names keys through {key:action.id} tokens (keyHint.ts withKeys), so a rebinding in Settings
// reaches the cards. A token for an action that does not exist renders as "[id]" on screen - so every
// one must name a real binding, which is what this pins.
describe('tutorial key tokens', () => {
  it('every {key:…} token names a bound action', () => {
    const tokens = TUTORIAL_STEPS.flatMap((s) => [...s.body.matchAll(/\{key:([\w.]+)\}/g)].map((m) => ({ step: s.id, id: m[1]! })))
    expect(tokens.length).toBeGreaterThan(0)
    for (const t of tokens) expect(keyHint(t.id, false), `${t.step}: {key:${t.id}}`).not.toBeNull()
  })

  it('no step types a chord in by hand any more', () => {
    for (const s of TUTORIAL_STEPS) expect(s.body, s.id).not.toMatch(/\*\*(Shift|Ctrl|Alt) \+/)
  })

  it('reads as the defaults when nothing is rebound', () => {
    const body = (id: string) => withKeys(TUTORIAL_STEPS.find((s) => s.id === id)!.body, false)
    expect(body('shortcuts')).toContain('Press **Shift+/**')
    expect(body('look-around')).toContain('steer with WASD, plus Q and E')
  })
})
