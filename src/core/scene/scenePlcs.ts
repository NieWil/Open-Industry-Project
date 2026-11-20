// The scene's controllers (SceneJSON.plcs): every PLC the project's tags reach, saved with the project so it travels
// to another computer and through a shared room, and so a rename or a removal is an edit that undoes.
//
// The first is the default controller: a tag with no controller name in front belongs to it (core/io/controllerTag.ts).
// Every other one is named by its tags (`Cell2::%IX0.0`). Each runs in the simulator or on a PLC outside it. In the
// simulator a controller runs the program instances the task table gives it (core/controller.ts ControllerProgram.plc),
// so a whole line of several PLCs can be built and tested here before one of them is real.
//
// Where each PLC is (an IP address, a port, a slot) is not here. That belongs to the bench, so each computer keeps it
// (editor/store/storePlcs.ts). This is the model IEC 61131-3 describes as a configuration holding several resources,
// each a controller of its own.

import { isControllerName } from '../io/controllerTag'
import type { SceneJSON } from '../types'

/**
 * How Play reaches a PLC. `serve`: the simulator is a Modbus TCP server the PLC polls. `poll`: the simulator polls the
 * PLC's Modbus TCP server. `opcua`, `eip`, `ads`: the PLC's tags by name. `s7`: an S7 CPU's memory over PUT/GET.
 * `slmp`: a MELSEC CPU's devices.
 */
export type PlcProtocol = 'serve' | 'poll' | 'opcua' | 'eip' | 's7' | 'slmp' | 'ads'
export const PLC_PROTOCOLS: readonly PlcProtocol[] = ['serve', 'poll', 'opcua', 'eip', 's7', 'slmp', 'ads']

export interface ScenePlc {
  /** a controller name (isControllerName); unique among the scene's, ignoring case */
  name: string
  /** `app`: the simulator runs it, the program instances the task table gives it; `plc`: a PLC outside the app */
  runsOn: 'app' | 'plc'
  /** how Play reaches it when it is a PLC */
  protocol: PlcProtocol
  /** Play connects it; false leaves its tags unconnected, for a PLC that is not wired up yet */
  connect: boolean
  /**
   * Watch only: Play reads every tag from the PLC, the ones parts write included, and writes nothing to it. For a
   * PLC that runs real equipment, whose inputs come from that equipment and must never be overwritten by the
   * simulator's (docs/live-share.md). Not over Modbus: the simulator cannot read a PLC's inputs there.
   */
  watch?: true
}

/** Whether a protocol can watch a PLC: it has to read what the simulator would otherwise write. */
export const canWatch = (protocol: PlcProtocol): boolean => protocol !== 'serve' && protocol !== 'poll'

/** How many controllers a scene holds: the desktop shell numbers a window's links below 32. */
export const MAX_SCENE_PLCS = 32

/** The default controller's name in a scene that has not named it: PLC1, or the first PLCn no other controller has. */
export function defaultPlcName(taken: readonly string[]): string {
  const lower = new Set(taken.map((n) => n.toLowerCase()))
  let n = 1
  while (lower.has(`plc${n}`)) n++
  return `PLC${n}`
}

/**
 * A scene's controller list from untrusted JSON, with what was repaired said in `repairs`. An entry that cannot be read
 * is dropped. Undefined when there is no list, or none of it could be read: the scene then has not set its controllers
 * (editor/store/storePlcs.ts says what that means).
 */
export function validateScenePlcs(raw: unknown, repairs: string[]): ScenePlc[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) {
    repairs.push('plcs is not a list, so it is ignored')
    return undefined
  }
  const out: ScenePlc[] = []
  raw.forEach((r: unknown, i) => {
    const o = typeof r === 'object' && r !== null ? (r as Record<string, unknown>) : {}
    const name = o.name
    if (typeof name !== 'string' || !isControllerName(name)) return repairs.push(`plcs[${i}] has no controller name, so it is dropped`)
    if (out.some((p) => p.name.toLowerCase() === name.toLowerCase())) return repairs.push(`plcs[${i}] (${name}) repeats a name, so it is dropped`)
    if (out.length >= MAX_SCENE_PLCS) return repairs.push(`plcs[${i}] (${name}) is past the ${MAX_SCENE_PLCS} a scene holds, so it is dropped`)
    const runsOn: ScenePlc['runsOn'] = o.runsOn === 'app' ? 'app' : 'plc'
    if (o.runsOn !== 'app' && o.runsOn !== 'plc') repairs.push(`plcs[${i}] (${name}) runs on ${JSON.stringify(o.runsOn)}, so it is a PLC`)
    const protocol = PLC_PROTOCOLS.includes(o.protocol as PlcProtocol) ? (o.protocol as PlcProtocol) : 'serve'
    if (o.protocol !== protocol) repairs.push(`plcs[${i}] (${name}) has protocol ${JSON.stringify(o.protocol)}, so it is serve`)
    out.push({ name, runsOn, protocol, connect: o.connect !== false, ...(o.watch === true ? { watch: true as const } : {}) })
  })
  return out.length > 0 ? out : undefined
}

/**
 * The fields a scene carries besides its parts and packages, which every copy of a scene keeps: its Units, its Length,
 * its controllers and the values its displays show. Spread into a scene being rebuilt, so a new field cannot be dropped
 * by one copy that forgot it.
 */
type SceneSettings = Pick<SceneJSON, 'units' | 'lengthUnit' | 'plcs' | 'display'>
export function sceneSettings(scene: SceneSettings): SceneSettings {
  return {
    ...(scene.units !== undefined ? { units: scene.units } : {}),
    ...(scene.lengthUnit !== undefined ? { lengthUnit: scene.lengthUnit } : {}),
    ...(scene.plcs !== undefined ? { plcs: scene.plcs } : {}),
    ...(scene.display !== undefined && scene.display.length > 0 ? { display: scene.display } : {}),
  }
}
