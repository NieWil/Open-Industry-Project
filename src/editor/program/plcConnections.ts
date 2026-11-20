// The PLC connections window's model (components/plc/PlcConnectionsWindow.tsx): the controllers it can list variables
// for, every machine's tag fields as one controller sees them, and the edit a connection is. A connection is nothing new
// in the document. It is the name in a part's tag field, the one the Inspector's Comms group shows, with the controller's
// name in front for a named controller (`Cell2::MAIN.Extend`, core/io/controllerTag.ts).

import { controllerTag, splitControllerTag } from '../../core/io/controllerTag'
import { eipTarget } from '../../core/io/eipTarget'
import type { EipTarget } from '../../core/io/eipTarget'
import { groupVariables } from '../../core/io/plcVariables'
import type { PlcVariable, PlcVariableGroup } from '../../core/io/plcVariables'
import type { PartInstance, SceneJSON, SdkPart } from '../../core/types'
import { deviceTags } from '../../plc/bindings'
import type { PlcSetup } from '../store/storePlcs'
import type { PlcLinkSettings } from '../store/storePrefs'
import type { ProgramTag } from './tagVerdicts'

/**
 * Where a controller's variables come from: the simulator's own program, or a PLC that lists its variables (TwinCAT over
 * ADS, a Logix controller over EtherNet/IP, an OPC UA server). The link's settings travel with it, so a read needs
 * nothing else.
 */
export type VariableSource =
  | { kind: 'program' }
  | { kind: 'ads'; netId: string; port: number }
  | ({ kind: 'eip' } & EipTarget)
  | { kind: 'opcua'; endpoint: string; from: readonly string[] }

/** A controller the window can list variables for. `name` is null for the default one. */
export interface ConnectableController {
  name: string | null
  label: string
  source: VariableSource
}

/** Where a PLC link's variables come from, or null for one that reads addresses, not names (Modbus, S7, SLMP). */
export function linkSource(link: PlcLinkSettings): VariableSource | null {
  if (link.mode === 'ads') return { kind: 'ads', netId: link.adsNetId, port: link.adsPort }
  if (link.mode === 'eip') return { kind: 'eip', ...eipTarget(link) }
  if (link.mode === 'opcua') return { kind: 'opcua', endpoint: link.opcUaEndpoint, from: link.opcUaBrowseFrom }
  return null
}

/**
 * Every controller whose variables the window can list, the default one first: the default one when the simulator runs
 * the program, and any controller on a PLC that lists its variables. A named controller the simulator runs is left out:
 * which program variables it answers to depends on its tasks, which this window does not read.
 */
export function connectableControllers(setup: PlcSetup): ConnectableController[] {
  const out: ConnectableController[] = []
  const main = setup.enabled ? linkSource(setup) : { kind: 'program' as const }
  if (main) out.push({ name: null, label: setup.mainName, source: main })
  for (const c of setup.controllers) {
    const source = c.runsOn === 'plc' ? linkSource(c) : null
    if (source) out.push({ name: c.name, label: c.name, source })
  }
  return out
}

/** The types a part's tag can carry a program variable of, and which of them is a bit. */
const NUMBERS = new Set(['SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT', 'ULINT', 'REAL', 'LREAL', 'BYTE', 'WORD', 'DWORD', 'LWORD'])

/**
 * The program's variables (tagVerdicts.ts programTagNames) as the window lists them: a single bit or number each,
 * grouped by the program instance a name starts with (`Main.Eye` in `Main`), the controller's own in the '' group.
 */
export function programVariableGroups(tags: readonly ProgramTag[]): PlcVariableGroup[] {
  const variables: PlcVariable[] = tags
    .filter((t) => t.type === 'BOOL' || NUMBERS.has(t.type))
    .map((t) => ({ name: t.name, short: t.name.slice(t.name.indexOf('.') + 1), typeName: t.type, kind: t.type === 'BOOL' ? 'bool' : 'number', ...(t.dir ? { dir: t.dir } : {}) }))
  return groupVariables(variables, (v) => (v.name === v.short ? '' : v.name.slice(0, v.name.indexOf('.'))), (g) => (g === '' ? 0 : 1))
}

/** One tag field of a machine, as one controller sees it. */
export interface ConnectionField {
  key: string
  label: string
  /** fromPlc: the machine reads it (a command); toPlc: the machine writes it (a sensor); null when undeclared */
  dir: 'fromPlc' | 'toPlc' | null
  type: 'BOOL' | 'INT' | 'DINT' | 'REAL' | null
  /** the PLC variable it is wired to on this controller, '' when none */
  variable: string
  /** the controller it is wired to instead, when it names another one (null: the default one) */
  elsewhere: string | null | undefined
}

export interface ConnectionMachine {
  id: string
  name: string
  kind: string
  /** its comms are on: a part switched off keeps the names in its fields, but Play binds none of them */
  enabled: boolean
  fields: ConnectionField[]
}

/** Every machine with tag fields, in scene order, each field with what it is wired to on `controller`. */
export function connectionMachines(parts: readonly PartInstance[], controller: string | null): ConnectionMachine[] {
  return deviceTags(parts).map((d) => ({
    id: d.id,
    name: d.name,
    kind: d.kind,
    enabled: d.enabled,
    fields: d.fields.map((f) => {
      const { controller: on, local } = splitControllerTag(f.value)
      // the spelling exactly: a run hands a controller only the tags that spell its name as it does
      // (core/io/controllerTag.ts tagsForController), so `cell2::` is not Cell2's
      const here = f.value !== '' && on === controller
      return {
        key: f.key,
        label: f.label,
        dir: f.section === 'VAR_OUTPUT' ? 'fromPlc' : f.section === 'VAR_INPUT' ? 'toPlc' : null,
        type: f.type,
        variable: here ? local : '',
        elsewhere: f.value === '' || here ? undefined : on,
      }
    }),
  }))
}

/** A connection as the window lists it. */
export interface Connection {
  partId: string
  machine: string
  key: string
  field: string
  dir: ConnectionField['dir']
  variable: string
}

/** The fields wired to `controller` that Play connects (comms on), in scene order. */
export function connectionsOf(machines: readonly ConnectionMachine[]): Connection[] {
  return machines.filter((m) => m.enabled).flatMap((m) => m.fields.filter((f) => f.variable !== '').map((f) => ({ partId: m.id, machine: m.name, key: f.key, field: f.label, dir: f.dir, variable: f.variable })))
}

/** The scene with part `partId`'s tag field `key` wired to `variable` on `controller` ('' disconnects it), or null when there is no such part. */
export function withConnection(scene: SceneJSON, partId: string, key: string, controller: string | null, variable: string): SceneJSON | null {
  const at = scene.parts.findIndex((p) => p.id === partId)
  const part = scene.parts[at]
  if (!part || part.type !== 'part') return null
  const params = { ...(part as SdkPart).params, [key]: controllerTag(controller, variable.trim()) }
  const parts = scene.parts.slice()
  parts[at] = { ...part, params } as SdkPart
  return { ...scene, parts }
}
