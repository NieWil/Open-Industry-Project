// The scene half of "Assign I/O" and "Import I/O list" (plc/ioAssign.ts is the program half).
//
// A part's PLC tag holds a program name (`Eye`) or an I/O point (`%IX100.0`). These commands move a scene
// from the first to the second: each tag a part is wired to by name is given an address, declared at it in
// the program (`Eye AT %IX100.0 : BOOL`), and every part wired to the name is rewired to the address, as
// one undo step (store.commitProgram). Nothing about it needs a PLC to be connected, or the desktop app:
// it is a program and wiring edit, which the external PLC link then serves.
//
// Which parts: those with comms enabled, as the wiring check and the link count them, plus annotations that
// show a renamed tag. A part already wired to an address the program locates counts as that name's, so
// moving the name (an imported list can) moves it.

import { ioDirection, registerImagePointWhere } from '../../core/io/externalIo'
import { commsOn as partCommsOn } from '../../core/conveyor/conveyorDirection'
import { controllerOf } from '../../core/io/controllerTag'
import { canonicalAddress, looksLikeAddress } from '../../core/io/iecAddress'
import { packageParamSpecs } from '../../core/packageParams'
import { partDisplayNames } from '../../core/parts/partDisplayName'
import { getPackage } from '../../core/parts/partRegistry'
import type { PartInstance, SceneJSON } from '../../core/types'
import { locatedVariables } from '../../plc'
import { locateTags, parseIoList, planIoAssignment, planIoImport, SERVER_TARGET, type IoPlan, type IoTagUse, type IoTarget } from '../../plc/ioAssign'
import { identKey } from '../../plc/program'
import { deriveClientIo, deriveExternalIo, pointWhere } from '../links/externalPlc'
import type { EditorStore } from '../store/store'
import { DEFAULT_EXTERNAL_PLC, type ExternalPlcSettings } from '../store/storePrefs'

export interface IoReport {
  headline: string
  assigned: { name: string; address: string; parts: number }[]
  skipped: { name: string; reason: string }[]
}

export interface IoEdit {
  source: string
  /** null when no part changed */
  scene: SceneJSON | null
  report: IoReport
}

interface TagParam {
  key: string
  dir?: 'in' | 'out'
  stType?: IoTagUse['stType']
}

function tagParams(part: PartInstance): TagParam[] {
  if (part.type === 'annotation') return [{ key: 'tag' }]
  if (part.type !== 'part') return []
  const pkg = getPackage((part as { packageId?: string }).packageId ?? '')
  if (!pkg) return []
  return packageParamSpecs(pkg)
    .filter((s) => s.kind === 'tagRef')
    .map((s) => ({ key: s.key, ...(s.dir === 'in' || s.dir === 'out' ? { dir: s.dir } : {}), ...(s.stType ? { stType: s.stType } : {}) }))
}

const paramsOf = (part: PartInstance): Record<string, unknown> => (part as { params?: Record<string, unknown> }).params ?? {}
const commsOn = (part: PartInstance): boolean => part.type === 'part' && partCommsOn(part)

/** A tag value as the scene means it: an address in its one spelling, or a name. */
function tagValue(raw: unknown): { address: string } | { name: string } | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  // a tag on another controller (`Cell2::%IX0.0`, core/io/controllerTag.ts) is that PLC's, not this program's to place
  if (v === '' || controllerOf(v) !== null) return null
  return looksLikeAddress(v) ? { address: canonicalAddress(v) ?? v } : { name: v }
}

/** What the scene's parts need from the program's tags, and the addresses they already sit on. */
function sceneIo(parts: readonly PartInstance[], located: Map<string, string>): { uses: IoTagUse[]; addresses: string[] } {
  const uses: IoTagUse[] = []
  const addresses: string[] = []
  for (const part of parts) {
    if (!commsOn(part)) continue
    for (const p of tagParams(part)) {
      if (!p.dir) continue
      const v = tagValue(paramsOf(part)[p.key])
      if (!v) continue
      const use = { dir: p.dir, ...(p.stType ? { stType: p.stType } : {}) }
      if ('address' in v) {
        addresses.push(v.address)
        const name = located.get(v.address)
        if (name !== undefined) uses.push({ name, ...use })
      } else uses.push({ name: v.name, ...use })
    }
  }
  return { uses, addresses }
}

/**
 * The scene with each part wired to a located name, or to an address that moved, wired to its address.
 * Counts the parts per name, for the report.
 */
function rewire(scene: SceneJSON, before: Map<string, string>, after: Map<string, string>): { scene: SceneJSON | null; counts: Map<string, number> } {
  const addressOf = new Map<string, string>()
  for (const [address, name] of after) addressOf.set(identKey(name), address)
  const moved = new Map<string, string>()
  for (const [address, name] of before) {
    const now = addressOf.get(identKey(name))
    if (now !== undefined && now !== address) moved.set(address, now)
  }
  let changed = false
  const parts = scene.parts.map((part) => {
    if (part.type === 'part' && !commsOn(part)) return part
    let next: Record<string, unknown> | null = null
    for (const p of tagParams(part)) {
      const v = tagValue(paramsOf(part)[p.key])
      const to = !v ? undefined : 'address' in v ? moved.get(v.address) : addressOf.get(identKey(v.name))
      if (to === undefined || paramsOf(part)[p.key] === to) continue
      next ??= { ...paramsOf(part) }
      next[p.key] = to
    }
    if (!next) return part
    changed = true
    return { ...part, params: next } as PartInstance
  })
  // parts wired to each located name once the edit is done, one count per part however many of its tags it is
  const counts = new Map<string, number>()
  for (const part of parts) {
    if (!commsOn(part)) continue
    const names = new Set<string>()
    for (const p of tagParams(part)) {
      const v = tagValue(paramsOf(part)[p.key])
      const name = v && 'address' in v ? after.get(v.address) : undefined
      if (name !== undefined) names.add(name)
    }
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return { scene: changed ? { ...scene, parts } : null, counts }
}

function applyPlan(scene: SceneJSON, source: string, plan: IoPlan, headline: string): IoEdit {
  const next = locateTags(source, plan.assignments)
  const wired = rewire(scene, locatedVariables(source), locatedVariables(next))
  return {
    source: next,
    scene: wired.scene,
    report: {
      headline,
      assigned: plan.assignments.map((a) => ({ name: a.name, address: a.address, parts: wired.counts.get(a.name) ?? 0 })),
      skipped: plan.skipped,
    },
  }
}

/**
 * The addressing the external-PLC link will use: a PLC that serves its process image (the dock's "the
 * simulator polls the PLC") packs points from its server device's first register, and bits share words
 * there; otherwise points start where OpenPLC's Editor maps a remote device (plc/ioAssign.ts, IoTarget).
 */
export function ioTargetFor(settings: Pick<ExternalPlcSettings, 'mode' | 'inputBase' | 'outputBase'>): IoTarget {
  return settings.mode === 'poll' ? { kind: 'register-image', base: { input: settings.inputBase, output: settings.outputBase } } : SERVER_TARGET
}

/** "Assign I/O": an address for every tag a part is wired to by name. */
export function assignIo(scene: SceneJSON, source: string, target: IoTarget = SERVER_TARGET): IoEdit {
  const io = sceneIo(scene.parts, locatedVariables(source))
  const plan = planIoAssignment(source, io.uses, io.addresses, target)
  return applyPlan(scene, source, plan, 'Assign I/O Addresses')
}

/** "Import I/O list": the addresses a CSV gives, for the tags the program or the scene uses. */
export function importIoList(scene: SceneJSON, source: string, text: string, target: IoTarget = SERVER_TARGET): IoEdit {
  const io = sceneIo(scene.parts, locatedVariables(source))
  const list = parseIoList(text)
  const plan = planIoImport(source, io.uses, list.rows, io.addresses, target)
  const unread = list.problems.map((p) => ({ name: '', reason: p }))
  return applyPlan(scene, source, { assignments: plan.assignments, skipped: [...unread, ...plan.skipped] }, 'Import I/O list')
}

/** One line for the report's head: what changed, in counts. */
export function reportSummary(r: IoReport): string {
  const moved = r.assigned.length
  const parts = r.assigned.reduce((n, a) => n + a.parts, 0)
  const head =
    moved === 0
      ? 'No tag was given an address.'
      : `${moved} tag${moved === 1 ? '' : 's'} at an I/O address, ${parts} part${parts === 1 ? '' : 's'} wired to ${moved === 1 ? 'it' : 'them'}.`
  const skipped = r.skipped.length > 0 ? ` ${r.skipped.length} left as ${r.skipped.length === 1 ? 'it was' : 'they were'}.` : ''
  return `${head}${skipped}`
}

/** A CSV cell: quoted only when it has to be, so the file stays readable in a text editor. */
function cell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

/**
 * The scene's I/O list as CSV: the document a controls engineer works from, and the one this app reads
 * back ({@link importIoList} takes its own output unchanged).
 *
 * It lists the points: the parts wired to an address. A part still wired to a program name has no point
 * yet, so it is not a row here; Assign I/O is what gives it one. `Tag` is what the program calls the
 * point, which is blank when the program declares nothing at that address: the address is what travels,
 * the name is a courtesy to whoever reads the file.
 */
export function ioListCsv(scene: SceneJSON, source: string, projectName = '', settings: ExternalPlcSettings = DEFAULT_EXTERNAL_PLC): string {
  const located = locatedVariables(source)
  // the Modbus point column is the link's: where the simulator serves it, or where it finds it on the PLC's server
  const points =
    settings.mode === 'poll'
      ? deriveClientIo(scene.parts, settings).io.points.map((p) => ({ tag: p.tag, type: p.type, toPlc: p.area === 'holdingRegister', where: registerImagePointWhere(p) }))
      : deriveExternalIo(scene.parts, settings).io.points.map((p) => ({ tag: p.tag, type: p.type, toPlc: ioDirection(p.area) === 'toPlc', where: pointWhere(p) }))
  // which part, and which of its parameters, sits on each address
  const devices = new Map<string, string[]>()
  const names = partDisplayNames(scene.parts)
  for (const part of scene.parts) {
    if (!commsOn(part)) continue
    for (const p of tagParams(part)) {
      const v = tagValue(paramsOf(part)[p.key])
      if (!v || !('address' in v)) continue
      devices.set(v.address, [...(devices.get(v.address) ?? []), `${names.get(part.id) ?? part.id}.${p.key}`])
    }
  }
  const rows = points.map((p) =>
    [
      cell(located.get(p.tag) ?? ''),
      cell(p.tag),
      cell(p.type ?? 'BOOL'),
      // the PLC's side of it: what the scene publishes is the PLC's input
      cell(p.toPlc ? 'PLC input' : 'PLC output'),
      cell(p.where),
      cell((devices.get(p.tag) ?? []).join(' + ')),
    ].join(','),
  )
  const head = projectName ? [`# I/O list - ${projectName}`] : []
  const empty = rows.length === 0 ? ['# no part is wired to an I/O address yet: run Assign I/O to give the scene its points'] : []
  return [...head, 'Tag,Address,Type,Direction,Modbus point,Device', ...rows, ...empty].join('\n') + '\n'
}

/** Download the scene's I/O list. A pure export: nothing about the document changes. */
export function exportIoList(store: EditorStore): void {
  const s = store.getState()
  const name = (s.projectName || 'scene').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'scene'
  const url = URL.createObjectURL(new Blob([ioListCsv(s.scene, s.stProgram, s.projectName, s.externalPlc)], { type: 'text/csv' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${name}-io-list.csv`
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Commit an edit as one undo step, and say what it did in the PLC panel's report card, under the code it changed - the
 * card the program's other file operations report in (store.showStFileReport). It has no checklist: every point
 * listed is already assigned. What was left alone is the thing to act on, so it makes the card a warning.
 */
export function commitIoEdit(store: EditorStore, edit: IoEdit): void {
  const s = store.getState()
  if (edit.source !== s.stProgram || edit.scene) store.commitProgram(edit.report.headline, { source: edit.source }, edit.scene ? { scene: edit.scene } : undefined)
  const r = edit.report
  store.showStFileReport({
    headline: r.headline,
    detail: reportSummary(r),
    items: [...r.assigned.map((a) => `${a.address}  ${a.name}`), ...r.skipped.map((k) => (k.name ? `${k.name}: ${k.reason}` : k.reason))],
    tone: r.skipped.length > 0 ? 'warn' : 'ok',
    keepOnEdit: false,
    checklist: false,
  })
  store.revealPanel('st')
}

export function runIoAssignment(store: EditorStore): IoReport {
  const s = store.getState()
  const edit = assignIo(s.scene, s.stProgram, ioTargetFor(s.externalPlc))
  commitIoEdit(store, edit)
  return edit.report
}

export function runIoImport(store: EditorStore, text: string): IoReport {
  const s = store.getState()
  const edit = importIoList(s.scene, s.stProgram, text, ioTargetFor(s.externalPlc))
  commitIoEdit(store, edit)
  return edit.report
}

/** Ask for an I/O list file, then import it. Resolves false when the pick was cancelled. */
export function pickAndImportIoList(store: EditorStore): Promise<boolean> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.csv,.tsv,.txt,text/csv,text/plain'
    input.addEventListener('cancel', () => resolve(false))
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return resolve(false)
      void file
        .text()
        .then((text) => {
          runIoImport(store, text)
          resolve(true)
        })
        .catch((e: unknown) => {
          console.warn('[oip] importing the I/O list failed', e)
          resolve(false)
        })
    })
    input.click()
  })
}
