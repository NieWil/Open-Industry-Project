// What every agent tool module shares (docs/agent-tools.md): the tool and context types, the refusal type, argument
// readers and the lookups several tools make. tools.ts holds the list; the tools live in it and in the modules
// beside it (partTools.ts, programTools.ts, viewTools.ts).

import { UNLISTED_BUILT_INS, sameAsBuiltIn } from '../../core/builtInVersion'
import type { PartPackage } from '../../core/parts/partPackage'
import type { PartInstance, SceneJSON } from '../../core/types'
import type { EditorController } from '../controller'
import type { EditorStore } from '../store/store'
import type { AgentSession } from './agentSession'
import { allPartDiagnostics, partDiagnosticsOverflowed } from '../../core/parts/partDiagnostics'
import { isKnownDialect } from '../../core/dialect'
import { controllerFor } from '../../plc/controller'
import { collectProblems } from '../problems'

/** The slice of the controller the tools use, so a test can hand in a stand-in (null = no viewport mounted yet). */
export type AgentController = Pick<EditorController, 'run' | 'stop' | 'plcWatch' | 'writePlcValue' | 'plcFault'> &
  Partial<Pick<EditorController, 'sim' | 'view' | 'lastFrame' | 'plcScanTimes' | 'plcForces' | 'forcePlcValue' | 'releasePlcForces' | 'setPaused' | 'stepBy' | 'externalPlcAvailable'>>

/** A rectangle of the editor window in CSS pixels. */
export interface CaptureRect {
  x: number
  y: number
  width: number
  height: number
}

/** One image a tool returns: base64 bytes and their media type. */
export interface AgentImage {
  data: string
  mimeType: string
}

/**
 * What the shell around the editor can do for a tool that the page cannot do itself. The desktop shell supplies it
 * (desktopAgent.ts); absent in a test and in any door without a shell.
 */
export interface AgentShell {
  /** the window's pixels inside `rect`, as composited on screen */
  capture?(rect: CaptureRect): Promise<AgentImage | null>
  /** a model file's bytes (.glb, .step, .stp, USD), or why not. A .usd / .usda / .usdc root also brings the layers
   *  and images under its folder (`files`, keyed by path from that folder; `root` is its own key). */
  readModel?(path: string): Promise<{ name: string; bytes: Uint8Array; files?: { path: string; bytes: Uint8Array }[]; root?: string } | { error: string }>
}

export interface AgentToolContext {
  store: EditorStore
  controller: AgentController | null
  shell?: AgentShell
  /** what the agent has done this session and the review of it (agentSession.ts); absent in a test that needs none */
  session?: AgentSession
}

/** A JSON Schema object, as MCP's `inputSchema` carries it. */
export type JsonSchema = Record<string, unknown>

export interface AgentTool {
  name: string
  description: string
  inputSchema: JsonSchema
  run(ctx: AgentToolContext, args: Record<string, unknown>): unknown
}

/** A result that carries images: the transport sends `info` as text and each image as an image block. */
export class AgentImageResult {
  constructor(
    readonly info: Record<string, unknown>,
    readonly images: AgentImage[],
  ) {}
}

/** A refusal the agent should read and act on (bad input, unknown id): reported as a tool error, not a crash. */
export class AgentToolError extends Error {}

/** The label prefix every agent edit carries in the undo history and the room feed. */
export const AGENT_LABEL = 'Agent'

// ── argument helpers ────────────────────────────────────────────────────────────────────────────────

export function str(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string' || v === '') throw new AgentToolError(`'${key}' must be a non-empty string`)
  return v
}

export function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string') throw new AgentToolError(`'${key}' must be a string`)
  return v
}

export function optNum(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new AgentToolError(`'${key}' must be a finite number`)
  return v
}

export function optBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key]
  if (v === undefined) return undefined
  if (typeof v !== 'boolean') throw new AgentToolError(`'${key}' must be true or false`)
  return v
}

export function optVec3(args: Record<string, unknown>, key: string): [number, number, number] | undefined {
  const v = args[key]
  if (v === undefined) return undefined
  if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new AgentToolError(`'${key}' must be [x, y, z] in metres`)
  }
  return [v[0], v[1], v[2]]
}

export function optObj(args: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = args[key]
  if (v === undefined) return undefined
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new AgentToolError(`'${key}' must be an object`)
  return v as Record<string, unknown>
}

export function strList(args: Record<string, unknown>, key: string): string[] {
  const v = args[key]
  if (!Array.isArray(v) || v.length === 0 || !v.every((s) => typeof s === 'string')) throw new AgentToolError(`'${key}' must be a non-empty array of strings`)
  return v as string[]
}

// ── shared reads ────────────────────────────────────────────────────────────────────────────────────

/** Refuse an edit the store would silently drop: a view-only room, or a scene still loading as a preview. */
export function assertEditable(store: EditorStore): void {
  if (store.getState().readOnly) throw new AgentToolError('this editor is view-only (opened from a view link): it cannot be edited')
}

export function findPart(scene: SceneJSON, id: string): PartInstance {
  const part = scene.parts.find((p) => p.id === id)
  if (!part) throw new AgentToolError(`no part '${id}' in the scene (get_scene lists them)`)
  return part
}

/** Every package the editor knows: bundled first-party parts, the user's own library, a desktop parts folder. */
export function knownPackages(store: EditorStore): PartPackage[] {
  const s = store.getState()
  const seen = new Map<string, PartPackage>()
  for (const p of [...s.bundledPackages, ...s.userPackages]) if (!seen.has(p.id)) seen.set(p.id, p)
  return [...seen.values()]
}

/** Every package the catalog offers: the known ones less an unlisted built-in (core/builtInVersion UNLISTED_BUILT_INS),
 *  unless the project has its own changed version of it. A named lookup uses knownPackages, so it still finds one. */
export function catalogPackages(store: EditorStore): PartPackage[] {
  const s = store.getState()
  const bundledById = new Map(s.bundledPackages.map((p) => [p.id, p]))
  return knownPackages(store).filter((p) => !UNLISTED_BUILT_INS.has(p.id) || s.userPackages.some((u) => u.id === p.id && !sameAsBuiltIn(u, bundledById.get(p.id))))
}

export const round = (n: number): number => Math.round(n * 1000) / 1000

/**
 * A tool's result as the text the transport sends: a string as it is, anything else as indented JSON with each array
 * of plain values on one line. Indented JSON puts every number of a position on its own line, which made a large
 * scene's get_scene several times longer than its data.
 */
export function agentResultText(value: unknown): string {
  if (typeof value === 'string') return value
  // an array holding no object or array: JSON strings never hold a raw newline, so a newline here is layout
  return JSON.stringify(value ?? null, null, 2).replace(/\[\n\s+([^[\]{}]*?)\n\s*\]/g, (_m, inner: string) => `[${inner.split(/,\n\s+/).join(', ')}]`)
}

export function needController(ctx: AgentToolContext): AgentController {
  if (!ctx.controller) throw new AgentToolError('the viewport is still loading; try again in a moment')
  return ctx.controller
}

/** What the Problems panel reports for the open document, with `stProgram` swapped for a candidate when given. */
export function problems({ store, controller }: AgentToolContext, candidate?: string): ReturnType<typeof collectProblems> {
  const s = store.getState()
  const source = candidate ?? s.stProgram
  const fault = controller?.plcFault ?? null
  return collectProblems({
    parts: s.scene.parts,
    stProgram: source,
    stDialect: s.stDialect,
    controller: isKnownDialect(s.stDialect) ? controllerFor(source, s.controller, s.stScanMs) : null,
    runtime: allPartDiagnostics(),
    buildErrors: s.packageBuildErrors,
    packageNames: Object.fromEntries(knownPackages(store).map((p) => [p.id, p.name])),
    stepHz: s.simHz,
    runtimeOverflowed: partDiagnosticsOverflowed(),
    plcFault: fault && fault.source === source ? fault : null,
    namedPlcs: s.externalPlc.controllers,
    mainPlcName: s.externalPlc.mainName,
  })
}
