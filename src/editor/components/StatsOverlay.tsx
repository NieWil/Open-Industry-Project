import { useEffect, useState } from 'react'
import type { IRenderView, RenderStats } from '../../render/api'
import { renderQuality } from '../../render/quality'
import { readBenchParams } from '../bench'
import type { EditorController } from '../controller'
import { budgetShare, limitOf, rowMs, splitRows, useRenderMeter, useStepMeter } from '../simLoad'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('stats', {
  render: 'render',
  gpu: 'gpu',
  sim: 'sim',
  cargo: 'cargo',
  limitedBy: 'limited by {what}',
  theSim: 'the sim',
  theMainThread: 'the main thread',
  theGpu: 'the GPU',
  gpuHint: 'Settings > Graphics > Quality: Reduced draws less',
  mainThreadHint: 'fewer parts in view, or Settings > Graphics > Quality: Reduced',
  simHint: 'a lower Physics rate (Scene inspector) or less cargo',
})

/** a row label's width in the monospace column, so the values line up whatever the label's length */
const LABEL_WIDTH = 8

/** the per-field render overrides that make the resolved config worth stating (see below) */
const CONFIG_OVERRIDES = ['gfx', 'dpr', 'msaa', 'overlaypass', 'nooverlaypass']

/**
 * Whether to print the resolved render config under the backend badge.
 *
 * The line answers "which arm am I in?", and that is only a question once something has moved off
 * the default. A plain desktop session with no overrides would just be restating the preset, so it
 * stays hidden there and the overlay keeps its summary. It appears when a per-field override
 * or `?gfx` is in play, on the mobile tier (a phone has no devtools to check against), and for a
 * `?bench` run, whose whole output has to be attributable to one arm.
 *
 * Resolved once, like every other URL flag here: none of its inputs change within a load.
 */
export function shouldShowConfigLine(search: string, tier: string): boolean {
  if (tier === 'mobile') return true
  if (readBenchParams(search).enabled) return true
  const params = new URLSearchParams(search)
  return CONFIG_OVERRIDES.some((k) => params.has(k))
}

/**
 * Whether to add the engineering lines (the step rate and the draw count) under the summary:
 * `?stats=dev`, or a `?bench` run, whose pasted output is read by whoever is tuning the renderer. A user
 * turning the read-out on in Settings gets the summary only: those numbers need a budget in your head to mean
 * anything, and the summary does that sum for them.
 */
export function shouldShowStatDetails(search: string): boolean {
  if (readBenchParams(search).enabled) return true
  return new URLSearchParams(search).get('stats') === 'dev'
}

const SEARCH = typeof location === 'undefined' ? '' : location.search
const SHOW_CONFIG = shouldShowConfigLine(SEARCH, renderQuality.tier)
const SHOW_DETAILS = shouldShowStatDetails(SEARCH)

/** RenderStats plus the pre-view state, where the backend isn't known yet (badge hidden). */
type FrameRenderStats = Omit<RenderStats, 'backend'> & { backend: RenderStats['backend'] | null }

export interface FrameStats {
  /** EMA of render frame dt, seconds; 0 until first frame */
  dtEma: number
}

interface StatsOverlayProps {
  frameStats: { current: FrameStats }
  controller: EditorController | null
  view: IRenderView | null
  running: boolean
  /** the scene's sim step rate (its `simHz` in project.json) */
  simHz: number
  /** the requested sim speed (the speed button): at 8x the worker steps 8x as often, so a step's budget is an eighth */
  timeScale: number
}

const pct = (load: number): string => `${Math.round(load * 100)}%`
const busy = (load: number | null): string => (load === null ? '-' : pct(load))
/** a frame's ms, against the refresh interval (null only before there is a view) */
// i18n-ok: unit
const frameMs = (ms: number, refreshMs: number | null): string => (refreshMs === null ? `${ms.toFixed(1)} ms` : `${ms.toFixed(1)} / ${refreshMs.toFixed(1)} ms`)

export function StatsOverlay({ frameStats, controller, view, running, simHz, timeScale }: StatsOverlayProps) {
  const [, setTick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 250)
    return () => clearInterval(id)
  }, [])

  const renderStats: FrameRenderStats = view
    ? view.getStats()
    : { drawCalls: 0, drawPath: null, triangles: 0, cpuMs: 0, cpuTotalMs: 0, frames: 0, gpuMs: null, gpuTotalMs: null, gpuFrames: 0, refreshMs: null, missedFrames: 0, backend: null, matrixLiveParts: 0, textures: 0, geometries: 0 }
  const cargo = running && controller ? controller.boxCount : 0

  // Every side is measured the same way: cumulative counters window-diffed against real time (simLoad.ts), so fps is
  // the true rate, hitches included. render = the main thread producing frames, gpu = the GPU drawing them (WebGPU
  // timestamps; "-" where there are none), sim = the sim worker (parts, PLC, physics and all, so not `physics`: that
  // is one row of it). Each line's percentage is its time against its budget (simLoad.ts budgetShare): a frame
  // against the display's refresh interval, a step against the time it has at this rate and speed. Over 100% is
  // too slow, by that much. The ms beside it are what compare across monitors, rates, scenes and machines.
  const frame = useRenderMeter(view)
  const dt = frameStats.current.dtEma
  // until the first window lands (half a second after mount), the view's own averaged interval
  const fps = frame.fps ?? (dt > 0 ? 1 / dt : 0)
  // the frame budget: the display's refresh interval (frameMeter.ts RefreshEstimate), or the frame interval before there is a view
  const refreshMs = renderStats.refreshMs
  const frameBudgetMs = refreshMs ?? (fps > 0 ? 1000 / fps : null)
  const render = frame.load === null ? null : budgetShare(frame.msPerFrame, frameBudgetMs)
  const gpu = budgetShare(frame.gpuMsPerFrame, frameBudgetMs)
  const step = useStepMeter(controller, running)
  // the step's budget at the rate this run steps at (a rate edited mid-run applies on the next one) and the speed
  // asked for: the time a step must fit in to keep up. Without the speed, 8x would read `1.24 / 16.7 ms` beside 59%,
  // two numbers that disagree, because the real budget there is 2.1 ms.
  const runHz = running && controller ? (controller.sim.runHz ?? simHz) : simHz
  const stepBudgetMs = 1000 / (runHz * timeScale)
  // paused, the worker takes no steps: its last ms per step is kept, but it costs nothing
  const sim = !running || step.load === null ? null : step.load === 0 ? 0 : (budgetShare(step.msPerStep, stepBudgetMs) ?? step.load)
  const limit = limitOf({ render, gpu, sim }, frame.fps, refreshMs)
  const limitedBy = limit === 'sim' ? t(M.theSim) : limit === 'render' ? t(M.theMainThread) : limit === 'gpu' ? t(M.theGpu) : null
  const limitHint = limit === 'sim' ? t(M.simHint) : limit === 'render' ? t(M.mainThreadHint) : limit === 'gpu' ? t(M.gpuHint) : null
  // where the worker's time went, always while running: a share that grows is visible before it limits anything
  const simSplit = sim !== null ? splitRows(step.split, step.msPerStep) : null

  return (
    <div className="stats-overlay" data-testid="stats-overlay">
      {renderStats.backend && <div className="stats-overlay-backend">{renderStats.backend}</div>}
      {/* The render config that actually took effect, shown only when it is not the plain default
          (shouldShowConfigLine). On a phone there are no devtools, so a mistyped or ignored
          ?gfx / ?dpr / ?msaa would otherwise hand you the same arm twice with nothing on screen to
          say so. */}
      {SHOW_CONFIG && renderStats.backend && (
        <div className="stats-overlay-note">
          {/* i18n-ok: render config switches as their URL flags spell them */}
          {renderQuality.tier} dpr{Math.min(window.devicePixelRatio, renderQuality.pixelRatioCap)} msaa
          {renderQuality.msaaSamples}{' '}
          {/* i18n-ok: render config switches as their URL flags spell them */}
          {renderQuality.singlePass || renderStats.backend !== 'WebGPU' ? '1-pass' : '2-pass'}
        </div>
      )}
      {/* fps is capped by the display's refresh rate, so it says nothing about headroom; the lines under it do */}
      {/* i18n-ok: metric abbreviation */}
      <div>fps     {fps.toFixed(0).padStart(5)}</div>
      {render !== null && (
        <div>
          {t(M.render).padEnd(LABEL_WIDTH)}
          {pct(render).padStart(5)}
          {frame.msPerFrame !== null && <span className="stats-overlay-note">  {frameMs(frame.msPerFrame, refreshMs)}</span>}
        </div>
      )}
      {/* the GPU's share and its ms per frame; "-" where the GPU isn't measured (WebGL, no timestamp queries) */}
      {render !== null && (
        <div data-testid="stats-gpu">
          {t(M.gpu).padEnd(LABEL_WIDTH)}
          {(gpu !== null ? pct(gpu) : '-').padStart(5)}
          {frame.gpuMsPerFrame !== null && <span className="stats-overlay-note">  {frameMs(frame.gpuMsPerFrame, refreshMs)}</span>}
        </div>
      )}
      {/* only while running: the worker only reports while stepping. ms per step against its budget at this run's rate */}
      {sim !== null && (
        <div>
          {t(M.sim).padEnd(LABEL_WIDTH)}
          {pct(sim).padStart(5)}
          {step.msPerStep !== null && (
            // i18n-ok: unit
            <span className="stats-overlay-note">  {step.msPerStep.toFixed(2)} / {stepBudgetMs.toFixed(stepBudgetMs < 10 ? 2 : 1)} ms</span>
          )}
        </div>
      )}
      {/* where that step time went, in its ms, indented under it: the rows add up to the sim line's ms */}
      {simSplit && (
        <div className="stats-overlay-note" data-testid="stats-sim-split">
          {simSplit.map((r) => (
            <div key={r.label}>
              {'  '}
              {r.label.padEnd(8)}
              {/* 9 = the decimal points sit under the sim line's ms (`sim      21%  1.77`), so the column adds up by eye */}
              {/* i18n-ok: unit */}
              {rowMs(r.ms).padStart(9)} ms
            </div>
          ))}
        </div>
      )}
      <div>
        {t(M.cargo).padEnd(LABEL_WIDTH)}
        {cargo.toFixed(0).padStart(5)}
      </div>
      {limitedBy && <div className="stats-overlay-warn">{t(M.limitedBy, { what: limitedBy })}</div>}
      {limitHint && <div className="stats-overlay-note">{limitHint}</div>}
      {SHOW_DETAILS && (
        <div className="stats-overlay-details">
          {/* how busy each side is per real second, for profiling; the summary's percentages are against budgets */}
          {/* i18n-ok: metric labels */}
          <div>{`busy main ${busy(frame.load)} gpu ${busy(frame.gpuLoad)}${running && step.load !== null ? ` sim ${busy(step.load)}` : ''}`}</div>
          {/* i18n-ok: metric label and unit */}
          <div>rate {String(runHz).padStart(6)} Hz</div>
          {/* `rec` marks a frame that re-recorded the render bundles (or was held unbundled) - its draw
              tally is the whole list, where a replayed frame counts one per bundle execute. Without the
              marker the same scene reads ~26 or ~620 with nothing to say why (RenderStats.drawPath). */}
          <div>
            {/* i18n-ok: metric abbreviation; e2e/probes/stats-rec-marker.mjs finds the line by it */}
            draws {renderStats.drawCalls.toFixed(0).padStart(5)}
            {/* i18n-ok: metric abbreviation */}
            {renderStats.drawPath === 'record' && <span className="stats-overlay-note"> rec</span>}
          </div>
        </div>
      )}
    </div>
  )
}
