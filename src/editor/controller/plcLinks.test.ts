import { afterEach, describe, expect, it } from 'vitest'
import type { PartPackage } from '../../core/parts/partPackage'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import { clearPackages, registerPackage } from '../../core/parts/partRegistry'
import type { PartInstance } from '../../core/types'
import * as m from '../links/externalPlc'
import type { PlcIoHost } from '../links/externalPlc'
import { DEFAULT_EXTERNAL_PLC, sanitizeExternalPlc } from '../store/storePrefs'
import type { ExternalPlcSettings } from '../store/storePrefs'
import { attachExternalPlc, detachExternalPlc, exchangeLinks, namedStatus, plcImage, PlcLinkState } from './plcLinks'
import type { PlcLinkDeps } from './plcLinks'
import { ProgramState, setDriven } from './program'

// Several controllers in one run: the main one (here the program, or an external PLC) and the named ones a tag reaches
// as `Cell2::%IX0.0` (core/io/controllerTag.ts). Each named controller gets its own link in the shell, sees only its
// own tags under its own names, and what it drives joins what the default controller drives.

const SENSOR: PartPackage = {
  format: PACKAGE_FORMAT,
  id: 't.sensor',
  name: 't.sensor',
  params: { tag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '' } },
  behavior: 'definePart({step(){}})',
  geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } },
}
const MOTOR: PartPackage = { ...SENSOR, id: 't.motor', name: 't.motor', params: { runTag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '' } } }
const part = (id: string, packageId: string, params: Record<string, unknown>) => ({ id, type: 'part', packageId, position: [0, 0, 0], rotationY: 0, params }) as unknown as PartInstance

/** The desktop socket with its links (apps/desktop/plcIo.cjs): a test plays each PLC's Modbus master by link number. */
function shell() {
  type Conn = { link?: number; id: number; remote: string; open: boolean }
  type Data = { link?: number; id: number; bytes: Uint8Array }
  const conn = new Set<(e: Conn) => void>()
  const data = new Set<(e: Data) => void>()
  const listened: { link?: number; port: number }[] = []
  const closed: (number | undefined)[] = []
  const written: { id: number; bytes: number[] }[] = []
  const host: PlcIoHost = {
    listen: async (opts) => {
      listened.push({ link: opts.link, port: opts.port })
      return { error: '' }
    },
    connect: async () => ({ error: 'listen only', id: 0 }),
    close: async (opts) => {
      closed.push(opts?.link)
    },
    onConnection: (cb) => {
      conn.add(cb)
      return () => conn.delete(cb)
    },
    onData: (cb) => {
      data.add(cb)
      return () => data.delete(cb)
    },
    write: (id, bytes) => written.push({ id, bytes: [...bytes] }),
    drop: () => {},
  }
  const connect = (link: number, id: number) => conn.forEach((cb) => cb({ link, id, remote: `10.0.0.${id}:502`, open: true }))
  const send = (link: number, id: number, bytes: number[]) => data.forEach((cb) => cb({ link, id, bytes: Uint8Array.from(bytes) }))
  return { host, listened, closed, written, connect, send }
}

/** a Modbus TCP request frame */
const frame = (tid: number, body: number[]) => [tid >> 8, tid & 0xff, 0, 0, 0, body.length + 1, 1, ...body]

function run(settings: ExternalPlcSettings, parts: PartInstance[]) {
  const sh = shell()
  const driven: string[][] = []
  const ec = {
    store: { getState: () => ({ externalPlc: settings, scene: { parts }, timeScale: 1, running: true }) },
    sim: { setDrivenTags: (t: string[]) => driven.push(t), beginStepping: () => {} },
    lastFrame: null,
    plcWatch: null,
    runSerial: 1,
    plcIoHost: sh.host,
    opcUaHost: null,
    eipHost: null,
    adsHost: null,
    opcUaServerHost: null,
    setTimeScale: () => {},
  } as unknown as PlcLinkDeps
  const l = new PlcLinkState()
  const p = new ProgramState()
  return { sh, ec, l, p, driven }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => clearPackages())

describe('named controllers in a run', () => {
  const settings = sanitizeExternalPlc({
    ...DEFAULT_EXTERNAL_PLC,
    controllers: [
      { name: 'Cell2', enabled: true, mode: 'serve', port: 5021 },
      { name: 'Off', enabled: false, mode: 'serve', port: 5022 },
      { name: 'Cell3', enabled: true, mode: 'serve', port: 5023 },
    ],
  })
  const parts = () => [
    part('eye1', 't.sensor', { tag: 'Eye' }),
    part('eye2', 't.sensor', { tag: 'Cell2::%IX0.0' }),
    part('belt2', 't.motor', { runTag: 'Cell2::%QX0.0' }),
    part('eye3', 't.sensor', { tag: 'Cell3::%IX0.0' }),
    part('belt3', 't.motor', { runTag: 'Cell3::%QX0.0' }),
  ]

  it('opens one link each, numbered in list order, beside the program', async () => {
    registerPackage(SENSOR)
    registerPackage(MOTOR)
    const { sh, ec, l, p, driven } = run(settings, parts())
    // the program attached first and drives a tag of its own
    setDriven(p, ec.sim, ['Run'])
    attachExternalPlc(l, p, ec, m)
    await settle()
    expect(l.externalSession).toBeNull()
    expect(sh.listened).toEqual([
      { link: 1, port: 5021 },
      { link: 3, port: 5023 },
    ])
    expect(l.named.map((n) => n.name)).toEqual(['Cell2', 'Cell3'])
    // what the links drive joins the program's, under the scene's names
    expect(driven.at(-1)).toEqual(['Run', 'Cell2::%QX0.0', 'Cell3::%QX0.0'])
    expect([...p.drivenKeys]).toEqual(['Run', 'Cell2::%QX0.0', 'Cell3::%QX0.0'])
    expect(namedStatus(l, 'Cell2')).toMatchObject({ state: 'listening', points: ['%QX0.0  coil 0', '%IX0.0  discrete input 0'] })
  })

  it("carries each controller's own tags, and puts its name on what its PLC writes", async () => {
    registerPackage(SENSOR)
    registerPackage(MOTOR)
    const { sh, ec, l, p } = run(settings, parts())
    attachExternalPlc(l, p, ec, m)
    await settle()
    // each link reports its outputs once, off, on its first exchange
    expect(exchangeLinks(l, {})).toEqual({ 'Cell2::%QX0.0': false, 'Cell3::%QX0.0': false })
    sh.connect(3, 7)
    // Cell3's master writes coil 0 on: only Cell3's belt runs
    sh.send(3, 7, frame(1, [0x05, 0x00, 0x00, 0xff, 0x00]))
    // what goes to the sim is every link's outputs, so Cell2's stay as they were
    expect(exchangeLinks(l, { '%IX0.0': false, 'Cell2::%IX0.0': false, 'Cell3::%IX0.0': true })).toEqual({ 'Cell2::%QX0.0': false, 'Cell3::%QX0.0': true })
    expect(exchangeLinks(l, {})).toBeNull()
    // and reads its own eye, not Cell2's or the default controller's
    sh.send(3, 7, frame(2, [0x02, 0x00, 0x00, 0x00, 0x01]))
    expect(sh.written.at(-1)!.bytes.slice(-1)).toEqual([0x01])
    // a request on Cell2's link never reaches Cell3's session
    sh.connect(1, 8)
    sh.send(1, 8, frame(3, [0x05, 0x00, 0x00, 0xff, 0x00]))
    expect(exchangeLinks(l, {})).toEqual({ 'Cell2::%QX0.0': true, 'Cell3::%QX0.0': true })
  })

  it('closes every link on Stop and keeps each last status', async () => {
    registerPackage(SENSOR)
    registerPackage(MOTOR)
    const { sh, ec, l, p } = run(settings, parts())
    attachExternalPlc(l, p, ec, m)
    await settle()
    detachExternalPlc(l)
    await settle()
    expect(sh.closed.sort()).toEqual([1, 3])
    expect(l.named).toEqual([])
    expect(namedStatus(l, 'Cell3')).toMatchObject({ state: 'off', endpoint: '127.0.0.1:5023' })
    expect(namedStatus(l, 'Never')).toMatchObject({ state: 'off', endpoint: '' })
  })

  it('runs the default controller on its own link 0, with only the tags that name no controller', async () => {
    registerPackage(SENSOR)
    registerPackage(MOTOR)
    const both = { ...settings, enabled: true, port: 5020 }
    const { sh, ec, l, p, driven } = run(both, [...parts(), part('belt1', 't.motor', { runTag: '%QX0.0' })])
    attachExternalPlc(l, p, ec, m)
    await settle()
    expect(sh.listened[0]).toEqual({ link: 0, port: 5020 })
    expect(l.externalSession?.driven).toEqual(['%QX0.0'])
    expect(driven.at(-1)).toEqual(['%QX0.0', 'Cell2::%QX0.0', 'Cell3::%QX0.0'])
  })
})

describe('the values watched with a PLC outside the app (plcImage)', () => {
  const frame = (tags: Record<string, Record<string, number | boolean>>) => ({ tags }) as unknown as Parameters<typeof plcImage>[2]

  it("is the program's own image when no link runs", () => {
    const l = new PlcLinkState()
    const own = { Count: 3 }
    expect(plcImage(l, own, frame({ eye: { Eye: true } }))).toBe(own)
    expect(plcImage(l, null, null)).toBeNull()
  })

  it('joins what the parts send and what the PLC drives back, under the scene names, beside the program', () => {
    const l = new PlcLinkState()
    l.externalSession = {} as PlcLinkState['externalSession']
    l.linkOut = { Run: true }
    const f = frame({ eye: { Eye: true }, belt: { Speed: 1.5 } })
    expect(plcImage(l, null, f)).toEqual({ Eye: true, Speed: 1.5, Run: true })
    expect(plcImage(l, { Count: 3 }, f)).toEqual({ Eye: true, Speed: 1.5, Run: true, Count: 3 })
  })

  it('is the same object until the frame, the outputs or the program image change, since it is read every frame', () => {
    const l = new PlcLinkState()
    l.externalSession = {} as PlcLinkState['externalSession']
    l.linkOut = { Run: true }
    const f = frame({ eye: { Eye: true } })
    const first = plcImage(l, null, f)
    expect(plcImage(l, null, f)).toBe(first)
    l.linkOut = { Run: false }
    const next = plcImage(l, null, f)
    expect(next).not.toBe(first)
    expect(next?.Run).toBe(false)
  })
})
