// The active in-editor tutorial: an action-gated walkthrough that drives a first-time
// user through building and programming a tiny line in their own scene. Each step waits
// for the real action (a part dropped, Play pressed, the program attached) before it
// advances - the overlay never fakes the work for them. See TutorialOverlay for the
// runtime that resolves the spotlight target and watches `done`.

import { conveyorEndsOf, type PartEnd } from '../../core/parts/partGeometry'
import { commsOn, commsParamOf } from '../../core/conveyor/conveyorDirection'
import type { PartInstance, SceneJSON } from '../../core/types'
import type { EditorController } from '../controller'
import { DESKTOP_MAC, DESKTOP_SHELL } from '../desktop/desktopMenuBridge'
import type { EditorState, EditorStore } from '../store/store'
import { defineMessages, t } from '../../core/i18n'

// The cards' text. Each step reads its strings through a getter, so t() runs when the overlay renders the card,
// after the locale is installed, never at module load. `{key:…}` and `{nav:…}` tokens are resolved later by
// withKeys (keyHint.ts); t() fills only the plain `{name}` placeholders.
const M = defineMessages('tutorialSteps', {
  welcomeTitle: 'Build your first line',
  welcomeBody:
    'Build a working conveyor line and program it with PLC logic. It takes a few minutes.\n\nYou build it in a project of your own, so you keep whatever you make.',
  start: 'Start',
  lookTitle: 'Look around',
  lookBody:
    'Move the camera to look around. Scroll to zoom, hold {nav:orbit} to orbit, and hold {nav:pan} to pan. To fly, hold the right mouse button and steer with {key:fly.forward}{key:fly.left}{key:fly.back}{key:fly.right}, plus {key:fly.down} and {key:fly.up} for down and up. Move the camera to continue.',
  shortcutsTitle: 'Keyboard shortcuts',
  shortcutsBody:
    'The editor is keyboard-driven: tools, snapping, and Pilot Mode all have keys. Press **{key:ui.shortcuts}**, or open this Help menu in the toolbar, for the full list at any time.',
  gotIt: 'Got it',
  appMenuTitle: 'The app menu',
  appMenuBody: 'File, Edit, View, Simulation and Help are behind the logo at the top left. Click it, or press Alt, to open them.',
  dropTitle: 'Place a conveyor',
  dropBody: 'In the Parts catalog at the bottom, open the Equipment tab and click Roller Conveyor, then click in the viewport to drop it near the marker.',
  dropHint: 'Drop it around here',
  boxTitle: 'Set a box on the conveyor',
  boxBody: 'Open the Products tab, click Box, then click the marker near the start of the conveyor. It rides the conveyor when the simulation runs.',
  boxHint: 'Drop a box here, on the conveyor',
  sensorTitle: 'Add a discharge sensor',
  sensorBody:
    'Open the Devices tab, click Photo Eye, then click the marker at the discharge end. It snaps to the side rail facing across the conveyor, so it can detect a box arriving.',
  sensorHint: 'Drop a sensor here, at the discharge',
  playTitle: 'Run the simulation',
  playBody: 'Press Play. The physics starts and the conveyor carries your box down the line.',
  watchTitle: 'The box runs off',
  watchBody: 'With no logic yet, the box rides straight off the end. A sensor and a program will fix that.',
  continue: 'Continue',
  stopTitle: 'Stop to wire it up',
  stopBody: 'Press Stop. The box returns to where you placed it, ready to run again with a program controlling it.',
  tagTitle: 'Tag the conveyor',
  tagBody:
    'A program controls a part through its PLC tag, a name you give it. The conveyor is selected. Type **{tag}** into the highlighted Run Tag field in the Inspector, then press Enter.',
  writeTitle: 'Write the program',
  writeBody:
    'A PLC program runs its logic over and over, reading its inputs and driving its outputs each pass. This one reads the sensor and stops the conveyor when a box arrives:\n\n{code}\n\nClick below to tag the sensor **{sensor}**, the same way you tagged the conveyor, and load that program into the PLC tab.',
  writeCta: 'Set up the sensor and program',
  plcTitle: 'Your program',
  plcBody:
    'This is the PLC tab, next to Parts. Your program lives here: read it, edit it, and Play runs whatever it holds.\n\nWhile the simulation runs, each variable shows its live value beside it.',
  runTitle: 'Run it',
  runBody: 'Press Play to run the line again, this time with your program in control.',
  interlockTitle: 'Watch the interlock',
  interlockBody:
    'The conveyor carries the box to the discharge. When the box breaks the sensor beam, the program stops the conveyor and the box stops there.\n\nIn the PLC tab, watch **{sensor}** turn TRUE and **{conveyor}** turn FALSE as it happens.',
  editTitle: 'Change the program',
  editBody:
    'Your program decides when the conveyor runs, so change it. In the PLC tab, find this line under IF {sensor} THEN:\n\n{line}\n\nChange FALSE to **TRUE** on that line, then press Reload. While the simulation runs, edits wait for Reload. Once it lands, the conveyor starts and the box rides off the end.\n\nA mistake is underlined in red and listed in the Problems tab.',
  doneTitle: 'Done',
  doneBody:
    'You placed equipment, added a sensor, and controlled the line with a PLC program you changed while it ran. The same steps work for any line you build.\n\nYour line stays in this scene, and its program stays in the PLC tab. To put the interlock back, change TRUE back to FALSE and press Reload.',
  finish: 'Finish',
})

/** a placed custom part bound to this package id (the SDK catalog cards place these) */
function isPkg(p: PartInstance, id: string): boolean {
  return p.type === 'part' && p.packageId === id
}

/** the conveyors a user can place from the catalog (Equipment tab): the SDK roller/belt cards place `custom`
 *  parts bound to their package ids (there are no built-in twins) */
function isConveyor(p: PartInstance): boolean {
  return isPkg(p, 'oip.roller-conveyor') || isPkg(p, 'oip.belt-conveyor')
}

function conveyors(scene: SceneJSON): PartInstance[] {
  return scene.parts.filter(isConveyor)
}

/**
 * The PLC tags the tutorial wires onto the line: a BOOL output that runs the conveyor, and a
 * sensor input. Named for the part the tour actually places, a roller conveyor. Calling it "the belt"
 * or tagging it `Belt` names the wrong equipment for a controls audience and points at the wrong
 * catalog card (there is a separate Belt Conveyor part).
 */
const CONVEYOR_TAG = 'Conveyor'
const SENSOR_TAG = 'BoxAtEnd'

/**
 * The interlock's logic, on its own so the "Write the program" card can show the user the logic
 * they're about to run before the button writes them. Shown verbatim in the card body (the
 * overlay renders any paragraph containing ST syntax as a code block) and embedded in the full
 * program below, so the two can't drift - steps.test.ts pins that.
 * Blank-line free: the card splits its body into paragraphs on blank lines, so a
 * gap here would break the snippet into two disjoint code blocks.
 */
export const INTERLOCK_LOGIC = `IF ${SENSOR_TAG} THEN
  ${CONVEYOR_TAG} := FALSE;
ELSE
  ${CONVEYOR_TAG} := TRUE;
END_IF;`

/**
 * The line "Change the program" has the user edit: the interlock's stop rung. Turning its FALSE into TRUE runs the
 * conveyor with the box parked at the sensor, so the box rides off, which is the proof that the program, not the
 * sensor, is what stopped it. It appears once in the program (the ELSE rung assigns TRUE), so the card's pointer
 * to it is unambiguous; steps.test.ts pins both.
 */
export const STOP_LINE = `${CONVEYOR_TAG} := FALSE;`

/** The sensor-interlock program the "Program the interlock" step writes into the PLC editor. The SDK roller's
 *  comms is a BOOL run tag (rollers run while true), so the interlock is a plain enable, not a REAL speed. */
export const INTERLOCK_PROGRAM = `VAR_INPUT
  ${SENSOR_TAG} : BOOL;
END_VAR
VAR_OUTPUT
  ${CONVEYOR_TAG} : BOOL;
END_VAR

(* Stop the line whenever the discharge sensor is blocked. *)
${INTERLOCK_LOGIC}
`

export interface TutorialContext {
  state: EditorState
  store: EditorStore
  controller: EditorController
  /** how long the current step has been on screen, so a gate that waits on the sim can time out
   *  rather than strand the user (the overlay owns the clock; it resets on every step change) */
  msOnStep: number
}

export interface TutorialStep {
  id: string
  title: string
  /** body copy; plain text, rendered as paragraphs split on blank lines */
  body: string
  /** ordered CSS selectors to spotlight; the first one present in the DOM wins. Omit for a centered card. */
  target?: string[]
  /** auto-advance predicate (the gate). Omitted = a pure button step advanced by `cta`. */
  done?: (ctx: TutorialContext) => boolean
  /** primary button label. For gated steps with an `action` it performs the setup; for un-gated steps it advances. */
  cta?: string
  /** optional one-click setup the `cta` runs (e.g. wiring the conveyor). After it runs, `done` should become true and auto-advance. */
  action?: (ctx: TutorialContext) => void
  /** dim the app around the card (default true): a full backdrop behind a centered/bottom card, or
   *  the surround of a spotlight. Set false on beats that ask the user to watch something - the dim
   *  would grey out the thing the card is pointing at. A spotlight step with `dim: false` keeps its
   *  ring and drops the surround, so it can point at a panel while the scene stays in plain view. */
  dim?: boolean
  /** advance once the camera has moved from where it sat when the step began (orbit/pan/zoom).
   *  The overlay owns the baseline + comparison, since `done` predicates can't see the camera. */
  cameraGate?: boolean
  /** card placement when there's no spotlight target: 'center' (default) or 'bottom' (keeps the viewport clear) */
  anchor?: 'center' | 'bottom'
  /** a world point [x,y,z] to mark in the 3D viewport (a "drop it here" target), or null to show none */
  placementHint?: (ctx: TutorialContext) => [number, number, number] | null
  /** caption under the placement marker */
  hintLabel?: string
  /** run once when the step becomes active (e.g. select a part + prime the Inspector). Idempotent. */
  onEnter?: (ctx: TutorialContext) => void
}

/**
 * The line's discharge conveyor as two world-space ends. Derived from the core `conveyorEndsOf`
 * seam so it's correct for every conveyor family regardless of the part's local origin: the SDK
 * roller bed is centre-origin while the belt is tail-origin, so the tutorial can't assume
 * `position` is the tail (a `position + length` guess floats the sensor marker a bed's
 * half-length past the real end of a roller bed). `front` is the downstream end, `back` upstream; `fwd` is the
 * unit XZ vector along the flow (back → front) and `len` the tail-to-head distance.
 */
function dischargeEnds(scene: SceneJSON): { front: PartEnd; back: PartEnd; fwd: [number, number]; len: number } | null {
  let best: { front: PartEnd; back: PartEnd } | null = null
  for (const c of conveyors(scene)) {
    const ends = conveyorEndsOf(c)
    const front = ends.find((e) => e.end === 'front')
    const back = ends.find((e) => e.end === 'back')
    if (!front || !back) continue
    // the discharge conveyor is the one whose downstream end reaches furthest along world +X
    if (!best || front.x > best.front.x) best = { front, back }
  }
  if (!best) return null
  const dx = best.front.x - best.back.x
  const dz = best.front.z - best.back.z
  const len = Math.hypot(dx, dz) || 1
  return { front: best.front, back: best.back, fwd: [dx / len, dz / len], len }
}

/**
 * Marker point for the discharge sensor: just above the conveyor surface near the far end, over
 * the bed edge on the side the sensor will mount. Dropping there engages the sensor snap
 * (the body overlaps the bed), which mounts it on that side rail facing across the bed with
 * an auto-fit range. Sitting it by the rail (rather than dead-centre) shows where the sensor
 * ends up and makes the mount side deterministic, while staying over the bed so the snap is
 * reliable - a drop on the thin rail itself risks missing the snap and floor-resting. Built from
 * the core-computed world ends, so it tracks the true discharge whatever the part's origin/incline.
 */
function dischargeMarkPoint(scene: SceneJSON): [number, number, number] | null {
  const d = dischargeEnds(scene)
  if (!d) return null
  const [fx, fz] = d.fwd
  const half = d.front.faceWidth / 2
  const side = Math.max(0, half - 0.1) // just inside the +side rail, still over the bed
  const px = -fz // +side: perpendicular to the flow axis
  const pz = fx
  const back = 0.4 // sit a little short of the very end, so the marker stays over the bed
  return [
    d.front.x - fx * back + px * side,
    d.front.y + 0.15,
    d.front.z - fz * back + pz * side,
  ]
}

/**
 * The scene as committed, with any in-flight placement preview unwound.
 *
 * The overlay's gates read `store.getState()` (the view/transient stream) so they react the instant
 * something changes, but placement stages the real part into `scene.parts` while it tracks the
 * cursor, before the user has dropped anything (docs/placement-staging.md; the staged part shares
 * the final id on purpose). Reading the raw scene would advance every "place a X" step the moment
 * the ghost appears: press Escape instead of clicking and the tour would have moved on with nothing
 * placed, and the step that follows would run a frame before the drop actually commits.
 * `controller.placing.staged` is the exact scene object the preview swapped in, so an identity
 * check against it is a reliable "this is the ghost, not a placement" test - the same one the
 * controller uses to keep the preview out of the sim (controller.ts).
 */
function committedScene(ctx: TutorialContext): SceneJSON {
  const p = ctx.controller.placing
  return p?.staged && ctx.state.scene === p.staged ? p.base : ctx.state.scene
}

function isWired(p: PartInstance, tag: string): boolean {
  const pr = p.params as Record<string, unknown>
  // the SDK roller's tag param is `runTag`; the sensors' (and the retired built-ins') is `tag`
  return commsOn(p) && (pr.tag === tag || pr.runTag === tag)
}

/**
 * Entry hook for the "Tag the conveyor" step: select the conveyor, so the Inspector is open on it and the
 * hands-on lesson is just naming it in the PLC tag field. A copy whose package declares a comms switch
 * (`commsParam`; no built-in does) has it switched on too.
 * Idempotent - safe to re-run if the effect fires again.
 */
function primeConveyorTagging(ctx: TutorialContext): void {
  const scene = ctx.store.getState().scene
  const conveyor = conveyors(scene)[0]
  if (!conveyor) return
  ctx.store.select(conveyor.id)
  const key = commsParamOf(conveyor)
  if (key && (conveyor.params as Record<string, unknown>)[key] !== true) {
    const parts = scene.parts.map((p) =>
      p.id === conveyor.id ? ({ ...p, params: { ...p.params, [key]: true } } as PartInstance) : p,
    )
    ctx.store.commit('Enable conveyor comms', { ...scene, parts })
  }
}

function conveyorIsTagged(ctx: TutorialContext): boolean {
  const conveyor = conveyors(committedScene(ctx))[0]
  return !!conveyor && isWired(conveyor, CONVEYOR_TAG)
}

/**
 * Entry hook for the beats where the user is meant to watch the line rather than act on it.
 *
 * Two bits of leftover editing state otherwise sit on top of the scene the card is pointing at:
 *  - the selection. The editor selects each part as it is placed, and the tagging step selects the
 *    conveyor on purpose, so a transform gizmo (a full rotate sphere, at the default tool) is drawn
 *    across the conveyor through the "box runs off" beat and the closing run.
 *  - placing mode. Click-to-place stays armed after a drop so you can place several
 *    (placement.ts re-arms on commit), which leaves a ghost part tracking the cursor while the card
 *    says "Press Play" - and makes the user's next viewport click drop a second sensor.
 *
 * Idempotent, and both calls no-op when there's nothing to clear. Pressing Play ends placing mode
 * too (controller.run), but the ghost is on screen for the whole trip up to the button.
 */
function clearSelectionForWatching(ctx: TutorialContext): void {
  ctx.store.clearSelection()
  ctx.store.cancelPlacing()
}

/**
 * Entry hook for the placement steps: put the Parts catalog on screen.
 *
 * The catalog shares the bottom dock with the PLC panel, and the tour's own program step brings the
 * PLC tab forward (tagSensorAndWriteProgram), a layout that persists. So a replay can open on the PLC
 * tab with the catalog unmounted: the card would say "click the Roller Conveyor" with nothing to click,
 * and its spotlight would have no target. Same for a collapsed bottom dock or distraction-free, both
 * of which the reveal undoes.
 */
function showCatalog(ctx: TutorialContext): void {
  ctx.store.revealPanel('catalog')
}

/**
 * Where the PLC panel is on screen: the dock slot it is the front tab of (DockSlot tags the slot
 * with its front panel), else its floating window. A popped-out panel lives in another window and
 * a maximized one covers the whole shell, so neither resolves and the card falls back to its anchor.
 */
const PLC_PANEL = ['[data-tutorial="dock-st"]', '[data-floating="st"]']

/** the tutorial's discharge sensor: the SDK diffuse-sensor card places a `custom` part (there is no
 *  built-in diffuse_sensor type) */
function isDiffuseSensor(p: PartInstance): boolean {
  return isPkg(p, 'oip.diffuse-sensor')
}

/** Setup-step action: tag the sensor for the user (same as they tagged the conveyor) + write the program */
function tagSensorAndWriteProgram(ctx: TutorialContext): void {
  const scene = ctx.store.getState().scene
  const parts = scene.parts.map((p) => {
    if (!isDiffuseSensor(p)) return p
    const key = commsParamOf(p)
    return { ...p, params: { ...p.params, ...(key ? { [key]: true } : {}), tag: SENSOR_TAG } } as PartInstance
  })
  ctx.store.commit('Tag sensor', { ...scene, parts })
  // Surface the PLC panel before writing, so the user watches the program arrive: the card says it
  // appears there and offers to edit it. The panel docks behind the Parts tab by default, which is also
  // where the tour's own placement steps put it: the panel is then unmounted and the program appears
  // out of nowhere on the next Play. (A floating or popped-out panel is always up and needs nothing.)
  // The write below doesn't depend on this (loadStProgram persists); this is only for visibility.
  ctx.store.revealPanel('st')
  ctx.store.loadStProgram(INTERLOCK_PROGRAM)
}

function sensorIsTagged(ctx: TutorialContext): boolean {
  const sensor = committedScene(ctx).parts.find(isDiffuseSensor)
  return !!sensor && isWired(sensor, SENSOR_TAG)
}

/** how long to wait for the box to reach the sensor before letting the last step finish anyway */
const INTERLOCK_TIMEOUT_MS = 30_000

/**
 * Gate for the "Watch the interlock" step: the interlock actually firing, not merely a program attach.
 *
 * Gating on `programStatus.attached`, which is true within a frame of Play, would flip the card to
 * "Done" before the box has moved, and the payoff the step promises ("the program stops the
 * conveyor, so the box stops there") would play out behind a card announcing the tour is over. Waiting for the sensor to read TRUE with the conveyor output driven FALSE means
 * the user is still being told what to watch while it happens.
 *
 * `plcWatch` is the running program's live variable image, keyed by declared variable name. It
 * changes every scan without emitting a store or program event, which is exactly the case the
 * overlay's gate poll exists for.
 *
 * The timeout is the escape hatch: a box knocked off the side, or a sensor mounted where nothing
 * ever breaks its beam, must not strand someone on the last beat. The step begins once Play is
 * pressed (the "Run it" step before it gates on that), so the clock measures the run itself.
 */
function interlockFired(ctx: TutorialContext): boolean {
  const status = ctx.controller.programStatus
  if (!status.attached || status.unwired.includes(SENSOR_TAG)) return false
  const watch = ctx.controller.plcWatch
  if (watch && watch[SENSOR_TAG] === true && watch[CONVEYOR_TAG] === false) return true
  return ctx.msOnStep > INTERLOCK_TIMEOUT_MS
}

/** the program with its whitespace collapsed: re-indenting it, or a newline CodeMirror normalized, is not an edit */
function programTokens(src: string): string {
  return src.replace(/\s+/g, ' ').trim()
}

/**
 * Gate for "Change the program": a program the user edited is the one running.
 *
 * Every step before this one writes the program for them, so the tour could end without the user ever changing a
 * line, and the first edit they made on their own would silently do nothing: while the sim runs, an edit waits for
 * Reload (or Ctrl/Cmd-Enter), and the PLC panel has no Run button to suggest it. So the step waits for the whole
 * loop, not the keystroke: the text differs from the tour's, and it is what runs. That is the Reload button's own
 * reading (controller.programOutOfDate, which lights it) plus a successful attach. A reload that does not compile
 * leaves the previous program running and `programAttachFailure` set, so a typo keeps the card up, with the
 * error underlined in the code, rather than moving on over a program that never ran.
 *
 * Play counts as well as Reload: a resumed run comes back stopped (Reload is dim then, and its tooltip says Play
 * runs the program as it is), and Play attaching the edit is the same lesson.
 */
function editedProgramRuns(ctx: TutorialContext): boolean {
  const { state, controller } = ctx
  if (!state.running || programTokens(state.stProgram) === programTokens(INTERLOCK_PROGRAM)) return false
  return controller.programStatus.attached && controller.programAttachFailure === null && !controller.programOutOfDate
}

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: 'welcome',
    get title() { return t(M.welcomeTitle) },
    get body() { return t(M.welcomeBody) },
    get cta() { return t(M.start) },
  },
  {
    id: 'look-around',
    get title() { return t(M.lookTitle) },
    // scroll leads: plenty of laptops and trackpads have no middle button, and the gate accepts any
    // camera change, so the first gesture offered should be the one everyone can perform
    // keys as {key:…} tokens, resolved from the active keymap when the card renders (keyHint.ts withKeys):
    // typed in, they would keep teaching the defaults after a rebinding in Settings. {nav:…} likewise follows the
    // navigation style, which decides whether the middle button alone orbits or pans
    get body() { return t(M.lookBody) },
    cameraGate: true,
    anchor: 'bottom',
    dim: false,
  },
  {
    id: 'shortcuts',
    get title() { return t(M.shortcutsTitle) },
    // Placed here, in the orientation half, because the previous step is the only other place the
    // tour teaches keys - the user has WASD in their head and is primed to ask "what else?". It
    // points at the button rather than opening the dialog: .author-backdrop is z-index 80 against
    // the tour's 60, so an auto-open would bury this very card behind a list of 40 bindings the
    // user has no context for yet. Knowing where the reference lives is the durable half; the
    // chord is the part they forget. The reference lives in the toolbar's Help menu, which is what
    // data-tutorial="shortcuts" marks.
    get body() { return t(M.shortcutsBody) },
    target: ['[data-tutorial="shortcuts"]', '.help-button'],
    get cta() { return t(M.gotIt) },
  },
  // Windows/Linux desktop only: the shell hides the OS menu bar (main.cjs), so the app's File/Edit/View menu
  // lives behind the logo, which people don't find on their own. macOS keeps the screen's menu bar and the
  // browser has none, so neither gets the step. Fixed at module load, like DESKTOP_SHELL itself, so a saved
  // step index stays meaningful within one surface.
  ...(DESKTOP_SHELL && !DESKTOP_MAC
    ? [
        {
          id: 'app-menu',
          get title() { return t(M.appMenuTitle) },
          get body() { return t(M.appMenuBody) },
          target: ['[data-tutorial="app-menu"]'],
          get cta() { return t(M.gotIt) },
        },
      ]
    : []),
  {
    id: 'drop-conveyor',
    get title() { return t(M.dropTitle) },
    get body() { return t(M.dropBody) },
    // the Equipment tab is the fallback for a catalog left on another tab (it is component state,
    // so it only resets when the catalog remounts)
    target: ['[data-package-id="oip.roller-conveyor"]', '[data-tutorial="catalog-Equipment"]'],
    onEnter: showCatalog,
    done: (ctx) => conveyors(committedScene(ctx)).length >= 1,
    placementHint: () => [0, 0.5, 0],
    get hintLabel() { return t(M.dropHint) },
  },
  {
    id: 'place-box',
    get title() { return t(M.boxTitle) },
    get body() { return t(M.boxBody) },
    target: ['[data-package-id="oip.box"]', '[data-tutorial="catalog-Products"]'],
    onEnter: showCatalog,
    done: (ctx) => committedScene(ctx).parts.some((p) => isPkg(p, 'oip.box')),
    placementHint: (ctx) => {
      const d = dischargeEnds(ctx.state.scene)
      if (!d) return null
      const [fx, fz] = d.fwd
      // sit it near the start (the upstream/back end) so it has the whole bed to travel to the discharge
      const along = Math.min(0.7, d.len * 0.2)
      return [d.back.x + fx * along, d.back.y + 0.25, d.back.z + fz * along]
    },
    get hintLabel() { return t(M.boxHint) },
  },
  {
    id: 'add-sensor',
    get title() { return t(M.sensorTitle) },
    get body() { return t(M.sensorBody) },
    target: ['[data-package-id="oip.diffuse-sensor"]', '[data-tutorial="catalog-Devices"]'],
    onEnter: showCatalog,
    done: (ctx) => committedScene(ctx).parts.some(isDiffuseSensor),
    placementHint: (ctx) => dischargeMarkPoint(ctx.state.scene),
    get hintLabel() { return t(M.sensorHint) },
  },
  {
    id: 'press-play',
    get title() { return t(M.playTitle) },
    get body() { return t(M.playBody) },
    target: ['[data-tutorial="play"]'],
    // drop the just-placed sensor's gizmo before the watching beats (see clearSelectionForWatching);
    // one deselect here covers Play, the run-off, and Stop
    onEnter: clearSelectionForWatching,
    done: (ctx) => ctx.state.running,
  },
  {
    id: 'watch',
    get title() { return t(M.watchTitle) },
    get body() { return t(M.watchBody) },
    anchor: 'bottom',
    dim: false,
    get cta() { return t(M.continue) },
  },
  {
    id: 'stop',
    get title() { return t(M.stopTitle) },
    get body() { return t(M.stopBody) },
    target: ['[data-tutorial="stop"]'],
    done: (ctx) => !ctx.state.running,
  },
  {
    id: 'tag-conveyor',
    get title() { return t(M.tagTitle) },
    get body() { return t(M.tagBody, { tag: CONVEYOR_TAG }) },
    // target the input itself - the .prop-row wrapper is display:contents (zero-size box). The SDK
    // roller's tag param is `runTag`; `tag` covers a retired built-in conveyor in an old scene.
    target: ['.inspector [data-param="runTag"] input', '.inspector [data-param="tag"] input'],
    onEnter: primeConveyorTagging,
    done: conveyorIsTagged,
  },
  {
    id: 'write-program',
    get title() { return t(M.writeTitle) },
    get body() { return t(M.writeBody, { code: INTERLOCK_LOGIC, sensor: SENSOR_TAG }) },
    get cta() { return t(M.writeCta) },
    action: tagSensorAndWriteProgram,
    done: sensorIsTagged,
  },
  {
    // The step above brings the PLC tab forward, but behind a full-screen dim, and its gate is met by
    // the same click, so on its own the panel would arrive unseen, and nothing in the tour would point
    // at where the program lives or how to get back to it.
    id: 'plc-panel',
    get title() { return t(M.plcTitle) },
    get body() { return t(M.plcBody) },
    target: PLC_PANEL,
    get cta() { return t(M.gotIt) },
  },
  {
    id: 'run-program',
    get title() { return t(M.runTitle) },
    get body() { return t(M.runBody) },
    target: ['[data-tutorial="play"]'],
    // the tagging step selected the conveyor for the Inspector; drop it so the closing run and the
    // Done card aren't watched through a gizmo
    onEnter: clearSelectionForWatching,
    done: (ctx) => ctx.state.running,
  },
  {
    // Split from "Run it" so the spotlight can move off Play: that step dims everything but the
    // button, which is the PLC panel this beat asks the user to watch.
    id: 'watch-interlock',
    get title() { return t(M.interlockTitle) },
    get body() { return t(M.interlockBody, { sensor: SENSOR_TAG, conveyor: CONVEYOR_TAG }) },
    target: PLC_PANEL,
    // the box is in the viewport and the values are in the panel: ring the panel, dim neither
    dim: false,
    anchor: 'bottom',
    done: interlockFired,
  },
  {
    // The one hands-on PLC beat: until here the tour writes every line for the user. What it teaches is the thing
    // they need the moment the tour ends, that an edit to a running program waits for Reload (editedProgramRuns).
    // No cursor is put on the line for them: store.revealStOffset focuses the code, and the next WASD meant for the
    // camera would type into the program.
    id: 'edit-program',
    get title() { return t(M.editTitle) },
    get body() { return t(M.editBody, { sensor: SENSOR_TAG, line: STOP_LINE }) },
    target: PLC_PANEL,
    // the payoff is the box in the viewport: ring the panel, dim nothing
    dim: false,
    anchor: 'bottom',
    // the user may have switched the bottom dock to Parts or Problems while the interlock ran
    onEnter: (ctx) => ctx.store.revealPanel('st'),
    done: editedProgramRuns,
  },
  {
    id: 'done',
    get title() { return t(M.doneTitle) },
    get body() { return t(M.doneBody) },
    // Pointed at the panel rather than anchored to the bottom of the window: that anchor sits on the
    // bottom dock, over the live values of the program that is still running.
    target: PLC_PANEL,
    anchor: 'bottom',
    // the interlock is still running behind this card - don't grey out the result
    dim: false,
    get cta() { return t(M.finish) },
  },
]
