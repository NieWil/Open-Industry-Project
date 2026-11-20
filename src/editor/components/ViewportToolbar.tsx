import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { keymapRev, subscribeKeymap } from '../../core/keymap'
import { DEFAULT_ROTATE_SNAP_DEG } from '../../core/types'
import { defaultTranslateSnap, toStored, unitView } from '../../core/units'
import { sceneDisplayUnits } from '../../core/scene/sceneUnits'
import type { EditorController } from '../controller'
import { IS_MAC, keyHint, withKey } from '../keyHint'
import type { EditorState, EditorStore, ToolMode } from '../store/store'
import { useDismiss } from './popover'
import { defineMessages, t, type MessageId } from '../../core/i18n'

const M = defineMessages('viewportToolbar', {
  transform: 'Transform',
  move: 'Move',
  rotate: 'Rotate',
  select: 'Select',
  listSelect: 'List Select',
  listSelectDetail: 'tap overlapping parts to choose from a list',
  measure: 'Measure',
  measureDetail: 'LMB+Drag measures between two points; hold Shift for X/Y/Z components + incline/plan angles',
  toolKey: '{label} ({key})',
  toolDetail: '{head}: {detail}',
  localSpaceTitle: '{label}: currently {space}',
  useLocalSpace: 'Use Local Space',
  spaceLocal: 'Local',
  spaceGlobal: 'Global',
  gridSnapTitle: '{label}: hold {ctrl} during a drag to invert',
  useGridSnap: 'Use grid snap',
  liveSnapTitle: '{label}: hold Alt to escape for one drag. {faceKey} toggles just face snap (tiling parts flushing onto neighbor faces).',
  liveSnap: 'Toggle live (part) snap',
  faceSnap: 'Face snap',
  configureSnap: 'Configure Snap…',
  snapFloor: 'Snap selected to floor',
  toggleGrid: 'Toggle floor grid',
  flowArrows: 'Toggle flow direction arrows',
  snapSettings: 'Snap Settings',
  translateField: 'Translate',
  rotateField: 'Rotate',
  on: 'On',
  off: 'Off',
  faceSnapHint:
    'Tiling parts (racks) land flush on neighbor faces ({faceKey}). Cargo is left out on purpose: a box is smaller than the grab distance, so it would snap to neighbors it does not touch. Hold Alt during {repositionKey} to face-snap anything onto the surface under the cursor.',
  resetDefaults: 'Reset to defaults',
  vertexSnapTitle: 'Vertex Snap (hold B)',
  base: 'Base',
  vertex: 'Vertex',
  origin: 'Origin',
  source: 'Source',
  collision: 'Collision',
  mesh: 'Mesh',
  flipHint: 'Hold Shift while snapping to flip Collision↔Mesh.',
  numberLabel: '{label} ({unit})',
})

// Icon geometry inlined verbatim as SVG paths so the glyphs recolor via the
// button's currentColor.
function TransformIcon() {
  // combined move+rotate glyph (rotate arc + move arrows)
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <defs>
        <path id="tfClip" d="m8 4.24v-4h3.49v4.15l-2.12 1.22z" />
        <path id="tfArrow" d="m9.28 4.72 1.41-1.41-2-2c-.391-.39-1.02-.39-1.41 0l-2 2 1.41 1.41 1.29-1.29z" />
        <clipPath id="tfClipA">
          <use xlinkHref="#tfClip" />
        </clipPath>
      </defs>
      <circle cx="8.02" cy="8" r="1.99" />
      <path d="m12.7 5.29 2 2c.39.39.39 1.02 0 1.41l-2 2-1.41-1.41 1.29-1.29-1.29-1.29z" />
      <path d="m1.92 1.01v2h1.21c-1.4 1.37-2.19 3.29-2.1 5.3.113 2.59 1.65 4.91 3.99 6.02a.9.9 0 0 0 1.2-.428.9.9 0 0 0-.428-1.2c-1.74-.827-2.88-2.54-2.96-4.47-.0628-1.44.473-2.81 1.44-3.82l-.342 1.37 1.94.484.998-4.01a1 1 0 0 0-.971-1.24z" />
      <use xlinkHref="#tfArrow" clipPath="url(#tfClipA)" />
      <use xlinkHref="#tfArrow" clipPath="url(#tfClipA)" transform="matrix(1 0 0 -1 0 16)" />
    </svg>
  )
}

function SelectIcon() {
  // ToolSelect.svg
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M14 6.932 2 1.995l4.936 12 1.421-4.23 2.826 2.825 1.412-1.412L9.77 8.352z" />
    </svg>
  )
}

function MoveIcon() {
  // ToolMove.svg
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1a1 1 0 0 0-.691.291l-2 2 1.414 1.414 1.293-1.293 1.293 1.293 1.414-1.414-2-2A1 1 0 0 0 8 1zM3.309 5.291l-2 2a1 1 0 0 0 0 1.414l2 2 1.414-1.414L3.43 7.998l1.293-1.293-1.414-1.414zm9.414 0-1.414 1.414 1.293 1.293-1.293 1.293 1.414 1.414 2-2a1 1 0 0 0 0-1.414l-2-2zm-6 6-1.414 1.414 2 2a1 1 0 0 0 1.414 0l2-2-1.414-1.414-1.293 1.293-1.293-1.293z" />
    </svg>
  )
}

function RotateIcon() {
  // ToolRotate.svg
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1a7 7 0 0 0-4.982 11.998H1.911v2h4a1 1 0 0 0 .97-1.242l-1-4-1.94.486.28 1.121a5 5 0 1 1 7.223.168l1.416 1.416A7 7 0 0 0 8 1z" />
    </svg>
  )
}

function ListSelectIcon() {
  // ListSelect.svg
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="m1 1v14h8.2578l-.82227-2h-5.4355v-2h4.6113l-.82227-2h-3.7891v-2h3.8867a1.5002 1.5002 0 0 1 1.0977-.49805v-.0019531a1.5002 1.5002 0 0 1 .58594.11133l.94531.38867h.48438v.19922l2 .82227v-7.0215h-11zm2 2h7v2h-7zm5 5 3.291 8 .94726-2.8203 1.8828 1.8828.94336-.94141-1.8848-1.8828 2.8203-.94726-8-3.291z" />
    </svg>
  )
}

function RulerIcon() {
  // Ruler.svg
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M1 1v14h14zm3 7 4 4H4z" />
    </svg>
  )
}

function LocalSpaceIcon() {
  // Local Space toggle uses an object/box glyph
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M1.553 4.104A1 1 0 0 0 1 5v6a1 1 0 0 0 .553.895l6 3a1 1 0 0 0 .894 0l6-3A1 1 0 0 0 15 11V5a1 1 0 0 0-.553-.894l-6-3a1 1 0 0 0-.894 0zm6.447-1 3.764 1.882L8 6.868 4.236 4.986zm-5 3.5 4 2v3.766l-4-2z" />
    </svg>
  )
}

function GridSnapIcon() {
  // "Use Snap" glyph; OIP maps it to grid snap
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M3 3v2h2V3zm6 0v2h2V3zM3 9v2h2V9zm4 4v2h2v-2zm6 0v2h2v-2z" />
      <path fillOpacity="0.686" d="M7 13h2v-2a2 2 0 0 1 4 0v2h2v-2a4 4 0 0 0-8 0z" />
    </svg>
  )
}

/** OIP-only structural part snap: a horseshoe magnet, distinct from Use Snap */
function LiveSnapIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M1 14V8a7 7 0 0 1 14 0v6h-3.2V8a3.8 3.8 0 0 0-7.6 0v6z" />
      <rect x="1" y="11.4" width="3.2" height="2.6" fillOpacity="0.55" />
      <rect x="11.8" y="11.4" width="3.2" height="2.6" fillOpacity="0.55" />
    </svg>
  )
}

/** OIP extra: opens the Configure-Snap popover */
function GearIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 5.5A2.5 2.5 0 1 0 8 10.5 2.5 2.5 0 0 0 8 5.5zm0 1.6a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8z" />
      <path d="M7 1 6.7 2.6a5.4 5.4 0 0 0-1.2.5L4.1 2.2 2.2 4.1l.9 1.4a5.4 5.4 0 0 0-.5 1.2L1 7v2l1.6.3c.1.4.3.8.5 1.2l-.9 1.4 1.9 1.9 1.4-.9c.4.2.8.4 1.2.5L7 15h2l.3-1.6c.4-.1.8-.3 1.2-.5l1.4.9 1.9-1.9-.9-1.4c.2-.4.4-.8.5-1.2L15 9V7l-1.6-.3a5.4 5.4 0 0 0-.5-1.2l.9-1.4-1.9-1.9-1.4.9a5.4 5.4 0 0 0-1.2-.5L9 1z" fillOpacity="0.5" />
    </svg>
  )
}

function FlowArrowIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M1.5 7h7.5V3.5L14.5 8 9 12.5V9H1.5z" />
    </svg>
  )
}

/** OIP-only: show/hide the floor reference grid (a simple 3×3 grid glyph) */
function ShowGridIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M2 2h3.3v3.3H2zm4.35 0h3.3v3.3h-3.3zm4.35 0H14v3.3h-3.3zM2 6.35h3.3v3.3H2zm4.35 0h3.3v3.3h-3.3zm4.35 0H14v3.3h-3.3zM2 10.7h3.3V14H2zm4.35 0h3.3V14h-3.3zm4.35 0H14V14h-3.3z" />
    </svg>
  )
}

/** OIP extra: Snap-to-Floor (also on PageDown) */
function SnapFloorIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="5" y="1" width="6" height="4" />
      <path d="M7 6h2v3h2l-3 3-3-3h2z" />
      <rect x="1.5" y="13" width="13" height="2" fillOpacity="0.5" />
    </svg>
  )
}

interface ToolDef {
  tool: ToolMode
  label: MessageId
  /** the keymap action that picks this tool; its chord is read from the active table at render (keyHint.ts) */
  action?: string
  /** a mouse gesture instead, which the keymap does not hold */
  gesture?: string
  /** more help, after the label and its key */
  detail?: MessageId
  Icon: () => ReactElement
}

// Touch has no precise pointer, and the controller acts on that in two places that decide what
// belongs in this strip: gizmoVisible/pushResizeHandles draw no manipulator at all, and
// onPointerDown returns before the tool branches for `pointerType === 'touch'` (a press becomes a
// pending tap resolved in resolveTap). Mirrors the IS_COARSE_POINTER gate in controller/gizmo.ts.
const IS_COARSE_POINTER =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)').matches
    : false

// spatial-toolbar order, filtered to OIP's tools (Group dropped; Lock/Unlock added below):
// group 1 = transform modes (Transform/Move/Rotate/Scale/Select), group 2 = pick tools
// (separator before them, like the engine). Transform is the default combined
// move+rotate gizmo; Select has its own key, matching the engine.
//
// Coarse pointer: none of group 1 renders. Each only picks which gizmo is drawn, and touch never
// draws one, so on touch they would be five inert buttons that only change the highlight. Editing on
// touch goes through the Inspector. gizmoVisible gates on the same query, so the two can't disagree.
// (Phones drop the whole strip: App.tsx renders it only when `!isPhone`, so this is for tablets. It
// takes the bar from 14 buttons to 9 for clarity; measured, the bar never wraps either way.
// `.app.mobile .viewport-toolbar`'s flex-wrap is a fallback.)
const MODE_TOOLS: ToolDef[] = [
  { tool: 'transform', label: M.transform, action: 'tool.transform', Icon: TransformIcon },
  { tool: 'move', label: M.move, action: 'tool.move', Icon: MoveIcon },
  { tool: 'rotate', label: M.rotate, action: 'tool.rotate', Icon: RotateIcon },
  { tool: 'select', label: M.select, action: 'tool.select', Icon: SelectIcon },
]

// The pick tools split by pointer, because each one only works on one of them.
//
// Measure needs a two-point drag, which touch never starts (onPointerDown returns first, and
// resolveTap makes a ruler tap an explicit no-op), so it is fine-pointer only.
//
// List Select is the mirror image. On a fine pointer it is redundant: Alt+RMB pops the same picker
// from whatever tool you are already in, so the button would only add a worse way in: a persistent
// mode, with no chord, that you have to remember to leave. On touch that gesture does not exist and
// resolveTap honours `tool === 'list'`, which makes this the only way a fingertip can separate
// overlapping parts. So it is coarse-pointer only, and it is the one pick tool that survives there.
const PICK_TOOLS: ToolDef[] = IS_COARSE_POINTER
  ? [{ tool: 'list', label: M.listSelect, detail: M.listSelectDetail, Icon: ListSelectIcon }]
  : [
      {
        tool: 'ruler',
        label: M.measure,
        action: 'tool.ruler',
        detail: M.measureDetail,
        Icon: RulerIcon,
      },
    ]

/** `Label (key): detail`, with the key as the keymap has it right now - a rebinding in Settings shows here */
function toolTitle({ label, action, gesture, detail }: ToolDef): string {
  const key = action ? keyHint(action) : gesture
  const head = key ? t(M.toolKey, { label: t(label), key }) : t(label)
  return detail ? t(M.toolDetail, { head, detail: t(detail) }) : head
}

interface ViewportToolbarProps {
  store: EditorStore
  state: EditorState
  controller: EditorController | null
}

/** Spatial toolbar, overlaid at the top-left of the 3D viewport. */
export function ViewportToolbar({ store, state, controller }: ViewportToolbarProps) {
  const [configOpen, setConfigOpen] = useState(false)
  const { space, gridSnap } = state
  const hasSelection = state.selectedIds.length > 0
  // every tooltip here names its chord from the active keymap, so a rebinding has to re-render them
  useSyncExternalStore(subscribeKeymap, keymapRev)

  const toolButton = (def: ToolDef) => (
    <button
      key={def.tool}
      className={`viewport-tool${state.tool === def.tool ? ' active' : ''}`}
      title={toolTitle(def)}
      onClick={() => store.setTool(def.tool)}
    >
      <def.Icon />
    </button>
  )

  // A pick tool clicked while it is already active goes back to Transform. They are both transient -
  // you measure a span, or you separate one overlapping pick, and then you are done - so the way out
  // has to be the same button you came in by. On a coarse pointer that is not a nicety: List Select
  // is the only mode button rendered there, so without this there is no way back to Transform at all.
  const pickButton = (def: ToolDef) => (
    <button
      key={def.tool}
      className={`viewport-tool${state.tool === def.tool ? ' active' : ''}`}
      title={toolTitle(def)}
      onClick={() => store.setTool(state.tool === def.tool ? 'transform' : def.tool)}
    >
      <def.Icon />
    </button>
  )

  // While a freefly/pilot camera gesture owns the viewport, make the toolbar pointer-inert so a stray
  // click can't toggle a tool mid-flight (keyboard shortcuts are already suppressed in the controller).
  // Kept mounted, not hidden - RMB-hold freefly is a frequent, short gesture and unmounting would flicker.
  return (
    <div className={`viewport-toolbar-wrap${state.navigating ? ' nav-inert' : ''}`}>
      <div className="viewport-toolbar">
        {!IS_COARSE_POINTER && (
          <>
            {MODE_TOOLS.map(toolButton)}
            <span className="viewport-toolbar-sep" />
          </>
        )}

        {PICK_TOOLS.map(pickButton)}

        <span className="viewport-toolbar-sep" />

        {/* Orientation: Local Space. No Perspective/Orthogonal toggle: the orthographic view anyone wants
            is an axis view, which clicking an orbit-gizmo axis ball switches to (and reverts once you orbit
            off). The explicit toggle keeps O / Numpad 5 and is in the command palette (commands.ts
            view.projection). "Use Trackball" is in Settings > Preferences > Editing and keeps U: it is a
            persisted, default-off preference for how one gizmo region answers a drag (the rotate rings'
            interior sphere, gizmo.ts `rotTrackball`), set once, and it does nothing on conveyors, which set
            `rotateYawOnly` and lock the tilt rings. */}
        <button
          className={`viewport-tool${space === 'local' ? ' active' : ''}`}
          title={t(M.localSpaceTitle, {
            label: withKey(t(M.useLocalSpace), 'view.space'),
            space: t(space === 'local' ? M.spaceLocal : M.spaceGlobal),
          })}
          onClick={() => store.toggleSpace()}
        >
          <LocalSpaceIcon />
        </button>

        <span className="viewport-toolbar-sep" />

        {/* Snap cluster: grid-increment snap (Y), structural part snap (N), Configure Snap,
            and Snap-to-Floor - all the snapping controls in one place. */}
        <button
          className={`viewport-tool${gridSnap.enabled ? ' active' : ''}`}
          title={t(M.gridSnapTitle, {
            label: withKey(t(M.useGridSnap), 'snap.grid'),
            ctrl: IS_MAC ? '⌘' : 'Ctrl', // i18n-ok: modifier key name
          })}
          onClick={() => store.toggleGridSnap()}
        >
          <GridSnapIcon />
        </button>
        <button
          className={`viewport-tool${state.liveSnap ? ' active' : ''}`}
          title={t(M.liveSnapTitle, { label: withKey(t(M.liveSnap), 'snap.live'), faceKey: keyHint('snap.face') ?? t(M.faceSnap) })}
          onClick={() => store.setLiveSnap(!state.liveSnap)}
        >
          <LiveSnapIcon />
        </button>
        <button
          data-snap-gear
          className={`viewport-tool viewport-tool-mini${configOpen ? ' active' : ''}`}
          title={t(M.configureSnap)}
          onClick={() => setConfigOpen((v) => !v)}
        >
          <GearIcon />
        </button>
        <button
          className="viewport-tool"
          title={withKey(t(M.snapFloor), 'place.floor')}
          disabled={!hasSelection || !controller}
          onClick={() => controller?.snapSelectedToFloor()}
        >
          <SnapFloorIcon />
        </button>

        <span className="viewport-toolbar-sep" />

        {/* Display toggles: what's drawn over the viewport - floor grid, flow arrows, perf stats. */}
        <button
          className={`viewport-tool${state.showGrid ? ' active' : ''}`}
          title={t(M.toggleGrid)}
          onClick={() => store.toggleGrid()}
        >
          <ShowGridIcon />
        </button>
        <button
          className={`viewport-tool${state.flowArrows ? ' active' : ''}`}
          title={withKey(t(M.flowArrows), 'view.flowArrows')}
          onClick={() => store.toggleFlowArrows()}
        >
          <FlowArrowIcon />
        </button>
        {/* Shadow-map resolution and the performance read-out are in Settings > Preferences (Graphics), not
            here. Every button in this cluster changes the viewport on click, but shadow resolution applies
            only on the next load (a live shadow-map resize blacks out the WebGPU bundled pass; see
            src/render/quality.ts). The read-out is an instrument, not something drawn on the scene, and sits
            beside the two settings it judges (Quality, Shadow detail). `?bench` / `?gfx` / `?dpr` / `?msaa`
            force it on for one session; see StatsOverlay's CONFIG_OVERRIDES. */}

        {/* No select-as-one button here. SceneTreeMenu makes the same setGrouped call off the same
            allGrouped test, Ctrl+G / Ctrl+Shift+G is a third surface, and the tree is the only place the
            `grouped` flag's state is visible (a per-row marker + a .grouped row class). A toolbar button
            could only reflect the current selection, so its glyph would flip meaning and never be learnable
            as a shape. Same reasoning as the note above for Lock and Reparent. */}
      </div>

      {configOpen && <SnapConfig store={store} state={state} onClose={() => setConfigOpen(false)} />}
    </div>
  )
}


interface SnapConfigProps {
  store: EditorStore
  state: EditorState
  onClose: () => void
}

/** "Snap Settings" dialog (Configure Snap): translate + rotate increments. */
function SnapConfig({ store, state, onClose }: SnapConfigProps) {
  const ref = useRef<HTMLDivElement>(null)
  // the gear that opened it lives outside this box: its own click toggles, so it must not also dismiss
  useDismiss(ref, onClose, { ignore: '[data-snap-gear]' })

  const { translate, rotate } = state.gridSnap
  // stored in metres, shown in the scene's Length (1 ft reads 12 in)
  const units = sceneDisplayUnits(state.scene)
  const tv = unitView('m', units)

  return (
    <div className="snap-config" ref={ref} onPointerDown={(e) => e.stopPropagation()}>
      <div className="snap-config-title">{t(M.snapSettings)}</div>
      <SnapNumber
        label={t(M.translateField)}
        unit={tv.unit}
        value={Number((translate * tv.k).toPrecision(6))}
        step={tv.k === 1 ? 0.05 : 1}
        onCommit={(v) => store.setGridSnap({ translate: toStored(v, tv.k) })}
      />
      <SnapNumber label={t(M.rotateField)} unit="°" value={rotate} step={1} onCommit={(v) => store.setGridSnap({ rotate: v })} />
      {/* the generic face-flush slice of live snap (Shift+N); declared snaps ride the magnet toggle */}
      <SnapChoice
        label={t(M.faceSnap)}
        value={state.faceSnap ? 'on' : 'off'}
        options={[
          { value: 'on', label: t(M.on) },
          { value: 'off', label: t(M.off) },
        ]}
        onChange={(v) => store.setFaceSnap(v === 'on')}
      />
      <div className="snap-config-hint">
        {t(M.faceSnapHint, { faceKey: keyHint('snap.face') ?? '', repositionKey: keyHint('place.reposition') ?? '' })}
      </div>
      <button
        className="snap-config-reset"
        onClick={() => store.setGridSnap({ translate: defaultTranslateSnap(units), rotate: DEFAULT_ROTATE_SNAP_DEG })}
      >
        {t(M.resetDefaults)}
      </button>

      {/* vertex-snap (hold B) options */}
      <div className="snap-config-title snap-config-sub">{t(M.vertexSnapTitle)}</div>
      <SnapChoice
        label={t(M.base)}
        value={state.vertexSnapOriginMode ? 'origin' : 'vertex'}
        options={[
          { value: 'vertex', label: t(M.vertex) },
          { value: 'origin', label: t(M.origin) },
        ]}
        onChange={(v) => store.setVertexSnapOriginMode(v === 'origin')}
      />
      <SnapChoice
        label={t(M.source)}
        value={state.vertexSnapCollision ? 'collision' : 'mesh'}
        options={[
          { value: 'collision', label: t(M.collision) },
          { value: 'mesh', label: t(M.mesh) },
        ]}
        onChange={(v) => store.setVertexSnapCollision(v === 'collision')}
      />
      <div className="snap-config-hint">{t(M.flipHint)}</div>
    </div>
  )
}

interface SnapChoiceProps {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}

/** small two-option segmented control */
function SnapChoice({ label, value, options, onChange }: SnapChoiceProps) {
  return (
    <div className="snap-config-field">
      <span>{label}</span>
      <div className="snap-choice">
        {options.map((o) => (
          <button
            key={o.value}
            className={`snap-choice-btn${value === o.value ? ' active' : ''}`}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

interface SnapNumberProps {
  label: string
  unit: string
  value: number
  step: number
  onCommit: (v: number) => void
}

function SnapNumber({ label, unit, value, step, onCommit }: SnapNumberProps) {
  const [text, setText] = useState(String(value))
  const focused = useRef(false)

  useEffect(() => {
    if (!focused.current) setText(String(value))
  }, [value])

  return (
    <label className="snap-config-field">
      <span>{t(M.numberLabel, { label, unit })}</span>
      <input
        type="number"
        min={0}
        step={step}
        value={text}
        onFocus={() => {
          focused.current = true
        }}
        onBlur={() => {
          focused.current = false
          setText(String(value))
        }}
        onChange={(e) => {
          setText(e.target.value)
          const v = Number.parseFloat(e.target.value)
          if (Number.isFinite(v) && v >= 0) onCommit(v)
        }}
      />
    </label>
  )
}
