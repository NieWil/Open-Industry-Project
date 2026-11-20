import { useState } from 'react'
import type { ReactElement } from 'react'
import { sceneDisplayUnits, sceneUnits, setSceneLengthUnit, setSceneUnits } from '../../../core/scene/sceneUnits'
import { lengthUnitOf } from '../../../core/units'
import { MAX_SIM_HZ, MIN_SIM_HZ } from '../../../core/types'
import type { SceneLengthUnit, SceneUnits } from '../../../core/types'
import type { EditorState, EditorStore } from '../../store/store'
import type { EditorController } from '../../controller'
import { LIMIT_LOAD, loadAtRate, sustainableHz, useStepMeter } from '../../simLoad'
import { NumberField } from './fields'
import { partDisplayName } from '../../../core/parts/partDisplayName'
import { InspectorHeader } from './header'
import { getCommand, runCommand } from '../../commands'
import { defineMessages, t } from '../../../core/i18n'
import { ownSharedProject } from '../../project/sharedProject'

const M = defineMessages('inspector.scene', {
  runToSee: 'Run the scene to see what this rate costs on this machine.',
  shareUnder: 'under 1%',
  shareAbout: 'about {pct}%',
  cost: 'At {hz} Hz and normal speed this scene uses {share} of one CPU core.',
  nearLimit: 'That is close to what this machine can keep up with: a lower rate, or less cargo, keeps the sim in real time.',
  couldMax: 'This machine could run this scene at the maximum rate, {hz} Hz.',
  couldUpTo: 'This machine could run this scene at up to about {hz} Hz.',
  atLimit: 'This is about as high as this machine can run this scene.',
  partFallback: 'Part',
  partSceneTip: 'Open in the Part Editor',
  editingDefinition:
    'Editing the {name} part itself. Select one of its nodes in the Scene dock to edit it, or the part for its settings.',
  openInEditor: '{name} is open in the Part Editor. Select one of its nodes in the Scene dock to edit it, or the part for its settings.',
  selectPart: 'Select the part',
  backToScene: 'Back to the full scene',
  closeEditor: 'Close Part Editor',
  demo: 'Demo',
  sceneTip: "This scene's own properties",
  selectPartHint: 'Select a part to edit its properties.',
  physicsRate: 'Physics rate',
  physicsRateTip: "How many times a second this scene's world steps, {min} to {max}. Higher costs more CPU.",
  msPerStep:
    '{ms} ms per step. The world moves and sensors update once per step, so this is also the soonest a PLC output can follow an input.',
  unitsTip:
    "How this scene shows speeds, and what its conveyors' speed tags carry. Speed tags are REALs either way. Changing it converts every conveyor, as one undoable edit.",
  units: 'Speed',
  imperial: 'Imperial (FPM)',
  metric: 'Metric (m/s)',
  lengthTip:
    'The unit every length is shown and typed in. Changing Speed to the other system changes it to meters or inches. Display only: the scene keeps its lengths as they are.',
  length: 'Length',
  meters: 'Meters (m)',
  millimeters: 'Millimeters (mm)',
  inches: 'Inches (in)',
  lengthsNowShow: 'Lengths now show in {unit}.',
  fpm: 'feet per minute',
  mps: 'meters per second',
  conveyorsNowRun: { one: '{count} conveyor now runs in {unit}.', other: '{count} conveyors now run in {unit}.' },
  tagsNowCarry: {
    one: 'Speed tag {tags} now carries {unit}: change the speed values the program writes to match.',
    other: 'Speed tags {tags} now carry {unit}: change the speed values the program writes to match.',
  },
  runStepping: 'This run is stepping at {hz} Hz. {next} Hz applies on the next run.',
  demoLocked: 'The demo is the built-in example, so its settings cannot be changed. Edit the demo to make it a project of your own first.',
})

/**
 * The Inspector with nothing selected: the properties of the scene itself, which is what is in front of you then.
 * Today that is the physics step rate, which is the scene's (core/project/project.ts
 * ProjectMachine.simHz): it decides how finely a sensor sees cargo and how soon a PLC output can follow an input,
 * so it is part of the machine the scene is, like its scan time. Saved with the scene and, in a room, shared.
 *
 * Two locks: a view-only link owns nothing, and the demo preview is an ephemeral view that only an edit to its
 * layout makes the user's own. A running sim is not a lock: a world keeps the rate it was built at, so a change
 * applies on the next run, and the panel says so.
 *
 * And the scene's Units (SceneJSON.units, core/scene/sceneUnits.ts): how every speed is shown and typed, and what
 * every conveyor's speed tag carries (FPM or m/s, a REAL either way). A plant runs one convention, so this is the
 * only place it is chosen: part of the scene document, and an ordinary, undoable edit that converts every conveyor
 * with it. It cannot rewrite the program, so after a switch that moved bound speed tags it says so. Beside it, the
 * scene's Length (SceneJSON.lengthUnit): the unit every length shows in, display only, so it converts nothing. The
 * dropdown always shows the Length in effect, and a Units switch that moves it says so in the same note.
 */

/** what the last Units switch in this panel did, for the note under it: shown until Units change again (an undo
 *  included), and gone with the panel once a part is selected */
interface UnitsSwitch {
  units: SceneUnits
  switched: number
  tags: string[]
  length?: SceneLengthUnit
}

/**
 * What the rate costs on this machine, beside the field that sets it, so the rate is chosen knowing its cost
 * rather than found out from the speed button turning amber. Measured from the run in progress (simLoad.ts),
 * because the cost depends on the scene and the cargo on it as much as on the rate; stopped, it says how to find out.
 */
function RateCost({ controller, running, runHz }: { controller: EditorController | null; running: boolean; runHz: number | null }): ReactElement {
  const { msPerStep } = useStepMeter(controller, running)
  if (!running || runHz === null || msPerStep === null) {
    return (
      <p className="inspector-hint" data-testid="scene-rate-cost">
        {t(M.runToSee)}
      </p>
    )
  }
  const load = loadAtRate(msPerStep, runHz)
  const ceiling = sustainableHz(msPerStep)
  const share = load < 0.01 ? t(M.shareUnder) : t(M.shareAbout, { pct: Math.round(load * 100) })
  return (
    <p className="inspector-hint" role="status" data-testid="scene-rate-cost">
      {/* at 1x by construction (per-step cost x rate): the rate is the scene's, the speed button is not */}
      {t(M.cost, { hz: runHz, share })}{' '}
      {load >= LIMIT_LOAD
        ? t(M.nearLimit)
        : ceiling >= MAX_SIM_HZ
          ? t(M.couldMax, { hz: MAX_SIM_HZ })
          : ceiling > runHz
            ? t(M.couldUpTo, { hz: ceiling })
            : t(M.atLimit)}
    </p>
  )
}

/**
 * The Inspector with nothing selected inside a part's own scene (Open Part Editor, or the Catalog ✎ session): what is
 * in front of you is that part, not the document, so the document's rate and units would be the wrong scene's.
 * It says which part this is and how to get to what can be edited, and the way back.
 */
export function PartSceneProperties({ store, state, partId }: { store: EditorStore; state: EditorState; partId: string }): ReactElement {
  const part = state.scene.parts.find((p) => p.id === partId)
  const name = part ? partDisplayName(part, state.scene.parts) : t(M.partFallback)
  const definition = state.packageEdit !== null
  return (
    <div className="inspector" data-testid="part-scene-properties">
      <InspectorHeader title={name} tooltip={t(M.partSceneTip)} />
      <p className="inspector-hint">
        {t(definition ? M.editingDefinition : M.openInEditor, { name })}
      </p>
      <div className="rig-script-actions">
        {part && (
          <button type="button" className="array-add" onClick={() => store.select(part.id)}>
            {t(M.selectPart)}
          </button>
        )}
        <button type="button" className="array-add" title={t(M.backToScene)} onClick={() => runCommand('part.closeScene')}>
          {getCommand('part.closeScene')?.label ?? t(M.closeEditor)}
        </button>
      </div>
    </div>
  )
}

export function SceneProperties({ store, state, controller }: { store: EditorStore; state: EditorState; controller: EditorController | null }): ReactElement {
  // in a shared project of this browser's own (the demo included) the name is what it shared, as the project menu says
  const own = state.collab ? ownSharedProject() : null
  const name = state.demoSession ? t(M.demo) : (own?.project ?? state.projectName)
  const runHz = state.running ? (controller?.sim.runHz ?? null) : null
  const units = sceneUnits(state.scene)
  const [last, setLast] = useState<UnitsSwitch | null>(null)
  const note = last?.units === units ? last : null
  return (
    <div className="inspector" data-testid="scene-properties">
      <InspectorHeader title={name} tooltip={t(M.sceneTip)} />
      <p className="inspector-hint">{t(M.selectPartHint)}</p>
      <NumberField
        label={t(M.physicsRate)}
        unit="Hz"
        value={state.simHz}
        decimals={0}
        min={MIN_SIM_HZ}
        max={MAX_SIM_HZ}
        step={1}
        disabled={state.readOnly || state.demoSession}
        tooltip={t(M.physicsRateTip, { min: MIN_SIM_HZ, max: MAX_SIM_HZ })}
        onCommit={(hz) => store.setSimHz(hz)}
      />
      <p className="inspector-hint">
        {t(M.msPerStep, { ms: (1000 / state.simHz).toFixed(1) })}
      </p>
      <RateCost controller={controller} running={state.running} runHz={runHz} />
      <label className="field">
        <span
          className="field-label"
          title={t(M.unitsTip)}
        >
          {t(M.units)}
        </span>
        <span className="field-control">
          <select
            data-testid="scene-units"
            value={units}
            disabled={state.readOnly || state.demoSession}
            onChange={(e) => {
              const next = e.target.value as SceneUnits
              const change = setSceneUnits(store.getState().scene, next)
              store.commit('Set scene units', change.scene)
              setLast({ units: next, switched: change.switched, tags: change.tags, length: change.length })
            }}
          >
            <option value="imperial">{t(M.imperial)}</option>
            <option value="metric">{t(M.metric)}</option>
          </select>
        </span>
      </label>
      <label className="field">
        <span className="field-label" title={t(M.lengthTip)}>
          {t(M.length)}
        </span>
        <span className="field-control">
          <select
            data-testid="scene-length"
            value={lengthUnitOf(sceneDisplayUnits(state.scene))}
            disabled={state.readOnly || state.demoSession}
            onChange={(e) => {
              const next = e.target.value as SceneLengthUnit
              store.commit('Set scene length unit', setSceneLengthUnit(store.getState().scene, next))
            }}
          >
            <option value="m">{t(M.meters)}</option>
            <option value="mm">{t(M.millimeters)}</option>
            <option value="in">{t(M.inches)}</option>
          </select>
        </span>
      </label>
      {note && (note.switched > 0 || note.length) && (
        <p className="inspector-hint" role="status" data-testid="scene-units-note">
          {note.switched > 0 && t(M.conveyorsNowRun, { count: note.switched, unit: t(note.units === 'imperial' ? M.fpm : M.mps) })}
          {note.switched > 0 && note.tags.length > 0 && (
            <>
              {' '}
              {t(M.tagsNowCarry, { count: note.tags.length, tags: note.tags.join(', '), unit: t(note.units === 'imperial' ? M.fpm : M.mps) })}
            </>
          )}
          {note.length && (
            <>
              {note.switched > 0 && ' '}
              {t(M.lengthsNowShow, { unit: t(note.length === 'in' ? M.inches : note.length === 'mm' ? M.millimeters : M.meters) })}
            </>
          )}
        </p>
      )}
      {runHz !== null && runHz !== state.simHz && (
        <p className="inspector-hint" role="status">
          {t(M.runStepping, { hz: runHz, next: state.simHz })}
        </p>
      )}
      {state.demoSession && (
        <p className="inspector-hint" role="status">
          {t(M.demoLocked)}
        </p>
      )}
    </div>
  )
}
