# @oip/part-sdk

TypeScript type definitions for authoring **Open Industry Project** custom parts.

A custom part is a small script that runs on every simulation tick. It declares params that
can be edited in the inspector, and a `step()` function that runs on each physics tick. The
same script works in the browser and in the desktop app, because it only talks to the
simulator through a `PartContext`.

This package only contains types. There's nothing to import at runtime, because the
simulator provides the `definePart` global to your script. You install the SDK so your
editor can give you autocomplete and type checking.

## Stability

The SDK is pre-1.0, so breaking changes can come in any release: the behavior API (`definePart`,
params, `ctx`) and the manifest format can both change. Saved parts are upgraded to the current
manifest format when they load wherever possible, but behavior code isn't rewritten for you. Expect a
custom part to need edits now and then, and keep its source somewhere you control.

## Setup

The SDK is not on the npm registry. Install it from a checkout of the repository:

```sh
npm install -D path/to/Open-Industry-Project/packages/part-sdk
```

The version is `0.<level>.0`, where `<level>` is the Part SDK level: the version of what a part can say. An app
build understands parts up to its own level, and warns about a part made under a newer one. Use the checkout of
the app version you build for.

Add a `jsconfig.json` next to your parts so VS Code checks them against the SDK:

```json
{
  "compilerOptions": {
    "checkJs": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "types": ["@oip/part-sdk"]
  },
  "include": ["**/*.js"]
}
```

Listing the SDK in `types` makes the `definePart` global available, so your script doesn't
need any imports.

## Writing a Part

```js
definePart({
  // Params that show up in the inspector.
  params: {
    speed: { type: 'number', default: 0.6, min: 0, max: 4, step: 0.1, label: 'Belt speed (m/s)' },
    reverse: { type: 'boolean', default: false, label: 'Reverse direction' },
  },

  // Runs every sim tick. Must be deterministic, so don't use Date or Math.random.
  step(ctx) {
    // ctx.params.speed is typed `number` and ctx.params.reverse is typed `boolean`,
    // based on the params above, so no casts are needed.
    const dir = ctx.params.reverse ? -1 : 1
    const s = ctx.params.speed * dir
    ctx.setSurfaceVelocity({ x: ctx.forward.x * s, y: 0, z: ctx.forward.z * s })
  },
})
```

`ctx` autocompletes without any import or `@typedef`, for example `dt`, `simTime`, `params`,
`position`, `forward`, `rng()`, `setSurfaceVelocity()`, `readTag()`, `writeTag()`. The full
surface is `PartContext` in `index.d.ts`.

With `strict` on, state declared at the top of the script (`let raised = null`) is an
implicit `any` to the type checker (TS7034). Give it a type, for example
`/** @type {number | null} */ let raised = null`. Top-level state belongs to each placed part
separately, since every placed part runs its own copy of the script.

## The Manifest

A part folder contains `manifest.json` and `behavior.js`. The manifest describes the
geometry, rig links and joints, assets and materials, and what the part is to the host: the
kind of conveyor it is (`conveyor`), an optional boolean that switches its PLC link (`commsParam`; without one, each
tag field that names a tag is connected),
how it connects to other parts (`snap`), the cargo it stores (`holds`), and, for a project's
copy of a part from elsewhere, where it came from (`origin`). It's typed as `PackageManifest` in
`manifest.d.ts` (also exported from the package root), and each shape kind has its own
documented interface (`RigMeshShape`, `RigBoxShape`, and so on). There's also a JSON Schema,
so your editor can complete and check the JSON directly:

```json
{
  "$schema": "./node_modules/@oip/part-sdk/manifest.schema.json",
  "id": "acme.pop-up-stop",
  "name": "Pop-up Stop",
  "geometry": { "kind": "rig", "links": [], "joints": [] }
}
```

From a checkout of this repository, `npm run check-part -- <folder>` checks the manifest against the
schema, builds the behavior the same way the app does, and reports the part's footprint,
signals, joints and colliders. The authoring guide (`docs/part-authoring-guide.md`) covers
the rest, including importing a GLB and testing a part without a browser.

A part can also be written as one `part.js`: a `definePart` that holds the manifest too, in `manifest`
(`PartSourceManifest`), and can compute its rig from its params in `rig(params)` (`PartRigSource`). From a
checkout of this repository, `npm run build-parts -- <folder>` writes the folder's `manifest.json` and `behavior.js` from it.
The app reads only those two files and ignores `manifest` and `rig`.

## Determinism

The simulation runs on a fixed timestep and is deterministic, so a part has to give the
same result for the same inputs. Use `ctx.rng()` instead of `Math.random`, and `ctx.simTime`
instead of the system clock. `ctx.rng()` is seeded from the part's params, so if you place
several identical parts and want them to behave differently, give each one a different
`seed` param. This is what lets a part behave the same way on every run, in the browser and
on the desktop.
