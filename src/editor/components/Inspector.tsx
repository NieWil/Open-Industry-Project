// --- Inspector shell: selection routing + the top-level panel (pieces live in ./inspector/) ---

import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { versionedAssetUrl } from '../../core/assetVersions'
import { sameAsBuiltIn } from '../../core/builtInVersion'
import { controllersUsed } from '../../core/io/controllerTag'
import { ControllerScope } from './inspector/controllerRow'
import { PART_DEFS } from '../../core/types'
import type { ParamSpec, PartInstance, PartType, SdkPart } from '../../core/types'
import { partParamSpecs, switchValue, visibleWhenHolds } from '../../core/packageParams'
import { partDisplayName } from '../../core/parts/partDisplayName'
import { packageThumbFile } from '../../core/parts/partPackage'
import type { PartPackage } from '../../core/parts/partPackage'
import { getPackage } from '../../core/parts/partRegistry'
import { rigGeometryOf } from '../rigTree'
import { paramDesc } from './paramDescriptions'
import type { EditorState, EditorStore } from '../store/store'
import type { EditorController } from '../controller'
import type { LiveSetpoints } from '../controller/setpoints'
import { BoolRow, DisplayUnitsContext, GuardOpeningsModeContext, LiveEditContext, RevertSlot, TextField } from './inspector/fields'
import { sceneDisplayUnits } from '../../core/scene/sceneUnits'
import type { LiveEditGate } from './inspector/fields'
import { ContextMenu, menuItemsFor } from './inspector/menu'
import type { OpenCtx, PropMenuState } from './inspector/menu'
import { GroupSection, ParamField, buildGroupTree } from './inspector/paramField'
import { buildSceneTagIndex, firstTagKey } from './inspector/paramLogic'
import type { SceneTagIndex } from './inspector/paramLogic'
import { HoldsSection } from './inspector/holds'
import { PartActions, PartInfoFields, PartStatus } from './inspector/rig'
import { importRigNodePanel, preloadRigNodePanel } from './inspector/rigNodeChunk'
import { InspectorHeader } from './inspector/header'
import { partCreditLine } from '../parts/partCredit'
import { placedCopiesOf } from '../treeNode'
import { titleCase } from './inspector/shared'
import type { Update } from './inspector/shared'
import { TransformSection } from './inspector/transform'
import { PartSceneProperties, SceneProperties } from './inspector/scene'
import { TagSourcesContext } from './inspector/tagField'
import type { TagSources } from './inspector/tagField'
import type { PlcTagList } from '../links/externalPlc'
import { adsEndpoint, eipEndpoint, eipTarget } from '../links/externalPlcStatus'
import { defineMessages, t } from '../../core/i18n'
import { tNodes } from '../i18nNodes'
import { selectionSet } from '../store/selectionSet'

const M = defineMessages('inspector', {
  partsSelected: { one: '{count} part selected', other: '{count} parts selected' },
  mixedTypes: 'Select parts of a single type to edit shared properties.',
  creditByFrom: 'by {by}, from {from}',
  creditFrom: 'from {from}',
  usedBanner: 'Operated by Use. Showing its current state, not the saved one.',
  joggedBanner: 'Jogged with the pose gizmo. Not saved: Capture Pose keeps it.',
  reset: 'Reset',
  sessionCopy:
    "Name and Category are the part's own. The fields below them only preview this copy and are dropped when you go back; each placed {kind} keeps its own.",
  name: 'Name',
  visible: 'Visible',
  filter: 'Filter properties',
  expandAll: 'Expand all sections',
  collapseAll: 'Collapse all sections',
})

// the rig-node editor, out of the first frame (inspector/rigNodeChunk.ts)
const RigNodePanel = lazy(() => importRigNodePanel().then((m) => ({ default: m.RigNodePanel })))

interface InspectorProps {
  store: EditorStore
  state: EditorState
  controller: EditorController | null
  /** the catalog's in-browser card renders, by package id (App state), so the header can reuse them */
  packageThumbnails?: ReadonlyMap<string, string>
}

/** a section's fold before anyone touches it: top-level sections open, nested ones ('Legs/Tail End') folded */
function startsCollapsed(path: string): boolean {
  return path.includes('/')
}

/** every group section path the specs make, parents included ('Legs', 'Legs/Tail End') */
function sectionPaths(specs: readonly ParamSpec[]): string[] {
  const paths = new Set<string>()
  for (const s of specs) {
    if (!s.group) continue
    let p = ''
    for (const name of s.group.split('/')) {
      p = p ? `${p}/${name}` : name
      paths.add(p)
    }
  }
  return [...paths]
}

/**
 * The package a part's catalog card shows, resolved the way the catalog resolves it (the project's own
 * version shadows a built-in), with the registry as the fallback for a package only the scene embeds.
 */
function packageOf(state: EditorState, id: string): PartPackage | undefined {
  const builtIn = state.bundledPackages.find((p) => p.id === id)
  const own = state.userPackages.find((p) => p.id === id)
  // a project's untouched copy of a built-in shows as the built-in (its committed image)
  return (own && !sameAsBuiltIn(own, builtIn) ? own : undefined) ?? builtIn ?? own ?? getPackage(id)
}

/** the header picture: the catalog card's image for a part (author thumbnail, in-browser render, then the
 *  committed one a pristine bundled package ships), the static type thumbnail for a structural part. A type with
 *  no 3-D form (PartDef.glyph) has none to ask for: the header draws its glyph (InspectorHeader). */
function headerThumb(
  state: EditorState,
  part: PartInstance,
  pkg: PartPackage | undefined,
  rendered: ReadonlyMap<string, string> | undefined,
): string | undefined {
  if (part.type !== 'part') return versionedAssetUrl(`/thumbnails/${part.type}.webp`)
  if (!pkg) return undefined
  const own = pkg.thumbnail ?? rendered?.get(pkg.id)
  if (own) return own
  return state.bundledPackages.includes(pkg) ? versionedAssetUrl(`/thumbnails/pkg/${packageThumbFile(pkg.id)}.webp`) : undefined
}

/** the polled values plus the part they were read for - see the staleness note in useLiveSetpoints */
type LiveSample = { partId: string; values: LiveSetpoints | null }

/** shallow equality over a live-setpoint sample - lets the poll below keep the previous object (no
 *  re-render) while the program holds a steady setpoint, which is most scans. */
function sameSample(a: LiveSample | null, b: LiveSample | null): boolean {
  if (a === b) return true
  if (!a || !b || a.partId !== b.partId) return false
  if (a.values === b.values) return true
  if (!a.values || !b.values) return false
  const ka = Object.keys(a.values)
  if (ka.length !== Object.keys(b.values).length) return false
  return ka.every((k) => {
    const x = a.values![k]!, y = b.values![k]
    return x.value === y?.value && x.tag === y.tag && x.driven === y.driven
  })
}

/**
 * Poll what a running scene is commanding into this part's number params (`controller.liveSetpoints`).
 * A setpoint tag replaces its param in the behavior, so a field left showing the authored number reads out
 * something the scene isn't obeying - a program commanding 0.5 m/s under a `speed` of 1. These values change
 * every scan, independent of any store update, so like the ST editor's watch overlay they can't ride the
 * React subscription; 120 ms is the same cadence and is well inside human reading speed for a readout.
 *
 * The sample carries the part it was read for, and the caller gets null unless it matches. Selecting a
 * second part re-renders with the new part's params before this effect can re-run, so an unkeyed sample
 * would paint one commit of the previous part's commanded value onto the new one - a flash of a greyed-out
 * wrong number on, say, a hand-run conveyor that no program touches.
 */
function useLiveSetpoints(controller: EditorController | null, running: boolean, partId: string | null): LiveSetpoints | null {
  const [live, setLive] = useState<LiveSample | null>(null)
  useEffect(() => {
    if (!controller || !running || partId === null) {
      setLive(null)
      return
    }
    const read = (): void => setLive((prev) => {
      const next: LiveSample = { partId, values: controller.liveSetpoints(partId) }
      return sameSample(prev, next) ? prev : next
    })
    read()
    const id = setInterval(read, 120)
    return () => {
      clearInterval(id)
      setLive(null)
    }
  }, [controller, running, partId])
  return live && live.partId === partId ? live.values : null
}

export function Inspector(props: InspectorProps) {
  const { store } = props
  // a field's scrub / held arrow streams as one live edit (see store.beginLiveEdit); stable, so a field's
  // mount-time effects close over a gate that stays current
  const liveGate = useMemo<LiveEditGate>(() => ({ begin: () => store.beginLiveEdit(), end: () => store.endLiveEdit() }), [store])
  const tagSources = useTagSources(props.controller, props.state)
  return (
    <LiveEditContext.Provider value={liveGate}>
      <DisplayUnitsContext.Provider value={sceneDisplayUnits(props.state.scene)}>
        <GuardOpeningsModeContext.Provider value={props.state.sideGuardMode}>
          <TagSourcesContext.Provider value={tagSources}>
            <InspectorBody {...props} />
          </TagSourcesContext.Provider>
        </GuardOpeningsModeContext.Provider>
      </DisplayUnitsContext.Provider>
    </LiveEditContext.Provider>
  )
}

/**
 * What a tag field suggests beyond the scene (inspector/tagField.tsx): the program, and the PLC's tags when the
 * external link is OPC UA, ADS or EtherNet/IP. The PLC's list is shown only while it is of the PLC the settings name:
 * change the address and the old list is not offered as the new PLC's.
 */
function useTagSources(controller: EditorController | null, state: EditorState): TagSources {
  const [plcList, setPlcList] = useState<Readonly<PlcTagList> | null>(() => controller?.plcTagList ?? null)
  useEffect(() => {
    if (!controller) return
    const read = (): void => setPlcList(controller.plcTagList)
    read()
    return controller.onExternalPlcStatus(read)
  }, [controller])
  const settings = state.externalPlc
  const protocol = settings.mode === 'opcua' || settings.mode === 'ads' || settings.mode === 'eip' ? settings.mode : null
  const linked = !!controller?.plcTagsAvailable && protocol !== null
  // a list read from another server, or from other start points, is not this link's
  const from = protocol === 'opcua' ? settings.opcUaBrowseFrom.join(',') : ''
  const endpoint = protocol === 'ads' ? adsEndpoint(settings.adsNetId, settings.adsPort) : protocol === 'eip' ? eipEndpoint(eipTarget(settings)) : settings.opcUaEndpoint
  const plc = linked && plcList?.protocol === protocol && plcList.endpoint === endpoint && plcList.from.join(',') === from ? plcList : null
  // an empty AMS Net ID is this PC's runtime, so ADS can always be read
  const canReadPlc = linked && !state.running && (protocol === 'ads' || (protocol === 'eip' ? settings.eipGateway : settings.opcUaEndpoint).trim() !== '')
  const program = state.stProgram
  const { stDialect: dialect, controller: table, stScanMs: scanMs } = state
  const check = useMemo(() => ({ source: program, dialect, controller: table, scanMs }), [program, dialect, table, scanMs])
  // the named controllers a tag field offers: the ones the project lists, then any other the scene's tags name
  const setUp = settings.controllers
  const parts = state.scene.parts
  const controllers = useMemo(() => {
    const names = setUp.map((c) => c.name)
    return [...names, ...controllersUsed(parts).filter((n) => !names.includes(n))]
  }, [setUp, parts])
  return useMemo(
    () => ({ check, plc, plcLinked: linked, plcProtocol: protocol ?? undefined, external: settings.enabled, canReadPlc, readPlc: () => controller?.readPlcTags(), controllers, defaultName: settings.mainName }),
    [check, plc, linked, protocol, settings.enabled, canReadPlc, controller, controllers, settings.mainName],
  )
}

function InspectorBody({ store, state, controller, packageThumbnails }: InspectorProps) {
  // fold state persists across selections (remembered per group), keyed by group path
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [filter, setFilter] = useState('')
  const [menu, setMenu] = useState<PropMenuState | null>(null)
  // A context menu belongs to the selection it was opened on (its Copy/Paste/Revert closures carry that
  // selection's ids), so it is dropped the moment the selection changes. Reset during render rather than in
  // an effect, so it can't paint even once over the new selection.
  const rigKey = state.selectedRigNode ? `${state.selectedRigNode.partId}/${state.selectedRigNode.linkName}` : ''
  const selKey = `${state.selectedIds.join(',')}|${rigKey}`
  const [menuSel, setMenuSel] = useState(selKey)
  if (menuSel !== selKey) {
    setMenuSel(selKey)
    if (menu) setMenu(null)
  }
  // The scene's tag bindings for every tag field of this render: built on first use, at most once per scene or
  // package-registry change, so a field doesn't walk the whole scene twice on every render.
  const allParts = state.scene.parts
  const packageRev = state.packageRev
  const stProgram = state.stProgram
  const tagIndex = useMemo(() => {
    void packageRev // a package edit changes which params are tags without touching the scene
    let built: SceneTagIndex | null = null
    return () => (built ??= buildSceneTagIndex(allParts, stProgram))
  }, [allParts, packageRev, stProgram])
  const toggle = (path: string) => setCollapsed((c) => ({ ...c, [path]: !(c[path] ?? startsCollapsed(path)) }))
  // A request to show one param (store.paramFocus, raised by a rig node's "Change Width"): open every fold on the
  // way to it, drop a filter that might hide it, then focus its row once it has rendered.
  const paramFocus = state.paramFocus
  useEffect(() => {
    if (!paramFocus) return
    const target = state.scene.parts.find((p) => p.id === paramFocus.partId)
    const schema = target?.type === 'part' ? (getPackage((target as SdkPart).packageId)?.params as Record<string, { group?: string } | undefined> | undefined) : undefined
    const group = schema?.[paramFocus.param]?.group
    if (group) {
      setCollapsed((c) => {
        const next = { ...c }
        const segs = group.split('/')
        for (let i = 1; i <= segs.length; i++) next[segs.slice(0, i).join('/')] = false
        return next
      })
    }
    setFilter('')
    let tries = 0
    let frame = 0
    const find = (): void => {
      const row = document.querySelector<HTMLElement>(`.inspector .prop-row[data-param="${CSS.escape(paramFocus.param)}"]`)
      if (row) {
        row.scrollIntoView({ block: 'nearest' })
        row.querySelector<HTMLElement>('input, select, textarea, button')?.focus()
        row.classList.add('prop-row-flash')
        setTimeout(() => row.classList.remove('prop-row-flash'), 1200)
        store.clearParamFocus()
        return
      }
      if (++tries < 30) frame = requestAnimationFrame(find)
      else store.clearParamFocus()
    }
    frame = requestAnimationFrame(find)
    return () => cancelAnimationFrame(frame)
    // a new request is a new seq; the rest is read when it arrives
  }, [paramFocus?.seq])
  const openCtx: OpenCtx = (e, m) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, ...m })
  }
  // Live PLC setpoints for a SINGLE selected part (a multi-selection edits authored values across parts,
  // where a per-part live readout has no single answer). Hooks run before the early returns below.
  const liveSetpoints = useLiveSetpoints(controller, state.running, state.selectedIds.length === 1 ? state.selectedIds[0]! : null)

  // Author-mode rig-node selection takes precedence: show the read-only rig-node panel (selectedIds is
  // empty whenever a rig node is selected). Falls through to the normal part inspector if it can't resolve.
  // a part's own scene is the only place its nodes are rows to select: start the node editor's chunk loading
  if (state.focusedPartId) preloadRigNodePanel()
  const rigSel = state.selectedRigNode
  if (rigSel) {
    const rigPart = state.scene.parts.find((p) => p.id === rigSel.partId)
    const geom = rigPart && rigPart.type === 'part' ? rigGeometryOf(rigPart) : null
    const link = geom?.links.find((l) => l.name === rigSel.linkName)
    if (rigPart && geom && link) {
      const joint = geom.joints.find((j) => j.link === link.name)
      return (
        // the panel's own chunk (rigNodeChunk.ts), almost always loaded by now: the part scene preloaded it
        <Suspense fallback={<div className="inspector" />}>
          <RigNodePanel
            part={rigPart as SdkPart}
            link={link}
            joint={joint}
            store={store}
            controller={controller}
            buildError={state.packageBuildErrors[(rigPart as SdkPart).packageId]}
            placedCopies={placedCopiesOf(state, (rigPart as SdkPart).packageId)}
            definitionSession={state.packageEdit?.partId === rigPart.id}
            focused={state.focusedPartId === rigPart.id}
            running={state.running}
          />
        </Suspense>
      )
    }
  }

  const selectedSet = selectionSet(state.selectedIds)
  const selected = state.scene.parts.filter((p) => selectedSet.has(p.id))

  // nothing selected: the scene itself is what is in front of you, so its own properties - or, inside a part's own
  // scene, that part's, since the document's rate and units are not what is on screen
  if (selected.length === 0 && state.focusedPartId)
    return <PartSceneProperties store={store} state={state} partId={state.focusedPartId} />
  if (selected.length === 0) return <SceneProperties store={store} state={state} controller={controller} />

  // Every SDK part is type 'part', so the type can't tell a conveyor from a sensor; the package can. The
  // fields come from the first part's package, and writing them into another package's part is junk at best.
  // one type (1+ parts): edit the representative, fan edits out to the whole selection
  const targets = selected
  const part = targets[0]!
  const type: PartType = part.type
  const multi = targets.length > 1
  const ids = targets.map((t) => t.id)
  const idSet = new Set(ids)
  const update: Update = (label, key, mutate) => {
    // Built on the store's current scene, never a rendered one: the context menu and a held spin arrow call
    // `update` from an earlier render, and a live edit's steps don't re-render at all, so a snapshot taken
    // there would silently revert every edit that landed since (a collab peer's, or the gesture's own steps).
    const scene = store.getState().scene
    store.commit(
      multi ? `${label} (${ids.length})` : label,
      { ...scene, parts: scene.parts.map((p) => (idSet.has(p.id) ? mutate(p) : p)) },
      { coalesceKey: `param:${ids.join(',')}:${key}` },
    )
  }

  const kindOf = (p: PartInstance): string => (p.type === 'part' ? `part:${(p as SdkPart).packageId}` : p.type)
  if (new Set(selected.map(kindOf)).size > 1) {
    // the params differ by kind, but every part has a pose: the Transform still edits them together
    return (
      <div className="inspector">
        <InspectorHeader title={t(M.partsSelected, { count: selected.length })} />
        <TransformSection
          store={store}
          committed={part}
          ids={ids}
          type={type}
          disabled={false}
          effCollapsed={collapsed}
          toggle={toggle}
          openCtx={openCtx}
          update={update}
        />
        <p className="inspector-hint">{t(M.mixedTypes)}</p>
        {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItemsFor(menu)} onClose={() => setMenu(null)} />}
      </div>
    )
  }
  const def = PART_DEFS[type]
  // the header names what the part is: every SDK part shares the generic 'part' type, so its package says it
  const pkg = type === 'part' ? packageOf(state, (part as SdkPart).packageId) : undefined
  const kindLabel = pkg?.name ?? def.label
  // the Part Editor session's throwaway: its Name field names the part itself (PartInfoFields)
  const definitionCopy = !multi && type === 'part' && state.packageEdit?.partId === part.id
  const thumb = headerThumb(state, part, pkg, packageThumbnails)
  const f = filter.trim().toLowerCase()
  // partParamSpecs resolves a part's fields from its package schema (def.params is empty for the generic
  // 'part' type); the structural types (building/group) fall through to their static PART_DEFS list.
  // `hidden` params are engine-owned storage (the curve's snap-set `reverse`) - resolved and persisted like
  // any other, but never a field. This is the only place they're dropped; filtering them further upstream
  // would lose their default + clamp (see ParamSpec.hidden).
  // ...and a param that is one of two ways of saying the same thing shows only while its switch says so
  // (ParamSpec.visibleWhen): the switch's own value, as the part resolves it.
  const allSpecs = partParamSpecs(part)
  const switchOf = (key: string) => switchValue(allSpecs, part.params as Record<string, unknown> | undefined, key)
  // ...and while the part's declared PLC switch (package.commsParam) is off, its PLC interface is folded away:
  // every tag field, plus the rest of the switch's own section (a conveyor's drive-feedback scaling). Those do
  // nothing until the switch is on, and a belt listed ten of them. The switch itself always stays.
  const commsKey = pkg?.commsParam
  const commsSpec = commsKey ? allSpecs.find((s) => s.key === commsKey) : undefined
  // across a multi-selection, only when it is off on every part (a tag some selected part uses stays editable)
  const commsOff =
    commsSpec?.kind === 'boolean' &&
    targets.every((t) => {
      const v = (t.params as Record<string, unknown> | undefined)?.[commsSpec.key]
      return (typeof v === 'boolean' ? v : (commsSpec.whenAbsent ?? commsSpec.default)) === false
    })
  const inCommsSection = (s: ParamSpec): boolean =>
    s.kind === 'tagRef' || (!!commsSpec?.group && !!s.group && (s.group === commsSpec.group || s.group.startsWith(`${commsSpec.group}/`)))
  // ...and a units switch (ParamSpec.imperialUnits) is the scene's to set: its Units (Scene Properties,
  // core/scene/sceneUnits.ts) write it on every part, so a per-part copy of that choice is never a field.
  const editableSpecs = allSpecs.filter(
    (s) =>
      !s.hidden &&
      !(s.kind === 'boolean' && s.imperialUnits === true) &&
      (!s.visibleWhen || visibleWhenHolds(s.visibleWhen, switchOf(s.visibleWhen.param))) &&
      !(commsOff && s.key !== commsKey && inCommsSection(s)),
  )
  // the filter matches the property name or its enclosing group path
  const visibleSpecs = f
    ? editableSpecs.filter((s) => titleCase(s.label).toLowerCase().includes(f) || (s.group ?? '').toLowerCase().includes(f))
    : editableSpecs
  const { ungrouped, groups } = buildGroupTree(visibleSpecs)
  // a live filter expands every group so matches aren't hidden behind a fold. Otherwise a nested section starts
  // folded until it is opened (startsCollapsed): the detail under a section (a belt's per-end leg settings, its
  // drive feedback) stays one click away instead of lengthening every conveyor's panel.
  const effCollapsed: Record<string, boolean> = f ? {} : { ...Object.fromEntries(sectionPaths(editableSpecs).map((p) => [p, startsCollapsed(p)])), ...collapsed }

  // every collapsible section path (Expand/Collapse All targets), incl. the Transform fold
  const allSectionPaths = (): string[] => ['Transform', ...sectionPaths(editableSpecs)]
  const collapseAll = () => setCollapsed(Object.fromEntries(allSectionPaths().map((p) => [p, true])))
  // explicit, since a nested section's default is folded
  const expandAll = () => setCollapsed(Object.fromEntries(allSectionPaths().map((p) => [p, false])))

  const allVisible = targets.every((t) => t.visible !== false)

  // teach-pendant capture source: a single selected custom rig exposes its posed joint row so a matching
  // numberList grid (waypoints / idle pose) can offer "Capture Pose" (see controller.captureRigPose)
  const capturePose = !multi && part.type === 'part' && controller ? () => controller.captureRigPose(part.id) : undefined
  // ...and the way back: show a waypoint's (or a Move step's) joint row on the arm, while the scene is stopped
  const previewPose = !multi && part.type === 'part' && controller && !state.running ? (row: readonly number[]) => controller.previewRigPose(part.id, row) : undefined
  // a tag field forces the program variable its tag names, only while the scene runs (inspector/tagForce.tsx)
  const forcing = state.running ? controller : null

  return (
    <div className="inspector">
      {/* the part type's picture + class name, and a custom part's actions at the right end. The part's id (its
          permanent key, which a rename leaves alone) is in the tooltip with the package's: wanted by agents, scripts
          and bug reports, not by someone laying out a line */}
      <InspectorHeader
        title={multi ? `${kindLabel} (${targets.length})` : kindLabel}
        tooltip={multi ? (pkg ? pkg.id : type) : `${part.id} · ${pkg ? pkg.id : type}`}
        icon={def.glyph ? { glyph: def.glyph } : { src: thumb }}
        actions={
          !multi && part.type === 'part' ? (
            <PartActions part={part as SdkPart} focused={state.focusedPartId === part.id} />
          ) : undefined
        }
      />
      {/* who made it: a part from a part library credits its publisher, wherever it is used (editor/parts/partCredit.ts) */}
      {pkg?.credit &&
        (() => {
          const credit = partCreditLine(pkg)!
          return (
            <p className="inspector-credit" data-testid="inspector-credit">
              {credit.by
                ? tNodes(M.creditByFrom, {
                    by: credit.url ? (
                      <a href={credit.url} target="_blank" rel="noreferrer">
                        {credit.by}
                      </a>
                    ) : (
                      credit.by
                    ),
                    from: credit.from,
                  })
                : t(M.creditFrom, { from: credit.from })}
            </p>
          )
        })()}
      {/* A stopped-scene Use (C, or E while walking) is operating this device: the viewport shows what the press left
          it doing, which is session state and not the saved design below. Said here so the two never silently
          disagree, with the way back. See controller useSessions. */}
      {!multi && !state.running && state.usedIds.includes(part.id) && (
        <div className="inspector-used" role="status" data-testid="inspector-used">
          <span>{t(M.usedBanner)}</span>
          <button type="button" data-testid="inspector-used-reset" onClick={() => controller?.resetUse(part.id)}>
            {t(M.reset)}
          </button>
        </div>
      )}
      {/* The pose gizmo holds this arm somewhere its saved pose does not put it (a drag, a waypoint shown): jogging,
          session state like Use above. Said so a pose that was never saved is not taken for one that was, with the
          way to keep it (Capture Pose, on the pose and waypoint grids) and the way back. See controller useSessions. */}
      {!multi && !state.running && state.joggedIds.includes(part.id) && (
        <div className="inspector-used" role="status" data-testid="inspector-jogged">
          <span>{t(M.joggedBanner)}</span>
          <button type="button" data-testid="inspector-jogged-reset" onClick={() => controller?.resetJog(part.id)}>
            {t(M.reset)}
          </button>
        </div>
      )}
      {/* The Catalog ✎ session's copy lives in the session's own scene, not the document's (packageEdit): its fields
          below preview the part and leave with it on Back. Said here so a setting typed into it isn't mistaken for
          one that is kept. */}
      {/* a custom part's own state (a failed edit, a runtime error, a changed built-in): read before its fields */}
      {!multi && part.type === 'part' && (
        <PartStatus part={part as SdkPart} store={store} controller={controller} buildError={state.packageBuildErrors[(part as SdkPart).packageId]} />
      )}
      {definitionCopy && (
        <p className="inspector-hint" data-testid="inspector-session-copy">
          {t(M.sessionCopy, { kind: kindLabel })}
        </p>
      )}
      {definitionCopy && (
        <PartInfoFields packageId={(part as SdkPart).packageId} builtIn={state.bundledPackages.some((b) => b.id === (part as SdkPart).packageId)} controller={controller} />
      )}
      {!multi && !definitionCopy && (
        <TextField
          label={t(M.name)}
          value={part.name ?? ''}
          // the id is shown separately above; the placeholder previews the auto label used while unnamed
          placeholder={partDisplayName(part, state.scene.parts)}
          tooltip={paramDesc(type, '_name')}
          disabled={false}
          extra={<RevertSlot />}
          onCommit={(v) => store.rename(part.id, v)}
        />
      )}
      <BoolRow
        label={t(M.visible)}
        checked={allVisible}
        mixed={!multi ? false : !targets.every((t) => (t.visible !== false) === (targets[0]!.visible !== false))}
        tooltip={paramDesc(type, '_visible')}
        disabled={false}
        extra={<RevertSlot />}
        onChange={(v) => store.setVisible(ids, v)}
      />
      <TransformSection
        store={store}
        committed={part}
        ids={ids}
        type={type}
        disabled={false}
        effCollapsed={effCollapsed}
        toggle={toggle}
        openCtx={openCtx}
        update={update}
      />
      {/* the filter searches the params below it, so a part with none (a group) has no filter */}
      {editableSpecs.length > 0 && (
        <div className="inspector-filter-row">
          <input
            className="inspector-filter"
            type="text"
            placeholder={t(M.filter)}
            aria-label={t(M.filter)}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button type="button" className="inspector-foldall" title={t(M.expandAll)} aria-label={t(M.expandAll)} onClick={expandAll}>
            ⊕
          </button>
          <button type="button" className="inspector-foldall" title={t(M.collapseAll)} aria-label={t(M.collapseAll)} onClick={collapseAll}>
            ⊖
          </button>
        </div>
      )}
      {/* one Controller row for every tag of the part, above its first tag field (inspector/controllerRow.tsx) */}
      <ControllerScope store={store} parts={targets} firstTag={firstTagKey(ungrouped, groups)}>
        {ungrouped.map((spec) => (
          <ParamField key={spec.key} store={store} spec={spec} parts={targets} allParts={allParts} tagIndex={tagIndex} liveSetpoints={liveSetpoints ?? undefined} disabled={false} update={update} onContext={openCtx} capturePose={capturePose} previewPose={previewPose} forcing={forcing} />
        ))}
        {groups.map((group) => (
          <GroupSection
            key={group.path}
            store={store}
            node={group}
            depth={0}
            collapsed={effCollapsed}
            toggle={toggle}
            parts={targets}
            allParts={allParts}
            tagIndex={tagIndex}
            liveSetpoints={liveSetpoints ?? undefined}
            disabled={false}
            update={update}
            onContext={openCtx}
            capturePose={capturePose}
            previewPose={previewPose}
            forcing={forcing}
          />
        ))}
      </ControllerScope>
      {!multi && part.type === 'part' && <HoldsSection store={store} part={part as SdkPart} scene={state.scene} running={state.running} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItemsFor(menu)} onClose={() => setMenu(null)} />}
    </div>
  )
}
