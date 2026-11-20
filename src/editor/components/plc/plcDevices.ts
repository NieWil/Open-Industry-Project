import { useMemo } from 'react'
import { commsParamOf } from '../../../core/conveyor/conveyorDirection'
import { deviceTags } from '../../../plc'
import { forceKeyOf } from '../../program/plcForces'
import type { PartInstance } from '../../../core/types'
import type { EditorStore } from '../../store/store'
import type { OrganizerDevices } from './OrganizerTree'
import type { PlcPanelCtx } from './plcPanelParts'

// The scene's devices as the PLC panel hands them to the organizer tree (OrganizerTree.tsx `OrganizerDevices`): the
// list, selecting one in the scene, and wiring a tag field.
//
// None of it is about the program - it is the scene. An edit here is the Inspector's own: one part's params, committed to the scene, so it is an ordinary document edit that
// undoes, saves and replicates like one made in the Inspector (docs/document-and-run.md: only authoring writes the
// document). Nothing here touches the program text.

/** One part's params changed - the same commit the Inspector's field makes. */
function patchPart(store: EditorStore, id: string, label: string, patch: Record<string, unknown>): void {
  const scene = store.getState().scene
  store.commit(label, { ...scene, parts: scene.parts.map((p) => (p.id === id ? ({ ...p, params: { ...(p.params as Record<string, unknown>), ...patch } } as PartInstance) : p)) }, { coalesceKey: `param:${id}:${Object.keys(patch).join(',')}` })
}

/**
 * The Devices section's list and its edits.
 *
 * Memoized on the scene's parts and the store alone - never on the panel's per-render ctx - because the object is a
 * prop of the tree's memoized `Popups`: a new one on every render would defeat what keeps opening a menu from
 * re-rendering a tree of hundreds of tag rows. Everything the callbacks need is read from the store when they run.
 */
export function useOrganizerDevices(ctx: PlcPanelCtx): OrganizerDevices {
  const { store } = ctx
  // Not the panel's `readOnly`: that is also true of a program written for a dialect this build cannot edit
  // (core/dialect.ts), and a part's wiring is the scene's, not the program's. A view-only link gates both, and is the one that belongs here.
  const readOnly = ctx.state.readOnly
  const list = useMemo(() => deviceTags(ctx.state.scene.parts), [ctx.state.scene.parts])
  return useMemo(
    () => ({
      list,
      readOnly,
      select: (id) => store.select(id),
      setTag: (id, key, value) => patchPart(store, id, `Edit ${key}`, { [key]: value }),
      setComms: (id, on) => {
        // the part's declared switch (package.commsParam); a part without one is always connected, nothing to write
        const part = ctx.state.scene.parts.find((p) => p.id === id)
        const key = part ? commsParamOf(part as { type: string; packageId?: string }) : undefined
        if (key) patchPart(store, id, 'Edit Enable Comms', { [key]: on })
      },
      // through the panel's doors, which reach the controller as it is when called
      forcing: {
        keyOf: (tag) => forceKeyOf(tag, ctx.watch(), ctx.aliases()),
        forces: ctx.forces,
        onForces: ctx.onForces,
        force: ctx.force,
        release: ctx.releaseForce,
        onProgramStatus: ctx.onProgramStatus,
      },
    }),
    [list, readOnly, store],
  )
}
