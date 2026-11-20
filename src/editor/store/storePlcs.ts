// The scene's controllers as Play uses them: the project's list (SceneJSON.plcs, core/scene/scenePlcs.ts) with this
// computer's addresses filled in (ExternalPlcSettings, storePrefs.ts), and the edits that change either.
//
// What a controller is belongs to the project: its name, whether the program here runs it, its protocol, and whether
// Play connects it. Those are edits, with undo, and they travel with the project and through a room. Where it is
// belongs to the bench: an IP address, a port, a slot. Those stay on this computer as preferences, keyed by the
// controller's name, and the default controller's are the top-level fields. A controller this computer has no address
// for gets the default ones, on a port of its own.
//
// A scene saved before scenes carried controllers has no list. Its controllers are then derived as they were before:
// the default runs where this computer's settings say, and a named controller its tags use is listed when this computer
// has it set up. Only names the scene's own tags use, so one project's controllers never appear in another. The first
// edit of the list writes it into the scene.

import { controllerOf, controllersUsed, isControllerName, moveTagToController, tagParamKeys } from '../../core/io/controllerTag'
import { memoizeByParticipants } from '../../core/memoParts'
import { defaultPlcName, MAX_SCENE_PLCS } from '../../core/scene/scenePlcs'
import type { ScenePlc } from '../../core/scene/scenePlcs'
import type { PartInstance, SceneJSON } from '../../core/types'
import type { Controller } from '../../core/controller'
import { keepLastValid, MAX_KEPT_ADDRESSES, sanitizeExternalPlc, sanitizePlcLink, sanitizeUaServer } from './storePrefs'
import type { ExternalPlcSettings, NamedPlcLink, PlcLinkSettings, UaServerSettings } from './storePrefs'

/** A named controller as Play uses it: its link to a PLC, and whether the simulator runs it instead. */
export interface PlcSetupController extends NamedPlcLink {
  /** `app`: the simulator runs it (the program instances the task table gives it), and its link is not opened */
  runsOn: 'app' | 'plc'
}

/** The links Play opens: the default controller's at the top level, every named one in `controllers`, in list order. */
export interface PlcSetup extends ExternalPlcSettings {
  controllers: readonly PlcSetupController[]
  /** the default controller's name, which its tags never carry */
  mainName: string
  /** the scene has its own list; false while it is derived (a scene saved before scenes had one) */
  saved: boolean
}

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** The controllers a scene's tags name, kept while no tagged part changes, so a drag costs a pass over references. */
const usedBy = memoizeByParticipants((p) => p.type === 'part', controllersUsed)

/** The scene's controllers: its own list, or, for a scene without one, the list derived as it was before scenes had one. */
export function scenePlcsOf(scene: Pick<SceneJSON, 'plcs' | 'parts'>, prefs: ExternalPlcSettings): ScenePlc[] {
  if (scene.plcs) return [...scene.plcs]
  const used = usedBy(scene.parts)
  const named: ScenePlc[] = prefs.controllers
    .filter((c) => used.some((u) => sameName(u, c.name)))
    .map((c) => ({ name: c.name, runsOn: 'plc', protocol: c.mode, connect: c.enabled }))
  const main: ScenePlc = { name: defaultPlcName([...used, ...named.map((c) => c.name)]), runsOn: prefs.enabled ? 'plc' : 'app', protocol: prefs.mode, connect: true }
  return [main, ...named].slice(0, MAX_SCENE_PLCS)
}

/**
 * The controllers of `list` with this computer's addresses. A named controller with none of its own gets the default
 * link on the first port after the default controller's that no other link uses, since two links serving on one port
 * cannot both listen, and an OPC UA server port the same way after the default controller's.
 */
function setupFor(list: readonly ScenePlc[], prefs: ExternalPlcSettings, saved: boolean): PlcSetup {
  const main = list[0]!
  const keptOf = (name: string): NamedPlcLink | undefined => prefs.controllers.find((k) => sameName(k.name, name))
  const kept = list.slice(1).flatMap((c) => keptOf(c.name) ?? [])
  const next = (taken: Set<number>, from: number) => {
    let free = from
    return (): number => {
      do free = free >= 65535 ? 1024 : free + 1
      while (taken.has(free))
      taken.add(free)
      return free
    }
  }
  const freePort = next(new Set([prefs.port, ...kept.map((k) => k.port)]), prefs.port)
  const freeUaPort = next(new Set([prefs.uaServerPort, ...kept.map((k) => k.uaServerPort)]), prefs.uaServerPort)
  const controllers: PlcSetupController[] = list.slice(1).map((c) => {
    const link: PlcLinkSettings & UaServerSettings = keptOf(c.name) ?? { ...sanitizePlcLink({}), port: freePort(), ...sanitizeUaServer({}, freeUaPort()) }
    return { ...link, name: c.name, mode: c.protocol, enabled: c.connect, runsOn: c.runsOn, watch: c.watch === true }
  })
  return { ...prefs, enabled: main.runsOn === 'plc', mode: main.protocol, watch: main.watch === true, controllers, mainName: main.name, saved }
}

let memo: { plcs: readonly ScenePlc[] | undefined; used: readonly string[] | null; prefs: ExternalPlcSettings; setup: PlcSetup } | null = null

/** The scene's controllers with this computer's addresses, memoized on the list (or the tags' names) and the preferences. */
export function plcSetupOf(scene: Pick<SceneJSON, 'plcs' | 'parts'>, prefs: ExternalPlcSettings): PlcSetup {
  const used = scene.plcs ? null : usedBy(scene.parts)
  if (memo && memo.plcs === scene.plcs && memo.used === used && memo.prefs === prefs) return memo.setup
  const setup = setupFor(scenePlcsOf(scene, prefs), prefs, scene.plcs !== undefined)
  memo = { plcs: scene.plcs, used, prefs, setup }
  return setup
}

/** What the controller edits need of the store. */
export interface PlcStore {
  getState(): { scene: SceneJSON; plcPrefs: ExternalPlcSettings; packageEdit: unknown; readOnly: boolean; controller: Controller | null }
  commit(label: string, scene: SceneJSON): void
  /** the task table and the scene as one edit (EditorStore.commitProgram) */
  commitProgram(label: string, next: { controller: Controller | null }, opts: { scene: SceneJSON }): void
  setPlcPrefs(prefs: ExternalPlcSettings): void
}

/** The scene's list, for an edit: none while the Catalog ✎ session holds a part's scene, or in a read-only document. */
function editable(store: PlcStore): ScenePlc[] | null {
  const s = store.getState()
  return s.packageEdit || s.readOnly ? null : scenePlcsOf(s.scene, s.plcPrefs)
}

/** The index of the controller called `name` in `list` (ignoring case), or -1. */
const indexOf = (list: readonly ScenePlc[], name: string): number => list.findIndex((c) => sameName(c.name, name))

/** Why `name` cannot be a new controller's in `list`, or null. */
export function refusedName(list: readonly ScenePlc[], name: string): 'name' | 'taken' | 'full' | null {
  if (!isControllerName(name)) return 'name'
  if (indexOf(list, name) >= 0) return 'taken'
  return list.length >= MAX_SCENE_PLCS ? 'full' : null
}

/** `list` with a new PLC controller called `name`, connected on Play over the default protocol. */
export const withPlc = (list: readonly ScenePlc[], name: string): ScenePlc[] => [...list, { name, runsOn: 'plc', protocol: 'serve', connect: true }]

/**
 * Keep the address a new controller was given, so it does not move when the list above it changes: a computer's
 * address for a controller is the one it had, once it has had one.
 */
function keepAddress(store: PlcStore, list: readonly ScenePlc[], name: string): void {
  const s = store.getState()
  const link = setupFor(list, s.plcPrefs, true).controllers.find((c) => c.name === name)
  if (link) putAddress(store, link)
}

/** This computer's address for a named controller, replacing any it had under that name; the oldest go past the limit. */
function putAddress(store: PlcStore, link: NamedPlcLink): void {
  const prefs = store.getState().plcPrefs
  const rest = prefs.controllers.filter((c) => !sameName(c.name, link.name))
  store.setPlcPrefs({ ...prefs, controllers: [...rest, link].slice(-MAX_KEPT_ADDRESSES) })
}

/** Add a PLC controller called `name` to the scene, as one edit. False when the name is refused or the list is full. */
export function addPlc(store: PlcStore, name: string): boolean {
  const list = editable(store)
  if (!list || refusedName(list, name) !== null) return false
  const next = withPlc(list, name)
  store.commit(`Add controller ${name}`, { ...store.getState().scene, plcs: next })
  keepAddress(store, next, name)
  return true
}

/** Remove a named controller from the scene, as one edit. The parts keep their tags; the default controller stays. */
export function removePlc(store: PlcStore, name: string): void {
  const list = editable(store)
  const at = list ? indexOf(list, name) : -1
  if (!list || at <= 0) return
  store.commit(`Remove controller ${list[at]!.name}`, { ...store.getState().scene, plcs: list.filter((_, i) => i !== at) })
}

/**
 * Rename a controller, and every tag of the scene on it and every task and instance that names it, as one edit. The
 * default controller's tags carry no name, so its rename moves no tag (a task may still spell it). This computer keeps the address under both names, so an undo finds it too.
 * False when `to` is not a controller name or another controller has it.
 */
export function renamePlc(store: PlcStore, from: string, to: string): boolean {
  const list = editable(store)
  const at = list ? indexOf(list, from) : -1
  if (!list || at < 0 || !isControllerName(to) || list.some((c, i) => i !== at && sameName(c.name, to))) return false
  const old = list[at]!.name
  if (old === to) return true
  const scene = store.getState().scene
  const tagged = at === 0 ? scene : (renameControllerInScene(scene, old, to).scene ?? scene)
  const plcs = list.map((c, i) => (i === at ? { ...c, name: to } : c))
  // the tasks and instances that name it follow, in the same edit: left on the old name, nothing would run them
  const table = store.getState().controller
  const renamed = table ? renamedInTable(table, old, to) : null
  const label = `Rename controller ${old} to ${to}`
  if (renamed) store.commitProgram(label, { controller: renamed }, { scene: { ...tagged, plcs } })
  else store.commit(label, { ...tagged, plcs })
  if (at > 0) {
    const link = setupFor(list, store.getState().plcPrefs, true).controllers.find((c) => c.name === old)
    if (link) putAddress(store, { ...link, name: to })
  }
  return true
}

/** `table` with every task and instance that names `from` (in any case) naming `to`; null when none does. */
export function renamedInTable(table: Controller, from: string, to: string): Controller | null {
  const on = (plc: string | undefined): boolean => plc !== undefined && sameName(plc, from)
  if (!table.tasks.some((t) => on(t.plc)) && !table.programs.some((p) => on(p.plc))) return null
  return {
    ...table,
    tasks: table.tasks.map((t) => (on(t.plc) ? { ...t, plc: to } : t)),
    programs: table.programs.map((p) => (on(p.plc) ? { ...p, plc: to } : p)),
  }
}

/**
 * The scene with every tag on `from` moved to `to`: a controller's rename, as far as the document goes. A tag that
 * spells `from` in another case is on it too (IEC names ignore case), and is moved with the rest.
 */
export function renameControllerInScene(scene: SceneJSON, from: string, to: string): { scene: SceneJSON | null; tags: number; parts: number } {
  const on = (raw: unknown): boolean => typeof raw === 'string' && controllerOf(raw.trim())?.toLowerCase() === from.toLowerCase()
  const ids = scene.parts.filter((p) => {
    const params = typeof p.params === 'object' && p.params !== null ? (p.params as Record<string, unknown>) : {}
    return tagParamKeys(p).some((key) => on(params[key]))
  })
  const chosen = new Set(ids.map((p) => p.id))
  let tags = 0
  const parts = scene.parts.map((p): PartInstance => {
    if (!chosen.has(p.id)) return p
    const params = { ...(p.params as Record<string, unknown>) }
    for (const key of tagParamKeys(p)) {
      const raw = params[key]
      if (typeof raw !== 'string' || !on(raw)) continue
      params[key] = moveTagToController(raw, to)
      tags++
    }
    return { ...p, params } as PartInstance
  })
  return { scene: tags > 0 ? { ...scene, parts } : null, tags, parts: chosen.size }
}

/** Run a controller (`name` null: the default one) in the simulator or on a PLC outside it, as one edit. */
export function setRunsOn(store: PlcStore, name: string | null, runsOn: ScenePlc['runsOn']): void {
  const list = editable(store)
  const at = !list ? -1 : name === null ? 0 : indexOf(list, name)
  if (!list || at < 0 || list[at]!.runsOn === runsOn) return
  const entry = list[at]!
  store.commit(runsOn === 'app' ? `Run ${entry.name} in the simulator` : `Run ${entry.name} on a PLC`, { ...store.getState().scene, plcs: list.map((c, i) => (i === at ? { ...c, runsOn } : c)) })
}

/**
 * What runs controller `name` (null: the default one), adding it to the list first when the project does not list it,
 * as one edit under `label` (an agent's tool is one undo step). Why it could not, or null: 'locked' in a read-only
 * document or the Catalog ✎ session, else refusedName's reason.
 */
export function setRunsOnAdding(store: PlcStore, name: string | null, runsOn: ScenePlc['runsOn'], label: string): 'locked' | 'name' | 'taken' | 'full' | null {
  const list = editable(store)
  if (!list) return 'locked'
  const at = name === null ? 0 : indexOf(list, name)
  let next: ScenePlc[]
  if (at >= 0) next = list.map((c, i) => (i === at ? { ...c, runsOn } : c))
  else {
    const why = refusedName(list, name!)
    if (why !== null) return why
    next = withPlc(list, name!).map((c) => (c.name === name ? { ...c, runsOn } : c))
  }
  if (at >= 0 && list[at]!.runsOn === runsOn) return null
  store.commit(label, { ...store.getState().scene, plcs: next })
  if (at < 0) keepAddress(store, next, name!)
  return null
}

/** The fields of a link that are the project's: whether Play connects it (or, for the default, runs it on a PLC), its protocol, and whether it only watches. */
const PROJECT_KEYS = ['enabled', 'mode', 'watch'] as const

/**
 * Change a controller's link (any subset; `name` null is the default one). Whether it runs on a PLC or is connected,
 * and its protocol, are the project's, an edit with undo. The rest is this computer's address, kept as a preference,
 * where an invalid value keeps the last valid one.
 */
export function setPlcLink(store: PlcStore, name: string | null, patch: Partial<ExternalPlcSettings>): void {
  const s = store.getState()
  const list = scenePlcsOf(s.scene, s.plcPrefs)
  const at = name === null ? 0 : indexOf(list, name)
  if (at < 0) return
  const entry = list[at]!
  const doc: Partial<ScenePlc> = {}
  if (patch.enabled !== undefined) Object.assign(doc, at === 0 ? { runsOn: patch.enabled ? 'plc' : 'app' } : { connect: patch.enabled })
  if (patch.mode !== undefined) doc.protocol = patch.mode
  if (patch.watch !== undefined) doc.watch = patch.watch ? true : undefined
  const changed = (Object.keys(doc) as (keyof ScenePlc)[]).filter((k) => doc[k] !== entry[k])
  if (changed.length > 0 && editable(store)) {
    const label =
      doc.runsOn !== undefined && doc.runsOn !== entry.runsOn
        ? doc.runsOn === 'plc'
          ? 'Run on an external PLC'
          : 'Run the program here'
        : doc.connect !== undefined && doc.connect !== entry.connect
          ? `${doc.connect ? 'Connect' : 'Disconnect'} ${entry.name}`
          : 'watch' in doc && doc.watch !== entry.watch
            ? `${doc.watch ? 'Only watch' : 'Stop only watching'} ${entry.name}`
            : `Change ${entry.name}'s protocol`
    const merged = (c: ScenePlc): ScenePlc => {
      const next = { ...c, ...doc }
      if (!next.watch) delete next.watch
      return next
    }
    store.commit(label, { ...s.scene, plcs: list.map((c, i) => (i === at ? merged(c) : c)) })
  }
  const address = Object.fromEntries(Object.entries(patch).filter(([k]) => !(PROJECT_KEYS as readonly string[]).includes(k))) as Partial<ExternalPlcSettings>
  if (Object.keys(address).length === 0) return
  const prefs = store.getState().plcPrefs
  if (at === 0) {
    const next = sanitizeExternalPlc({ ...prefs, ...address })
    keepLastValid(next, prefs, address)
    if (address.uaServerPort !== undefined && next.uaServerPort !== address.uaServerPort) next.uaServerPort = prefs.uaServerPort
    if (address.controllers === undefined) next.controllers = prefs.controllers
    // the project's fields stay as this computer had them, for a scene without a list of its own
    next.enabled = prefs.enabled
    next.mode = prefs.mode
    if ((Object.keys(next) as (keyof ExternalPlcSettings)[]).some((k) => next[k] !== prefs[k])) store.setPlcPrefs(next)
    return
  }
  const cur = setupFor(list, prefs, true).controllers.find((c) => sameName(c.name, entry.name))!
  const next: NamedPlcLink = { ...sanitizePlcLink({ ...cur, ...address }), ...sanitizeUaServer({ ...cur, ...address }, cur.uaServerPort), name: cur.name }
  keepLastValid(next, cur, address)
  if ((Object.keys(next) as (keyof NamedPlcLink)[]).some((k) => next[k] !== cur[k])) putAddress(store, next)
}

/**
 * The scene's list with `name` added, for an edit that also writes tags on it (Assign to Controller), so the two are
 * one undo step. Null when it is already listed or cannot be added; `name` is then used as it is.
 */
export function plcsWithAdded(store: PlcStore, name: string): ScenePlc[] | null {
  const list = editable(store)
  return list && refusedName(list, name) === null ? withPlc(list, name) : null
}

/** After an edit that added `name` to the scene's list (plcsWithAdded), keep the address it was given. */
export function keepAddedAddress(store: PlcStore, name: string): void {
  keepAddress(store, store.getState().scene.plcs ?? [], name)
}

