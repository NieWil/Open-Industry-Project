import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { keymapRev, subscribeKeymap } from '../../core/keymap'
import type { IRenderView } from '../../render/api'
import { withKeys } from '../keyHint'
import type { EditorController } from '../controller'
import type { EditorState, EditorStore } from '../store/store'
import { isOtherDocumentSlot, SCENE_SLOT, sceneSlotKey, slotDocumentId } from '../project/documentStore'
import { canCreateProject, createNewProject, openProjectById } from '../project/newProject'
import { leaveDemo } from '../project/sceneFile'
import {
  clearTutorialProgress,
  consumeTourOnBoot,
  markTourOnBoot,
  markTutorialDone,
  onTutorialRequest,
  saveTutorialProgress,
  savedTutorialProgress,
  sceneHasWork,
  tutorialDone,
} from '../tutorial/session'
import { TUTORIAL_STEPS, type TutorialContext, type TutorialStep } from '../tutorial/steps'
import { CloseIcon } from './toolbarIcons'
import { defineMessages, t } from '../../core/i18n'
import { tNodes } from '../i18nNodes'

const M = defineMessages('tutorial', {
  needsEmptyTitle: 'The tour needs an empty project',
  needsEmpty:
    'It builds a line of its own and writes its own program, so it will not start over this one. Clear the layout and program (Project menu), or export this project first.',
  placeHere: 'Place here',
  stepCount: 'Step {n} of {total}',
  exit: 'Exit tutorial',
  paused: 'Tutorial paused',
  waiting: 'Your tutorial is waiting in the {project} project. It stays there, so it cannot touch this one.',
  end: 'End tutorial',
  backToTutorial: 'Back to the tutorial',
  skip: 'Skip tour',
  back: 'Back',
  next: 'Next',
})

interface TutorialOverlayProps {
  store: EditorStore
  state: EditorState
  controller: EditorController | null
  view: IRenderView | null
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
  /** top edge of the dock panel the target sits in, if any - the card must not cover it (see below) */
  dockTop: number | null
}

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.w - b.w) < 0.5 &&
    Math.abs(a.h - b.h) < 0.5 &&
    a.dockTop === b.dockTop
  )
}

/** resolve a step's spotlight to the first selector currently present in the DOM */
function resolveTarget(step: TutorialStep): Rect | null {
  for (const sel of step.target ?? []) {
    const el = document.querySelector(sel)
    if (el) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) {
        // A card placed above a target low on screen would cover the rest of that target's dock. For
        // the catalog steps that would hide the tab row the copy tells the user to click ("Open the
        // Devices tab", with the tab behind the card). Remember the dock's top edge so the
        // card can clear the whole panel instead of just the highlighted control.
        const dock = el.closest('.dock')
        const dockTop = dock ? dock.getBoundingClientRect().top : null
        return { x: r.left, y: r.top, w: r.width, h: r.height, dockTop }
      }
    }
  }
  return null
}

/**
 * The slot a run binds to: the open project's scene (documentStore.sceneSlotKey: the document id, and the one
 * scene a project holds). Every project's scene is `scene-1`, so a bare id would let a run parked in one project
 * resume, and commit its steps, in another.
 *
 * Null while a demo view holds the viewport: nothing on screen is the project's then. A run that can't name its
 * slot is not persisted; see `remember`.
 */
function activeSceneId(state: EditorState): string | null {
  return state.demoSession ? null : sceneSlotKey(SCENE_SLOT)
}

// `state` re-renders the overlay on every store change (keeping the card and gating responsive),
// and is read for the scene binding below: which tab is live is render-time truth, not something
// a predicate should re-derive. Everything else reads store.getState() for the freshest scene.
export function TutorialOverlay({ store, state, controller, view }: TutorialOverlayProps): ReactElement | null {
  const [active, setActive] = useState(false)
  const [index, setIndex] = useState(0)
  /** the scene slot this run is building in; the tour drives that scene and no other */
  const [sceneId, setSceneId] = useState<string | null>(null)
  // Furthest step reached this run. `index < maxIndex` means the user pressed Back and is
  // re-reading a step they already completed - see `reviewing` below.
  const [maxIndex, setMaxIndex] = useState(0)
  const [rect, setRect] = useState<Rect | null>(null)
  // a placement marker: an on-screen ring (`edge:false`) or, when its world point is off the
  // screen / behind the camera, an arrow at the screen edge pointing toward it (`edge:true`)
  const [hint, setHint] = useState<{ x: number; y: number; label: string; edge: boolean; angle: number } | null>(null)
  const step = TUTORIAL_STEPS[index]
  // step bodies name keys as {key:…} tokens (withKeys, below), so a rebinding has to re-render the card
  useSyncExternalStore(subscribeKeymap, keymapRev)

  const finish = useCallback(() => {
    setActive(false)
    setSceneId(null)
    markTutorialDone()
  }, [])

  // Persist as we go, so a reload (or a stray navigation) mid-tour resumes here instead of
  // dropping the user with the work half-done and no card, and record which scene "here" is in,
  // so the resume can only ever re-enter the tour's own work (session.ts).
  const remember = useCallback(
    (step: number) => {
      if (sceneId) saveTutorialProgress({ sceneId, step })
      else clearTutorialProgress() // an unbound run (a demo view) has no slot to resume into
    },
    [sceneId],
  )

  const advance = useCallback(() => {
    setIndex((i) => {
      if (i >= TUTORIAL_STEPS.length - 1) {
        finish()
        return i
      }
      remember(i + 1)
      return i + 1
    })
  }, [finish, remember])

  /**
   * Step back to re-read the previous card. Navigation only: it never touches the scene.
   *
   * It doesn't revert the step's work: the tour commits
   * into the same scene and the same undo stack as everything else the user does, so there is no
   * "step 3 transaction" to roll back. Anything they did in between (moved the conveyor, dropped
   * extra parts, edited the program) would be collateral, and the welcome card promises they keep
   * what they build. Undo is the per-action tool for taking something back; Back moves the card.
   */
  const goBack = useCallback(() => {
    setIndex((i) => {
      if (i <= 0) return i
      remember(i - 1)
      return i - 1
    })
  }, [remember])

  const startTour = useCallback((at: number, boundTo: string | null) => {
    // A view-only link blocks placing and committing (store.readOnly), so the tour would open and
    // then dead-end on its first build step: the card says "click the Roller Conveyor" and the
    // click does nothing. The toolbar button and the palette command already refuse through their
    // enablement; this covers the ways in that have no button to disable - the first-visit offer,
    // ?tour=1, and a resumed run.
    if (store.getState().readOnly) return
    setIndex(at)
    // a fresh start/resume re-bases the high-water mark, or the whole run would open in review mode
    setMaxIndex(at)
    setSceneId(boundTo)
    setActive(true)
  }, [store])

  /**
   * Start a run from the top, in a project the tour is allowed to drive.
   *
   * The tour can't run over an existing line: every build step's gate is satisfied by parts that
   * are already there (it only looks for "a conveyor", "a box", "a sensor"), so it would
   * fast-forward through the building and then reach into the user's scene for real - priming an
   * arbitrary existing conveyor for tagging, and overwriting whatever ST program they had.
   *
   * So it runs where nothing of theirs can be touched. A blank project (a first visit, a project made a
   * moment ago) is as good as a new one, and the tour runs right there. Anything else gets a "Tutorial"
   * project of its own, filed beside theirs: creating it reloads into it (newProject.ts), and markTourOnBoot
   * carries the start across, so the tour's line never lands inside whatever they were building.
   *
   * Where no project can be created (a room, a view link, a browser that keeps one project), the tour does not
   * start over their work: it says so. "Empty" includes the program (sceneHasWork).
   */
  const beginFreshRun = useCallback(() => {
    const s = store.getState()
    if (!s.demoSession && !sceneHasWork(s)) {
      startTour(0, activeSceneId(s))
      return
    }
    if (canCreateProject(store)) {
      markTourOnBoot()
      // i18n-ok: the new project's name, which also names its folder
      const failed = (error: string): void => {
        consumeTourOnBoot()
        alert(error)
      }
      void createNewProject(store, 'Tutorial')
        .then((error) => {
          if (error !== null) failed(error) // null: reloading into it
        })
        .catch((e: unknown) => failed(e instanceof Error ? e.message : String(e)))
      return
    }
    if (s.readOnly) return
    store.showSaveNotice(t(M.needsEmptyTitle), t(M.needsEmpty))
  }, [startTour, store])

  // Track the furthest step reached. Derived from `index` so it stays right however the index
  // moved (gate advance, Next, Back, resume).
  useEffect(() => {
    setMaxIndex((m) => (index > m ? index : m))
  }, [index])

  // Re-reading an already-completed step: its gate is satisfied by definition, so leaving the gate
  // armed would bounce the user straight forward again and make Back look broken. Suppress the
  // auto-advance and offer an explicit Next instead.
  const reviewing = index < maxIndex

  /**
   * The run's own scene is not the one on screen: the user switched tabs, or a demo view took the
   * viewport. The tour goes inert rather than following them: its gates read the live scene and
   * its `onEnter` hooks commit to it, so driving someone else's line is not a cosmetic mistake
   * (`primeConveyorTagging` would select their conveyor and turn its comms on, unprompted). The
   * card becomes a way back instead.
   */
  const away = active && sceneId !== null && activeSceneId(state) !== sceneId

  // The run's project is no longer the open one (a folder linked in place, a demo forked into a project of its
  // own): the tour closes here without retiring it, and the run is kept for when that project is open.
  useEffect(() => {
    if (!active || !sceneId) return
    if (!isOtherDocumentSlot(sceneId)) return
    setActive(false)
    setSceneId(null)
  }, [active, sceneId, state.projectName])

  // Decide once on mount whether to open, and where.
  //   ?tour=1               → always, from the top (the explicit "replay it" URL)
  //   half-finished run     → resume at the saved step, in the scene it was building in
  //   first-timer, blank    → offer from the top, once; the centered welcome card is the offer,
  //                           its Start / Skip tour being the accept / decline
  // The blank-scene condition keeps the tour from interrupting existing work - but it only
  // applies to the offer. A resume ignores it, since by then the tour's own scene is (correctly)
  // full of the parts it just had the user place.
  //
  // ?tour=1 goes through beginFreshRun like the toolbar does, so the explicit replay URL gets the
  // same protection instead of starting over whatever is on screen.
  useEffect(() => {
    // the tour's own project, just created for it (beginFreshRun): it is blank, so the run starts at the top here
    if (consumeTourOnBoot()) {
      startTour(0, activeSceneId(store.getState()))
      return
    }
    if (new URLSearchParams(location.search).get('tour') === '1') {
      // Consume the param: the landing page links here, and left in the URL a reload mid-run would
      // start another fresh run (the tour's own scene now has work, so beginFreshRun opens a second
      // Tutorial tab) instead of resuming the saved one below.
      try {
        const url = new URL(location.href)
        url.searchParams.delete('tour')
        history.replaceState(history.state, '', url.pathname + url.search + url.hash)
      } catch {
        // best-effort: a stuck param only costs a restart on reload
      }
      beginFreshRun()
      return
    }
    const saved = savedTutorialProgress()
    if (saved && saved.step < TUTORIAL_STEPS.length) {
      // Resume only into the scene the run was building in. Gone (the tab was deleted) means there
      // is nothing to resume, and re-entering over whatever is active is the hazard the binding
      // exists for - so drop the run rather than land it somewhere it doesn't belong.
      if (sceneSlotKey(SCENE_SLOT) === saved.sceneId) {
        startTour(saved.step, saved.sceneId)
        return
      }
      // a run in another project is kept for that project; one whose scene is gone from this one is dropped
      if (!isOtherDocumentSlot(saved.sceneId)) clearTutorialProgress()
    }
    if (tutorialDone()) return
    if (sceneHasWork(store.getState())) return
    // The offer is made once. Retiring it as it is shown means walking past the card (placing a part, a new
    // project, a reload) counts as a decline, so it does not re-offer on every blank project. Start still runs
    // the tour: progress is saved and resumed whatever the done flag says.
    markTutorialDone()
    startTour(0, activeSceneId(store.getState()))
  }, [beginFreshRun, startTour, store])

  // Toolbar entry point: resume a half-finished run, else start a fresh one (`beginFreshRun`, which
  // owns the "not over their line" rule). Without this, "Skip" on the welcome would retire the tour
  // for good in this browser.
  //
  // A resume goes back to the tour's own scene, switching tabs to get there. That is the button's
  // whole job when a run is parked in another tab: the tour is inert everywhere else (see `away`),
  // so "open the tutorial" has to mean "take me to it", not "start it here".
  useEffect(
    () =>
      onTutorialRequest(() => {
        const saved = savedTutorialProgress()
        if (saved && saved.step < TUTORIAL_STEPS.length) {
          if (sceneSlotKey(SCENE_SLOT) === saved.sceneId) {
            // a demo opened over the tour's project is left first: the tour drives the project, not the demo. Leaving
            // reloads into it, and the resume on that boot picks the run up at its step
            if (store.getState().demoSession) {
              leaveDemo()
              return
            }
            startTour(saved.step, saved.sceneId)
            return
          }
          // In a project that is not open: that project is the tour's, so open it - the resume on its boot picks
          // the run up at its step. If it cannot be opened (deleted since), the run is dropped and starts over.
          const doc = slotDocumentId(saved.sceneId)
          if (doc !== null && isOtherDocumentSlot(saved.sceneId) && canCreateProject(store)) {
            const failed = (): void => {
              clearTutorialProgress()
              beginFreshRun()
            }
            void openProjectById(store, doc)
              .then((error) => {
                if (error !== null) failed() // null: reloading into it
              })
              .catch((e: unknown) => {
                console.warn('[oip] reopening the tutorial project failed', e)
                failed()
              })
            return
          }
          // its scene is gone from this project: dropped, and a fresh run
          if (!isOtherDocumentSlot(saved.sceneId)) clearTutorialProgress()
        }
        beginFreshRun()
      }),
    [beginFreshRun, startTour, store],
  )

  // Run a step's one-time entry hook (e.g. select a part so the Inspector is primed, or drop the
  // selection before a watching beat).
  //
  // Deferred a frame. The action that advances a step usually has more to do after the
  // store commit that triggered it: placing a part commits (which is what advances the tour) and
  // then selects the new part and re-arms placing mode (placement.ts). Run inline, the hook would
  // lose that race: a hook clearing the selection would clear an empty one and the placement would
  // re-select immediately after, leaving the gizmo on screen. A frame later the burst has settled.
  useEffect(() => {
    if (!active || away || !step?.onEnter || !controller) return
    const hook = step.onEnter
    const raf = requestAnimationFrame(() => hook({ state: store.getState(), store, controller, msOnStep: 0 }))
    return () => cancelAnimationFrame(raf)
  }, [active, away, index, step, controller, store])

  // Scroll the spotlight target into view once it exists - a field like the Inspector's
  // PLC-tag row sits below the fold, so without this the highlight is off-screen and the
  // user has to hunt for it. Polls until the target renders (onEnter selection is async).
  useEffect(() => {
    if (!active || away || !step?.target) return
    const targets = step.target
    let raf = 0
    let scrolled = false
    const tryScroll = (): void => {
      if (scrolled) return
      for (const sel of targets) {
        const el = document.querySelector(sel)
        if (el) {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' })
          scrolled = true
          return
        }
      }
      raf = requestAnimationFrame(tryScroll)
    }
    raf = requestAnimationFrame(tryScroll)
    return () => cancelAnimationFrame(raf)
  }, [active, away, index, step])

  // Gate: re-check the current step's `done` whenever the scene, run state, or program
  // status changes, and advance the moment it's satisfied. This is the whole "active"
  // mechanism - the step waits for the real action, it isn't click-through.
  useEffect(() => {
    if (!active || away || !controller || !step) return
    if (reviewing) return // re-reading a completed step: wait for Next, don't re-fire its gate
    // Per-step clock for gates that wait on the sim rather than on a user action (the closing
    // interlock step). This effect re-runs on every step change, so `enteredAt` is exactly when
    // the current step came up.
    const enteredAt = Date.now()
    // Latch: one part placement fires several store notifications synchronously (transient
    // drag → commit → selection). Without this guard a still-true predicate (e.g. "≥1
    // conveyor") would call advance() once per notification and skip several steps in a
    // single burst, since this effect's closure isn't refreshed until React re-renders.
    let advanced = false
    const check = (): void => {
      if (advanced) return
      const ctx: TutorialContext = { state: store.getState(), store, controller, msOnStep: Date.now() - enteredAt }
      if (step.done?.(ctx)) {
        advanced = true
        advance()
      }
    }
    check()
    const unScene = store.subscribeView(check)
    const unProg = controller.onProgramStatus(check)
    // Some gates read live values that don't emit store/program events (e.g. plcWatch.Belt,
    // which changes each PLC scan). Poll so those steps still advance.
    const poll = step.done ? window.setInterval(check, 150) : 0
    return () => {
      unScene()
      unProg()
      if (poll) window.clearInterval(poll)
    }
  }, [active, away, index, controller, step, store, advance, reviewing])

  // Camera-move gate ("Look around"): snapshot the view when the step begins, then advance
  // once it has moved beyond a small epsilon (orbit/pan/zoom all change position or target).
  useEffect(() => {
    if (!active || away || !step?.cameraGate || !view) return
    if (reviewing) return // as with the `done` gates: Back must not be undone by a stray orbit
    const base = view.cameraPose()
    let advanced = false
    let raf = 0
    const moved = (): boolean => {
      const p = view.cameraPose()
      const d =
        Math.abs(p.px - base.px) + Math.abs(p.py - base.py) + Math.abs(p.pz - base.pz) +
        Math.abs(p.tx - base.tx) + Math.abs(p.ty - base.ty) + Math.abs(p.tz - base.tz)
      return d > 0.05
    }
    const loop = (): void => {
      if (!advanced && moved()) {
        advanced = true
        advance()
        return
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [active, away, index, step, view, advance, reviewing])

  // Track the spotlight target every frame so it follows tab switches, scrolling, and
  // layout/resize without any coupling to the components it highlights.
  useEffect(() => {
    if (!active || away || !step) {
      setRect(null)
      return
    }
    let raf = 0
    const loop = (): void => {
      const r = resolveTarget(step)
      setRect((prev) => (sameRect(prev, r) ? prev : r))
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [active, away, index, step])

  // Placement marker: project a step's world "drop it here" point to screen each frame so
  // it tracks the camera. Cleared when the point is off-screen or the step defines none.
  useEffect(() => {
    if (!active || away || !step?.placementHint || !view || !controller) {
      setHint(null)
      return
    }
    const hintFn = step.placementHint
    const label = step.hintLabel ?? t(M.placeHere)
    let raf = 0
    const same = (
      a: { x: number; y: number; label: string; edge: boolean; angle: number } | null,
      b: { x: number; y: number; label: string; edge: boolean; angle: number },
    ): boolean =>
      !!a && a.edge === b.edge && a.label === b.label && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.angle - b.angle) < 0.01
    const loop = (): void => {
      const world = hintFn({ state: store.getState(), store, controller, msOnStep: 0 })
      if (!world) {
        setHint((prev) => (prev === null ? prev : null))
        raf = requestAnimationFrame(loop)
        return
      }
      const s = view.worldToScreen(world[0], world[1], world[2])
      let next: { x: number; y: number; label: string; edge: boolean; angle: number }
      if (s.visible) {
        // on screen: a ring sits right on the spot
        next = { x: s.x, y: s.y, label, edge: false, angle: 0 }
      } else {
        // off screen / behind the camera: clamp an arrow to the 3D viewport edge (not the
        // window: it must not float over the side panels/toolbar), pointing toward the spot.
        // cameraPose tells us if it's behind us (projection then flips), so we negate the
        // direction in that case to point the user the right way to turn.
        const vp = document.querySelector('.viewport')?.getBoundingClientRect()
        const cx = vp ? vp.left + vp.width / 2 : window.innerWidth / 2
        const cy = vp ? vp.top + vp.height / 2 : window.innerHeight / 2
        const pose = view.cameraPose()
        const dot = (pose.tx - pose.px) * (world[0] - pose.px) + (pose.ty - pose.py) * (world[1] - pose.py) + (pose.tz - pose.pz) * (world[2] - pose.pz)
        let dx = s.x - cx
        let dy = s.y - cy
        if (dot <= 0) {
          dx = -dx
          dy = -dy
        }
        const len = Math.hypot(dx, dy) || 1
        dx /= len
        dy /= len
        const mx = (vp ? vp.width : window.innerWidth) / 2 - 32
        const my = (vp ? vp.height : window.innerHeight) / 2 - 32
        const t = Math.min(mx / (Math.abs(dx) || 1e-6), my / (Math.abs(dy) || 1e-6))
        next = { x: cx + dx * t, y: cy + dy * t, label, edge: true, angle: Math.atan2(dy, dx) }
      }
      setHint((prev) => (same(prev, next) ? prev : next))
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [active, away, index, step, view, controller, store])

  if (!active || !step) return null

  const cardW = 320

  // Parked in another tab: no spotlight, no backdrop, no gate - just the way back. Anchored at the
  // bottom so it stays clear of the scene the user came here to work on, and it can be dismissed
  // outright, since a paused tour they no longer want must not follow them around the project.
  if (away) {
    const tourProject = state.projectName
    // the only way to be away from the tour's own project while it is open is the demo opened over it; leaving it
    // reloads into the project, where the run resumes on its step
    const returnToTour = (): void => leaveDemo()
    return (
      <div className="tut-root">
        <div className="tut-card" style={{ width: cardW, left: '50%', bottom: 28, transform: 'translateX(-50%)' }}>
          <div className="tut-card-head">
            <span className="tut-step-count">{t(M.stepCount, { n: index + 1, total: TUTORIAL_STEPS.length })}</span>
            <button className="tut-close" title={t(M.exit)} onClick={finish}>
              <CloseIcon />
            </button>
          </div>
          <h3 className="tut-title">{t(M.paused)}</h3>
          <p className="tut-body">{tNodes(M.waiting, { project: <span className="tut-kbd">{tourProject}</span> })}</p>
          <div className="tut-card-foot">
            <button className="tut-btn tut-btn-ghost tut-skip" onClick={finish}>
              {t(M.end)}
            </button>
            <button className="tut-btn tut-btn-primary" onClick={returnToTour}>
              {t(M.backToTutorial)}
            </button>
          </div>
        </div>
      </div>
    )
  }

  const onCta = (): void => {
    if (step.action && controller) {
      step.action({ state: store.getState(), store, controller, msOnStep: 0 })
      // gated action steps advance via `done`; un-gated ones advance now
      if (!step.done) advance()
    } else {
      advance()
    }
  }

  // Tooltip placement: below the target if there's room, else above, else beside it; clamp to the
  // viewport. With no target it's centered or bottom-anchored (welcome / watch).
  let cardStyle: React.CSSProperties
  if (rect) {
    // a typical card's height: enough to decide which side has room, not a layout constant
    const cardH = 180
    const below = rect.y + rect.h + 12
    // going above, clear the target's whole dock (not just the control) so the card doesn't sit on
    // the panel's own tabs/header - which is where the step's next instruction usually points.
    // The wider gap when clearing a dock keeps the card off its title, which paints above the
    // element's own box.
    const above = rect.dockTop !== null && rect.dockTop < rect.y ? rect.dockTop - 26 : rect.y - 12
    const left = Math.max(12, Math.min(window.innerWidth - cardW - 12, rect.x + rect.w / 2 - cardW / 2))
    // A target too tall to clear either way - a whole panel, when the user has docked the PLC
    // editor down a side column - would put an "above" card off the top of the window. Sit beside
    // it instead, on the roomier side, or failing that inside its foot.
    const roomLeft = rect.x - 12
    const roomRight = window.innerWidth - (rect.x + rect.w) - 12
    if (below + cardH < window.innerHeight) {
      cardStyle = { left, top: below }
    } else if (above - cardH >= 12) {
      cardStyle = { left, bottom: window.innerHeight - above }
    } else if (Math.max(roomLeft, roomRight) >= cardW) {
      const top = Math.max(12, Math.min(window.innerHeight - cardH - 12, rect.y + 12))
      cardStyle = { left: roomLeft >= roomRight ? rect.x - 12 - cardW : rect.x + rect.w + 12, top }
    } else {
      cardStyle = { left, bottom: Math.max(12, window.innerHeight - (rect.y + rect.h) + 12) }
    }
  } else if (step.anchor === 'bottom') {
    cardStyle = { left: '50%', bottom: 28, transform: 'translateX(-50%)' }
  } else {
    cardStyle = { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }
  }

  const stepNo = index + 1
  const total = TUTORIAL_STEPS.length

  return (
    <div className="tut-root">
      {rect ? (
        <div
          // `dim: false` keeps the ring and drops the surround (see TutorialStep.dim)
          className={`tut-spotlight${step.dim === false ? ' tut-spotlight-clear' : ''}`}
          // the surround is a box-shadow, invisible to a hit test: the desktop caption strip reads it from here
          data-strip-dim="shadow"
          style={{ left: rect.x - 6, top: rect.y - 6, width: rect.w + 12, height: rect.h + 12 }}
        />
      ) : (
        // No spotlight: dim the app behind the card, unless the step is asking the user to watch
        // the scene ("The box runs off", the closing run behind the Done card), which a backdrop
        // would grey out.
        // (pointer-events: none hides it from the caption strip's hit test, hence the attribute)
        step.dim !== false && <div className="tut-dim" data-strip-dim="fill" />
      )}
      {hint &&
        (hint.edge ? (
          <div
            className="tut-edge"
            title={hint.label}
            style={{ left: hint.x, top: hint.y, transform: `translate(-50%, -50%) rotate(${hint.angle}rad)` }}
          />
        ) : (
          <div className="tut-place-marker" style={{ left: hint.x, top: hint.y }}>
            <span className="tut-place-ring" />
            <span className="tut-place-label">{hint.label}</span>
          </div>
        ))}
      <div className="tut-card" style={{ width: cardW, ...cardStyle }}>
        <div className="tut-card-head">
          <span className="tut-step-count">{t(M.stepCount, { n: stepNo, total })}</span>
          <button className="tut-close" title={t(M.exit)} onClick={finish}>
            <CloseIcon />
          </button>
        </div>
        <h3 className="tut-title">{step.title}</h3>
        {withKeys(step.body).split('\n\n').map((para, i) =>
          // a code block (ST snippet) renders monospace with its line breaks preserved
          /VAR_|:=|END_IF/.test(para) ? (
            <pre key={i} className="tut-code">
              {para}
            </pre>
          ) : (
            <p key={i} className="tut-body">
              {/* **word** marks a literal the user types (e.g. a PLC tag), shown as a chip */}
              {para.split(/\*\*(.+?)\*\*/).map((seg, j) =>
                j % 2 === 1 ? (
                  <span key={j} className="tut-kbd">
                    {seg}
                  </span>
                ) : (
                  seg
                ),
              )}
            </p>
          ),
        )}
        <div className="tut-card-foot">
          <button className="tut-btn tut-btn-ghost tut-skip" onClick={finish}>
            {t(M.skip)}
          </button>
          {index > 0 && (
            <button className="tut-btn tut-btn-ghost" onClick={goBack}>
              {t(M.back)}
            </button>
          )}
          {reviewing ? (
            // Replaces the step's own CTA while re-reading. Those CTAs perform setup
            // (the sensor-tag-and-write-program button), and re-running one would clobber edits the
            // user has made since - the ST buffer especially. The work is already done; the only
            // thing left to offer is a way forward.
            <button className="tut-btn tut-btn-primary" onClick={advance}>
              {t(M.next)}
            </button>
          ) : (
            step.cta && (
              <button className="tut-btn tut-btn-primary" onClick={onCta}>
                {step.cta}
              </button>
            )
          )}
        </div>
      </div>
    </div>
  )
}
