import type { Finish, ParamSchema, SnapSpec, UnitLoadDecl } from './partApi'
import type { PartInstance } from '../types'

// A custom part as a portable, distributable artifact, authored in a real IDE against the part SDK
// (src/sdk) and then imported by the web or native runtime. Neither surface is an authoring surface. Both
// just load + run packages. One self-contained unit: metadata + the exported-param schema (baked so the
// Inspector needs no code run) + the behavior script source + a geometry/collision spec.

export type Vec3Tuple = [number, number, number]
/** A quaternion (x, y, z, w) - used for a rig link's rest rotation when an Euler angle can't express it. */
export type Vec4Tuple = [number, number, number, number]

/**
 * A param-driven geometry override: one axis tracks an instance param as `params[param] * scale
 * + add` (scale default 1, add default 0), optionally clamped to `[min, max]`. Used two ways: a box link's
 * `sizeParams` (a `width`/`length` param resizing a link) and any link's `offsetParams` (a param positioning
 * a sub-part, e.g. a hinge/leaf at `±length/2`). The static `size`/`offset` axis is the fallback (used when
 * the param is missing/non-numeric, and by the param-less `shapeHalfExtents`). Resolved in render (the visual
 * reflows on a param edit) and sim (the kinematic collision body is built + placed at the resolved geometry).
 */
/** A value that tracks an instance param: `params[param] × scale + add`, clamped to `[min, max]` - the one-axis
 *  twin of {@link SizeParamRef} (a joint limit, a reach). */
export type ParamRef = Omit<SizeParamRef, 'axis'>

export interface SizeParamRef {
  /** 0 = x, 1 = y, 2 = z */
  axis: 0 | 1 | 2
  /** the instance param name whose (numeric) value drives this axis */
  param: string
  /** multiply by a second param's value before `scale`/`add`: a product of two params, which the single linear
   *  map can't express (the chain transfer's deck width = `chains` × `distance`). The entry is skipped (static axis
   *  stands) when either param is missing/non-numeric. */
  mulParam?: string
  /** multiply the param value (default 1) */
  scale?: number
  /** add after scaling (default 0) */
  add?: number
  /** clamp the resolved value from below (after scale+add) - a floor a linear map can't express, e.g. the
   *  Blade Stop's corner sections stop at the centreline instead of crossing it on a very narrow lane */
  min?: number
  /** clamp the resolved value from above (after scale+add) - the mirror floor for a negative-side offset */
  max?: number
  /** add this entry's value to the axis instead of replacing it: entries for one axis apply in order, so a
   *  replacing entry then a `plus` one makes a sum of two params (an offset at `length/2 + gap`), and a lone `plus`
   *  entry shifts the static value. Default false (the entry replaces the axis). */
  plus?: boolean
}

/** One indicator lamp a rig link carries ({@link RigLink.lamps}): a light the behavior switches with
 *  `ctx.lamps[name]`, render-only. On a primitive link the lamp is the link's own material (at most one); on a
 *  mesh link each lamp lights one GLB material the link remaps, so a model whose lenses share a node (the
 *  Diverter's red + green) carries several. Lit = full emissive at `emissive`; off = the unlit base colour (a
 *  primitive's `color`, else a dark neutral; a mesh lamp's remapped material colour). */
export interface RigLamp {
  /** the `ctx.lamps` key; defaults to the link's name. Unique across the rig; required for a second lamp on a
   *  link, since two cannot share the default */
  name?: string
  /** lit colour [r, g, b] (0..1, linear) */
  emissive: Vec3Tuple
  /** the colour it shows while dark [r, g, b] (0..1, linear): the lens or cup seen unlit. Omit for the host's dark
   *  neutral on a primitive link, or the material's own base colour on a mesh link (an unlit cap stays its colour).
   *  Package format 3 took a primitive lamp link's `color` for this. */
  offColor?: Vec3Tuple
  /** Mesh links only, and required there: the GLB material this lamp lights, a key of the shape's `materials`
   *  remap (an un-remapped material is shared with every part using the model, so lighting it would light theirs) */
  material?: string
  /** lit-state opacity (0..1] for a lens-style lamp: when lit it goes translucent at this opacity (tinted glass
   *  over an inner core, the stack light's optics). Omit for an opaque lamp. Off is always opaque */
  opacity?: number
  /** the key of a boolean param that lights this lamp whenever the behavior isn't driving it: at rest in the
   *  editor and right after Stop (the stack light's authored tiers, a gantry's vacuum lamp). While the sim runs
   *  the behavior's `ctx.lamps` commands take precedence each tick; a missing or non-boolean param reads as off */
  param?: string
}

/**
 * A gripper link's pickup volume ({@link RigLink.grip}): a box `zone`, or a `radius` sphere. A gripper holds every
 * cargo body inside its volume, each with its own captured offset, so the group rides rigidly in formation - a
 * layer head's formed layer, a loaded fork's pallet and stack. The count is therefore not a mode but a consequence of
 * the volume.
 */
export interface RigGrip {
  /** the volume as an oriented box (`size` = [w, h, d]) in the link's frame, centred on the link's origin unless
   *  `offset` (link-local metres) moves it to where the tool engages (a fork's load rides on the tines, ahead of the
   *  grab frame). `sizeParams` (same shape as a box's) tracks a tool-size param. The right model of a
   *  vacuum plate: a sphere big enough to span a 1.2 m plate also swallows cargo standing beside or under the tool,
   *  so declare a zone on any gripper wider than the thing it grips. With a zone the radius is not read. */
  zone?: { size: Vec3Tuple; offset?: Vec3Tuple; sizeParams?: SizeParamRef[] }
  /** without a zone: the reach (metres) beyond the link's max half-extent (a `frame` gripper has none, so this is its
   *  whole reach), measured to each body's box surface so a cup that only brushes a case still seals. Default 0.2. */
  radius?: number
  /** Param-driven reach: each entry resolves `params[param] x scale + add` (clamped; `axis` is ignored for a
   *  sphere) and the reach is the largest resolved value, `radius` the fallback. */
  radiusParams?: SizeParamRef[]
  /** This gripper is a pair of forks whose blades run along the link's +X. When it takes a pallet the host checks
   *  the face the blades went in through against the pallet's fork channels, and reports it on the part when they
   *  do not fit (they would land on its blocks). `spread` is blade centre to centre, `spreadParam` a number param
   *  that sets it instead. */
  forks?: { spread?: number; spreadParam?: string; bladeWidth: number; bladeThickness: number }
}

/** A shape for a rig link: a primitive, a transform-only 'frame', or a 'mesh' that renders an embedded GLB.
 *  Each kind is its own interface below, so its rules are documented where an author (or an editor hover) looks. */
export type RigShape = RigBoxShape | RigCylinderShape | RigConeShape | RigFrameShape | RigMeshShape | RigLabelShape | RigLegShape

/** A box primitive with a collision body, centred on its link's origin. `size` is the full [x, y, z] extent (m). */
export interface RigBoxShape {
  kind: 'box'
  size: Vec3Tuple
  /** make an axis track an instance param (a `width`/`length` param resizing the link) */
  sizeParams?: SizeParamRef[]
}

/** A cylinder primitive with a collision body; its length runs along the link's local +Y. */
export interface RigCylinderShape {
  kind: 'cylinder'
  radius: number
  height: number
  /** an entry whose axis is 1 tracks the height (the cylinder's local +Y length, e.g. a roller's
   *  axle length following the belt `width`); axis 0 or 2 tracks the radius. */
  sizeParams?: SizeParamRef[]
}

/** A render-only cone - no collision body (like `frame`/`label`), so cargo passes straight through it. The
 *  schematic "cargo drops here" cue the built-in spawner draws (a translucent marker cone). `radius` is the
 *  base radius, `height` the apex height; three's convention is apex +Y / base −Y, so a downward drop cue
 *  rotates the link 180° about X. Pair with the link's `opacity` for the translucent look; a `color` tints it. */
export interface RigConeShape {
  kind: 'cone'
  radius: number
  height: number
}

/** A transform-only link: no geometry, no collision - a pure pivot/frame node in the kinematic tree (a joint
 *  origin or a fixed offset between driven links). The articulated robot is built from these: a frame per
 *  joint pivot, mesh links hung off them. Also the usual parent of a moving mesh: put the joint on the frame. */
export interface RigFrameShape {
  kind: 'frame'
}

/**
 * A visual mesh from a GLB (see PartPackage.assets). **Render-only unless `collision` is set** - for anything
 * cargo must hit, prefer hidden (`hidden: true`) primitive `box` links sized to the real surfaces: the visual
 * mesh / primitive collider split every built-in uses.
 *
 * Two ways to take geometry from the GLB, and they place it differently:
 * - **`node`** takes one named node's geometry in its mesh-local frame (its node transform is reset), so the
 *   link's `offset`/`rotation` alone place it. One GLB of an articulated model (a robot) supplies a mesh per rig
 *   link this way; you transcribe each node's transform into the rig.
 * - **Whole scene** (no `node`): the GLB as authored, optionally normalised by `fitHeight`, then carved by
 *   `hideNodes` / `keepNode`. Carved pieces keep identical scale and placement, so links cut from the same GLB
 *   line up without transcribing anything. This is the simplest route for an imported device: put each moving
 *   node on a second mesh link (`keepNode`) under a `frame` that carries the joint. Each node is drawn by one link,
 *   the nearest that keeps it, so the base link leaves a kept node out on its own, and a piece kept from inside
 *   another piece is left out of that one too.
 */
export interface RigMeshShape {
  kind: 'mesh'
  /** a PartPackage.assets[].id (the GLB) */
  asset: string
  /** use just this named GLB node, in its mesh-local frame (its node transform is reset, see above) */
  node?: string
  /** uniform scale applied to the mesh */
  scale?: number
  /** whole-scene refs only: uniformly scale the GLB to this height (m), centre it in XZ and rest its underside
   *  on y=0 - how the built-in device parts normalise a raw GLB, so an import's native scale/origin doesn't
   *  have to be hand-transcribed. Applied before `hideNodes`/`keepNode`,
   *  to the full scene, which is what keeps carved pieces aligned. */
  fitHeight?: number
  /** node scaling: each entry stretches the mesh on one axis by a param-driven factor
   *  `params[param] * scale + add` (a multiplier on top of `scale`/`fitHeight`), so an imported model section
   *  can grow with a `width`/`length` param - the mesh equivalent of a box's sizeParams. Tune `scale`/`add` so
   *  the factor is ~1 at the default param. Drives both the render mesh and (with `collision`) the collider;
   *  pairs with the link's `offsetParams` (which slides edge nodes out). */
  sizeParams?: SizeParamRef[]
  /** re-tile instead of stretch, for a `sizeParams` stretch: each entry multiplies one UV channel of the listed
   *  GLB materials by the resolved stretch factor on its axis, so a texture that repeats along the member (a
   *  trim-sheet strip: a rail's bolt holes, a tube's seam) keeps its real spacing at any length instead of
   *  smearing. Only for a model whose UVs run 0..1 along the stretched axis on those materials; list just
   *  those, since a UV island that does not repeat (an end cap sampling one spot of an atlas) would wander off
   *  it. Matched by the GLB material name, before any `materials` remap. Render-only. */
  tileUv?: MeshUvTile[]
  /** a PartPackage.materials[].id overriding the GLB's own material on every mesh */
  material?: string
  /** remap per GLB material name → a PartPackage.materials[].id, so a model that ships several named materials
   *  can recolour each one individually */
  materials?: Record<string, string>
  /** whole-scene refs: never draw these nodes and their subtrees (applied after `fitHeight`). A node another link
   *  keeps needs no entry here: it is left out on its own. */
  hideNodes?: string[]
  /** whole-scene refs: keep only this one node's subtree, re-based into the fitted frame (works even when the
   *  node is nested under a housing node). Every other whole-scene link of the same asset then leaves the node out,
   *  and this link leaves out any node inside it that a further link keeps. A moving piece made of several sibling
   *  nodes can't be named here - use `hideNodes` listing everything else instead. */
  keepNode?: string
}

/** One `tileUv` entry on a mesh link: which stretch axis re-tiles which UV channel, on which GLB materials. */
export interface MeshUvTile {
  /** the `sizeParams` axis whose stretch factor re-tiles (0 = x, 1 = y, 2 = z) */
  axis: 0 | 1 | 2
  /** the UV channel that runs along that axis in the model */
  uv: 'u' | 'v'
  /** GLB material names (as authored, before any `materials` remap) whose UVs repeat along the axis */
  materials: string[]
}

/** A render-only text label: a flat plane (local +Z facing) carrying canvas-drawn text, the rig equivalent of
 *  a 3-D text label (e.g. a push button's face caption). No collision. Empty resolved text hides it. */
export interface RigLabelShape {
  kind: 'label'
  /** a static caption */
  text?: string
  /** names an instance param so the label is Inspector-editable (the resolved param value is drawn) */
  textParam?: string
  /** the live form: names a display the behavior publishes (`ctx.display`) and the caption follows it every
   *  tick - a totaliser, a weight on a scale, a status word. Takes precedence over `text`/`textParam` while the
   *  sim runs; falls back to them when nothing is published, so a stopped scene still reads as authored. */
  textFrom?: string
  /** the plane [width, height] in metres (default 0.05 × 0.05) */
  size?: [number, number]
  /** text colour [r, g, b] 0..1 (default black) */
  color?: Vec3Tuple
}

/** A conveyor support leg (the built-in dual-post steel trestle), rendered from the shared `legPieces` builder,
 *  so an SDK conveyor gets the exact built-in legs. One `leg` link becomes a row: legs auto-space along the
 *  `spanParam` length (tail/head insets + a spacing grid). `widthParam` sets the trestle's cross width (posts at
 *  ±width/2). The leg height adjusts itself: it tracks `standParam` (the deck-above-floor stand height, a
 *  `rest:'surfaceBelow'` param the host fills at drop/snap) minus `frameDepth` (deck→frame bottom). The link's
 *  own offset y should track −standParam (offsetParams) so the feet sit on the floor. Render-only. `arc` makes
 *  it a curved conveyor's fanned leg row: trestles fan around an arc of centreline radius `arc.radiusParam` over
 *  `arc.sweepDeg`, each yawed radially. */
export interface RigLegShape {
  kind: 'leg'
  spanParam: string
  widthParam: string
  standParam: string
  /** deck → frame bottom (m): where the leg tops meet the frame */
  frameDepth: number
  /** make the frame depth track a param (a bed whose frame depth is authored, so the legs still meet its
   *  bottom); `frameDepth` stands while the param is missing or non-numeric */
  frameDepthParam?: ParamRef
  arc?: { radiusParam: string; sweepDeg: number }
}

/**
 * A PBR material a mesh link can reference (by id) to override the embedded GLB's own material. An
 * ORM material recipe: a base-color (albedo) texture + a packed occlusion-roughness-metalness
 * texture (G=roughness, B=metalness) + an optional normal map, each an embedded PartPackage.assets[].id.
 * Scalar fallbacks (color/metalness/roughness) cover a textureless material.
 */
export interface PartMaterial {
  /** referenced by a mesh RigShape's `material` */
  id: string
  /** asset id of the base-color (albedo) texture; sampled sRGB */
  albedo?: string
  /** asset id of a packed occlusion-roughness-metalness texture (G=roughness, B=metalness); sampled linear */
  orm?: string
  /** asset id of a normal map (optional) */
  normal?: string
  /** flat base color [r, g, b] in 0..1 when there's no albedo texture */
  color?: Vec3Tuple
  /** scalar metalness when there's no orm texture (default 1 with an orm map, else 0) */
  metalness?: number
  /** scalar roughness when there's no orm texture (default 1 with an orm map, else 0.6) */
  roughness?: number
  /**
   * Sample the `albedo` texture triplanar - projected on the world/object planes and blended by the surface
   * normal - instead of by the mesh's own UVs. The fix for an imported GLB whose UVs don't progress along a
   * long axis, so a baked texture pins into stretched streaks (the Diverter arms' brushed metal). `space`:
   * 'object' locks the grain to the geometry (a telescoping/moving part doesn't swim); 'world' tiles at a
   * fixed density across parts. `scale` = texture tiles per metre; `boost` brightens the sampled albedo (a
   * colour tint), default 1. Requires `albedo` or `pattern`; `metalness`/`roughness`/`color` still apply as the tint.
   */
  triplanar?: { space: 'object' | 'world'; scale: number; boost?: number }
  /**
   * A two-colour pattern the host draws, in place of an `albedo` image: hazard stripes, a painted band, a checker.
   * Plain data, so a part needs no texture file for it. One repeat of the pattern is one texture tile: with
   * `triplanar` it is projected at `triplanar.scale` repeats per metre (the usual choice: builder ops' UVs are not
   * in metres), else it follows the mesh's UVs, one repeat per UV unit. Without an `orm`, it defaults to a painted
   * finish (`metalness` 0, `roughness` 0.6). Not with `albedo`. See {@link PartPattern}.
   */
  pattern?: PartPattern
}

/**
 * A two-colour pattern ({@link PartMaterial.pattern}). Colours are linear r,g,b 0..1, like a rig link's `color`.
 * - `'stripes'`: alternating bands, `colors[0]` taking `ratio` of each repeat (default 0.5). `angle` is the way the
 *   bands run, in degrees from the tile's U axis: 0, 45, 90 or 135 (default 0). Hazard tape is 45.
 * - `'checker'`: a 2 x 2 checkerboard per repeat.
 */
export interface PartPattern {
  kind: 'stripes' | 'checker'
  colors: [Vec3Tuple, Vec3Tuple]
  /** stripes: the share of each repeat in `colors[0]`, between 0 and 1 (default 0.5) */
  ratio?: number
  /** stripes: the way the bands run, degrees from the tile's U axis (default 0) */
  angle?: 0 | 45 | 90 | 135
}

/**
 * A binary asset (a GLB mesh or a texture) a part references by id. Two flavors:
 *  - `data` (base64): embedded - the part is self-contained/portable (a shared third-party part).
 *  - `url`: referenced - points at an app-served asset (e.g. "/models/foo.glb"). For first-party bundled
 *    examples that reuse already-shipped public/ assets, so they don't duplicate megabytes into the bundle.
 * Exactly one of `data` / `url` is set.
 */
export interface PartAsset {
  /** referenced by a mesh RigShape's `asset` (or a material's albedo/orm/normal) */
  id: string
  /** e.g. "model/gltf-binary" or "image/webp" */
  mime: string
  /** base64-encoded bytes (embedded, portable) */
  data?: string
  /** URL of an app-served asset (referenced, not embedded) */
  url?: string
  /** SHA-256 (64 hex) of the asset's bytes, when they are known. An asset that has one is identified by those bytes, whether it
   *  holds them (`data`, or a project folder's `assets/<sha256>.*` file) or names where they are served (`url`): a
   *  part's fingerprint identifies it by this alone. A first-party asset gets it from the app's table of shipped
   *  assets, with `url` pointing at `/part-assets/<sha256>.<ext>`. */
  sha256?: string
}

/** One axis of a grid array-link (see RigLink.array.grid): the params giving the lattice's full span,
 *  per-edge inset, and desired spacing along this axis. The static `size`/`pitch`/`margin` are the
 *  fallbacks when a param is missing or non-numeric (e.g. an instance saved without that param), the
 *  same rule as every other param-driven size or offset. */
export interface GridAxisSpec {
  /** param holding the full span (m) the lattice covers (e.g. the EOAT's toolSizeX) */
  sizeParam: string
  /** param holding the desired instance spacing (m); count = floor(usable/pitch)+1. Optional when `maxSpacing`
   *  is set (which uses ceil/OSHA spacing instead of a param-driven pitch). */
  pitchParam?: string
  /** param holding the inset (m) kept off each edge of the span (usable = size − 2·margin); omit for none */
  marginParam?: string
  /** static span fallback (m) when `sizeParam` doesn't resolve (default 0 - a single centred instance) */
  size?: number
  /** static pitch fallback (m) when `pitchParam` doesn't resolve (default 0.1) */
  pitch?: number
  /** static margin fallback (m) when `marginParam` doesn't resolve (default 0) */
  margin?: number
  /** ceil/OSHA spacing (m): a fixed max gap. count = spans+1 where spans = max(1, ceil(usable/maxSpacing)),
   *  so every gap stays ≤ this (never exceeds it), edges included. The structure-grid mode (support columns
   *  at max column spacing); mirrors a 1-D `distribute`. Takes precedence over pitchParam when set. */
  maxSpacing?: number
}

/** One sub-part of a multi-body rig: a shape at a local transform under an optional parent link. */
export interface RigLink {
  /** unique within the rig; referenced by joints and child links */
  name: string
  /** parent link name; omitted = attached to the rig root */
  parent?: string
  shape: RigShape
  /** local position relative to the parent (or rig origin), metres */
  offset: Vec3Tuple
  /** local rotation (Euler XYZ, radians) relative to the parent; omitted = identity */
  rotation?: Vec3Tuple
  /** local rotation as a quaternion (x, y, z, w); takes precedence over `rotation` when an arbitrary
   *  rotation matrix (e.g. an axis permutation from a CAD export) doesn't map cleanly to Euler angles */
  quat?: Vec4Tuple
  /** per-axis overrides that make this link's `offset` track an instance param (e.g. a hinge at
   *  `-length/2`), so a length/width param repositions the sub-part per instance */
  offsetParams?: SizeParamRef[]
  /** per-axis overrides that make this link's `rotation` (Euler XYZ, radians) track an instance param, the same
   *  rule as `offsetParams` (a spur's splay angle in degrees is `scale: π/180`). Not with `quat`. */
  rotationParams?: SizeParamRef[]
  /** The base material colour [r, g, b] (0..1, linear) of this primitive link - gives it its own tinted
   *  material instead of the shared neutral fallback (so a belt reads as steel, a rack's shelves as wood,
   *  etc.). Not on a lamp link: a lamp's colours are its own, lit `emissive` and dark `offColor` ({@link RigLamp}).
   *  Render-only; ignored on mesh/frame links (a mesh keeps its GLB/`material`). */
  color?: Vec3Tuple
  /** Param-driven colour: the name of a `color`/string param whose `#rrggbb` value tints this primitive link's
   *  albedo, editable in the Inspector + live on the running frame (the barriers' `steel color`, a platform's
   *  deck tint). The hex is read as sRGB and converted to linear (three's `.color.set`), so a param default of
   *  `#f2bd0f` matches the built-in's `mat.color.set('#f2bd0f')` exactly. Overrides the static `color` for the
   *  albedo (still the lamp unlit base when `emissive` is also set). On a mesh link it tints the link's own
   *  package material: the `lamp` material when one is declared - both the unlit base and the lit colour follow
   *  the param (the push button's `button color` sets albedo = emission) - else the
   *  single `material` override. Ignored on `finish`/`frame` links (a finish keeps its shared textured material)
   *  and on a mesh link that keeps the GLB's own materials. Render-only. */
  colorParam?: string
  /** Render-only PBR finish for a `color`/`colorParam` primitive link: `metalness` and `roughness` (each 0..1)
   *  of its MeshStandardMaterial, overriding the SDK default (0.3 / 0.6). A link that mirrors a built-in's flat
   *  non-metallic steel sets `metalness: 0, roughness: 0.8` so it shows its albedo instead of the environment
   *  reflection the default gloss adds - the built-in rack's "keep the uprights non-metallic" note.
   *  Ignored on `finish`/`mesh`/`frame`/`emissive` links (those own their material/lamp finish). */
  metalness?: number
  roughness?: number
  /** Render-only idle translucency (0..1] for a `color`/`colorParam` primitive link: below 1 the link gets its
   *  own transparent material at this opacity (depth-write off), so it reads as a schematic cue rather than solid
   *  equipment - the built-in spawner's translucent drop marker, a light-curtain plane, a ghost preview. Distinct
   *  from a lamp's `opacity` (a lit lens); this is the unlit base finish. 1 / omitted = opaque. Ignored
   *  on `finish`/`mesh`/`frame` links and lamp links (those own their material). */
  opacity?: number
  /** Render-only wireframe outline colour [r, g, b] (0..1, linear) for a primitive link: draws the crisp edge
   *  lines of its box/cylinder/cone on top of the fill (three's EdgesGeometry, the built-in spawner marker's
   *  light-blue outline). Reads as a schematic/diagram edge, and gives a translucent {@link opacity} link
   *  definition it would otherwise lack. Omit for no outline. Ignored on `mesh`/`frame` links. */
  outline?: Vec3Tuple
  /** The link's look, from the host's built-in finishes instead of a flat `color`: the same textured metal and
   *  fabric the built-in conveyors use, so an SDK part looks the same as a built-in.
   *  `'frame'`/`'guard'`/`'leg'`/`'bolt'` = the steel materials (Metal.webp), `'roller'` = the brushed roller
   *  metal (RollerMetal.webp, spun by the part's `speed`; casts no shadow), `'belt'` = the scrolling fabric,
   *  `'tread'` = steel tread plate (TreadPlate.webp) and `'deck'` = a solid concrete deck (BuildingFloor.webp), the
   *  two walking surfaces, each tiled per metre from the link's resolved box size (a box link's X/Z sizeParams
   *  drive the tiling). {@link finishParam} lets an instance choose between finishes.
   *  Works on primitive and mesh links. Takes precedence over `color`. Omit for a flat tint.
   *  A finish is only a look: what the host does with the link is declared on its own ({@link sideGuard},
   *  {@link sideRail}, {@link bed}, {@link notchable}). Package format 3 called this `role`, and it also
   *  switched those on. */
  finish?: Finish
  /** The name of an `'enum'` param whose option values are finishes (`'tread'`, `'deck'`, ...): the instance's choice
   *  is this link's finish, so the Inspector picks the look (a platform's "Deck surface": tread plate for an access
   *  platform, a solid deck for one carrying equipment). `finish` is what shows when the param holds no finish.
   *  Only the look changes; the link's body is the same either way. */
  finishParam?: string
  /** This box is one of a straight conveyor's side guard walls, on its `'left'` (-Z) or `'right'` (+Z) side (the
   *  bed runs along +X). The host treats it as a guard: a neighbouring conveyor whose end butts that side opens a
   *  gap in it, a flush side merge retracts it to the neighbour's wall, it merges with a collinear neighbour's
   *  guard into one wall, its collider takes the shared guard cross-section, and it has no friction so cargo
   *  slides along it. */
  sideGuard?: 'left' | 'right'
  /** This box is one of a straight conveyor's below-deck side rails (a frame wall or flange) on its `'left'` (-Z)
   *  or `'right'` (+Z) side: a flush side merge retracts it to the neighbour's wall, like a guard, but a butting
   *  neighbour never opens it (the host frame stays closed). */
  sideRail?: 'left' | 'right'
  /** On a conveying rig (one with a `conveys` link): this solid belongs to the conveyor bed, so cargo sliding
   *  across it from a conveying surface (a diverter kick onto a takeaway, a load stepping off a turntable lane)
   *  does not snag on its edges. It joins the conveyor contact gates with no surface velocity. A guard must stop
   *  cargo, so a {@link sideGuard} never needs it. */
  bed?: boolean
  /** The friction of this link's surface, on the scale a conveyor's `frictionParam` uses (0 to 2; cargo's own friction
   *  combines with it): a slide's low-friction plate, a rubber stop pad. Omitted keeps the host's default of 0.6. A
   *  {@link sideGuard} always has none, and a `conveys` deck takes the conveyor's `frictionParam` instead. */
  friction?: number
  /** This box is the part's walking deck: its resolved size is the deck's extent, and where a neighbour's edge
   *  mount `notch`es the deck, the host carves the box into the strips around the stairwell. */
  notchable?: boolean
  /** The indicator lamps this link carries, each switched by the behavior's `ctx.lamps` ({@link RigLamp}): one on
   *  a primitive link (its own material), one per lit material on a mesh link. Render-only. */
  lamps?: RigLamp[]
  /** This mesh link compresses along its local Y by `amount` (0..1] while `lamp` is lit (default: the
   *  link's own lamp). The suction cup's bellows collapsing as the vacuum grips, the EOAT's physical grip tell:
   *  anchored at the link's rim (the contact lip, −Y-most in its local frame, from its mesh bounds) so the lip
   *  stays seated on the workpiece while the bellows fold toward the mount; eased over ~120 ms each way and
   *  released when the sim stops. `lamp` names any lamp in the rig, so cups with no glow of their own can
   *  compress off the tool's vacuum-status LED and one `ctx.lamps` signal drives both. Render-only. */
  squash?: { amount: number; lamp?: string }
  /** Two-point look-at: override this link's rotation each evaluation so its local +Z (model front,
   *  glTF convention) points at `target` link's origin, with roll fixed by `up` (default the parent's world
   *  +Y). For struts/cables that must stay connected as a
   *  driven parent moves (e.g. the robot's hydraulics). The authored `quat`/`rotation` is the fallback, used
   *  only when the target can't be resolved or the two origins coincide. Honored by both render + sim FK. */
  aim?: { target: string; up?: Vec3Tuple }
  /** A sensor beam emitted from this link's origin along `axis` (link-local, default +Z) for
   *  `range` metres. The host casts it against cargo each tick; the behavior reads the nearest hit via
   *  `ctx.sense(linkName)` (presence / distance / colour) and drives a PLC tag. The render draws the beam
   *  line (green clear / red blocked, like the built-in sensors) out to that length; `tint: 'hit'` colours the
   *  blocked beam with the detected cargo's tint instead of red (a colour-classifying sensor).
   *  `rangeParam` names a `number` param that sets the beam's length - the sensing range and the drawn line
   *  both, so an Inspector slider (or a snap's auto-fit, `mount.fitRangeParam`) reaches the part's real
   *  detection distance; `range` is the length without one, and the fallback when the param is not > 0.
   *  `showParam` names a `boolean` param that hides the drawn line when false (a viewing aid only: sensing is
   *  unchanged). A beam sees cargo and the walking pilot, never the part's own links. Package format 4 had no
   *  `showParam`, and drew to a param that happened to be named `maxRange` / hid on one named `showBeam`. */
  beam?: { range: number; rangeParam?: string; showParam?: string; axis?: Vec3Tuple; tint?: 'hit' }
  /** A box detection and removal zone (`size` = [w, h, d]) centred on this link's origin. The host
   *  counts cargo inside it each tick (`ctx.zone(linkName)`) and removes that cargo when the behavior calls
   *  `ctx.despawn(linkName)`: an exit or sink that reports throughput and clears cargo from the line. `sizeParams`
   *  (same shape as a box's) makes the trigger volume resize with a param, so a despawner's
   *  length, height and width sliders grow the detection box the way the built-in despawner's do. */
  zone?: { size: Vec3Tuple; sizeParams?: SizeParamRef[] }
  /** This (box) link is a weighing platform: a load cell under it. The host reads the vertical force the cargo
   *  resting on it puts through it each tick, and the behavior reads it with `ctx.weight(linkName)`, in kg. The
   *  force comes from the physics: every body touching the link's top and everything stacked on it, at its own mass,
   *  with the vertical acceleration it has this tick, so a load landing on the platform or riding a lift reads more
   *  for a moment, as on a real scale. A load resting on this link alone counts in full, even one hanging past its
   *  edge. A load that also rests on something else (a case crossing the seam onto a weigh belt, a pallet bridging two
   *  scales) is shared between them by where its centre of gravity falls between the two, so the reading ramps as a
   *  case comes on. Works on a `conveys` deck (a checkweigher's weigh belt) and on a plain solid box (a platform
   *  scale). */
  loadCell?: boolean
  /** This link grips: its pickup volume, where cargo is taken when the behavior closes it (`ctx.setGrip` /
   *  `ctx.grips`). Any link can be commanded to grip; this block sizes what it takes ({@link RigGrip}). Omit it and
   *  the link picks within the host's 0.2 m default reach. Package format 3 spelled these `grabZone`,
   *  `grabRadius` and `grabParams` on the link. */
  grip?: RigGrip
  /** Is this link solid, and as what? Omitted = the shape's own default: a `box` / `cylinder` collides as itself,
   *  and a `mesh` (a model), `cone`, `frame`, `label` or `leg` does not.
   *  - `'none'`: render it but build no body. For cosmetic geometry that must not touch cargo: a roller
   *    conveyor's rollers (the separate `conveys` deck is the real surface), a railing's decorative rails.
   *  - `{ box: [x, y, z] }` (a `mesh` or `frame` link): collide as a box of that full size, **centred on the link
   *    origin** (not on the model's bounds). For an off-centre model, use a hidden `box` link at the right offset.
   *    On a `frame` it is a solid that draws nothing of its own, so the meshes `geometry()` attaches to the link
   *    (`MeshPart.link`) are its look. A `hidden` box link can't do that: hiding a link hides what is attached to it.
   *  A drawn submesh says the same thing with `collision: 'box' | 'hull'` (partApi `MeshPart`). */
  collision?: 'none' | { box: Vec3Tuple }
  /** This box link (or `frame` with a `collision` box: a deck that draws nothing, dressed from `geometry()`) is a
   *  conveyor surface: its top face carries cargo at the velocity the behavior
   *  sets via `ctx.setSurfaceVelocity` (a powered belt/roller deck). The host builds it as a static conveyor
   *  body, so cargo rides it; other links (frame, guards) stay normal. A `conveys` link under a joint (a lift's
   *  carriage, a pop-up transfer) is built kinematic instead and follows the joint each tick, carrying its cargo
   *  with it: a vertical lift is a `conveys` deck on a prismatic joint. So is one the behavior poses with
   *  `ctx.setSubPose` (a shuttle's roller top), or one under such a link. A posable array that conveys is a deck per
   *  copy (a cross-belt sorter's carriers), each run by `ctx.setSurfaceSpeed(speed, link, i)` and never by the
   *  part-wide surface commands. A `conveys` link turned in the part is built
   *  at that turn, and its running face is its local +Y wherever that points: a side belt is a `conveys` box stood
   *  on its edge. A running face meeting cargo from the side needs a firm squeeze to grip it: a contact up to
   *  2 mm deep on a sideways face reads as a seam snag between butted conveyors and is ignored. */
  conveys?: boolean
  /** Author-mode visibility: when true the link (and its subtree, via the render group) is hidden in the
   *  rendered part - the Scene-tree eye toggle. Render-only: the sim/collision body is still built, like a
   *  `frame`/`label` link is visual-only the other way round. A persisted authoring property (every instance
   *  hides it), not per-instance state. */
  hidden?: boolean
  /** Param-gated structural toggle: the name of a boolean param that must be true for this link to exist. When
   *  it resolves false, the link is omitted entirely: no rendered mesh and no collision body (both, unlike the
   *  render-only `hidden`), so a part can drop an optional structural member from the Inspector, like the
   *  belt/curved conveyors' side-guard toggles (roller-conveyor `leftGuard`/`rightGuard`). Resolved with the
   *  param default, so an unset default-true param keeps the link. A missing/non-boolean param reads as shown.
   *  `'param=value'` names an enum param instead: the link exists only while that param is `value` (a robot's own
   *  hand, shown while its `tool` param is `'hand'`). */
  showParam?: string
  /** This link runs on the named edge of the part's deck surface (a railing post array, rail, toe board or infill
   *  wall), so a neighbour that meets that edge and {@link SnapEdgeMount.opens} it cuts the link around the gap:
   *  boxes split into the solid spans left, array posts in the gap drop out. A link without
   *  it is never cut. Package format 2 called this `railing`. */
  onEdge?: 'posX' | 'negX' | 'posZ' | 'negZ'
  /** `'floor'`: when a connection lifts this part (an edge mount's `lift`, raising a flight flush onto a deck),
   *  this link stretches back down so it still stands on the floor: a plain box grows downward by the lift, and an
   *  array link (a riser row) also gains a filler plate under its first instance. Links without it rise with the lift.
   *  Package format 2 called this `stairFoot: true`. */
  anchor?: 'floor'
  /** When a connection mounts this part on a deck (an edge mount's `lift` meeting a deck edge), this link is
   *  omitted, mesh and collision body both: the deck takes its place. A stair's own top landing, which the
   *  platform it climbs to replaces. Freestanding, the link is built as usual. */
  dropWhenMounted?: boolean
  /** array-links: repeat this link into N static instances, a count-driven sub-part array (a
   *  belt's legs, a roller bed's rollers, a fence's posts, a rack's shelves). Three forms:
   *   - `distribute`: spread instances evenly along `axis`, centred on the link offset, across the span the
   *     `spanParam` gives (count = ceil(span/maxSpacing)+1 - e.g. fence posts auto-spaced as the length grows).
   *     `spanAdd` (metres) lengthens that span past the param (a railing whose posts stand just outside the deck
   *     runs `2 × that offset` further, so each end post stands on the true corner).
   *     Set `worldPhase` (axis 0 only) to lock copies to the world pitch grid instead (`maxSpacing` becomes the
   *     exact pitch), so collinear beds (butted roller conveyors) share grid lines without the snap having to
   *     pass anything between them. Falls back to the centred spread when the host has no placement to lock to.
   *   - `count` + `step`: place `params[count]` instances `step` apart (optionally `centered`) - e.g. rack
   *     shelves stacked by a numShelves param. `stepParams` (same shape as sizeParams) makes a `step` axis track
   *     an instance param (the chain transfer's lane spacing following `distance`), the static `step` the fallback.
   *   - `grid`: a 2-D X×Z lattice with param-driven span + pitch (the EOAT suction-cup bed).
   *     Per axis: usable = max(params[sizeParam] − 2·params[marginParam], 0),
   *     count = floor(usable/params[pitchParam]) + 1 (clamped 1..64), instances
   *     spread edge-to-edge across ±usable/2 (actual spacing = usable/(count−1) ≈ pitch). Uniquely usable on a
   *     `mesh` link (the cup GLB node cloned per cell).
   *   - `pitch`: as many instances as fit a span at a fixed pitch, count = round(span / pitch) (at least 1, at most
   *     1024), laid `pitch` apart along `axis` and centred on the link offset. span = `params[spanParam] × spanScale +
   *     spanAdd`, plus `params[param] × scale` for each of `spanTerms`: a loop of two straights and two half turns
   *     is `spanParam: 'length', spanScale: 2, spanTerms: [{ param: 'radius', scale: 2π }]`. A span param whose range
   *     reaches past 1024 copies is an authoring problem, and a part that hits the limit says so on the part.
   *     The form for carriers on a loop: a sorter's slats at a 76 mm pitch, round a chain whose length follows the
   *     section's length (`spanScale: 2` for the top and return runs, `spanAdd` for the turns).
   *  To switch the whole array off with a param, give the link a {@link showParam}: false ⇒ zero instances, mesh
   *  and collision (format 3's `enabledParam` inside the array).
   *  Each instance is a copy of the shape (sizeParams applied uniformly). Render + sim build N meshes/bodies.
   *
   *  `posable: true` lets the behavior move each instance on its own: `ctx.setSubPose(link, pose, i)` places
   *  instance `i` where `ctx.setSubPose(link, pose)` would place the link, in its parent's frame, and
   *  `ctx.arrayCount(link)` says how many there are. Each instance gets a kinematic body (a static one otherwise),
   *  and a `geometry()` submesh attached to the link (`MeshPart.link`) is drawn once per instance and moves with it.
   *  An instance not posed this tick stands at its rest place in the row, so the link's offset and the array form
   *  say only how the row stands at rest. For a carrier's look, make the link a `frame` with a `collision` box and
   *  attach the look from `geometry()`. With `conveys`, each copy is also a deck of its own, run by
   *  `ctx.setSurfaceSpeed(speed, link, i)`; with `grip`, a gripper of its own, closed by `ctx.setGrip(link, on, i)`. Not with `worldPhase` (the count would depend on where the part stands)
   *  or on a `mesh` link. */
  array?: {
    distribute?: { axis: 0 | 1 | 2; spanParam: string; spanAdd?: number; maxSpacing: number; worldPhase?: boolean }
    pitch?: { axis: 0 | 1 | 2; spanParam: string; spanScale?: number; spanAdd?: number; spanTerms?: { param: string; scale?: number }[]; pitch: number }
    posable?: boolean
    count?: string
    step?: Vec3Tuple
    stepParams?: SizeParamRef[]
    centered?: boolean
    /** Drop the first / last instance of a 1-D array (`distribute` or `count`) when the named boolean param is
     *  true, so two barriers butt end-to-end without a doubled post at the shared junction (the built-in guard
     *  rail / fence / safety gate's omitPostStart / omitPostEnd). "First" = the low end of `axis` (−span/2 for
     *  `distribute`); "last" = the high end. Ignored on the 2-D `grid` form. */
    omitFirstParam?: string
    omitLastParam?: string
    grid?: {
      x: GridAxisSpec
      z: GridAxisSpec
    }
  }
}

/**
 * A kinematic joint that moves one link relative to its parent - the articulation a behavior commands
 * via `ctx.setJoint(name, value)`. Position-controlled (revolute angle / prismatic extension), the
 * deterministic default for an industrial twin; physical joints can come later as another kind.
 */
export interface RigJoint {
  /** the setJoint() name */
  name: string
  /** the link this joint drives (relative to its parent) */
  link: string
  type: 'revolute' | 'prismatic'
  /** joint axis in the link's local frame */
  axis: Vec3Tuple
  /** command limits - revolute radians, prismatic metres; the host clamps setJoint() to [min, max]. With
   *  {@link minParam} / {@link maxParam} these are the outer envelope (the widest any instance may travel) */
  min: number
  max: number
  /** make a limit track an instance param, as a size or an offset does: resolves `params[param] × scale + add`
   *  (clamped to the ref's own `[min, max]`, then kept inside the joint's static envelope). A gantry carriage whose
   *  travel is its frame's length less an inset: `maxParam: { param: 'frameLength', scale: 0.5, add: -0.06 }`. The
   *  host enforces it everywhere the joint is posed (the sim, the rendered FK, `ctx.measured.joints`), so the
   *  behavior needs no clamp of its own. The static limit stands when the param is missing. */
  minParam?: ParamRef
  maxParam?: ParamRef
  /** Self-driven dressing the behavior animates from its own state (an AGV's rolling wheels, a piston that
   *  tracks the lift at a ratio), not an author-commandable axis. The rig gizmo skips it (no ring, never the
   *  IK end-effector) and the authored idle `pose` row indexes only non-cosmetic joints. FK/sim treat it like
   *  any other joint. */
  cosmetic?: boolean
  /** This joint follows another: it is posed at the leader's value × `multiplier` (default 1) + `offset` (default 0),
   *  then held to its own limits. A gripper's second finger is the usual case. The host poses it everywhere the
   *  leader is posed (the sim, the rendered FK, the teach gizmo), so the behavior commands only the leader, and
   *  `ctx.setJoint` on a follower changes nothing. The leader must be another joint of the rig that follows none.
   *  The teach gizmo and the PLC panel leave a follower out. */
  mimic?: { joint: string; multiplier?: number; offset?: number }
  /** The settled (idle/held) value the behavior slews this joint to, as a param binding: resolves
   *  `params[param] × scale + add` in the joint's native unit (revolute radians, prismatic metres) - e.g. a
   *  turntable's `{ param: 'deckAngleDeg', scale: π/180 }`. Lets the host mirror the at-rest pose without
   *  running the behavior (the pilot's surface-carry direction on a settled deck). Omit for joints that rest
   *  at 0 or whose rest isn't a single param's function. */
  rest?: { param: string; scale?: number; add?: number }
  /** A servo: the host drives this joint as a motion axis instead of taking a position
   *  from the behavior each tick. The behavior commands it through `ctx.servos.<name>` (power, moveAbsolute,
   *  moveVelocity, halt, ...) and the host runs the profile inside the joint's limits ({@link min} / {@link max},
   *  narrowed by {@link minParam} / {@link maxParam}). The caps are in the joint's native unit, per second
   *  (revolute radians, prismatic metres); a command asking for more is held to them. */
  servo?: RigServo
}

/** The rig's joints as the JSON a behavior instance is created with (embeddedBehavior `create`'s `jointsJson`), or
 *  undefined when it has none: the instance runs the servos among them, and a robot's controller drives them within
 *  their limits. Every host that runs a rig's behavior hands it these, so the joints move the same in a run, an idle
 *  preview and a stopped Use. */
export function rigJointsJson(geometry: PartPackageGeometry): string | undefined {
  if (geometry.kind !== 'rig' || geometry.joints.length === 0) return undefined
  return JSON.stringify(geometry.joints)
}

/**
 * A part's `robot` declaration in definePart: the host runs a robot controller for it, reached as `ctx.robot`
 * ({@link RobotController}). `robot: true` drives every joint of the rig that is not a servo, cosmetic or following
 * another (mimic), in rig order. An object names the `joints` (in waypoint column order), the `gripper` link a Grip
 * step closes, a `lamp` lit while it holds, and a `gripJoint` that opens and closes with the grip (`open` and `closed`
 * in the joint's own units, rad or m).
 */
export interface RobotDeclaration {
  joints?: readonly string[]
  gripper?: string
  lamp?: string
  gripJoint?: { name: string; open: number; closed: number }
  /** the link the host draws the robot's tool on, the one the `tool` param picks (core/robot/robotTools.ts) */
  tool?: string
  /** the arm's own hand, which grips instead of `gripper` and `gripJoint` while the `tool` param is `'hand'` (an
   *  imported arm whose description carries one). Its links take `showParam: 'tool=hand'`, so another tool replaces
   *  it. */
  hand?: { gripper: string; gripJoint: { name: string; open: number; closed: number } }
}

/**
 * `ctx.robot`, for a part that declares `robot`: the host's robot controller (core/robot/robotController.ts).
 * `step()`, called once from the part's step(), takes the PLC's command, runs the job, moves the arm on a coordinated
 * profile, and writes the joints, grip, lamp, Done tag and outputs. It reads the part's params by fixed names, which the
 * part declares like any other params: `speed`, `accel`, `blendDeg`, `waypoints`, `waypointNames`, `blendWaypoints`,
 * `jobs` (rows `[job, op, a, b]`: op 1 Move to waypoint a, b = 1 to blend; 2 Grip, a = 1 on; 3 Wait a seconds; 4 Wait
 * for input a + 1 to read b; 5 Set output a + 1 to b), `jobNames`, `pose` (the idle pose), and the tags `commandTag`,
 * `executeTag`, `doneTag`, `enableTag`, `gripperTag`, `in1Tag`..`in4Tag`, `out1Tag`..`out4Tag`. Positions are degrees
 * for a revolute joint and millimetres for a prismatic one. The six-axis robot declares them all.
 */
export interface RobotController {
  step(): void
}

export interface RigServo {
  maxVelocity: number
  maxAccel: number
  /** defaults to maxAccel */
  maxDecel?: number
  /** a revolute servo that turns without end, its position wrapping at this many radians (2π for a full turn); the
   *  joint's min / max then do not limit it */
  modulo?: number
}

/**
 * Rename one rig link, cascading the new name through every structural reference in the rig: child links'
 * `parent`, two-point look-at targets (`aim.target`), and joints' `link`. A link name is a reference key,
 * not just a label, so a bare relabel would orphan those. Joint names are left untouched: they're a separate
 * identifier the behavior commands via `setJoint`. Returns the rewritten links+joints, or `null` when the rename
 * is a no-op or invalid: a blank/unchanged name, an unknown source link, or a name already taken by another link.
 * Pure, and in core so the editor and any headless authoring path share one cascade. Behavior-script references
 * to the link by name (setGrip/setSubPose string args) are not rewritten here. The caller adds that guarded
 * source-edit step separately.
 */
export function renameRigLink(
  geometry: { links: RigLink[]; joints: RigJoint[] },
  oldName: string,
  rawName: string,
): { links: RigLink[]; joints: RigJoint[] } | null {
  const newName = rawName.trim()
  if (newName === '' || newName === oldName) return null
  if (!geometry.links.some((l) => l.name === oldName)) return null
  if (geometry.links.some((l) => l.name === newName)) return null
  const links = geometry.links.map((l): RigLink => {
    let next = l
    if (l.name === oldName) next = { ...next, name: newName }
    if (l.parent === oldName) next = { ...next, parent: newName }
    if (l.aim?.target === oldName) next = { ...next, aim: { ...l.aim, target: newName } }
    return next
  })
  const joints = geometry.joints.map((j): RigJoint => (j.link === oldName ? { ...j, link: newName } : j))
  return { links, joints }
}

/**
 * Does a behavior script mention a joint (or any rig name) at all? This is the crudest test: the name appearing
 * anywhere in the source, comments included. It guards a rename that does not rewrite the script. A joint is commanded as `ctx.setJoint('shoulder', …)`, as `ctx.joints.shoulder`, as
 * `ctx.measured.joints.shoulder`, and declared in `definePart({ joints: [...] })`, and a literal-only rewrite like
 * {@link renameRigNameRefs} would miss the property forms and leave a joint that silently stops moving. A false
 * "mentioned" only keeps a name read-only; a false "not mentioned" would break a part.
 */
export function behaviorMentions(source: string, name: string): boolean {
  return name !== '' && source.includes(name)
}

/**
 * Rename one rig joint (its `name`, the identifier the behavior commands it by). Nothing else in a rig points at
 * a joint by name - joints point at links - so the geometry half is just the joint itself. Returns the rewritten
 * joints, or `null` for a no-op or invalid rename: a blank/unchanged name, an unknown joint, or a name another
 * joint already has. The script half is the caller's: it may only rename a joint the script never mentions
 * ({@link behaviorMentions}). Pure (core), like {@link renameRigLink}.
 */
export function renameRigJoint(joints: readonly RigJoint[], oldName: string, rawName: string): RigJoint[] | null {
  const newName = rawName.trim()
  if (newName === '' || newName === oldName) return null
  if (!joints.some((j) => j.name === oldName)) return null
  if (joints.some((j) => j.name === newName)) return null
  return joints.map((j) => (j.name === oldName ? { ...j, name: newName } : j))
}

/**
 * The guarded other half of a rig-link rename ({@link renameRigLink} handles geometry): rewrite references to
 * the link by name in a behavior script. A link name reaches behavior only as a string argument -
 * `setGrip('hand', …)`, `setSubPose('hand', …)` - so only whole-string-literal occurrences of `oldName` are
 * rewritten (`'oldName'`, `"oldName"`, or a template whose entire content is the name), quote style preserved.
 * A bare identifier, a substring (`'hand-tip'`) or a built name is left alone: a wrong rewrite of freeform JS is
 * worse than a missed one, which is why the caller applies this only behind an explicit confirm. Returns the
 * rewritten source plus the match `count` so the caller can decide whether to prompt. Pure + portable (core).
 */
/**
 * Filename-safe form of a package id, for `public/thumbnails/pkg/<file>.webp` - the catalog card's image and
 * the boot warm both resolve a card's thumbnail through this, so they cannot disagree about where it lives.
 *
 * `scripts/gen-thumbnails.mjs` keeps a hand-copied mirror of this rule (a plain .mjs cannot import the TS):
 * change both together, or a card 404s and silently falls back to the offscreen renderer.
 */
export function packageThumbFile(id: string): string {
  return id.replace(/[^a-z0-9._-]/gi, '_')
}

/**
 * Every lamp name a rig offers the behavior: each link's {@link RigLink.lamps} (named, else the link's name)
 * plus the lamps its geometry() draws. The only complete answer to "is `ctx.lamps.x` a real lamp?", which is
 * why the typo guard (sim/validatePart.ts) asks here.
 */
export function rigLampNames(geometry: PartPackageGeometry | undefined, drawnLamps: Iterable<string> = []): Set<string> {
  // drawnLamps: the lamps the part's geometry() draws (core/geometry/geometryEval geometryLampNames) - a code-built lamp
  const out = new Set<string>(drawnLamps)
  if (!geometry || geometry.kind !== 'rig') return out
  for (const link of geometry.links) for (const lamp of link.lamps ?? []) out.add(lamp.name ?? link.name)
  return out
}

/**
 * The rig links a behavior script can move at runtime through `ctx.setSubPose`: the static half of
 * "is this link really static?", read by the render layer to keep such a link out of the scene-global
 * instance pool. A jointless rig's meshes otherwise merge across parts with world matrices baked at rebuild,
 * so a per-tick subPose (the push button's cap depressing) would leave the merged copy drawing the rest pose.
 * Joints and `aim` are declared in the geometry; a subPose is named only in the script, hence this read.
 *
 * Same whole-string-literal convention as {@link renameRigNameRefs}. A call whose first argument is not a plain
 * literal can't be resolved statically, so it sets `unresolved` and the caller must treat every link as movable:
 * over-excluding costs a merged draw, under-excluding renders a part visibly stuck. Pure + portable (core), so
 * both shells decide this identically.
 */
export function subPosedLinkNames(source: string | undefined): { names: Set<string>; unresolved: boolean } {
  const names = new Set<string>()
  let unresolved = false
  if (!source) return { names, unresolved }
  // every `setSubPose(` call site, capturing its first argument only when it's a whole string literal
  for (const m of source.matchAll(/setSubPose\s*\(\s*(?:(['"`])([^'"`]*)\1)?/g)) {
    const name = m[2]
    // a template with a substitution (`${x}`) is a literal to the regex but a dynamic name in fact
    if (name === undefined || name.includes('${')) unresolved = true
    else names.add(name)
  }
  return { names, unresolved }
}

export function renameRigNameRefs(source: string, oldName: string, newName: string): { source: string; count: number } {
  const esc = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // ([quote]) <oldName> \1 - the backreference forces matching open/close quotes and the anchored content
  // forces a whole-literal (not substring) match across all three JS string-literal forms.
  const re = new RegExp('([\'"`])' + esc + '\\1', 'g')
  let count = 0
  const out = source.replace(re, (_m, q: string) => {
    count++
    return q + newName + q
  })
  return { source: out, count }
}

/** A part's geometry - `kind` discriminates. Each kind is its own interface below so its rules are documented
 *  where an author (or an editor hover) looks. */
export type PartPackageGeometry = RigGeometry | DrawnGeometry | CargoGeometry

/** The part's footprint box (m) - what the Inspector, snapping and placement use without running code. `length`
 *  runs along local X, `width` along Z, centred on the origin unless `centerX` / `centerZ` move the box; y spans
 *  [`bottom`, `top`] in the part's own frame. So an imported model belongs with its XZ centre on the origin (offset
 *  its links, or use a mesh's `fitHeight`), or declares where its centre is. Package format 3 spelled the vertical
 *  extent `height` (above the origin) and `floorY` (below it). */
export interface PartBounds {
  length: number
  width: number
  /** the highest point, y in the part's frame (above the origin for a floor-standing part) */
  top: number
  /** the lowest point, y in the part's frame; default 0 (a floor-standing part whose origin is its underside). A
   *  conveyor-mounted rig (blade stop, chain transfer) has its origin at the belt surface and its housing hanging
   *  below, so its bottom is negative: a free-standing drop rests that underside on the floor instead of sinking
   *  the origin to it. */
  bottom?: number
  /** the box's centre along local X, m from the origin (default 0): a part whose origin is not its middle, like a
   *  pusher whose origin sits on the guard it mounts to */
  centerX?: number
  /** the box's centre along local Z, m from the origin (default 0) */
  centerZ?: number
  /** param-driven fields, so the box follows the part's own size params: each entry replaces one field with
   *  `params[param] [× mulParam] × scale + add`, clamped to `[min, max]`, the same rule as a link's `sizeParams`.
   *  The static fields above are what stands while the param is missing, and what a host that cannot see params
   *  reads. A resolved length or width must be positive and a resolved top above the bottom, or that field keeps
   *  its static value. An axis with a `face` resize handle reads the handle's param instead. */
  params?: BoundsParamRef[]
}

/** One {@link PartBounds.params} entry: the bounds `field` it drives, and the param it is a linear map of. */
export interface BoundsParamRef {
  field: 'length' | 'width' | 'top' | 'bottom' | 'centerX' | 'centerZ'
  /** the instance param name whose (numeric) value drives the field */
  param: string
  /** multiply by a second param's value before `scale`/`add` */
  mulParam?: string
  /** multiply the param value (default 1) */
  scale?: number
  /** add after scaling (default 0) */
  add?: number
  /** clamp the resolved value from below (after scale+add) */
  min?: number
  /** clamp the resolved value from above (after scale+add) */
  max?: number
  /** add this entry's value to the field instead of replacing it, as a link's {@link SizeParamRef.plus}: a bounds
   *  length of `length + 2 × overhang` is a replacing entry then a `plus` one */
  plus?: boolean
}

/** A cargo box's size (m), centred on its origin: `length` along X, `height` along Y, `width` along Z. */
export interface CargoSize {
  length: number
  width: number
  height: number
}

/** A multi-body rig: a tree of links + kinematic joints (robots, gates, AGVs, imported devices). */
export interface RigGeometry {
  kind: 'rig'
  links: RigLink[]
  joints: RigJoint[]
  /** Opts the rig into the in-scene teach-by-pose gizmo (joint rings + IK end-effector handle, shown whenever the
   *  placed part is selected: pose the arm, then Inspector → Capture Pose). Set it only for manipulators you
   *  hand-teach (robot / gantry / AGV lift). Leave it off for parts whose joints are driven by the sim/PLC (safety
   *  gate, diverter, blade-stop, turntable); an interactive pose gizmo there is a false affordance. Omitted/false
   *  = no in-scene pose gizmo (the joints still articulate; FK/sim are unaffected). */
  posable?: boolean
  /** The link the teach gizmo's end-effector handle drags: the tool point (a robot's flange or TCP frame). The IK
   *  moves only the joints between the rig root and this link, so a gripper's finger joints, which branch off
   *  beside it, keep their place. Omitted = the link of the last posable joint. */
  tool?: string
  /** Marks the rig a whole-bed incline conveyor: names a `number` param (degrees) that tilts the whole bed about
   *  the rig root, around local +Z (cross-bed), so the +X head lifts by run·sin while the origin stays put
   *  The host tilts render + collision from the one param, regrows the trestle legs
   *  to the floor, and carries cargo up the slope. `leg` links stay vertical. Omitted = flat. */
  inclineParam?: string
  /** clamps `inclineParam` (default 30 - rollers shed product on a steep grade, unlike belts) */
  maxInclineDeg?: number
  /** The footprint box ({@link PartBounds}); omitted = a unit box until the author declares one. */
  bounds?: PartBounds
}

/** Procedural geometry from the behavior's `geometry(g, params)` callback (Tier 2 in the part authoring guide),
 *  for shapes the static `mesh` sweep can't list (a bent multi-segment belt, a lofted or revolved profile).
 *  The shape lives in code: the host runs `geometry()` to get a MeshDescription and runs it again on a param
 *  change. `bounds` is the baked footprint, so the Inspector, snapping and placement work without running code.
 *  `conveys` marks it a powered conveyor surface (the sim builds a deck body sized to `bounds`). `material`
 *  optionally overrides the surface. */
export interface DrawnGeometry {
  kind: 'drawn'
  bounds: PartBounds
  material?: string
  conveys?: boolean
}

/** Dynamic cargo: the part is a piece of cargo, not a machine. The host builds one dynamic body for
 *  it and the part goes through the same pipeline as the built-in box and pallet. `cargoKind` picks the physics and
 *  visual family: 'box' (size from the instance's length/height/width params, falling back to `size`, drawn with the
 *  shared Box model), 'pallet' (a block pallet at the footprint its `size` param picks) or 'tote' (an open-top
 *  plastic container at the standard size its `size` param picks). Centre origin, like the built-ins. The behavior
 *  is passive by convention (an empty step), because cargo is payload. */
export interface CargoGeometry {
  kind: 'cargo'
  cargoKind: 'box' | 'pallet' | 'tote'
  /** the box, centred (package format 3 called it `bounds`) */
  size: CargoSize
}

/** A mark a machine leaves on cargo (ctx.mark): a small fact other parts can read (ctx.marked, a beam's hit). */
export type CargoMarkValue = number | boolean | string


/**
 * What kind of conveyor a part is, declared (package format 4; format 3 inferred it from drag handles). Only a
 * declared conveyor is one to its neighbours: guard openings where another conveyor butts it, end-to-end and
 * side-merge snapping, deck merging, and the host's matching of guards and roller grids where two conveyors meet.
 *
 * - `bed`: the shape of the conveying bed, which decides how neighbours meet it. Each kind names the declaration
 *   that gives its geometry, and a missing one is a validation error:
 *   - `'straight'`: a centre-origin rectangle, sized by the `number` params carrying `face` handles on x (length)
 *     and z (width). The roller conveyor.
 *   - `'spur'`: a straight bed whose ends splay: the length face handle also names `angleFrontParam` /
 *     `angleBackParam`. The spur conveyors.
 *   - `'path'`: a tail-origin bent belt, its segments edited by a `path` handle. The belt conveyor.
 *   - `'arc'`: a curve, swept by an `arc` handle. The curved conveyors.
 *   - `'turntable'`: a deck turning on a revolute joint whose link is a cylinder (its rim is where neighbours butt).
 *   Omit `bed` for a part that conveys but is not a conveyor to its neighbours (a powered deck inside a machine).
 * - `surface`: what cargo rides on, which sets its grip: `'belt'` when cargo rests on a surface that moves with it (a
 *   belt, slats, a mat-top chain), `'roller'` when it rides over rollers or wheels that turn under it (also the
 *   default for a conveying part that declares no `conveyor`).
 * - `speedParam`: the `number` param that is the conveying speed (m/s, negative = reverse). The host mirrors it
 *   outside the behavior's tick (belt scroll and roller spin, the flow arrow, the pilot riding the surface, a
 *   spawner's "is my conveyor running" before the first tick); without it those stay still until the behavior runs.
 * - `reverseParam`: a hidden `boolean` param the snap flips to turn a curve's flow around when it mates two ends
 *   that both discharge into the junction (rotating a curve 180 degrees would swap its radii). The effective speed
 *   is `speed x (reverse ? -1 : 1)`; the behavior folds it the same way.
 * - `frictionParam`: the `number` param that is the running surface's friction against a standard carton, the
 *   figure a belt datasheet quotes (a smooth PVC belt about 0.4, a rough-top about 0.9, a low-friction modular
 *   belt about 0.2). Other cargo grips by its own friction against the same surface. Without it the surface grips
 *   as its `surface` kind does: about 0.59 against a carton for a belt, 0.42 for rollers.
 *
 * The handles are only the viewport's drag affordances; they don't decide what a part is.
 */
export interface ConveyorDecl {
  bed?: 'straight' | 'spur' | 'path' | 'arc' | 'turntable'
  surface: 'belt' | 'roller'
  speedParam?: string
  reverseParam?: string
  frictionParam?: string
}

export interface PartPackage {
  /** package format version, the literal of PACKAGE_FORMAT (spelled out, not `typeof`: the generated SDK carries
   *  this file's types but not its constants). A stored package of an older one is carried forward by
   *  upgradeStoredPackage; see PACKAGE_UPGRADES for when to bump it. */
  format: 6
  /** stable globally-unique id, e.g. "acme.spiral-belt" */
  id: string
  /** display name in the catalog */
  name: string
  /** optional catalog grouping */
  category?: string
  /** exported params, baked from the behavior's definePart (so importers show the Inspector without running code) */
  params: ParamSchema
  /** the behavior script source - an import-free script that calls definePart(...) */
  behavior: string
  /** collision/visual footprint */
  geometry: PartPackageGeometry
  /** embedded GLB meshes referenced by mesh shapes (by id); absent when the part uses only primitives */
  assets?: PartAsset[]
  /** PBR materials a mesh shape can reference (by id) to override its GLB's own material */
  materials?: PartMaterial[]
  /** optional data-URL thumbnail for the catalog */
  thumbnail?: string
  /** The behavior reads `ctx.used()` (declared `interactive: true`), so the editor offers a
   *  "Use" prompt and routes a pilot-mode click to it. Baked from the behavior when the package is built. */
  interactive?: boolean
  /** The boolean param that is the device's hand state (declared `useParam`): the state a run starts from, set
   *  in the Inspector; Use never writes it, and step() reports its live value. Baked + validated at package build. */
  useParam?: string
  /** This part is a unit load product type (definePart `unit`): its children are one load. Baked from the behavior. */
  unit?: UnitLoadDecl
  /** Declarative snap features - the connection geometry the editor's snap engine matches across parts (a device's
   *  mount onto a host surface). Declared in the manifest. See {@link SnapSpec}. */
  snap?: SnapSpec
  /** what kind of conveyor this part is, if any ({@link ConveyorDecl}) */
  conveyor?: ConveyorDecl
  /** the `boolean` param that switches this part's PLC link: while it is false the part's tags are disconnected
   *  (it runs on its authored params), and the PLC panel's comms toggle writes it. Usually omitted: a part without
   *  one is connected by each tag field that names a tag, and an empty field is a signal left unconnected, which is
   *  how the built-in parts work. Package format 3 read a param named `enableComms` for this. */
  commsParam?: string
  /** the cargo this part stores, held on its grippers ({@link HoldsDecl}) */
  holds?: HoldsDecl
  /** this part is cargo with its own body: its rig moves as one rigid body ({@link CargoDecl}) */
  cargo?: CargoDecl
  /** Where this project's copy came from ({@link PartOrigin}). Absent on a part made here, and on a copy made before
   *  these records existed. */
  origin?: PartOrigin
  /** Who made it, for a copy from a part library ({@link PartCredit}). Written by the app, never by the part. */
  credit?: PartCredit
  /** The Part SDK level this part was last changed under ({@link PartSdkStamp}), written by the app. */
  sdk?: PartSdkStamp
}

/**
 * Who made a part a project copied from a part library, kept with the copy so the credit goes wherever the part does
 * (an exported project, a room, a part file). Its models are under CC BY 4.0, whose one condition is attribution, and
 * the people who publish parts should be named where they are used. Written by the app from the library's listing:
 * `by` is the publisher the parts repository's checks confirmed (a GitHub account or organization), or the Open
 * Industry Project for the project's own libraries. Not part of what the part is (its fingerprint leaves it out), so
 * a credit never makes a copy read as edited. Kept through edits and Save as New Part, since a changed part is still
 * based on the publisher's work.
 */
export interface PartCredit {
  /** the publisher; absent for a library that names none */
  by?: string
  /** the library's name, e.g. "Community" */
  library: string
  /** where to find the publisher: their GitHub page, or the project's site */
  url?: string
}

/**
 * The Part SDK level a part was last changed under, written by the app. An app older than `level`
 * may lack something the part uses, so it warns. `of` is the part's fingerprint when it was stamped: the stamp only
 * counts while the part is unchanged, so an edit made by an app that does not stamp never keeps an old level.
 */
export interface PartSdkStamp {
  level: number
  of: string
}

/**
 * Cargo with its own body: declared on a `rig` geometry, it makes the part payload that moves
 * as one rigid body, the way a box, pallet or tote does, but with the rig's own shape. Its collider is the rig's
 * colliding links at rest pose (a box per box link, a round cylinder per cylinder link, so a drum rolls), and it draws
 * as its own rig. The rig has no joints, and its links' bounds are centred on the part's origin, like every cargo.
 *
 * - `friction`: the body's friction (default 0.5, a box's).
 * - `massParam`: the `number` param that is its mass in kg (default `mass`; 10 kg when the part has no such param).
 * - `colorParam`: the colour param that tints it (default `color`).
 *
 * What it is, to the machines around it (each is off unless declared). A built-in box, pallet or tote that declares
 * none has the ones its kind always had:
 * - `forkPockets`: it has a block pallet's fork channels at its footprint, so forks that take it are told when their
 *   spread does not fit a face. A pallet's.
 * - `heavy`: it bears loads (a pallet under a stack). The physics solver works harder on it so a stack does not sink
 *   into it, and it is never counted as dropped or tipped. A pallet's.
 * - `loadBase`: a load is wrapped from it (a stretch wrapper's film starts at its mid-height), and
 *   it anchors a unit load before any other piece. A pallet's.
 * - `separateContacts`: its sub-shapes keep their own contacts, so a floor that hovers over its foot does not sink
 *   into what it stands on. A tote's.
 * - `nestDepth`: a body of its shape set on it sits this far lower than its height (m), its foot inside the rim
 *   below. A stacking tote's foot.
 */
export interface CargoDecl {
  friction?: number
  massParam?: string
  colorParam?: string
  forkPockets?: boolean
  heavy?: boolean
  loadBase?: boolean
  separateContacts?: boolean
  nestDepth?: number
}

/** Is this package cargo: a box, pallet or tote (`geometry.kind: 'cargo'`), or a rig with its own cargo body? */
export function isCargoPackage(pkg: Pick<PartPackage, 'geometry' | 'cargo'>): boolean {
  return pkg.geometry.kind === 'cargo' || (pkg.cargo !== undefined && pkg.geometry.kind === 'rig')
}

/**
 * Where a project's copy of a part came from, per source: the fingerprint of the version that
 * source had when the copy was made, so the app can tell whether the source, this project, or both have changed it
 * since. One copy can have more than one: a project's version of a built-in that is also on
 * the shelf. Package format 5 spelled `app` as `basedOn` and `shelf` as `fromShelf`.
 *
 * - `app`: this is a project's own version of the built-in part of the same id, or, with
 *   `appPart`, of the built-in `appPart` names: a variant made from it under its own id ("Save as a New Part").
 * - `appPart`: the id of the built-in a variant was made from. Absent on a copy of the same id.
 * - `shelf`: this was copied from the parts shelf.
 * - `library`: this was installed from a part library. Read through the index signature.
 *
 * A key this build does not know is kept and ignored, so a later source does not make an older build refuse the part.
 */
export interface PartOrigin {
  app?: string
  appPart?: string
  shelf?: string
  [source: string]: string | undefined
}

/** The gripper name of copy `index` of a posable array (`ctx.setGrip(link, on, index)`): `link#index`, the key it holds
 *  cargo under and reports in `ctx.measured.grips`. */
export function copyGripName(link: string, index: number): string {
  return `${link}#${index}`
}

/** A copy gripper's link and index, or null for a plain link name */
export function parseCopyGripName(name: string): { link: string; index: number } | null {
  const at = name.lastIndexOf('#')
  if (at <= 0) return null
  const index = Number(name.slice(at + 1))
  return Number.isInteger(index) && index >= 0 ? { link: name.slice(0, at), index } : null
}

/**
 * The cargo a part stores: a magazine, a buffer, a rack position. The stored items are real cargo held on the part's
 * grippers, one per position (never despawned and remade), so what a run starts with is authored like any other
 * cargo: parts of `part` placed at the positions, parented to the holder. The editor's Fill / Empty place and remove
 * them; the behavior grips what it finds there when the run starts.
 *
 * - `part`: the package id of the cargo part a position holds (`'oip.pallet'`).
 * - `positions`: gripper link names, bottom first (the order they fill in). Each must be a rig link with a
 *   `grip.zone`; the item stands at the zone's centre, at the part's rest pose. A copy of a posable gripper array is
 *   named `link#i` (`'pos#0'`, `'pos#1'`, ...) and stands at its rest place in the row; a copy the array's count
 *   leaves out is not a position.
 * - `limitParam`: a `number` param capping how many positions are in use (a magazine's capacity). Absent = all.
 * - `params`: params Fill gives each item it places, from the holder's own: `{ size: 'palletSize' }` places pallets
 *   of the size the magazine is set to. Item param name -> holder param name.
 */
export interface HoldsDecl {
  part: string
  positions: string[]
  limitParam?: string
  params?: Record<string, string>
}

/** What a unit load stored before it declared its pieces ({@link UnitLoadDecl.pieces}) stacks. */
const UNDECLARED_UNIT_PIECES = { pallet: 'oip.pallet', case: 'oip.box' } as const

/** The pallet and case parts a unit load that stacks itself is made of; undefined when `pkg` is not a unit load. */
export function unitPiecesOf(pkg: PartPackage): { pallet: string; case: string } | undefined {
  return pkg.unit ? (pkg.unit.pieces ?? UNDECLARED_UNIT_PIECES) : undefined
}

/**
 * The other parts `pkg` names, by package id: the cargo it holds ({@link HoldsDecl}), a unit load's pieces, and the
 * default of each product param ({@link productRefsOf} covers what an instance sets instead). A project that uses
 * `pkg` needs them too, so it holds copies of them (docs/part-sources.md).
 */
export function packageDependencies(pkg: PartPackage): string[] {
  const out: string[] = []
  if (pkg.holds) out.push(pkg.holds.part)
  const pieces = unitPiecesOf(pkg)
  if (pieces) out.push(pieces.pallet, pieces.case)
  for (const spec of Object.values(pkg.params)) {
    if (spec.type === 'string' && spec.product === true && typeof spec.default === 'string' && spec.default) out.push(spec.default)
  }
  return [...new Set(out)].filter((id) => id !== pkg.id)
}

/** The products an instance of `pkg` names in its product params ({@link ParamSpec.product}): its own values, else
 *  the defaults. A spawner set to make totes needs the tote in the project, and in the run. */
export function productRefsOf(params: Readonly<Record<string, unknown>>, pkg: PartPackage): string[] {
  const out: string[] = []
  for (const [key, spec] of Object.entries(pkg.params)) {
    if (spec.type !== 'string' || spec.product !== true) continue
    const v = params[key] ?? spec.default
    if (typeof v === 'string' && v && v !== pkg.id) out.push(v)
  }
  return out
}

/**
 * Every definition `parts` need, through `resolve`: each part's own, the products its params name (productRefsOf), and
 * what each of those names in turn (packageDependencies). In the order first resolved, the parts' own in scene order
 * first. An id `resolve` has no definition for is skipped. The one answer to "what do these parts need": the sim
 * (forSim), a save (missingLibraryCopies), a copy (storeCopy) and a room (syncReferencedPackages) each filter it.
 */
export function definitionsUsedBy(parts: Iterable<PartInstance>, resolve: (id: string) => PartPackage | undefined): PartPackage[] {
  const out: PartPackage[] = []
  const resolved = new Map<string, PartPackage | undefined>()
  const lookup = (id: string): PartPackage | undefined => {
    if (resolved.has(id)) return resolved.get(id)
    const pkg = resolve(id)
    resolved.set(id, pkg)
    if (pkg) out.push(pkg)
    return pkg
  }
  const queue: string[] = []
  for (const p of parts) {
    if (!('packageId' in p) || typeof p.packageId !== 'string') continue
    queue.push(p.packageId)
    const pkg = lookup(p.packageId)
    if (pkg) queue.push(...productRefsOf(p.params, pkg))
  }
  const seen = new Set<string>()
  while (queue.length > 0) {
    const id = queue.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    const pkg = lookup(id)
    if (pkg) queue.push(...packageDependencies(pkg))
  }
  return out
}

export interface PackageProblem {
  field: string
  message: string
}

// --- the workspace / part-folder manifest ---------------------------------------------------------

/**
 * The authored half of a part: everything except the behavior script and the fields baked from that
 * script (`format`, `params`, `interactive`). This is the `manifest.json` of the on-disk part
 * folder layout (`manifest.json` + `behavior.js`) shared by the desktop parts workspace
 * and a project folder's `parts/`. When the app builds the part it bakes those fields again by running the
 * behavior, so the script is always the source of truth for them.
 */
export interface PackageManifest {
  id: string
  name: string
  category?: string
  geometry: PartPackageGeometry
  /** embedded GLB meshes referenced by mesh shapes (by id) - carried into the package so it stays self-contained */
  assets?: PartAsset[]
  /** PBR materials a mesh shape can reference (by id) */
  materials?: PartMaterial[]
  thumbnail?: string
  /** what kind of conveyor this part is, if any ({@link ConveyorDecl}) */
  conveyor?: ConveyorDecl
  /** the boolean param that switches this part's PLC link (see {@link PartPackage.commsParam}) */
  commsParam?: string
  /** how this part connects to others: the snap engine's connectors ({@link SnapSpec}). Structure, like the rig: it
   *  lives here, beside the geometry whose params it names. Package format 3 declared it in `definePart`. */
  snap?: SnapSpec
  /** the cargo this part stores on its grippers ({@link HoldsDecl}) */
  holds?: HoldsDecl
  /** this part is cargo with its own body ({@link CargoDecl}) */
  cargo?: CargoDecl
  /** where a project's copy came from, written by the app ({@link PartOrigin}) */
  origin?: PartOrigin
  /** who made a copy from a part library, written by the app ({@link PartCredit}) */
  credit?: PartCredit
  /** the Part SDK level the part was last changed under, written by the app ({@link PartSdkStamp}) */
  sdk?: PartSdkStamp
}

/**
 * The manifest half of a built package - the inverse of buildPackage's input. `params` (and the other
 * behavior-baked fields) are intentionally omitted: buildPackage re-bakes them from the behavior source,
 * exactly like a hand-authored folder, so writing them would only risk drift.
 */
export function manifestOfPackage(pkg: PartPackage): PackageManifest {
  return {
    id: pkg.id,
    name: pkg.name,
    ...(pkg.category !== undefined ? { category: pkg.category } : {}),
    geometry: pkg.geometry,
    ...(pkg.assets !== undefined ? { assets: pkg.assets } : {}),
    ...(pkg.materials !== undefined ? { materials: pkg.materials } : {}),
    ...(pkg.thumbnail !== undefined ? { thumbnail: pkg.thumbnail } : {}),
    ...(pkg.conveyor !== undefined ? { conveyor: pkg.conveyor } : {}),
    ...(pkg.commsParam !== undefined ? { commsParam: pkg.commsParam } : {}),
    ...(pkg.snap !== undefined ? { snap: pkg.snap } : {}),
    ...(pkg.holds !== undefined ? { holds: pkg.holds } : {}),
    ...(pkg.cargo !== undefined ? { cargo: pkg.cargo } : {}),
    ...(pkg.origin !== undefined ? { origin: pkg.origin } : {}),
    ...(pkg.credit !== undefined ? { credit: pkg.credit } : {}),
    ...(pkg.sdk !== undefined ? { sdk: pkg.sdk } : {}),
  }
}
/** The package format this build writes and the newest one it reads. Typed as {@link PartPackage.format}, so a bump
 *  here fails to compile until that literal moves with it. */
export const PACKAGE_FORMAT: PartPackage['format'] = 6

/** One upgrade step: a stored package of format N in, the same package written as format N+1 out, plus a line per
 *  thing it had to change for the load's repair report. It must not mutate its input (a room's copy is shared). */
export type PackageUpgrade = (pkg: Record<string, unknown>) => { pkg: Record<string, unknown>; notes: string[] }
