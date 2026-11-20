// --- Transform fold (Position / Rotation; live pose via the throttled view stream) ---

import { normalizeAngle } from '../../../core/math'
import { translateParts, yawParts } from '../../../core/scene/offsetParts'
import type { PartInstance, PartType } from '../../../core/types'
import { paramDesc } from '../paramDescriptions'
import type { EditorStore } from '../../store/store'
import { useLiveValue } from '../../useLiveValue'
import { AxisInput, Fold, useShownLengthUnit, VectorRow } from './fields'
import type { OpenCtx } from './menu'
import { coerceVec3 } from './paramLogic'
import type { Update } from './shared'
import { defineMessages, t } from '../../../core/i18n'

const M = defineMessages('inspector.transform', {
  title: 'Transform',
  position: 'Position ({unit})',
  rotation: 'Rotation (°)',
})

/**
 * The Transform fold (Position / Rotation). The rest of the inspector reads the committed `state`
 * and refreshes only on commit. This section reads the live pose through useLiveValue, which
 * follows the store's throttled view stream, so the fields track a gizmo drag frame by frame.
 * The editor chrome skips those high-frequency updates for performance (see EditorStore.subscribe);
 * keeping the live read to this small section keeps that saving while showing the moving values.
 *
 * Over several parts a field the parts disagree on is mixed, and a typed value sets it on each. A relative entry
 * ("+= 1.2", see parseOffset) moves the selection the way the gizmo does: Position offsets every part and its
 * descendants, Rotation Y turns them all about the selection's centre.
 */
export function TransformSection({
  store,
  committed,
  ids,
  type,
  disabled,
  effCollapsed,
  toggle,
  openCtx,
  update,
}: {
  store: EditorStore
  committed: PartInstance
  /** the selected parts the section edits (committed is the first) */
  ids: readonly string[]
  type: PartType
  disabled: boolean
  effCollapsed: Record<string, boolean>
  toggle: (path: string) => void
  openCtx: OpenCtx
  update: Update
}) {
  // live pose: while a drag streams transient scenes, getState() carries the moving parts even though
  // the React stream skipped them. useLiveValue rides the throttled view stream so the fields track the
  // drag frame by frame without re-rendering the rest of the panel. The selector returns the scene's parts
  // array, a stable reference until the scene changes, so Object.is equality holds.
  const liveParts = useLiveValue(store, (s) => s.scene.parts)
  const idSet = new Set(ids)
  const live = liveParts.filter((p) => idSet.has(p.id))
  const targets = live.length > 0 ? live : [committed]
  const part = targets[0]!
  const multi = ids.length > 1
  const offset = (label: string, key: string, move: (parts: readonly PartInstance[]) => PartInstance[]) => {
    // built on the store's current scene, never a rendered one (see the Inspector's update)
    const scene = store.getState().scene
    store.commit(multi ? `${label} (${ids.length})` : label, { ...scene, parts: move(scene.parts) }, { coalesceKey: `param:${ids.join(',')}:${key}` })
  }
  const mixedBy = (of: (p: PartInstance) => number): boolean => targets.some((p) => of(p) !== of(part))
  const setAxis = (label: string, key: string, axis: 0 | 1 | 2, v: number) =>
    update(label, key, (p) => {
      const position: [number, number, number] = [...p.position]
      position[axis] = v
      return { ...p, position }
    })
  const rotDeg = (normalizeAngle(part.rotationY) * 180) / Math.PI
  const rotXDeg = (normalizeAngle(part.rotationX ?? 0) * 180) / Math.PI
  const rotZDeg = (normalizeAngle(part.rotationZ ?? 0) * 180) / Math.PI
  const rotated = targets.some((p) => p.rotationY !== 0 || !!p.rotationX || !!p.rotationZ)
  const lengthUnit = useShownLengthUnit()
  return (
    <Fold title={t(M.title)} path="Transform" collapsed={effCollapsed} toggle={toggle}>
      <VectorRow
        label={t(M.position, { unit: lengthUnit })}
        tooltip={paramDesc(type, '_position')}
        onContext={disabled ? undefined : (e) =>
          openCtx(e, {
            key: 'position',
            kind: 'pos',
            value: [...part.position],
            accept: coerceVec3,
            setValue: (v) => {
              const a = v as readonly number[]
              update('Move part', 'pos', (p) => ({ ...p, position: [a[0]!, a[1]!, a[2]!] }))
            },
          })
        }
      >
        {([0, 1, 2] as const).map((axis) => (
          <AxisInput
            key={axis}
            prefix={['X', 'Y', 'Z'][axis]!}
            value={part.position[axis]}
            decimals={3}
            entryUnit="m"
            disabled={disabled}
            mixed={mixedBy((p) => p.position[axis])}
            onCommit={(v) => setAxis('Move part', `pos${axis}`, axis, v)}
            onOffset={(d) => {
              const delta: [number, number, number] = [0, 0, 0]
              delta[axis] = d
              offset('Move part', `pos${axis}`, (parts) => translateParts(parts, ids, delta))
            }}
          />
        ))}
      </VectorRow>
      {/* rotation is a 3-vector (YXZ Euler): X/Z tilt a part (e.g. an angled sensor) */}
      <VectorRow
        label={t(M.rotation)}
        tooltip={paramDesc(type, '_rotation')}
        onContext={disabled ? undefined : (e) =>
          openCtx(e, {
            key: 'rotation',
            kind: 'rot',
            value: [part.rotationX ?? 0, part.rotationY, part.rotationZ ?? 0],
            accept: coerceVec3,
            setValue: (v) => {
              const a = v as readonly number[]
              update('Rotate part', 'rot', (p) => ({
                ...p,
                rotationX: normalizeAngle(a[0]!),
                rotationY: normalizeAngle(a[1]!),
                rotationZ: normalizeAngle(a[2]!),
              }))
            },
            revert: rotated
              ? () =>
                  update('Rotate part', 'rot', (p) => {
                    const q = { ...p } as PartInstance
                    delete q.rotationX
                    delete q.rotationZ
                    return { ...q, rotationY: 0 }
                  })
              : undefined,
          })
        }
      >
        <AxisInput
          prefix="X"
          value={rotXDeg}
          decimals={1}
          step={15}
          disabled={disabled}
          mixed={mixedBy((p) => p.rotationX ?? 0)}
          onCommit={(v) =>
            update('Rotate part', 'rot', (p) => ({ ...p, rotationX: normalizeAngle((v * Math.PI) / 180) }))
          }
        />
        <AxisInput
          prefix="Y"
          value={rotDeg}
          decimals={1}
          step={15}
          disabled={disabled}
          mixed={mixedBy((p) => p.rotationY)}
          onCommit={(v) =>
            update('Rotate part', 'rot', (p) => ({ ...p, rotationY: normalizeAngle((v * Math.PI) / 180) }))
          }
          onOffset={(d) => offset('Rotate part', 'rot', (parts) => yawParts(parts, ids, (d * Math.PI) / 180))}
        />
        <AxisInput
          prefix="Z"
          value={rotZDeg}
          decimals={1}
          step={15}
          disabled={disabled}
          mixed={mixedBy((p) => p.rotationZ ?? 0)}
          onCommit={(v) =>
            update('Rotate part', 'rot', (p) => ({ ...p, rotationZ: normalizeAngle((v * Math.PI) / 180) }))
          }
        />
      </VectorRow>
    </Fold>
  )
}
