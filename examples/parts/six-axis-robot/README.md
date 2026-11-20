# Six-Axis Robot: a first-party part on the public SDK

The built-in Six-Axis robot is authored **entirely against the public part SDK**, the same SDK external authors
use. Built-ins are custom parts, so an author can read any first-party part to learn from it.

Its kinematics are exact: a [kinematic-parity test](../../../src/render/parts/sixAxisRigParity.test.ts) pins its
gripper to the world position `robotForwardKinematics` (`src/render/parts/robotKinematics.ts`) gives, for every
joint pose.

## What's here

- **`part.js`** is the source to read. It declares a `robot`, so it runs the app's robot controller
  ([src/core/robot/robotController.ts](../../../src/core/robot/robotController.ts)), the one every robot part shares,
  with `ctx.robot.step()`. The robot owns its jobs: short programs of steps (Move to a named waypoint, stopping on it
  or blending through it; Vacuum on/off; Wait; Wait for an input; Set an output) taught in the Inspector. A PLC runs a
  job by number (command tag + an Execute edge) and waits for Done. An Enable input holds the arm where it is while
  the cell is unsafe. Motion is one coordinated trapezoidal profile per move, and blend points overlap two moves so
  each joint's speed changes smoothly instead of jumping. A robot with no jobs falls back to single moves (the
  command is a waypoint row). The script declares the params the controller reads and the job steps' labels.
  [src/sim/sixAxisRobotJobs.test.ts](../../../src/sim/sixAxisRobotJobs.test.ts) pins the job contract, and
  [src/editor/palletizerCell.test.ts](../../../src/editor/palletizerCell.test.ts) runs the demo's jobs against it.
- **`rig.json`** is the rig: a tree of 21 links (12 transform-only `frame` pivots and 9 per-node `mesh` links) and
  6 revolute joints, plus the ORM material `sixaxis` for the arm and four plain finishes for the end-of-arm
  tooling. The pivot positions, the shoulder and elbow frames, and each linkage's mesh-local placement come from
  the project's own robot model. Placements are quaternions, because they are CAD axis permutations that Euler
  angles can't express cleanly.
- **The EOAT** (end-of-arm tooling) is the app's (`robot.tool`, drawn by
  [src/core/robot/robotTools.ts](../../../src/core/robot/robotTools.ts)) on the `eoat` frame, the one the `tool` param
  picks: the vacuum plate it always had, or a clamp gripper riding the `fingerA` / `fingerB` links. The plate is a
  resizable suction tool built at the size its params ask for (a painted plate framed by slotted rails and corner caps, the
  adapter the wrist flange bolts to, the vacuum LED, and a pitch/margin grid of turned cups that `squash` off that
  LED). The arm keeps its model and baked textures. The tool is engineered hardware, so it is code (see
  [Code or a model?](../../../docs/part-authoring-guide.md#code-or-a-model-decide-first) in the part authoring
  guide).

## How it's built

`part.js` is the source: the kinematics, the rig (`rig()`), the robot declaration and the params its controller and tool read.
`rig.json` + `behavior.ts` are **built** from it, so edit `part.js`, not the output. The committed `rig.json`
names its GLB + textures as URL assets (`/models/SixAxisRobot.glb` and `/models/sixaxis/…`, served from
`public/models/`), so it loads on its own in the app. The multi-MB model files are not committed in this folder.

```sh
npm run build-parts -- six-axis-robot
# → examples/parts/six-axis-robot/{rig.json, behavior.ts}
```

The parity test loads the committed example itself (`examplePart('oip.six-axis-robot')`).

Browser smoke tests (each starts its own server, see [e2e/_server.mjs](../../../e2e/_server.mjs)):

```sh
node e2e/verify-robot-cycle.mjs            # the arm articulates and picks a layer in the running demo
node e2e/verify-robot-jobs-inspector.mjs   # the Inspector's job editor: named steps, pose preview, live step
node e2e/verify-prod-draco-rigs.mjs        # meshes decode and textures load from the production build
```

## Capabilities it uses

The robot relies on three general-purpose features of the custom-part format:

- **`frame` links**: transform-only pivots (no geometry), for kinematic joint chains.
- **`quat` rest rotations**: for arbitrary rotation matrices an Euler angle can't express.
- **package `materials`**: a PBR/ORM material (albedo + packed ORM + optional normal) a `mesh` link references
  to override the GLB's own material, plus geometry-only per-node mesh refs (the rig owns placement).
