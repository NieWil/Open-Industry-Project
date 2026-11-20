# Document and run - what counts as an edit

> Related: [scene-composition.md](./scene-composition.md) (the document model),
> [collab.md](./collab.md) ("shared design, personal run"), [project-tests.md](./project-tests.md).

## The rule

**Only authoring writes the document. Operating a device, or the run itself, never does.**

"The document" is what a user saved: the scene's parts and settings, its program, its project. An *edit*
changes it, and only an edit may produce the consequences of one: an undo step, an autosave, a
project-folder write, a line in a room's edit feed, and a demo fork (the first edit of the `?scene=demo`
view makes it a project of the user's own).

The rule is easy to break without deciding to. Each of these breaks it, and the gate below prevents them:
the walking character's Use saving a gate's `open` and forking the demo; the editor's C doing the same;
pressing Stop after clicking a moving box forking it; moving a promoted box mid-run becoming an undo step;
undo after Stop bringing the run's box back as saved content.

## The edit gate

What counts as an edit is decided in one place, not by the write path a gesture happens to call.

- **`documentOf(scene)`** ([storeDocument.ts](../src/editor/store/storeDocument.ts), which the store's own
  `documentOf` calls with its live-cargo seam and designed poses) is the scene minus what the current run owns,
  the store's one definition of "run-owned". Two things:
  - **Parts the run owns**: the ids in `LiveCargoHost.runScopedIds()` and their subtrees. A box someone clicks,
    band-selects or picks up mid-run is promoted to a part so the editor can address it. Cargo dropped or
    copied onto a running line is created as one. Stop deletes all of it.
  - **A placed box's pose.** Physics owns where a box is while the sim runs ([core/frame.ts](../src/core/frame.ts)
    `CargoPose`), so moving, rotating or freezing a box you placed is operating. The store snapshots every
    placed box's *designed* pose at Play (`designedPoses`). The document keeps those, and Stop puts each box
    back there. A box's settings (size, colour, mass) and whether it exists stay authoring. The one pose change
    that is authoring is a **carry**: when an edit moves a box's ancestor (a pallet-load group), the box's
    designed pose follows the ancestor's rigid motion (`carryCargoPose`), so Stop puts it back on the moved
    group. Without designed poses, a drag on a running box would commit "wherever the belt had carried it, plus
    the nudge" as the box's designed start.
- **`commit()` asks `documentChanged(before, after)`** ([store.ts](../src/editor/store/store.ts), through the store's
  `RunOwnership`, which holds the run's cargo seam and designed poses; the rule itself is in
  [storeDocument.ts](../src/editor/store/storeDocument.ts)) and treats only a document change as an edit.
  Anything else (a run-owned box moved, deleted or copied; a re-commit of the same scene) is shown and
  stops there. Parts are immutable, so the comparison is by reference and never serializes.
- **The undo history holds documents**, never run-owned parts. `withRunParts` puts the live ones back when
  an entry is applied mid-run, so an undo can't delete a box from under its body, and an undo after Stop
  can't resurrect one.
- **`setAuthored`** (the Stop cleanup) saves only if the document changed. Dropping the run's boxes never
  changes it, so Stop writes nothing.
- **Anything that creates run-owned parts must mark them run-owned before the commit that adds them.** The gate
  reads ownership to decide, so a dropped box marked afterwards would be saved.

The gate can't see intent. A gesture that writes a real param *is* a document change, and no mechanism can
tell it from authoring. The rules below cover that half.

## Use operates; the Inspector authors

A device's hand state (the gate's `open`, a blade stop's `active`) is declared with `useParam`. The param is
the state a run **starts** from, and only the Inspector writes it. Use (C in the editor, E while walking)
operates the device:

| When | What Use does | Kept until |
|---|---|---|
| Running | `ctx.used()` to the behavior | Stop |
| Stopped (C in the editor, or E walking) | `ctx.used()` to a **live session** of the behavior (`IdleUseSession`, `controller.useSessions`): the device moves and stays the way a press leaves it | Reset, Play, an edit to that part, or the device coming back to its design |

Stopped, C and E are one model. What a press leaves a device doing is session state, not the
document, so the Inspector says so ("Operated by Use", `state.usedIds`) and offers Reset. The viewport never
silently disagrees with it. A live session avoids two failures. Playing a recorded stroke that always comes
home means a press can't leave a gate open. Rebuilding state by replaying a count of presses fails for a
device whose response takes time (the E-stop).

`useParam` parts must `ctx.report` the param with the state they are actually in. The package build refuses
one that doesn't, the same contract `setpointFor` makes. The Inspector's live readout uses it.

**Session state never enters `scene.parts`.** Walk-mode dock doors are the model: `state.walkDoors` in the
store, overlaid on the view-only scene in `editTargetViewScene`, dropped when walk mode ends. (Dock doors stay
walk-only: a leaf belongs to the building and has no Inspector field to show a held state against.)

## Collab draws the same line its own way

In a room each client runs its own sim ([collab.md](./collab.md)), so the bridge keeps its own copy of the rule
(`authoredCargoView`). While a client runs, cargo the doc doesn't hold never reaches it, and cargo it does hold
keeps the **doc's pose**, with everything else about the box passing through. Stop re-asserts the doc. A box
carried by a group this change moved follows it into the doc, so peers see the load move with its group. It
does not use the store's `runScopedIds`, because "cargo the doc doesn't hold" is the right test from the
room's side. Pinning by pose keeps one person's physics from teleporting everyone else's boxes.

Solo and rooms agree on every case. A placed box dragged mid-run is not an edit in either, and a box's settings
edited mid-run are an edit in both.

## Limitations

- A run cannot be saved or resumed. Every Play starts from the document: bodies at rest, the PLC at its
  initial values, and each part's private state (an AGV's route step, a spawner's count) fresh.
- Run-owned cargo lives in `scene.parts` beside the document's parts, so selection, the gizmo, the Inspector
  and the other tools address it by part id. The gate, not a separate run layer, keeps it out of the document.
  A consumer of `scene.parts` that reads run boxes must handle them itself.

## Gates

- [verify-run-cargo-not-edits.mjs](../e2e/verify-run-cargo-not-edits.mjs) (curated): promote + Stop, move and
  delete a run box, undo/redo after Stop, a placed box moved mid-run and put back at Stop, a pallet-load group
  carrying its box, on the demo; control: a conveyor moved mid-run does fork.
- [verify-walk-session.mjs](../e2e/verify-walk-session.mjs) (curated): walking and the editor's C never fork;
  control: an Inspector edit does.
- [verify-idle-use.mjs](../e2e/verify-idle-use.mjs) (C latches, sweeps, the Inspector's notice and Reset, Play starts
  from the design, an edit ends the session), [verify-pilot-idle-use.mjs](../e2e/verify-pilot-idle-use.mjs) (E, and
  C continuing the same session after walk mode).
- Unit: the "edit gate" and "placed boxes mid-run" blocks in `store.test.ts`; `authoredCargoView` in
  `collab.test.ts`; `IdleUseSession` in `idlePose.test.ts`; the `useParam` report rule in `validatePart.test.ts`.
