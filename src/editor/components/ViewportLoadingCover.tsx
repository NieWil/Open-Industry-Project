import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { onModelLoadProgress, whenAssetsQuiet, whenBuildingReady } from '../../render/gltf'
import { getLoadStage, signalCoverHidden, subscribeLoadStage, whenScenePainted } from '../../render/renderReady'
import type { LoadStage } from '../../render/renderReady'
import { isSceneSwapCovered, subscribeSceneSwapCover } from '../sceneSwapCover'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('loadingCover', {
  boot: 'Loading…',
  models: 'Loading models…',
  modelsRemaining: 'Loading models… {count} remaining',
  shaders: 'Compiling shaders…',
  scene: 'Loading scene…',
})

/** What the cover calls each leg of the first load: message ids, resolved where the cover renders. */
const STAGE_LABEL: Record<LoadStage, string> = {
  boot: M.boot,
  models: M.models,
  shaders: M.shaders,
}

/**
 * A count is safe on the models leg and nowhere else, for the same reason this cover has no spinner.
 * That leg is network + decode bound, so frames present normally and a number that changes gets a
 * frame to change in. The shaders leg stalls presentation outright (1.4-2.2 s of zero presented
 * frames on a cold pipeline cache), so anything that has to repaint to stay truthful freezes there
 * and reads as a hang. Hence: determinate where it can be, one static word where it cannot.
 */
const COVER_BUDGET_MS = 20000

/**
 * Full-bleed cover over the 3D viewport on first load, lifted once the building has its GLB geometry and
 * textures (whenBuildingReady), so the first building the user sees is the finished, textured one. The
 * toolbar and panels stay interactive underneath; parts keep streaming in behind the "Loading models…" pill.
 *
 * The progress signal is the stage label, and there is no spinner; do not add one. The WebGPU
 * pipeline pre-warm stalls presentation, not just the main thread: no frame is painted for 1.4-2.2 s on a
 * cold pipeline cache (e2e/probes/spinner-hitch.mjs), so a CSS spinner freezes mid-rotation and reads as a
 * hang. A label needs a frame only when it changes; RenderView announces each stage a painted frame ahead
 * (see LoadStage). The post-cover pill (ModelLoadingIndicator) keeps its spinner, since frames present there.
 *
 * Known gap: on WebGL the label sits at "Loading models…" through a ~1.5 s synchronous program link. It
 * fires before whenBuildingReady, so it has no verified point to be announced ahead of.
 *
 * The cover returns for a scene swap that cannot draw in one frame (sceneSwapCover.ts). It appears instantly
 * (`.swap` drops the transition), since a fade-in would show the pop-in it exists to hide, and leaves with
 * the usual fade because the lift removes `.swap` in the same render that adds `.ready`.
 */
export function ViewportLoadingCover() {
  const [ready, setReady] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // getServerSnapshot returns 'boot' so an SSR/prerender pass can't read the live stage
  const stage = useSyncExternalStore(subscribeLoadStage, getLoadStage, () => 'boot' as LoadStage)
  const swapping = useSyncExternalStore(subscribeSceneSwapCover, isSceneSwapCovered, () => false)
  // `ready` is the first load's verdict and never goes back; a swap re-covers on top of it
  const covered = !ready || swapping
  useEffect(() => {
    let cancelled = false
    let raf1 = 0
    let raf2 = 0
    // Both signals: the building's textures have decoded (whenBuildingReady) and the
    // renderer has actually painted the scene (whenScenePainted) - the latter waits for
    // WebGPU pipeline warm-up so the cover never fades onto a black, still-compiling
    // frame. On WebGL whenScenePainted resolves on frame one, so timing is unchanged.
    // One promise on both surfaces: the building is textured, the renderer has painted, and the
    // scene has stopped arriving. Without whenAssetsQuiet, WebGL would lift on the building alone
    // and then show ~2.5 s of parts popping in, while WebGPU waits for its whole staged pre-warm.
    // With it, "the cover lifted" means the same everywhere: the scene you asked for is here.
    void Promise.all([whenBuildingReady(), whenScenePainted(), whenAssetsQuiet()]).then(() => {
      // Wait two frames so the textured building has actually painted before we
      // fade out: the gate opening and building.ts's geometry-swap + texture
      // apply run on separate microtask chains, so the swap can still be pending
      // the instant the gate resolves.
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          if (!cancelled) setReady(true)
        })
      })
    }).catch((e: unknown) => console.warn('[oip] waiting for the scene to load failed', e))
    // One budget for the whole wait. The signals above carry their own internal caps (20 s on the
    // building assets, then a further 20 s on the pre-warm, armed only once the first resolved), so
    // chained they allow ~40 s of logo before either times out. Whatever is stuck, the user
    // waits this long and no longer: an incomplete scene with the pill still running explains
    // itself, and 40 s of a static logo reads as broken.
    const budget = setTimeout(() => {
      if (cancelled) return
      console.warn('[oip] loading cover hit its budget; revealing a scene that is still arriving')
      setReady(true)
    }, COVER_BUDGET_MS)
    return () => {
      cancelled = true
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
      clearTimeout(budget)
    }
  }, [])

  // in-flight model count, for the determinate remainder on the models leg (see STAGE_LABEL)
  const [remaining, setRemaining] = useState(0)
  useEffect(() => onModelLoadProgress(setRemaining), [])
  // Announce the fade's end, not its start. Work that only competes for the main thread (the
  // deferred interaction pre-warm) waits on this instead of on whenScenePainted, which fires two
  // rAF before the fade begins, so that work would run during the fade (see whenCoverHidden).
  // Keyed on `covered`, not `ready`: a swap that began during the first load holds the cover past
  // `ready`, so the fade has not started until it lets go. A later swap's lift re-signals, a no-op.
  useEffect(() => {
    if (covered) return
    const el = ref.current
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      signalCoverHidden()
    }
    // prefers-reduced-motion sets `transition: none`, so transitionend never fires there; a
    // backgrounded tab can drop it too. transitionend is the normal path, and the timer finishes the fade when it never comes.
    el?.addEventListener('transitionend', finish, { once: true })
    const timer = setTimeout(finish, 1200)
    return () => {
      el?.removeEventListener('transitionend', finish)
      clearTimeout(timer)
    }
  }, [covered])
  return (
    <div
      ref={ref}
      className={`viewport-cover${covered ? '' : ' ready'}${swapping ? ' swap' : ''}`}
      role="status"
      aria-live="polite"
      aria-hidden={!covered}
    >
      {/* i18n-ok: the product's name */}
      <img className="viewport-cover-logo" src="/oip-logo.svg" alt="Open Industry Project" />
      <div className="viewport-cover-status">
        {ready && swapping ? (
          t(M.scene)
        ) : stage === 'models' && remaining > 0 ? (
          t(M.modelsRemaining, { count: remaining })
        ) : (
          t(STAGE_LABEL[stage])
        )}
      </div>
    </div>
  )
}
