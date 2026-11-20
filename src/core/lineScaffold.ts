// A straight line laid out from a list of parts, wired and given a program: the core of
// `npm run add-part -- <project> <part>... --scaffold` (scripts/add-part.mjs), kept here so it is unit-tested.
//
// Every seat the editor has a snap for goes through its snap engine (snapFeatures.ts findSnap, committed by
// snapCommit.ts), so it ends up where a person's drop would. Layout: conveyors end to end along +X in argument order
// from x = 0 at a 0.8 m stand height, each snapped onto the previous discharge; `conveyorGuard` devices on the +Z
// guard facing across the belt (one 0.6 m before the discharge, several spread from the infeed to there); `face`
// devices (buttons) on the -Z frame near the infeed, soft-parented; a source (Products with a `runTag`) above the
// infeed, a sink (Products, no `runTag`) on the floor past the discharge; cargo on the first belt; anything else on
// the floor beside the line.
//
// `opts.at`: a guard or panel device's x is its spot along the line (the snap still decides height and side); any
// other non-conveyor goes exactly there with `opts.rotationY`. A position or yaw for a conveyor, or a yaw for a
// snapped device, is an error. A param in `opts.given` is never written over (a given stand height is the line's).
//
// Tags: a tag param that already holds a name keeps it; only tags the program or starter test read or drive are
// wired, the rest stay blank and are listed in `notes`. Made-up names are unique against `takenTags` and the given
// names: <Stem><n> / <Stem><n>Run per conveyor, DischargeEye (and InfeedEye when gating a source), StartPB / StopPB,
// Spawner<n>Run, Sink<n>Count. A given name the scaffold does not otherwise wire is declared in the program too.
//
// Program: `Running := (Start OR Running) AND NOT Stop`, stopped until Start. Conveyors run while Running; the last
// also stops while DischargeEye is blocked unless a sink follows; a source feeds while Running and neither end eye is
// blocked. The starter test presses Start first.

import { findSnap } from './snap/snapFeatures'
import type { SnapCandidate } from './snap/snapFeatures'
import { commitSnap } from './snap/snapCommit'
import { conveyorEndsOf, isConveyorLike, partFootprint } from './parts/partGeometry'
import { conveyingSurfaceAt } from './conveyor/conveyorSurface'
import { getPackage } from './parts/partRegistry'
import { packageParamSpecs, switchValue, visibleWhenHolds } from './packageParams'
import type { PartPackage } from './parts/partPackage'
import { isCargoPackage } from './parts/partPackage'
import type { PartInstance, SdkPart, SdkPartParams } from './types'

export type ScaffoldRole = 'conveyor' | 'guard' | 'panel' | 'source' | 'sink' | 'cargo' | 'other'

export interface ScaffoldTag {
  /** the program name, also written into the part's tag param */
  name: string
  type: string
  /** from the program's side: 'input' = a part publishes it, 'output' = the program drives a part with it */
  dir: 'input' | 'output'
  /** `<partId>.<param>` */
  owner: string
}

export interface ScaffoldResult {
  /** the input parts, same order and ids, laid out and wired */
  parts: SdkPart[]
  roles: Map<string, ScaffoldRole>
  tags: ScaffoldTag[]
  /** the scene program (bare VAR blocks + statements); null when nothing is wired */
  program: string | null
  /** every VAR_INPUT the program declares: the wired inputs in `tags`, plus Start / Stop when no button carries them */
  programInputs: string[]
  /** a starter project test (docs/project-tests.md), or null with the reason in `notes` */
  test: Record<string, unknown> | null
  /** what the caller should tell its user: what was left out, and why */
  notes: string[]
}

/** working stand height: a `rest: 'surfaceBelow'` param's default is a placeholder the app fills from the drop */
export const SCAFFOLD_STAND_HEIGHT = 0.8
/** a single guard device's distance before the discharge end; also where the last of several goes */
const DISCHARGE_SLOT = 0.6
/** the first of several guard devices, past the infeed (clear of what a source drops there) */
const INFEED_SLOT = 1.2

const r3 = (n: number): number => Math.round(n * 1000) / 1000
const pascal = (s: string): string => s.replace(/(^|[^A-Za-z0-9])([a-z])/g, (_m, _p, c: string) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, '')
const numParam = (p: SdkPart, key: string, fallback: number): number => (typeof p.params[key] === 'number' ? (p.params[key] as number) : fallback)

function roleOf(pkg: PartPackage, part: SdkPart): ScaffoldRole {
  if (isCargoPackage(pkg)) return 'cargo'
  if (isConveyorLike(part)) return 'conveyor'
  const mounts = pkg.snap?.mounts ?? []
  if (mounts.some((m) => m.accepts === 'conveyorGuard')) return 'guard'
  if (mounts.some((m) => m.accepts === 'face')) return 'panel'
  if (pkg.category === 'Products') return 'runTag' in pkg.params ? 'source' : 'sink'
  return 'other'
}

/** a presence sensor: one BOOL it publishes under `tag` (the photo eye), as against a guard actuator */
function isPresenceSensor(pkg: PartPackage): boolean {
  const t = pkg.params.tag as { type?: string; dir?: string; stType?: string } | undefined
  return t?.type === 'tag' && t.dir === 'out' && (t.stType ?? 'BOOL') === 'BOOL'
}

/** the lowest-cost snap of `mover` onto `host` from `position`, over the four quarter-turn yaws */
function bestSnap(mover: SdkPart, position: [number, number, number], host: PartInstance): SnapCandidate | null {
  let best: SnapCandidate | null = null
  for (let k = 0; k < 4; k++) {
    const rotationY = (k * Math.PI) / 2
    const c = findSnap({ ...mover, position, rotationY } as PartInstance, { position, rotationY }, [host])
    if (c && c.targetId === host.id && (!best || c.cost < best.cost)) best = c
  }
  return best
}

export interface ScaffoldOptions {
  /** tag names the scene already uses: none is made up again (a given name is kept even so) */
  takenTags?: Iterable<string>
  /** part id -> where it goes (see the header: a guard or panel device reads only x, along the line) */
  at?: Readonly<Record<string, readonly [number, number, number]>>
  /** part id -> yaw (radians) for a source, sink, cargo or other part */
  rotationY?: Readonly<Record<string, number>>
  /** part id -> the params the caller gave it explicitly (add-part's --params): kept as given, never written over */
  given?: Readonly<Record<string, readonly string[]>>
}

/** Lay out, wire and program a straight line. `parts` carry full params (createSdkPart); their packages registered.
 *  Throws an Error for a position or yaw the scaffold cannot honour (a conveyor's; a snapped device's yaw). */
export function scaffoldLine(parts: readonly SdkPart[], opts: ScaffoldOptions = {}): ScaffoldResult {
  const notes: string[] = []
  const atOf = (id: string): [number, number, number] | undefined => {
    const a = opts.at?.[id]
    return a ? [a[0], a[1], a[2]] : undefined
  }
  const rotOf = (id: string): number | undefined => opts.rotationY?.[id]
  const isGiven = (id: string, key: string): boolean => opts.given?.[id]?.includes(key) ?? false
  let scene: PartInstance[] = parts.map((p) => ({ ...p, position: [...p.position] as [number, number, number], params: { ...p.params } }))
  const get = (id: string): SdkPart => scene.find((p) => p.id === id) as SdkPart
  const set = (next: SdkPart): void => {
    scene = scene.map((p) => (p.id === next.id ? next : p))
  }
  const pkgOf = (p: SdkPart): PartPackage => {
    const pkg = getPackage(p.packageId)
    if (!pkg) throw new Error(`scaffold: ${p.packageId} is not registered`)
    return pkg
  }
  const roles = new Map<string, ScaffoldRole>(parts.map((p) => [p.id, roleOf(pkgOf(p), p)]))
  const ofRole = (r: ScaffoldRole): string[] => parts.filter((p) => roles.get(p.id) === r).map((p) => p.id)
  for (const p of parts) {
    const role = roles.get(p.id)!
    if (role === 'conveyor' && (atOf(p.id) || rotOf(p.id) !== undefined)) {
      throw new Error(`${p.id}: a scaffold lays its conveyors end to end along +X from x = 0, so it takes no position or yaw for one (move the line after, or place the conveyor without --scaffold)`)
    }
    if ((role === 'guard' || role === 'panel') && rotOf(p.id) !== undefined) {
      throw new Error(`${p.id}: the snap decides a ${role === 'guard' ? 'guard' : 'frame'}-mounted device's yaw; give it only a position (its x is where along the line)`)
    }
  }
  const snapOnto = (id: string, position: [number, number, number], hostId: string): boolean => {
    const c = bestSnap(get(id), position, get(hostId))
    if (!c) return false
    scene = [...commitSnap(scene, id, c)]
    return true
  }

  // 1. conveyors, end to end
  const conveyors = ofRole('conveyor')
  conveyors.forEach((id, n) => {
    const c = get(id)
    const pkg = pkgOf(c)
    const params = { ...c.params }
    // a stand height given is the height this conveyor is laid at (the next ones snap to it)
    const h = isGiven(id, 'standHeight') ? numParam(c, 'standHeight', SCAFFOLD_STAND_HEIGHT) : SCAFFOLD_STAND_HEIGHT
    if ('standHeight' in pkg.params) params.standHeight = h
    const at0 = { ...c, params, position: [0, h, 0] as [number, number, number], rotationY: 0 }
    const back = conveyorEndsOf(at0).find((e) => e.end === 'back')
    const fp = partFootprint(at0)
    const backX = back ? back.x : (fp.cx ?? 0) - fp.hx
    let x = -backX // this conveyor's infeed at x = 0
    if (n > 0) {
      const prev = get(conveyors[n - 1]!)
      const front = conveyorEndsOf(prev).find((e) => e.end === 'front')
      x = (front ? front.x : 0) - backX
    }
    set({ ...at0, position: [r3(x), h, 0] })
    if (n > 0 && !snapOnto(id, [r3(x), h, 0], conveyors[n - 1]!)) {
      notes.push(`${id}: no end-to-end snap onto ${conveyors[n - 1]}; it is butted to it by its footprint instead`)
    }
  })
  const first = conveyors.length ? get(conveyors[0]!) : null
  const last = conveyors.length ? get(conveyors[conveyors.length - 1]!) : null
  const lineStart = first ? (conveyorEndsOf(first).find((e) => e.end === 'back')?.x ?? 0) : -1.5
  const lineEnd = last ? (conveyorEndsOf(last).find((e) => e.end === 'front')?.x ?? 3) : 1.5
  const surfaceAt = (x: number): number => {
    for (const id of conveyors) {
      const s = conveyingSurfaceAt(get(id), x, 0)
      if (s) return s.y
    }
    return SCAFFOLD_STAND_HEIGHT
  }
  const conveyorAt = (x: number): SdkPart | null => conveyors.map(get).find((c) => conveyingSurfaceAt(c, x, 0)) ?? (last ?? null)
  const halfWidth = (c: SdkPart | null): number => (c ? partFootprint(c).hz : 0.5)

  // 2. guard devices: seated on the +Z guard, across the belt
  // the ones given a position sit at its x; the rest are spread, in argument order, over the slots
  const guards = ofRole('guard')
  const spread = guards.filter((id) => !atOf(id))
  const spreadX: number[] = []
  if (spread.length === 1) spreadX.push(lineEnd - DISCHARGE_SLOT)
  else if (spread.length > 1) {
    const a = Math.min(lineStart + INFEED_SLOT, lineEnd - DISCHARGE_SLOT)
    const b = lineEnd - DISCHARGE_SLOT
    spread.forEach((_id, i) => spreadX.push(a + ((b - a) * i) / (spread.length - 1)))
  }
  guards.forEach((id) => {
    const x = atOf(id)?.[0] ?? spreadX[spread.indexOf(id)]!
    const host = conveyorAt(x)
    if (!host) {
      notes.push(`${id}: no conveyor to seat it on; left at the origin`)
      return
    }
    if (atOf(id) && (x < lineStart || x > lineEnd)) notes.push(`${id}: x ${x} is off the line (${r3(lineStart)} to ${r3(lineEnd)})`)
    if (!snapOnto(id, [r3(x), surfaceAt(x) + 0.05, r3(halfWidth(host) + 0.05)], host.id)) notes.push(`${id}: nothing on ${host.id}'s guard engages it; left unseated`)
  })

  // 3. panel devices on the first conveyor's -Z frame side
  ofRole('panel').forEach((id, i) => {
    if (!first) {
      notes.push(`${id}: no conveyor frame to mount it on; left at the origin`)
      return
    }
    const x = atOf(id)?.[0] ?? lineStart + 0.3 + 0.25 * i
    if (!snapOnto(id, [r3(x), first.position[1], r3(-halfWidth(first) - 0.05)], first.id)) notes.push(`${id}: no face on ${first.id} engages it; left unseated`)
  })

  // 4. sources above the infeed, sinks past the discharge end, cargo on the belt, the rest beside the line
  ofRole('source').forEach((id, i) => {
    const s = get(id)
    // the box spawner drops each box from 0.2 m below its origin (its behavior's ctx.spawn offset): clear the belt
    const drop = 0.2 + numParam(s, 'height', 0.4) / 2 + 0.05
    const x = lineStart + numParam(s, 'length', 0.6) / 2 + 0.15 + i * 0.9
    // a source held by nothing is held with the belt it drops onto, so a stopped belt can't stack boxes (check-layout's
    // feed warning); a `conveyorId` given in --params is kept as it is
    const declared = pkgOf(s).params
    const hold: SdkPartParams = {}
    if (first && 'conveyorId' in declared && !s.params?.conveyorId) {
      hold.conveyorId = first.id
      if ('keepSpacing' in declared) hold.keepSpacing = true
    }
    set({ ...s, params: { ...s.params, ...hold }, position: atOf(id) ?? [r3(x), r3(surfaceAt(x) + drop), 0], rotationY: rotOf(id) ?? 0 })
  })
  ofRole('sink').forEach((id, i) => {
    const s = get(id)
    const fp = partFootprint(s)
    set({ ...s, position: atOf(id) ?? [r3(lineEnd + fp.hx - (fp.cx ?? 0) + i * 2 * fp.hx), r3(-fp.y0), 0], rotationY: rotOf(id) ?? 0 })
  })
  ofRole('cargo').forEach((id, i) => {
    const s = get(id)
    const fp = partFootprint(s)
    const x = lineStart + 0.5 + i * 0.8
    set({ ...s, position: atOf(id) ?? [r3(x), r3(surfaceAt(x) - fp.y0 + 0.005), 0], rotationY: rotOf(id) ?? s.rotationY })
  })
  ofRole('other').forEach((id, i) => {
    const s = get(id)
    const fp = partFootprint(s)
    const z = -halfWidth(first) - 1 - fp.hz
    const at = atOf(id)
    set({ ...s, position: at ?? [r3((lineStart + lineEnd) / 2 + i * 1.5), r3(-fp.y0), r3(z)], rotationY: rotOf(id) ?? s.rotationY })
    if (!at) notes.push(`${id}: placed on the floor beside the line; seat it with npm run snap-part -- ${s.packageId} --project <folder> --host <id> --id ${id} --write`)
  })

  // 5. what the program and the starter test will use, decided before anything is wired: a tag nothing reads or
  // drives is left blank, so the program's interface is what it uses and no more
  const eyeIds = guards.filter((id) => isPresenceSensor(pkgOf(get(id)))).sort((a, b) => get(a).position[0] - get(b).position[0])
  const dischargeId = eyeIds[eyeIds.length - 1]
  const sources = ofRole('source')
  const sinks = ofRole('sink')
  const infeedId = eyeIds.length > 1 && sources.length > 0 ? eyeIds[0] : undefined
  const fed = sources.length > 0 || ofRole('cargo').length > 0
  const holdAtEnd = dischargeId !== undefined && sinks.length === 0
  const testKind: 'hold' | 'sink' | 'ride' | 'feed' | null =
    fed && dischargeId && last ? (holdAtEnd ? 'hold' : 'sink') : fed && conveyors.length > 0 ? (ofRole('cargo').length > 0 ? 'ride' : 'feed') : null

  // 6. names and wiring. A tag param that already holds a name was given it (add-part's --params): it keeps it, and
  // the given names are reserved first so that nothing made up collides with them.
  const tagKeys = (p: SdkPart): string[] => {
    const specs = packageParamSpecs(pkgOf(p))
    // a tag its visibleWhen hides is not one of the part's signals (the part does not read it)
    return specs.filter((s) => s.kind === 'tagRef' && visibleWhenHolds(s.visibleWhen, s.visibleWhen ? switchValue(specs, p.params, s.visibleWhen.param) : undefined)).map((s) => s.key)
  }
  const givenName = (id: string, key: string): string | undefined => {
    const v = parts.find((p) => p.id === id)?.params[key]
    return typeof v === 'string' && v !== '' ? v : undefined
  }
  const taken = new Set([...(opts.takenTags ?? [])].map((t) => t.toUpperCase()))
  for (const p of parts) for (const key of tagKeys(p)) taken.add(givenName(p.id, key)?.toUpperCase() ?? '')
  taken.delete('')
  const unique = (base: string): string => {
    let name = base
    for (let n = 2; taken.has(name.toUpperCase()); n++) name = `${base}${n}`
    taken.add(name.toUpperCase())
    return name
  }
  const tags: ScaffoldTag[] = []
  const wired = new Set<string>() // `<partId>.<param>`
  const wire = (id: string, key: string, name: string): string => {
    const p = get(id)
    const pkg = pkgOf(p)
    const spec = pkg.params[key] as { dir?: string; stType?: string }
    const n = givenName(id, key) ?? unique(name)
    const params: SdkPartParams = { ...p.params, [key]: n }
    if (pkg.commsParam) params[pkg.commsParam] = true
    set({ ...p, params })
    wired.add(`${id}.${key}`)
    // a name two parts share (one run tag for two belts) is one variable: declared once, listing both owners
    const same = tags.find((t) => t.name.toUpperCase() === n.toUpperCase())
    if (same) same.owner = `${same.owner}, ${id}.${key}`
    else tags.push({ name: n, type: spec.stType ?? 'BOOL', dir: spec.dir === 'in' ? 'output' : 'input', owner: `${id}.${key}` })
    return n
  }

  const convRun: string[] = []
  let lastRun: string | undefined // the last conveyor's run tag: what holds a box at the discharge eye
  const perStem = new Map<string, number>()
  for (const id of conveyors) {
    const p = get(id)
    const stem = pascal(p.packageId.split('.').pop()!.replace(/-?conveyor$/, '')) || 'Conveyor'
    const n = (perStem.get(stem) ?? 0) + 1
    perStem.set(stem, n)
    if ('runTag' in pkgOf(p).params) {
      const name = wire(id, 'runTag', `${stem}${n}Run`)
      if (!convRun.includes(name)) convRun.push(name)
      if (id === last?.id) lastRun = name
    } else notes.push(`${id}: has no runTag, so the program cannot start and stop it; it runs on its own params`)
  }
  const discharge = dischargeId && (holdAtEnd || testKind === 'hold' || testKind === 'sink') ? wire(dischargeId, 'tag', 'DischargeEye') : undefined
  const infeed = infeedId ? wire(infeedId, 'tag', 'InfeedEye') : undefined
  const buttons: string[] = []
  ofRole('panel').forEach((id, i) => {
    const p = get(id)
    if (i < 2 && 'tag' in pkgOf(p).params) {
      const role = i === 0 ? 'Start' : 'Stop'
      const params: SdkPartParams = { ...p.params }
      if ('text' in pkgOf(p).params) params.text = role.toUpperCase()
      if (i === 0 && 'buttonColor' in pkgOf(p).params) params.buttonColor = '#2e9e44'
      set({ ...p, params })
      buttons.push(wire(id, 'tag', `${role}PB`))
    }
  })
  const sourceRun: string[] = []
  sources.forEach((id, i) => {
    const name = wire(id, 'runTag', `Spawner${i === 0 ? '' : i + 1}Run`)
    if (!sourceRun.includes(name)) sourceRun.push(name)
  })
  const sinkCount: string[] = []
  if (testKind === 'sink') {
    sinks.forEach((id, i) => {
      if ('countTag' in pkgOf(get(id)).params) sinkCount.push(wire(id, 'countTag', `Sink${i === 0 ? '' : i + 1}Count`))
    })
  }
  // any other tag given a name (a belt's speedTag, a conveyor's runningTag): the program declares it, so it connects
  for (const p of parts) {
    for (const key of tagKeys(get(p.id))) {
      const name = givenName(p.id, key)
      if (name && !wired.has(`${p.id}.${key}`)) wire(p.id, key, name)
    }
  }
  // the rest stay blank: say which (one line), so a reader knows they were left, not lost
  const blanks = parts
    .map((p) => ({ id: p.id, keys: tagKeys(get(p.id)).filter((k) => !wired.has(`${p.id}.${k}`) && !get(p.id).params[k]) }))
    .filter((b) => b.keys.length > 0)
  if (blanks.length) {
    notes.push(
      `left blank (unwired: nothing in the program or the test uses them): ${blanks.map((b) => `${b.id} ${b.keys.join(' ')}`).join('; ')}. ` +
        `To wire one, name it in that part's --params (${blanks[0]!.keys[0]}=<Name>) and the program declares it`,
    )
  }

  // 7. the program
  const startName = buttons[0] ?? unique('Start')
  const stopName = buttons[1] ?? unique('Stop')
  const running = unique('Running')
  const decl = (t: ScaffoldTag): string => `  ${t.name} : ${t.type};  (* ${t.owner} *)`
  const inputs = tags.filter((t) => t.dir === 'input')
  const outputs = tags.filter((t) => t.dir === 'output')
  const body: string[] = [`${running} := (${startName} OR ${running}) AND NOT ${stopName};`]
  for (const name of convRun) {
    const hold = name === lastRun && holdAtEnd
    body.push(`${name} := ${running}${hold ? ` AND NOT ${discharge}` : ''};${hold ? '  (* hold the box at the discharge eye *)' : ''}`)
  }
  const sourceGates = [infeed, holdAtEnd ? discharge : undefined].filter((n): n is string => n !== undefined)
  for (const name of sourceRun) body.push(`${name} := ${running}${sourceGates.map((g) => ` AND NOT ${g}`).join('')};`)
  const program =
    tags.length === 0
      ? null
      : [
          '(* Scaffolded by add-part --scaffold (src/core/lineScaffold.ts). A scene program is bare VAR blocks and statements,',
          '   no PROGRAM wrapper, so these names ARE the tags the parts are wired to. Replace the logic with your own. *)',
          'VAR_INPUT',
          ...inputs.map(decl),
          ...(buttons[0] ? [] : [`  ${startName} : BOOL;  (* no start button in the scene: a test (or a watch) presses it *)`]),
          ...(buttons[1] ? [] : [`  ${stopName} : BOOL;  (* no stop button in the scene: a test (or a watch) sets it *)`]),
          'END_VAR',
          ...(outputs.length ? ['VAR_OUTPUT', ...outputs.map(decl), 'END_VAR'] : []),
          'VAR',
          `  ${running} : BOOL;  (* starts stopped: ${startName} latches it, ${stopName} drops it *)`,
          'END_VAR',
          '',
          ...body,
          '',
        ].join('\n')

  // 8. a starter test that presses Start, then reads the world as well as the program
  let test: Record<string, unknown> | null = null
  const press = [
    { at: 0.5, tag: startName, value: true },
    { at: 1, tag: startName, value: false },
  ]
  // nothing moves before the press: the latch starts stopped
  const stoppedFirst = { always: true, until: 0.4, tag: running, equals: false }
  if ((testKind === 'hold' || testKind === 'sink') && discharge && dischargeId && last) {
    const eyeX = get(dischargeId).position[0]
    const y = surfaceAt(eyeX)
    const w = halfWidth(last)
    const zone = { min: [r3(eyeX - 0.6), r3(y), r3(-w)], max: [r3(eyeX + 0.8), r3(y + 1), r3(w)] }
    test =
      testKind === 'hold'
        ? {
            name: `starter: Start runs the line, a box reaches ${discharge} and the line holds it there`,
            duration: 20,
            inputs: press,
            // the eye sees it, nothing runs off the end onto the floor (what a line that did not hold it does), and
            // at the end a box is still there
            checks: [
              stoppedFirst,
              { eventually: true, within: 15, tag: discharge, equals: true },
              { always: true, probe: { count: { zone: { min: [r3(lineEnd), 0, -2], max: [r3(lineEnd + 3), r3(y - 0.1), 2] } } }, max: 0 },
              { at: 20, probe: { count: { zone } }, min: 1 },
            ],
          }
        : {
            name: `starter: Start runs the line, boxes pass ${discharge} and leave the line into the sink`,
            duration: 20,
            inputs: press,
            checks: [stoppedFirst, { eventually: true, within: 15, tag: discharge, equals: true }, ...sinkCount.map((n) => ({ eventually: true, within: 20, tag: n, min: 1 }))],
          }
  } else if (testKind === 'ride') {
    const box = ofRole('cargo')[0]!
    const target = r3(Math.min(lineEnd - 0.3, get(box).position[0] + 1))
    test = {
      name: `starter: Start runs the line and ${box} rides it`,
      duration: 10,
      inputs: press,
      checks: [stoppedFirst, { eventually: true, within: 10, min: target, probe: { pose: { part: box, axis: 'x' } } }],
    }
  } else if (testKind === 'feed') {
    const zone = { min: [r3(lineStart), r3(SCAFFOLD_STAND_HEIGHT - 0.1), -2], max: [r3(lineEnd), r3(SCAFFOLD_STAND_HEIGHT + 1.5), 2] }
    test = { name: 'starter: Start runs the line and the source feeds boxes onto it', duration: 10, inputs: press, checks: [stoppedFirst, { eventually: true, within: 10, probe: { count: { zone } }, min: 1 }] }
  } else notes.push(`no starter test: it needs a conveyor and something on it (a source or cargo); this scene has ${conveyors.length === 0 ? 'no conveyor' : 'no source or cargo'}`)

  // 9. what was given stays as given, whatever a step above set (a snap fits a sensor's range; wiring turns comms on)
  for (const p of parts) {
    const keys = (opts.given?.[p.id] ?? []).filter((k) => k in p.params)
    if (keys.length === 0) continue
    const cur = get(p.id)
    const params: SdkPartParams = { ...cur.params }
    for (const k of keys) params[k] = p.params[k]!
    set({ ...cur, params })
  }

  const programInputs = program === null ? [] : [...inputs.map((t) => t.name), ...(buttons[0] ? [] : [startName]), ...(buttons[1] ? [] : [stopName])]
  return { parts: parts.map((p) => get(p.id)), roles, tags, program, programInputs, test, notes }
}
