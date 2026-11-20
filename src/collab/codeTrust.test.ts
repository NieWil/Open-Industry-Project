import { afterEach, describe, expect, it } from 'vitest'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import type { PartPackage } from '../core/parts/partPackage'
import {
  forgetTrustedRooms,
  INERT_BEHAVIOR,
  isRoomCodeTrusted,
  markRoomOpening,
  ownCodeAmong,
  PackageGate,
  rememberOwnCode,
  rememberRoomCodeTrust,
  roomOpenDidNotFinish,
  roomOpenFinished,
  trustedRoomCount,
} from './codeTrust'
import type { FirstPartyCode } from './codeTrust'
import { PACKAGE_FORMAT } from '../core/parts/partPackage'

const SHIPPED_BELT = 'definePart({ step(ctx) { ctx.setSurfaceVelocity(1) } })'

function pkg(id: string, behavior: string, name = id): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id,
    name,
    params: { length: { type: 'number', default: 2 } },
    behavior,
    geometry: { kind: 'rig', links: [{ name: 'body', shape: { kind: 'box', size: [1, 1, 1] }, offset: [0, 0, 0] }], joints: [] },
  }
}

/** an app that ships one part, `oip.belt` */
const firstParty: FirstPartyCode = {
  isFirstParty: (src) => src === SHIPPED_BELT,
  sourceFor: (id) => (id === 'oip.belt' ? SHIPPED_BELT : undefined),
}

afterEach(() => clearPackages())

describe('PackageGate', () => {
  it("holds a stranger's code: the part keeps its data and runs nothing", () => {
    const gate = new PackageGate(firstParty)
    const theirs = pkg('acme.spiral', 'definePart({ geometry() { for(;;){} } })', 'Spiral')
    const [admitted] = gate.review([theirs])
    expect(admitted!.behavior).toBe(INERT_BEHAVIOR)
    expect(admitted!.params).toBe(theirs.params) // the Inspector, the rig and the params still resolve
    expect(admitted!.geometry).toBe(theirs.geometry)
    expect(gate.getHeld()).toEqual([{ id: 'acme.spiral', name: 'Spiral', runs: 'nothing' }])
  })

  it("passes this app's own code through untouched, under any id", () => {
    const gate = new PackageGate(firstParty)
    const same = pkg('oip.belt', SHIPPED_BELT)
    const forked = pkg('someone.belt-copy', SHIPPED_BELT)
    const out = gate.review([same, forked])
    expect(out[0]).toBe(same)
    expect(out[1]).toBe(forked)
    expect(gate.getHeld()).toEqual([])
  })

  it('runs the built-in in place of a built-in whose code the room changed', () => {
    const gate = new PackageGate(firstParty)
    const [admitted] = gate.review([pkg('oip.belt', 'definePart({ step() { /* not ours */ } })', 'Belt')])
    expect(admitted!.behavior).toBe(SHIPPED_BELT)
    expect(gate.getHeld()[0]!.runs).toBe('built-in')
  })

  it('keeps running the version already registered when a peer changes code it ran before', () => {
    const gate = new PackageGate(firstParty)
    const mine = pkg('me.part', 'definePart({ step() {} /* v1 */ })')
    registerPackage(mine)
    const [admitted] = gate.review([{ ...mine, behavior: 'definePart({ step() {} /* v2 from a peer */ })' }])
    expect(admitted!.behavior).toBe(mine.behavior)
    expect(gate.getHeld()[0]!.runs).toBe('previous')
  })

  it("trusts code this client wrote into the room, even when it comes back from the doc", () => {
    const told: string[] = []
    const gate = new PackageGate(firstParty, false, (src) => told.push(src))
    const mine = pkg('me.part', 'definePart({ step() {} })')
    gate.noteOwn(mine.behavior)
    gate.noteOwn(mine.behavior)
    expect(gate.review([mine])[0]).toBe(mine)
    expect(told).toEqual([mine.behavior]) // remembered once, not per note
  })

  it('allowing the room releases what was held, and later code from it', () => {
    const gate = new PackageGate(firstParty)
    const theirs = pkg('acme.spiral', 'definePart({ step() {} /* theirs */ })')
    gate.review([theirs])
    let notified = 0
    gate.subscribe(() => notified++)
    gate.trustRoom()
    expect(gate.trusted).toBe(true)
    expect(notified).toBe(1)
    expect(gate.review([theirs])[0]).toBe(theirs)
    expect(gate.getHeld()).toEqual([])
    const later = pkg('acme.other', 'definePart({ step() {} /* newer */ })')
    expect(gate.admit(later)).toBe(later)
  })

  it('a package that leaves the room drops off the list, but its stand-in is still never written back as its code', () => {
    const gate = new PackageGate(firstParty)
    const theirs = pkg('acme.spiral', 'definePart({ step() {} /* theirs */ })')
    const [held] = gate.review([theirs])
    const list = gate.getHeld()
    gate.review([theirs])
    expect(gate.getHeld()).toBe(list) // useSyncExternalStore needs a stable snapshot
    gate.review([])
    expect(gate.getHeld()).toEqual([]) // nothing left in the room to allow
    // the registry still runs the stand-in, so a write from here (the missing-package safety net) must restore
    // the author's code rather than publish ours as theirs
    expect(gate.isHeld('acme.spiral')).toBe(true)
    expect(gate.docForm(held!).behavior).toBe(theirs.behavior)
  })

  it("admitScene swaps a held package's code in the scene's embedded copies too", () => {
    const gate = new PackageGate(firstParty)
    const theirs = pkg('acme.spiral', 'definePart({ step() {} /* theirs */ })')
    const scene = { packages: [theirs] }
    gate.review([theirs])
    expect(gate.admitScene(scene).packages![0]!.behavior).toBe(INERT_BEHAVIOR)
    const noPackages: { parts: unknown[]; packages?: PartPackage[] } = { parts: [] }
    expect(gate.admitScene(noPackages)).toBe(noPackages)
  })

  it("docForm puts the author's code back over the stand-in, and leaves a script the user typed alone", () => {
    const gate = new PackageGate(firstParty)
    const theirs = pkg('acme.spiral', 'definePart({ step() {} /* theirs */ })')
    const [held] = gate.review([theirs])
    // a data edit made here (the registry copy carries the stand-in) must not erase the author's code
    const edited = { ...held!, name: 'Renamed' }
    expect(gate.docForm(edited)).toEqual({ ...edited, behavior: theirs.behavior })
    // a script the user wrote is theirs to write
    const typed = { ...held!, behavior: 'definePart({ step() {} /* mine */ })' }
    expect(gate.docForm(typed)).toBe(typed)
    // nothing held: the package goes out as it is
    const other = pkg('me.part', 'definePart({ step() {} })')
    expect(gate.docForm(other)).toBe(other)
  })
})

/** run `body` against an in-memory localStorage */
async function withStorage(body: (store: Map<string, string>) => void | Promise<void>): Promise<void> {
  const store = new Map<string, string>()
  const prev = (globalThis as { localStorage?: unknown }).localStorage
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  }
  try {
    await body(store)
  } finally {
    ;(globalThis as { localStorage?: unknown }).localStorage = prev
  }
}

describe('code this browser wrote, remembered past a reload', () => {
  it('recognises exactly the sources it was told about, by SHA-256 fingerprint', () =>
    withStorage(async (store) => {
      const mine = 'definePart({ step() {} /* mine */ })'
      const theirs = 'definePart({ step() {} /* theirs */ })'
      expect(await ownCodeAmong([mine, theirs])).toEqual([])
      await rememberOwnCode(mine)
      await rememberOwnCode(mine) // no duplicate
      expect(await ownCodeAmong([mine, theirs, mine])).toEqual([mine])
      const saved = JSON.parse(store.get('oip-web/own-part-code')!) as string[]
      expect(saved).toHaveLength(1)
      expect(saved[0]).toMatch(/^[0-9a-f]{64}$/) // a fingerprint, never the source itself
    }))
})

describe("naming other people's code", () => {
  it('lists a stranger’s package whether held or running, and never the app’s own or this browser’s', () => {
    const theirs = pkg('acme.spiral', 'definePart({ step() {} })', 'Spiral')
    const mine = pkg('me.part', 'definePart({ step() {} /* mine */ })', 'Mine')
    const builtIn = pkg('oip.belt', SHIPPED_BELT, 'Belt')

    const held = new PackageGate(firstParty)
    held.noteOwn(mine.behavior)
    held.review([theirs, mine, builtIn])
    expect(held.getForeign()).toEqual(['acme.spiral'])

    const running = new PackageGate(firstParty, true) // the room runs sandboxed: trusted from the start
    running.noteOwn(mine.behavior)
    running.review([theirs, mine, builtIn])
    expect(running.getHeld()).toEqual([])
    expect(running.getForeign()).toEqual(['acme.spiral'])
  })

  it('Settings can count and forget every Allow', () => {
    const store = new Map<string, string>()
    const prev = (globalThis as { localStorage?: unknown }).localStorage
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    }
    try {
      expect(trustedRoomCount()).toBe(0)
      rememberRoomCodeTrust('r-a')
      rememberRoomCodeTrust('r-b')
      expect(trustedRoomCount()).toBe(2)

      forgetTrustedRooms()
      expect(trustedRoomCount()).toBe(0)
      expect(isRoomCodeTrusted('r-a')).toBe(false)
    } finally {
      ;(globalThis as { localStorage?: unknown }).localStorage = prev
    }
  })
})

describe('recovering a room whose code froze or crashed the page', () => {
  it('an open that never finished is noticed on the next open, and a finished one is not', () => {
    const store = new Map<string, string>()
    const prev = (globalThis as { localStorage?: unknown }).localStorage
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    }
    try {
      expect(roomOpenDidNotFinish('r-abc')).toBe(false)
      markRoomOpening('r-abc', 1000) // the code is about to run...
      expect(roomOpenDidNotFinish('r-abc')).toBe(true) // ...and the page froze: the next open sees the mark
      expect(roomOpenDidNotFinish('r-other')).toBe(false)
      roomOpenFinished('r-abc') // an open that stayed responsive
      expect(roomOpenDidNotFinish('r-abc')).toBe(false)
      expect(store.has('oip-web/room-opening')).toBe(false) // nothing left behind
      for (let i = 0; i < 80; i++) markRoomOpening(`r-${i}`, i) // tabs closed mid-open must not pile up
      expect(Object.keys(JSON.parse(store.get('oip-web/room-opening')!)).length).toBe(50)
      expect(roomOpenDidNotFinish('r-79')).toBe(true) // the newest are the ones kept
      expect(roomOpenDidNotFinish('r-0')).toBe(false)
    } finally {
      ;(globalThis as { localStorage?: unknown }).localStorage = prev
    }
  })
})

describe('the per-room decision', () => {
  it('is remembered per doc name', () => {
    const store = new Map<string, string>()
    const prev = (globalThis as { localStorage?: unknown }).localStorage
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    }
    try {
      expect(isRoomCodeTrusted('r-abc')).toBe(false)
      rememberRoomCodeTrust('r-abc')
      rememberRoomCodeTrust('r-abc') // no duplicate
      expect(isRoomCodeTrusted('r-abc')).toBe(true)
      expect(isRoomCodeTrusted('r-other')).toBe(false)
      expect(JSON.parse(store.get('oip-web/trusted-rooms')!)).toEqual(['r-abc'])
    } finally {
      ;(globalThis as { localStorage?: unknown }).localStorage = prev
    }
  })

  it('reads as untrusted when storage is unavailable', () => {
    const prev = (globalThis as { localStorage?: unknown }).localStorage
    ;(globalThis as { localStorage?: unknown }).localStorage = undefined
    try {
      expect(isRoomCodeTrusted('r-abc')).toBe(false)
      expect(() => rememberRoomCodeTrust('r-abc')).not.toThrow()
    } finally {
      ;(globalThis as { localStorage?: unknown }).localStorage = prev
    }
  })
})
