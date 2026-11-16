// The public SDK a custom part's script implements - a script attached to a scene part. A part declares
// exported params (→ Inspector fields) and a `step()` callback run every fixed sim tick. The script is a portable artifact that
// runs identically on both shipping surfaces - the browser and the Electron desktop app - because both
// run the same V8 over the same TS SimCore. It only ever sees a `PartContext`, never a host API. The reason is not
// cross-engine portability. It keeps parts (1) deterministic, so the twin stays reproducible and measurable, and
// (2) confined: part code runs inside an SES Compartment and is handed only `ctx`, so `ctx` is the interface
// the sandbox audits (docs/part-sandbox.md). The curated surface is meant to
// grow (query/effect capabilities) without becoming a raw scene handle - see
// docs/custom-part-capability-surface.md. Driven by src/sim/embeddedBehavior.ts.

// types only: partPackage.ts imports this file, and the SDK lifts both (scripts/build-part-sdk.mjs)
import type { PackageManifest, PartPackageGeometry, RigGeometry, RobotController, RobotDeclaration } from './partPackage'

export interface Vec3 {
  x: number
  y: number
  z: number
}

/** One exported, inspector-editable parameter. */
export interface ParamSpec {
  /**
   * The value kind. `'number' | 'boolean' | 'string'` are the plain scalar types. `'tag'` is a
   * special string: it names a PLC tag the part reads/writes (`ctx.readTag`/`ctx.writeTag`/
   * `ctx.readNumber`/`ctx.writeNumber`). The Inspector renders a tag picker with autocomplete from the
   * scene's tags, so the person placing the part can't fat-finger a tag name. The runtime value is still a
   * `string`; `'tag'` only changes how it's edited.
   *
   * `'numberList'` is a list of fixed-width numeric rows, instead of a `'string'` you `JSON.parse` every tick
   * (which silently falls back to the default on a typo). `ctx.params.x` is a real `readonly number[][]`, already
   * parsed and validated, and the Inspector edits it as a row grid. Set {@link arity} to the numbers per row
   * (6 for a joint pose, 3 for an XYZ point, 1 for a flat list); `default` is the starting rows.
   *
   * `'color'` is a special string: an `#rrggbb` hex colour edited via a swatch picker (e.g. a belt's fabric
   * tint). The runtime value is still a `string`. Set {@link alpha} to expose an A channel (an 8-digit
   * `#rrggbbaa` value), e.g. a floor marking whose transparent bands show the floor.
   *
   * `'enum'` is a string picked from a fixed {@link options} list (a dropdown). The runtime value is the chosen
   * `value` string. If the options carry `rows` and the param names a {@link stamps} target, the enum becomes a
   * one-tap template picker over a `'numberList'` param (e.g. a belt `shapePreset` stamping a segment template
   * into `segments`) - see {@link stamps}.
   *
   * `'partRef'` is a special string holding another scene part's id, edited via a dropdown of the scene's parts
   * (a spawner's "pause when this conveyor stops" interlock). The runtime value is the target part's id
   * (`''` = unset). It isn't validated: a dangling id is inert. Read the live conveyor state it points at with
   * `ctx.conveyorRunning(id)`.
   */
  type: 'number' | 'boolean' | 'string' | 'tag' | 'numberList' | 'color' | 'enum' | 'partRef'
  /** numbers per row for a `'numberList'` param (e.g. 6 = a six-joint pose). Default 1 (a flat list). */
  arity?: number
  /**
   * For a `'numberList'` param: a header per column (`['x', 'z', '°']`), shown on the Inspector's cells in place
   * of `#1`, `#2`. Say the column's unit here rather than packing the whole row layout into the label. Length
   * should match {@link arity}. Ignored for other kinds.
   */
  columns?: string[]
  /**
   * For a `'numberList'` param: a fixed row count. The Inspector shows exactly these rows with no Add or
   * Remove, so a single value of several numbers (a robot's idle pose: one row of six joints) reads as one
   * strip rather than a table of one. Storage is unchanged. Ignored for other kinds.
   */
  rows?: number
  /**
   * For an arity-1 `'numberList'` param: its rows are indices into the named `'numberList'` param, a set of that
   * table's rows (the robot's `blendWaypoints` marks which `waypoints` are via points). The Inspector shows one
   * checkbox per row of the named table instead of a column of numbers to keep in sync by hand. The runtime
   * value is unchanged: `[[1], [3]]`. Ignored for other kinds.
   */
  rowsOf?: string
  /**
   * For a `'numberList'` param: names a `'string'` param holding a name for each row, one per line (a robot's
   * waypoints read "Home", "Pick", "Place" instead of 0, 1, 2). The Inspector edits the names beside the rows, keeps
   * them in sync when a row is added or removed, and shows them wherever another param points at this table
   * ({@link rowsOf}, a {@link program}'s `row` argument). Declare the named param `hidden`, since the table edits it.
   * The runtime values are unchanged: the rows stay numbers, the names stay a string. Ignored for other kinds.
   */
  rowNames?: string
  /**
   * For a `'numberList'` param: its rows are the steps of numbered programs, a short sequence per program (a robot's
   * jobs: move here, grip, wait, move there). Each row is `[program, op, ...args]`: which program the step belongs to
   * (0 for the first), which {@link ProgramSpec.ops} entry it is, then that op's arguments. Steps run in row order
   * within their program. The Inspector edits it as a list of programs, each a list of steps, instead of a grid, and
   * `ctx.params.x` is still the plain `number[][]`. {@link arity} must be 2 + the most arguments any op takes. Report
   * the row being run with `ctx.report(key, row)` (-1 when idle) and the Inspector highlights it while the scene runs.
   * Ignored for other kinds.
   */
  program?: ProgramSpec
  /**
   * For a `'color'` param: a list of colours, edited as a row of swatches with add and remove. The runtime value
   * stays a `string`, the `#rrggbb` values joined by commas (`''` = none), so a part that already split a
   * comma-separated string keeps reading it the same way. Ignored for other kinds.
   */
  list?: boolean
  /**
   * For a `'number'` param that is a bitmask: edit it as one checkbox per bit instead of a number to work out by
   * hand. Either the bit count, or the name of a `'number'` param holding it (a stack light's `bits: 'segments'`,
   * so the boxes follow its tier count). Bit 0 is the first box. The value stays the number. Ignored for other kinds.
   */
  bits?: number | string
  /**
   * For a `'string'` param: what the field offers as suggestions while typing. `'marks'` = the product marks the
   * scene knows, which are the product attributes its parts declare ({@link attribute}), so a sensor filtering on
   * a mark is set to one that exists (`'wrapped'`, not `'Wrapped'`). Any text is still accepted: a machine may
   * write a mark no part declares. Ignored for other kinds.
   */
  suggest?: 'marks'
  /**
   * For a `'string'` param: the value is a cargo part's package id (`'oip.tote'`), the product a spawner makes or a
   * sink counts. The Inspector offers the cargo parts the project can use, and the project holds a copy of the
   * part named, so the run can make it. `''` = none. Ignored for other kinds.
   */
  product?: boolean
  /**
   * For a {@link product} param: names a hidden `'string'` param that holds settings for the product, as JSON
   * (`{"size":"400x300x220"}`). The Inspector shows the chosen product's own params under it and edits them there,
   * and choosing another product clears them. Pass them on as `ctx.spawn({ part, params })`. Ignored otherwise.
   */
  settings?: string
  /**
   * For an `'INT'` / `'DINT'` `'tag'` param that carries a code: what each number means (a colour sensor's
   * `[{ value: 1, label: 'red' }, ...]`). The Inspector lists them on the field and the catalog prints them, so the
   * meaning is declared rather than squeezed into the label. The runtime value is unchanged. Ignored for other kinds.
   */
  values?: { value: number; label: string }[]
  /**
   * For a `'boolean'` param: this is the part's units switch, true = imperial (a conveyor's `fpmUnits`: its speed and
   * speed tag in feet per minute). It is the scene's choice, not the part's: the scene's Units (Scene Properties) set
   * it on every part placed and every part already there, carrying each value it switches between to its twin (two
   * `number` params shown on opposite sides of it with the same label; two `tag` params commanding such a pair through
   * {@link setpointFor}), and the Inspector never shows it. Pair it with {@link whenAbsent} so scenes saved before
   * the switch keep their old meaning. Ignored for other kinds.
   */
  imperialUnits?: boolean
  /**
   * The choices for an `'enum'` param. `value` is the stored string; `label` is the display text (defaults to
   * `value`). An option may carry `rows` - the `[number[]]` template stamped into the {@link stamps} target
   * when it's chosen (and matched against when drifting back). Ignored for non-`'enum'` params.
   */
  options?: { value: string; label?: string; rows?: number[][] }[]
  /**
   * For a `'color'` param: expose an alpha channel - the picker shows an A slider and the runtime value becomes
   * an 8-digit `#rrggbbaa`. Omit ⇒ opaque-only `#rrggbb` (the default). A part
   * reads the alpha off its own param string (e.g. a floor marking treats a fully-transparent band as "cut out,
   * show the floor through the gap"). Ignored for non-`'color'` params.
   */
  alpha?: boolean
  /**
   * For a `'tag'` param: which way the signal flows, from the part's perspective - `'in'` = the part reads
   * it (an attached program drives it), `'out'` = the part writes it (a program reads it).
   *
   * A `'tag'` param is this device's PLC interface: the part declares that it has a run input, and whoever
   * places it says which tag name that input is on. `dir` and {@link stType} give the direction and type in a
   * machine-readable form. The English `label` ("Run tag (belt runs while true)") is only for a human reading the
   * Inspector. Declared, the part's I/O surface can be listed
   * without running it (`npm run catalog`), the picker can offer only tags that fit, and a tool wiring a
   * scene can tell a command from a readback. Required on a `'tag'` param (with {@link stType}): a part that
   * leaves it out is refused at validation, since the wiring check could not see the signal at all. Optional in
   * the type only because this one interface describes every param kind; ignored for non-`'tag'` params.
   */
  dir?: 'in' | 'out'
  /**
   * For a `'tag'` param: the ST scalar type carried on the wire (named `stType` only because `type` already
   * names the param kind). A conveyor's `runTag` is `'BOOL'`, its speed tags `'REAL'` (m/s or feet per minute), a stack light's bitmask
   * `'INT'`, a spawner's running count `'DINT'` (a 32-bit integer, room for a count that runs for days).
   * Required with {@link dir} on a `'tag'` param. Ignored for non-`'tag'` params.
   */
  stType?: 'BOOL' | 'INT' | 'DINT' | 'REAL'
  /**
   * For a `'tag'` param: this tag commands the device - the script follows the auto-vs-hand convention
   * (`ctx.tagDriven(tag) ? readTag(tag) : manualLatch`), so while an attached program declares
   * the tag as an output, the program owns the device and hand presses are overridden. Declaring it lets the
   * host surface that ownership at the point of interaction (the pilot's "In auto - PLC controlled" prompt).
   * Leave it off for tags the device merely publishes (a button's press, a sensor's beam) or reads as an
   * indicator (a button's `lampTag`) - the PLC driving those never takes the device out of hand control.
   * Ignored for non-`'tag'` params.
   */
  autoWhenDriven?: boolean
  /**
   * For an `'in'` `'tag'` param: the script reads it only while a program drives it (`ctx.tagDriven(tag)`), and runs
   * on its own setting the rest of the time. A conveyor's run gate: `!ctx.tagDriven(runTag) || ctx.readTag(runTag)`,
   * so a belt with a run tag named and no program runs at its authored speed. Declaring it lets the wiring check say
   * so when the program does not drive the tag, instead of warning that the tag reads 0. Implied by
   * {@link autoWhenDriven}, which gates the same way and also takes the device out of hand control. Leave it off a
   * tag read whenever it names one (a setpoint, read as 0 until driven). Ignored for non-`'tag'` params.
   */
  onlyWhenDriven?: boolean
  /**
   * For a `'tag'` param that is an analog setpoint (a REAL the script reads instead of a value param,
   * `tag ? ctx.readNumber(tag) : ctx.params.speed`): the name of the param it replaces. A conveyor's
   * `speedTag` declares `setpointFor: 'speed'`.
   *
   * Without it the Inspector shows the authored number while the scene obeys a different one (a program commanding
   * 0.5 leaves the field reading 1; an unset tag reads 0). Declared, the host shows the live commanded value in
   * that field while the setpoint is in force, marked `plc` and read-only, and restores the authored value when it
   * isn't: the analog twin of {@link autoWhenDriven} for a boolean command tag.
   *
   * Must name a declared `'number'` param (validated at package build), and the setpoint must be in the same
   * units as it - that is what "replaces" means. Ignored for non-`'tag'` params.
   */
  setpointFor?: string
  /**
   * This param is a product attribute: a fact the product carries on down the line, not just a setting. On a cargo
   * part (a case, a pallet, a unit load) it is authored like any param, saved with the scene, and at Run it becomes
   * the product's mark of the same name, which machines update ({@link PartContext.mark}) and other parts read
   * ({@link PartContext.marked}, a beam's `marks`); the Inspector shows its live value while the scene runs. A
   * machine marking it with a value of another type is refused. Only `'boolean' | 'number' | 'string'` params can be
   * attributes. Omit ⇒ an ordinary param.
   */
  attribute?: boolean
  default: number | boolean | string | number[][]
  min?: number
  max?: number
  step?: number
  /**
   * For a `'number'` param: the unit the value is stored in, shown as a dim suffix inside the Inspector field
   * (`'m'`, `'m/s'`, `'kg'`, `'s'`, `'°'`). A field in a length or speed unit also accepts other units typed
   * into it and converts them (`5ft`, `5' 6"`, `600mm` into metres; `394 fpm` into m/s), and shows in the scene's
   * Units (Scene Properties: a metre field reads inches under imperial, an `'FPM'` one m/s under metric). That is
   * display only: the part always reads the value in the unit declared here. Omit it and a trailing
   * `(unit)` in the label is read as the unit instead (`label: 'Width (m)'` ⇒ `Width` with an `m` suffix), so
   * existing parts get suffixes without an edit. `'%'` is the one unit that also scales: the value is stored
   * as a fraction (0 to 1) and the field shows and takes it as a percentage (0.42 reads 42 %), so a part
   * keeps multiplying by the raw value.
   *
   * For a `'tag'` param: the unit of the value the tag carries (`'m/s'`, `'FPM'`, `'m'`, `'s'`), shown after its
   * type in the Inspector's badge (`READ REAL m/s`) and the Device Tags dialog, so a program declares and scales it
   * right. Put it here rather than in the label. The scene's Units never convert it: the program reads and writes
   * the value in this unit. A `setpointFor` tag that declares none takes its param's unit. Ignored for other kinds.
   */
  unit?: string
  label?: string
  /**
   * One-line explanation of what this param does, shown as the Inspector's hover tooltip under the label
   * (which is joined there with the range and default the host already knows). The place to say the thing a
   * label can't: what the value means in the part's local frame, what a toggle actually suppresses, which
   * sign convention runs which way.
   *
   * It lives on the param, next to the value it explains: a host table keyed by part type would go stale
   * silently. Authored here it cannot drift from the param, it ships inside the package, and a user-authored
   * part can carry one too.
   *
   * Keep it to a sentence, and don't restate the label - "Length (m)" gains nothing from "the length in
   * metres". Omit when the label already says everything.
   */
  desc?: string
  /**
   * Inspector group this param sits under - a collapsible section header.
   * Params with the same `group` string cluster together; `'A/B'` nests B inside A. Omit for a top-level field.
   * A part with many params (a belt's frame / guards / legs toggles) reads far better grouped than as a flat wall.
   */
  group?: string
  /**
   * Stored but not shown in the Inspector: the part's private state, resolved / defaulted / persisted like
   * any other param. For engine-owned facts the user must not hand-edit,
   * as opposed to {@link rest}, which the host writes but still exposes for pinning.
   *
   * The curved conveyor's `reverse` is the motivating case: a curve can't be rotated 180° to reverse its flow
   * (that would swap inner/outer radius), so the snap flips this flag when it mates two ends that both
   * discharge into the junction. It must not be the user-facing way to reverse a belt. That stays a negative
   * `speed`, which is why this is hidden rather than merely grouped away. Fold it into the effective speed in
   * `step()`, as the host does for its own conveyors.
   */
  hidden?: boolean
  /**
   * Make this param editable in the viewport: declare a gizmo bound to it. The
   * author states *where* the param is edited in the part's local frame; the engine renders the dot, runs the
   * drag, clamps to {@link min}/{@link max}, and commits to undo. A declaration the engine draws for you - the third
   * facet alongside `geometry()` and `step()`, held to the same curated, sandbox-safe, deterministic contract.
   * The handle kind is from a closed, growable set (add a kind engine-side when a real part needs one).
   * Omit for params edited only from the Inspector.
   */
  handle?: ParamHandle
  /**
   * Declares this (`number`) param a host-resolved placement fact (orthogonal to {@link handle} - that's a
   * viewport gizmo, this is a value the host computes). The host writes it at discrete placement events
   * (drop / snap), so `geometry()` stays a pure function of params and never touches the world. `'surfaceBelow'`
   * = the distance from the part's origin down to the nearest surface beneath it (the floor, or a platform on a
   * multi-level scene), so e.g. a conveyor's `standHeight` legs reach whatever they're standing on. Automatic by
   * default; the Inspector lets the user pin it to a deliberate value. A declarative, curated vocabulary - the
   * part never raycasts or queries the scene; novel facts are added here, not by handing the part a world handle.
   */
  rest?: 'surfaceBelow'
  /**
   * For an `'enum'` whose {@link options} carry `rows`: names the `'numberList'` param those rows are stamped
   * into when an option is chosen (e.g. `stamps: 'segments'` on a belt's `shapePreset`). The numberList stays
   * the source of truth - editing it afterwards drifts this enum to the option whose `rows` match, or to the
   * first option with no rows (the "custom" escape). A declarative one-tap template picker layered over the
   * list; the geometry never reads the enum. Ignored unless {@link type} is `'enum'`.
   */
  stamps?: string
  /**
   * Show this param in the Inspector only while the named switch param has the value `is` - for a part that offers
   * the same setting two ways and a switch between them (a conveyor's speed in metres per second, or in feet per
   * minute: one field of each, and only the one in use is on screen), or a part with modes whose fields differ.
   * The switch is a `'boolean'` param (`is: true` / `false`) or an `'enum'` param (`is: 'follow'`, or a list,
   * `is: ['position', 'follow']`, for a field several modes share). Presentation only: the param is stored,
   * defaulted and resolved exactly as if it were always shown, and `step()` reads whichever it needs; a tag param
   * it hides is not one of the part's signals while hidden, since the part does not read it.
   */
  visibleWhen?: { param: string; is: boolean | string | readonly string[] }
  /**
   * For a `'boolean'` param: the value a part takes when its saved params don't carry this key (a scene saved
   * before the param existed, or a part built in code that doesn't set it). {@link default} is what a newly placed
   * part gets. They differ exactly when a new switch changes what existing numbers mean: a conveyor
   * whose speed tag turns from m/s into feet per minute must stay in m/s for every scene already written, and
   * be in feet per minute for the next belt dropped. Omit it and an absent key takes {@link default}.
   */
  whenAbsent?: boolean
}

/**
 * The step vocabulary of a `'numberList'` param declared a {@link ParamSpec.program}: what each step can be, and what
 * it takes. The part's `step()` is what gives the ops meaning; this only tells the Inspector how to write them.
 */
export interface ProgramSpec {
  /** a `'string'` param holding each program's name, one per line (program 0 on the first). Declare it `hidden`. */
  names?: string
  /** the kinds of step, in the order the Inspector offers them. At least one. */
  ops: ProgramOp[]
}

/** One kind of program step. */
export interface ProgramOp {
  /** the number stored in the step's second column. Whole, and unique within the program. */
  code: number
  /** what the Inspector calls it ("Move", "Wait") */
  label: string
  /** a sentence on what the step does, shown as its tooltip */
  desc?: string
  /** what the step takes, stored in order from the third column. */
  args?: ProgramArg[]
}

/**
 * One argument of a program step, stored as a number.
 *   `row`    - a row of another `'numberList'` param (`of`), picked by its {@link ParamSpec.rowNames} name. An index that
 *              is no longer in the table is stored as -1 and shown as missing, never silently re-pointed.
 *   `number` - a value, with the same `unit` / `min` / `max` / `step` a `'number'` param takes.
 *   `choice` - one of a fixed set. An option may name a `'tag'` param (`param`), and the Inspector then shows the tag
 *              it is bound to beside the label ("Input 1 · Safe"), so a step reads as the signal it waits on.
 */
export type ProgramArg =
  | { kind: 'row'; of: string; label?: string }
  | { kind: 'number'; label?: string; unit?: string; min?: number; max?: number; step?: number; default?: number }
  | { kind: 'choice'; label?: string; options: { value: number; label: string; param?: string }[]; default?: number }

/**
 * One viewport handle bound to a param ({@link ParamSpec.handle}) - a {kind, placement} the engine knows how
 * to render and drag.
 */
export type ParamHandle =
  /** ± dot on a part face → drags a scalar `number` along that axis (opposite face stays fixed). `sign`
   *  restricts it to one face (e.g. only the +Y top); omitted = both faces.
   *  The spur marker: on a conveying part's length (axis:'x') handle, `angleFrontParam`/`angleBackParam` name
   *  sibling `number` params holding each end face's splay angle (degrees about +Y). Declaring either makes the
   *  host treat the part as a spur (centre-origin parallelogram bed: front face x = +L/2 + tan(front)·z, back face
   *  x = −L/2 + tan(back)·z) and derive the two angled snap ends, the parallelogram footprint/collision deck, the
   *  opening the merge cuts in the host's guard, and the rail/guard extents it folds into a declared
   *  `guardExtents` param (see the part authoring guide). `sideGap` is the clearance (m) kept off the host's
   *  bed edge when side-merging, default 2×frame-flange (0.04). Override only for hardware protruding past the
   *  mated face, and keep it well under the resolvers' 0.15 contact tolerance. The gap uses up part of that tolerance,
   *  and with a large one a small nudge makes the merge silently lose both the host guard opening and the rail extents.
   *  Bay snap: `bayParam` names a sibling `number` param holding the bay pitch; the drag locks this face's
   *  extent to whole multiples of it (≥ one bay), e.g. the storage rack's per-cell resize. `bayGateParam` names a
   *  boolean param that must be true for the snap to apply (omitted = always on), e.g. the rack's
   *  `enableAutoPoles`. Clamped to the param's min/max. */
  | { kind: 'face'; axis: 'x' | 'y' | 'z'; sign?: 1 | -1; angleFrontParam?: string; angleBackParam?: string; sideGap?: number; bayParam?: string; bayGateParam?: string }
  /** a `numberList` of `[length, tilt]` rows rendered as a tail dot + one node per row - the multi-segment
   *  belt/path handle. `lengthCol`/`tiltCol` name the columns (default 0/1). Declaring it makes the host treat
   *  the part as a belt-like conveyor, and the sibling params it names feed everything the host derives from
   *  the belt path (deck body, snap ends, footprint, guard walls): `widthParam`/`heightParam` name the belt's
   *  cross-width and belt-surface-height params (defaults `'width'`/`'height'`), and
   *  `leftGuardParam`/`rightGuardParam` name the boolean side-guard toggles whose walls the host builds
   *  path-aware (defaults `'leftGuard'`/`'rightGuard'`; a missing param reads as guarded). The authored
   *  side-guard openings always live in the canonical `guardOpenings` param (a first-class param kind). */
  | { kind: 'path'; lengthCol?: number; tiltCol?: number; widthParam?: string; heightParam?: string; leftGuardParam?: string; rightGuardParam?: string }
  /** the curved-conveyor marker: this (`number`) param holds the sweep angle (degrees) of a horizontal arc,
   *  and `innerRadiusParam`/`widthParam` name the sibling params that give the arc's inner radius + belt width
   *  (defaults `'innerRadius'`/`'width'`). Declaring it makes the host treat the part as a curved conveyor -
   *  it derives the two arc ends (SDK convention: entry on local +X, sweeping toward −Z) so the curve
   *  butt-snaps to any conveyor, an arc footprint for selection/broadphase, and the in-viewport arc resize
   *  gizmo (an 'angle' dot on the arc end dragging sweep, a 'width' dot on the outer rim dragging width).
   *  `innerGuardParam`/`outerGuardParam` name the boolean side-guard toggles whose banked walls the host
   *  builds along the arc (defaults `'innerGuard'`/`'outerGuard'`; a missing param reads as guarded).
   *  `endGap` is the straight tangent lead-in/out (metres) the snap ends extend past the arc. It should match
   *  the stub the geometry draws so neighbours butt flush. Default (omitted) is the belt half-pulley
   *  (BELT_HEIGHT/2 = 0.085); a curved roller bed sets ≈0.002 to butt nearly flush like the built-in.
   *  `endGapParam` makes it track a param instead (`params[param] × scale + add`): a curved belt whose end drums
   *  follow its Frame height sets `{ param: 'height', scale: 0.5 }`, the drum radius, so it butts a straight belt
   *  of the same height flush. `endGap` stands while the param is missing or non-numeric. */
  | { kind: 'arc'; innerRadiusParam?: string; widthParam?: string; innerGuardParam?: string; outerGuardParam?: string; endGap?: number; endGapParam?: { param: string; scale?: number; add?: number } }
  /** a scalar size dragged on a rig link's frame: the six-axis robot's EOAT resize (the tool-size
   *  handles). An orange dot sits on the named link's local `axis` at `value/2` (so it follows the
   *  posed arm, unlike a `face` dot on the static footprint); dragging projects the pointer onto that axis
   *  and writes back `2·|distance|`, clamped to the param's min/max. When an `'x'` and a `'z'` handle share
   *  the link, the host also draws the tool's outline rectangle between them. `frameY` drops the handle
   *  plane below the link origin (the EOAT frame sits at −0.075). Rig parts only; ignored elsewhere. */
  | { kind: 'rigSize'; link: string; axis: 'x' | 'z'; frameY?: number }
  /** the flex-conveyor path: this `numberList` param holds [x, z] control points (part-local, the last one the
   *  discharge end) of a bed built as `sections` equal sections hinged end to end, running from the part origin
   *  (its infeed, heading local +X) along a smooth curve through the points with equal chords;
   *  `lengthParam` names the `number` param holding the resulting bed length. The host draws a dot on every point
   *  and on the infeed: dragging a point writes the points and the length together, dragging the infeed moves the
   *  part with the points held. A drag needing a length outside that param's range, or a hinge sharper than
   *  `maxHingeDeg`, stops at that limit. The drag is authoring: one undo step.
   *  In walk mode the character pulls it by hand: an end dragged past what the bed can stretch or bend draws the
   *  whole unit after it, as a flex rolls on its casters. `infeedBrakeParam` / `dischargeBrakeParam` name
   *  `boolean` params for that end's caster brakes: a braked end cannot be taken hold of or drawn along (authoring
   *  drags ignore them).
   *  `scissor` says the bed is a scissor bed of `rollers` rollers a section, `widthParam` wide: a bend closes the
   *  rollers on the inside of the curve and opens them on the outside, within the length param's range (fully
   *  collapsed to fully extended). So a hinge bends not at all at either extreme, most at mid-stretch, less on a
   *  wider bed. The host draws each section's rollers fanned across it, and every pull stops at this limit. */
  | {
      kind: 'flexPath'
      lengthParam: string
      sections: number
      maxHingeDeg?: number
      infeedBrakeParam?: string
      dischargeBrakeParam?: string
      scissor?: { widthParam: string; rollers: number }
    }

export type ParamSchema = Record<string, ParamSpec>
export type ParamValue = number | boolean | string | number[][]

/** The runtime value type a single ParamSpec resolves to (`'number'` → `number`, etc.). */
export type ParamValueOf<S extends ParamSpec> = S['type'] extends 'number'
  ? number
  : S['type'] extends 'boolean'
    ? boolean
    : S['type'] extends 'string' | 'tag' | 'color' | 'enum' | 'partRef'
      ? string
      : S['type'] extends 'numberList'
        ? readonly number[][]
        : ParamValue

/**
 * The typed `ctx.params` bag derived from a part's schema. Because `definePart` infers the schema as a
 * `const`, `ParamsOf<{ speed: { type: 'number' } }>` gives `{ readonly speed: number }` - so authors get
 * `ctx.params.speed` typed as `number`, not the loose `ParamValue` union.
 */
export type ParamsOf<P extends ParamSchema> = { readonly [K in keyof P]: ParamValueOf<P[K]> }

/** A servo's state, PLCopen's single-axis states. */
export type ServoState = 'disabled' | 'standstill' | 'homing' | 'discrete' | 'continuous' | 'stopping' | 'errorStop'

/** The dynamics of one move, in the joint's unit per second (and per second squared). Accel / decel default to the
 *  servo's caps; anything above a cap is held to it. */
export interface ServoMove {
  velocity: number
  accel?: number
  decel?: number
  /** wait for the command ahead to finish instead of replacing it (PLCopen Buffered): the move queues while the servo
   *  is busy, `queued(id)` reads true until its turn, and it starts where the one ahead stops */
  buffered?: boolean
}

/**
 * One servo axis (a rig joint the manifest marks `servo`). It starts unpowered, as a real drive does: `power(true)`
 * before it will move. Every command returns the id of the command it started (> 0), or, when the servo refuses
 * it, a negative error code: -1 not powered, -2 in ErrorStop (reset first), -3 a stop is held, -4 a target that is
 * not a number, -5 bad velocity / accel / decel, -7 still moving (reset, home). A command replaces the one before it
 * (a new target mid-move blends in from the current velocity); `done(id)` / `aborted(id)` say how a command you
 * started ended (a PLC motion block's Done / CommandAborted pair).
 *
 * The joint's limits are software limits, as on a real drive: a target past one is accepted, and when the servo
 * could not otherwise stop before it, it brakes to rest at or short of the limit and goes to ErrorStop (`error` 6);
 * `reset()` once still. Every move is a trapezoid (constant acceleration, cruise, constant deceleration), the
 * motion kernel's documented rule.
 *
 * The servos move after `step()`, so what a step reads (`position`, `velocity`, `inPosition`) is where the axis
 * stood when the tick began, one tick behind a command it sends, as a real drive's feedback lags a cycle. Compare
 * a follow setpoint with the one you sent last tick.
 */
export interface Servo {
  /** position, the joint's unit; a wrapping (modulo) servo reports it in [0, modulo) */
  readonly position: number
  readonly velocity: number
  readonly state: ServoState
  readonly powered: boolean
  readonly homed: boolean
  /** why the servo is in ErrorStop (6 = it reached a joint limit while running at a velocity); 0 otherwise */
  readonly error: number
  /** still, and at the position it was last sent to */
  readonly inPosition: boolean
  /** enable or disable the drive; disabling stops the axis where it is */
  power(on: boolean): void
  /** move to `position` and stop there. A wrapping servo goes the `direction` way round (shortest by default). */
  moveAbsolute(position: number, move: ServoMove & { direction?: 'shortest' | 'positive' | 'negative' | 'current' }): number
  /** move by `distance` from where the axis is now */
  moveRelative(distance: number, move: ServoMove): number
  /** run at a signed `velocity` until told otherwise; done once at that velocity */
  moveVelocity(velocity: number, move?: { accel?: number; decel?: number; buffered?: boolean }): number
  /** track a setpoint you send every tick (a drive fed by an external motion controller), capped at the max velocity */
  follow(setpoint: number): number
  /** brake to a stop and stay commandable */
  halt(decel?: number): number
  /** brake to a stop and refuse motion until {@link releaseStop} */
  stop(decel?: number): number
  releaseStop(): void
  /** leave ErrorStop, once still */
  reset(): number
  /** declare where the axis is now (`position`, default 0) and mark it homed */
  home(position?: number): number
  done(id: number): boolean
  aborted(id: number): boolean
  /** a buffered command still waiting its turn */
  queued(id: number): boolean
}

/**
 * Everything a part script is handed each tick.
 * Generic over the part's param schema `P` so `params` is strongly typed; defaults to the loose schema
 * for paramless parts and for the runtime, which is schema-agnostic.
 */
/** Which cargo in a zone {@link PartContext.zone} counts: one product (a cargo part's package id) or one kind. */
export interface ZoneFilter {
  part?: string
  kind?: 'box' | 'pallet' | 'tote'
}

export interface PartContext<P extends ParamSchema = ParamSchema, J extends string = string, G extends string = string, L extends string = string, S extends string = string> {
  /** fixed timestep in seconds (constant - the sim never varies it) */
  readonly dt: number
  /** simulated seconds elapsed (not wall-clock), deterministic */
  readonly simTime: number
  /** exported params, resolved from the schema defaults + the instance's overrides */
  readonly params: ParamsOf<P>
  /** the part's origin in world space */
  readonly position: Readonly<Vec3>
  /** the part's local +X (flow) axis in world space */
  readonly forward: Readonly<Vec3>
  /** deterministic PRNG in [0, 1), seeded from the instance's resolved params - so two instances with identical
   *  params draw identical streams (a fresh run reproduces them exactly). To decorrelate them, give the part a
   *  `seed` number param and set it differently per instance. Never use Math.random in a part. */
  rng(): number
  /**
   * Step `current` toward `target` by at most `maxDelta`, never overshooting - the rate-limited-motion
   * primitive (a lift easing to height, a gate slewing open, a velocity ramp). Returns the new value: if
   * `target` is within `maxDelta` it snaps exactly to `target`, otherwise it moves `maxDelta` (its magnitude)
   * in `target`'s direction. Replaces the hand-rolled `x < t ? Math.min(t, x+step) : Math.max(t, x-step)` -
   * the clamp that's easy to get wrong (overshoot, a sign slip that oscillates). Pure + deterministic; a
   * non-finite argument returns `current` unchanged. Call every tick with `maxDelta = rate * ctx.dt`.
   */
  approach(current: number, target: number, maxDelta: number): number
  /**
   * {@link approach} for angles: step `current` toward `target` (radians) along the shortest arc by at most
   * `maxDelta`, snapping onto the target once within reach - so a heading/turret slew never takes the long
   * way round or oscillates across the ±π wrap. Returns the new angle, continuous with `current` (not
   * re-wrapped). Pure + deterministic; call every tick with `maxDelta = rate * ctx.dt`.
   */
  approachAngle(current: number, target: number, maxDelta: number): number
  /**
   * Coordinated {@link approach} over a joint vector: step every element of `current` toward `target` so
   * they all arrive together. The dominant (largest-remaining) element moves by at most `maxDelta` and the
   * others scale proportionally, which keeps a multi-joint move straight in joint space instead of each
   * axis finishing on its own schedule. Returns the new vector (same length as `current`; an element whose
   * pair is missing/non-finite is left unchanged). The constant-rate core of a robot move - layer your own
   * accel profile on `maxDelta` if you need trapezoidal easing. Call every tick with `maxDelta = rate * ctx.dt`.
   */
  approachVec(current: readonly number[], target: readonly number[], maxDelta: number): number[]
  /**
   * Signed shortest rotation from angle `from` to angle `to`, radians in (−π, π] - the wrap-safe angular
   * difference (replaces the hand-rolled `atan2(sin(b−a), cos(b−a))`). Feed it to a turn-rate clamp, or use
   * {@link approachAngle} directly.
   */
  angleDelta(from: number, to: number): number
  /** Clamp `v` into [lo, hi] - the one-liner every motion script otherwise re-declares. Pure; NaN returns `lo`. */
  clamp(v: number, lo: number, hi: number): number
  /**
   * The part's current yaw (radians): the angle of {@link forward} in the world XZ plane -
   * `atan2(−forward.z, forward.x)`, so 0 faces world +X and positive turns left (counter-clockwise seen from
   * above), matching {@link drive}'s `turn` sign. The −z convention is the one yaw gotcha every mobile part
   * hits; read it from here instead of re-deriving it.
   */
  heading(): number
  /**
   * Compute drive commands that close on a world point - the go-to-waypoint primitive for mobile parts.
   * Turns toward the target's bearing at up to `turnRate` (rad/s) and drives forward at up to `speed` (m/s),
   * scaled by facing alignment (`max(0, cos(error))`: facing away = turn in place, aligned = full speed) and
   * capped so a tick never overshoots the point. Returns `{ forward, turn, distance }` - feed the first two
   * straight to {@link drive}, use `distance` for your arrival test. Pure: it reads the live pose
   * ({@link position}/{@link forward}/{@link dt}) but commands nothing, so the choreography (when to stop,
   * final heading, dwell) stays yours. Non-finite inputs command a stop.
   */
  steer(target: { x: number; z: number }, opts: { speed: number; turnRate: number }): { forward: number; turn: number; distance: number }
  /** Drive cargo resting on the part's surface (m/s, world space) - the conveyor primitive.
   *  Declare the param that feeds it as the manifest's `conveyor.speedParam` (m/s, negative = reverse): the host
   *  reads that param for everything it mirrors outside the behavior tick - the belt scroll / roller spin
   *  visuals, the pilot's surface carry, and the pre-first-tick seed of the spawner interlock
   *  (`conveyorRunning`) - so a conveying part that declares none still conveys, but idles those mirrors until
   *  its first tick. */
  setSurfaceVelocity(v: Vec3): void
  /**
   * Drive cargo around an arc instead of in a straight line - the curved-conveyor primitive. The part's
   * conveying decks become a rotational surface-velocity field: cargo at world point `p` is carried tangentially
   * at `omega × (p − center)`, so it sweeps around the arc `center` (world X/Z) at angular rate `omega` (rad/s,
   * + = counter-clockwise seen from above). Compute `center` from {@link position}/{@link forward} + your arc
   * geometry, and `omega = speed / radius`. Overrides {@link setSurfaceVelocity} for this tick when both are set.
   * Command it every tick like the linear velocity. (A curved belt/roller uses this; the turntable instead
   * rotates a kinematic deck, which carries cargo by friction - no arc velocity needed.)
   */
  setArcSurfaceVelocity(opts: { center: { x: number; z: number }; omega: number }): void
  /**
   * Drive every conveying deck along its own local +X at `speed` (m/s, negative runs it back) - the
   * articulated-conveyor primitive. Where {@link setSurfaceVelocity} gives the whole part one world velocity and
   * {@link setArcSurfaceVelocity} one rotation, this lets a bed built from hinged sections (a flex conveyor, a
   * snaking accordion) carry product along each section's direction, whatever shape its joints put it in: the
   * host re-reads each deck's orientation every tick. Author each `conveys` link with its flow along local +X.
   * Pass an array to run each deck at its own speed, in the order the rig declares its `conveys` links (a missing
   * entry stands still): the zones of an accumulating bed, each stopping on its own photo-eye. A spawner interlocked
   * on the part (`ctx.conveyorRunning`) then reads the first deck, the infeed.
   * Overrides {@link setSurfaceVelocity} for this tick when both are set; an arc overrides it.
   *
   * With a `link`, it runs the copies of a posable conveying array (`conveys` + `array.posable`: a cross-belt
   * sorter's carriers) instead: copy `index` at `speed` along its own local +X, or every copy when `index` is left
   * out. Each copy is a deck of its own that rides where {@link setSubPose} puts it, and cargo on it moves with the
   * copy and along its belt. A copy not given a speed this tick stands still, and the part-wide surface commands
   * never run these copies. An index outside the row is ignored.
   */
  setSurfaceSpeed(speed: number | readonly number[], link?: string, index?: number): void
  /**
   * Drive the part's base - the mobility primitive (AGVs, mobile robots). `forward` is the speed (m/s) along
   * the part's current facing (its local +X), `turn` is the yaw rate (rad/s, + turns left). The host integrates
   * it into the part's live root pose each tick; read the live pose back via {@link position} / {@link forward}
   * to steer toward a waypoint. Only the runtime pose moves (the saved scene pose is unchanged, like a joint
   * command). Deterministic - command it every tick from your navigation logic.
   */
  drive(forward: number, turn: number): void
  /**
   * Command a named rig joint each tick - the articulation primitive for multi-body parts (robots,
   * gates, AGVs). `value` is a revolute joint's angle in radians or a prismatic joint's extension in
   * metres; the host clamps it to the joint's declared limits and moves the link kinematically (real
   * manipulators are position-commanded, not physics-flopped). Joints are declared in the package's rig
   * geometry; setting an unknown name is ignored. Write-only and deterministic: command the pose every
   * tick (e.g. from `simTime`/`params`), don't read it back.
   */
  setJoint(name: string, value: number): void
  /**
   * Open/close a gripper to carry cargo - the manipulator primitive. `gripper` is a rig link name; when
   * closing (`on=true`) the host attaches the nearest cargo within reach of that link and the cargo moves
   * with it rigidly, opening (`on=false`) drops it. Choreograph pick-and-place open-loop: command the joints to
   * the pickup pose, `setGrip(true)`, move to the drop pose, `setGrip(false)`. Deterministic; command it
   * every tick like the joints. Setting it on a non-gripper/unknown link is a no-op.
   *
   * With `index`, copy `index` of a posable array link grips on its own, from where that copy stands (its `grip`
   * volume is the link's), and holds and reports under the name `link#index`: `ctx.measured.grips['p#3']`. A row of
   * magazine positions, each holding the pallet it stands under. An index outside the row is ignored.
   */
  setGrip(gripper: string, on: boolean, index?: number): void
  /**
   * Pose a rig link freely each tick, in all six degrees of freedom, for motion a single revolute/prismatic
   * joint can't express (an end-effector tracing a path, a platform tilting on two axes). `position` is
   * the link's local offset from its parent (metres), `rotation` is its local Euler XYZ (radians); either
   * omitted keeps the rest value. `quat` ([x, y, z, w], normalised by the host) gives the rotation as a
   * quaternion instead, and wins over `rotation`: for an orientation built from turns about moving axes, such as
   * a tray that tilts about its direction of travel while following a curve, compose the turns as quaternions
   * rather than finding the Euler angles. Overrides the link's joint/rest transform for this tick - command it
   * every tick. Deterministic. Setting an unknown link is ignored.
   *
   * With `index`, it poses one instance of a posable array link (`array.posable`): instance `index` of
   * {@link arrayCount}, placed as the pose would place the link itself (in its parent's frame), its body and every
   * `geometry()` submesh attached to the link moving with it. An instance not posed this tick stands at its rest
   * place in the row. An index outside the row, or a link that is not a posable array, is ignored. A sorter's slats
   * round a chain: `for (let i = 0; i < n; i++) ctx.setSubPose('slat', { position: [x, y, 0], rotation: [0, 0, turn] }, i)`.
   */
  setSubPose(link: string, pose: { position?: [number, number, number]; rotation?: [number, number, number]; quat?: [number, number, number, number] }, index?: number): void
  /**
   * How many instances a posable array link (`array.posable`) has for this part's params, the count its
   * {@link setSubPose} index runs over. A `pitch` array's count follows its span param: a longer sorter has more
   * slats. Fixed for the run (a param edit rebuilds the part). 0 for a link that is not a posable array.
   */
  arrayCount(link: string): number
  /**
   * The part's joints as a typed property bag - the primary articulation idiom. Declare joint names in
   * `definePart({ joints: [...] })` and they autocomplete here, fully type-checked: `ctx.joints.shoulder =
   * angle` commands the joint, and reading `ctx.joints.shoulder` returns its last-commanded position
   * (declared joints start at 0). A typo is a compile error, not a silent no-op. Command every tick.
   *
   * Same command as {@link setJoint}, which is the spelling for a computed name: with joints declared,
   * `ctx.joints['h' + i]` is a type error (a string is not one of the declared names), so a loop over
   * numbered joints writes `ctx.setJoint('h' + i, v)`. A fixed name reads better as the bag.
   */
  joints: Record<J, number>
  /**
   * Host-applied joint feedback: the closed-loop read half of {@link joints}. Where the command bag reports what
   * you last commanded, `ctx.measured.joints.shoulder` reports what the host applied after clamping to the joint's
   * declared limits, as of the previous tick (a begin-of-tick snapshot, identical for every part, so reads stay
   * deterministic + order-independent). Use it to tell a joint drove into its limit (`commanded ≠ measured`) or to
   * gate a position-reached check. Read-only; declared joints start at 0, and the first tick reads 0. Today it is
   * the clamped command (for a kinematic joint, its position); richer feedback can refine it in this shape.
   *
   * `measured.grips.<name>` is the matching feedback for {@link grips}: `true` only when the gripper is actually
   * carrying cargo, as of the previous tick (closing over empty space: `grips.hand === true`,
   * `measured.grips.hand === false`). Use it to confirm a pick before moving to the drop pose. Read-only;
   * declared grippers start `false`.
   */
  readonly measured: { readonly joints: Record<J, number>; readonly grips: Record<G, boolean> }
  /**
   * The part's grippers as a typed property bag - see {@link joints}. Declare names in
   * `definePart({ grippers: [...] })`; `ctx.grips.hand = true` closes (carry), `false` opens (drop), and
   * reading returns the last-commanded state (declared grippers start open / `false`). Same command as
   * {@link setGrip}, the spelling for a computed name (see {@link joints}).
   */
  grips: Record<G, boolean>
  /**
   * Light a lamp on/off - the indicator/beacon primitive (stack lights, status lamps). `name` is a lamp the rig
   * declares: an entry of a link's `lamps` (named, else the link's name), or of a drawn submesh's `lamps`. `on=true`
   * lights it (full emissive at that lamp's colour), `false` darkens it. Render-only (no physics), but deterministic
   * and commanded every tick like the joints, so the lit state reaches the visual with the sim frame. An unknown name is
   * a no-op (and reported).
   */
  setEmissive(name: string, on: boolean): void
  /**
   * The part's emissive lamps as a typed property bag - see {@link joints}. Declare names in
   * `definePart({ lamps: [...] })`; `ctx.lamps.red = true` lights it, `false` darkens it; reading returns the
   * last-commanded state (declared lamps start off / `false`). Same command as {@link setEmissive}, the
   * spelling for a computed name (see {@link joints}).
   */
  lamps: Record<L, boolean>
  /**
   * The part's servo axes as a typed bag, one {@link Servo} handle per joint the manifest marks `servo`. Declare
   * names in `definePart({ servos: [...] })`. A servo is not posed by the behavior: the part sends it commands
   * (power it, move it to a position, run it at a velocity, halt it) and the host runs the motion profile, inside
   * the joint's limits and the servo's caps, on every tick. Units are the joint's own: metres for a prismatic
   * joint, radians for a revolute one. {@link servo} is the spelling for a computed name.
   */
  readonly servos: Readonly<Record<S, Servo>>
  /** The {@link Servo} named `name` (a computed name: `ctx.servo('axis' + i)`), or undefined if the rig has none. */
  servo(name: string): Servo | undefined
  readonly robot?: RobotController
  /**
   * Read a sensor beam's nearest cargo hit this tick - the world-sensing primitive (photoeyes, color/laser
   * sensors). `beam` is a rig link name that declares a `beam` in the geometry; the host casts it against
   * cargo each tick and hands back `{ hit, distance, color }`: `hit` = something is in the beam, `distance` =
   * metres to it (the beam range when clear), `color` = its [r,g,b] tint (classify it for a colour sensor).
   * Deterministic; drive a PLC tag from it (`writeTag`). An unknown beam reads as clear. Each call returns a
   * fresh copy, so writing into the result changes nothing outside your part. `marks` is what machines upstream
   * left on the cargo it hit ({@link mark}), present when there is any: a scanner reads a label, a check reads
   * "wrapped". A beam also sees the walking pilot, as a real photo-eye sees a person, and a box the pilot carries.
   */
  sense(beam: string): { hit: boolean; distance: number; color: [number, number, number]; marks?: Readonly<Record<string, number | boolean | string>> }
  /**
   * Read a load cell: the weight resting on a `loadCell` link this tick, in kg (the vertical force through the
   * platform over g). The host measures it from the physics, not from what the cargo says it weighs: every body
   * touching the link's top and everything stacked on it, at its own mass and with its vertical acceleration, so a
   * case dropping onto the platform or a lift starting up reads high for a moment, as a real scale does. A load on the
   * platform alone counts in full, even hanging past its edge; one that also rests on something else (a case still
   * crossing onto it, a pallet bridging two scales) is shared by where its centre of gravity falls between the two.
   * Filtering, settling and tare are the machine's job, as on a real checkweigher: read it while one case
   * is fully on and the reading is steady. An unknown link reads 0.
   */
  weight(link: string): number
  /** read a BOOL PLC tag (device I/O bus); a numeric tag reads as `!== 0`, an absent tag as false */
  readTag(name: string): boolean
  /**
   * Is `name` currently driven by a controller - declared as an output of the attached PLC program (or, later,
   * a real PLC over the wire)? The output-ownership primitive: a controller in RUN owns the outputs it declares;
   * everything else is hand-operable. Gate a device's automatic mode on it -
   * `tagDriven(tag) ? readTag(tag) : manual` - so the device answers the program while one is
   * scanning and answers the operator (ctx.used()) when none is: sim stopped, no program attached, or the tag
   * isn't a program output. False whenever readTag would be reading nobody's value. Deterministic; changes
   * only on program attach/detach, never mid-scan.
   */
  tagDriven(name: string): boolean
  /** write a BOOL PLC tag (device I/O bus) - a signal the PLC program can read as an input */
  writeTag(name: string, value: boolean): void
  /** read a numeric PLC tag (INT/REAL) - e.g. a commanded setpoint or selector; absent reads as 0 */
  readNumber(name: string): number
  /** write a numeric PLC tag (INT/REAL) - e.g. a position/count feedback the PLC program reads */
  writeNumber(name: string, value: number): void
  /**
   * Report the effective value your part is using for one of its own params - `param` is a param name, not
   * a tag (no scoping, nothing is written to the PLC). Call it with the number you actually act on:
   *
   * ```js
   * const eff = (running ? commanded : 0) * (ctx.params.reverse ? -1 : 1)
   * ctx.report('speed', eff)
   * ctx.setSurfaceVelocity({ x: ctx.forward.x * eff, y: 0, z: ctx.forward.z * eff })
   * ```
   *
   * The Inspector shows this instead of the authored param while the param is tag-owned (see
   * {@link ParamSpec.setpointFor}), so the readout is the number your `step` computed, including what the tag
   * alone doesn't explain (a `runTag` gating to 0, a `reverse` flip, a ramp, a clamp). Declaring `setpointFor`
   * requires a matching `report` (checked at package build).
   *
   * Reporting a param that isn't tag-owned is harmless and changes no UI: the Inspector still shows the authored value.
   */
  report(param: string, value: number | boolean): void
  /**
   * Publish a named value for this part to show - the readout primitive. `name` is a display name of your
   * choosing (not a param, not a tag: nothing is written to the PLC and no Inspector field changes), read by
   * a `label` link's `textFrom` to give the part a live caption:
   *
   * ```js
   * made += ctx.zone('exit')                 // what the sim actually measured this tick
   * ctx.display('count', made)                // → the plate on the machine now reads the total
   * ctx.display('status', faulted ? 'FAULT' : 'READY')
   * ```
   *
   * Publish from the same expression that acts on the value, as with {@link report}: the plate must show the
   * number the deterministic step computed, never a host-side re-read of the tag a tick apart from it.
   *
   * A name nothing publishes renders blank, not zero (an unbound tag must look unbound). Values persist only for
   * the tick they were published, so a display you stop publishing goes blank, like a device losing its feed.
   * Strings are allowed here (unlike a tag) because a display is shown on the part and never sent to a PLC.
   */
  display(name: string, value: number | boolean | string): void
  /**
   * True for the single tick a BOOL tag goes **false → true** - the rising-edge primitive. The decoupled
   * "notify me when X happens" you'd reach an observer/signal for, except it stays a synchronous poll: the
   * host gives every part the same begin-of-tick tag snapshot, so the edge is computed against the previous
   * tick's value and reads identically regardless of part order - no callbacks, no determinism hazard.
   * Use it to handle an event once (latch a command, pulse a counter, accept a handshake's execute) instead
   * of stashing a `prev` flag and diffing it by hand - the pattern that silently drops edges over the async
   * tag bus. A numeric tag counts as the boolean `!== 0`; an absent tag is `false`, so a tag that is already
   * true on the first tick reads as a rising edge (initial state is treated as `false`).
   */
  rising(name: string): boolean
  /** True for the single tick a BOOL tag goes **true → false** - the falling-edge twin of {@link rising}
   *  (e.g. react to a button release or a beam clearing). Same begin-of-tick snapshot semantics. */
  falling(name: string): boolean
  /**
   * Spawn cargo - the producer primitive (spawners). `opts.part` names the product: a cargo part's package id (from a
   * {@link ParamSpec.product} param), and the spawned body is that part, as if placed: its size, mass, colour,
   * physics and product attributes come from the part's definition, with `params` overriding the part's own (only
   * params it declares, of their declared type). `color` and `mass`, when given, override the part's. A unit load
   * product cannot be spawned yet; a part that is not cargo, or is not in the project, spawns nothing and is reported
   * on the spawner.
   *
   * `marks` are facts the item starts its life with, as if a machine had already left them ({@link mark}): the code
   * printed on its label, its destination. A product's own attributes start the same way, and a mark of one of them
   * must have its declared type.
   *
   * Without `part`, the older form: `kind` `'box'` (default), `'pallet'` (a four-way
   * block pallet with its own friction) or `'tote'` (an open-top plastic container with its own friction, which cargo can ride in), `size`
   * [w, h, d] (box default 0.6×0.4×0.4; for a pallet only the footprint counts: it is snapped to a standard one within
   * 6 mm, every pallet is 0.135 tall, default 48 x 40 in, 1.22×1.02; a tote is snapped to a standard size within 6 mm,
   * default 0.6×0.32×0.4),
   * `color` [r, g, b] 0..1 (default white), `mass` kg, `offset` from the part origin in the part's local frame (so a spawner
   * drops cargo below/ahead of itself). The host creates a dynamic body at the part's pose + offset when the
   * sim runs; call it when your rate timer fires. Deterministic. Spawned cargo stays until something removes it
   * ({@link despawn}, or falling out of the world) or the run stops, so a line with no outlet piles up the way a
   * real one would. The one limit is the physics engine's body table, 10,240 bodies in total: past it a spawn is
   * skipped.
   */
  spawn(opts?: {
    part?: string
    params?: Record<string, number | boolean | string>
    kind?: 'box' | 'pallet' | 'tote'
    size?: [number, number, number]
    color?: [number, number, number]
    mass?: number
    offset?: [number, number, number]
    marks?: Record<string, number | boolean | string>
  }): void
  /**
   * Count the cargo currently inside a detection/removal zone - the sink primitive (despawners, exits, counts).
   * `zone` is a rig link name that declares a `zone` box in the geometry; the host counts cargo whose centre is
   * inside it this tick, never the pilot and never a box the pilot is carrying. Read-only + deterministic. Tally throughput from it, then call {@link despawn} to clear
   * the counted cargo. An unknown zone reads 0.
   *
   * `filter` counts only some of it: `{ part: 'oip.tote' }` the cargo that is that product (a placed part of it, or
   * one spawned as it), `{ kind: 'tote' }` the cargo of that kind. A tote carrying a case is two bodies in the zone,
   * so a sink that counts totes passes `{ part }` and still despawns everything.
   */
  zone(zone: string, filter?: ZoneFilter): number
  /**
   * The summed age of the cargo {@link zone} counted this tick: for each item, the sim seconds since it came
   * into being (spawned, or placed in the scene when the run started), added up. Divide a running sum by a
   * running count and you have the line's average cycle time at this exit:
   *
   * ```js
   * const n = ctx.zone('mouth')
   * if (n > 0) { done += n; ageSum += ctx.zoneAge('mouth'); ctx.despawn('mouth') }
   * ctx.display('cycle', done > 0 ? ageSum / done : 0)
   * ```
   *
   * A sum rather than a list so the call allocates nothing. Sim time, so it is deterministic and holds at any
   * speed multiplier. An unknown or empty zone reads 0.
   */
  zoneAge(zone: string, filter?: ZoneFilter): number
  /**
   * Remove the cargo currently inside a zone - the sink effect. `zone` is the same rig link name as
   * {@link zone}; the host deletes the cargo whose centre is inside it after this tick. Call it (optionally
   * gated by a tag) once you've counted the exits; pair with {@link zone} to report throughput.
   *
   * For sinks only: every item removed counts as one that left the line (the world's completed count, throughput
   * and cycle time). A machine that stores cargo and gives it back (a magazine, a buffer, a rack) must hold the
   * real items instead, with grippers ({@link setGrip}), so each keeps its identity, tint, mass and marks and is
   * not counted as finished. The pallet dispenser example part shows the pattern: one gripper per storage position.
   */
  despawn(zone: string): void
  /**
   * Product state: what a machine does to cargo besides making, moving and removing it. Four effects and one read,
   * all on the cargo in a zone (the same rig link names as {@link zone}), all applied by the host after this tick:
   *
   * - {@link mark} leaves a fact on every cargo body whose centre is in the zone, for other parts to read
   *   ({@link marked}, a beam's `marks`): "scanned", "wrapped", "passed inspection". A program sees it through the
   *   part that reads it, as a tag.
   * - {@link dress} fits a look to the load (film, a label, straps), drawn in one of your package's materials; it
   *   stays on the load from then on.
   * - {@link join} makes the load one unit load: the pallet and everything on it become a single rigid body (each
   *   piece still drawn, counted and sensed where it stands), as wrapping or strapping does. Only the host takes
   *   one apart (a hand lifting a piece out, or a piece leaving the world).
   *
   * "The load", for dress and join, is the lowest pallet in the zone (else the lowest body) and everything resting
   * on it inside its footprint, course on course.
   *
   * To act on one body rather than on the cargo in a zone (a label on the case a pad touched), use {@link markHit}.
   */
  mark(zone: string, key: string, value: number | boolean | string): void
  /**
   * Leave a mark on the one body a beam hit this tick: the case a labeller's pad touched, the item a coder printed
   * on. It is the body {@link sense} reported for that beam, so a short beam on the face of a tamp pad marks only
   * the case the pad is against, never a neighbour beside it. Nothing is marked when the beam is clear or sees
   * only the walking pilot. A piece of a unit load marks the load, as {@link mark} does. Applied by the host after
   * this tick, in call order with the zone calls.
   */
  markHit(beam: string, key: string, value: number | boolean | string): void
  /** How many cargo bodies in a zone carry a truthy mark `key` (counted like {@link zone}: every case of a unit load). */
  marked(zone: string, key: string): number
  /**
   * Fit a dressing to the load in a zone (see {@link mark}). `id` names it on the load, so dressing again under the
   * same id grows the same dressing; `material` is one of this package's materials and `opacity` how see-through it
   * is (default 0.42). `upTo`, a height in metres above this part's origin, clips it: a stretch wrapper passes its
   * film carriage's height tick by tick and the film climbs with it. It only ever grows.
   *
   * `web` draws the material running from a roll to the load for this tick: `link` is the rig link the roll is on,
   * `offset` the roll's foot in that link's frame, `height` its length up the link. The sheet runs to the corner of
   * the load the roll last went round, so pass it only while the roll is paying out.
   */
  dress(zone: string, spec: { id: string; material: string; opacity?: number; upTo?: number; web?: { link: string; offset?: [number, number, number]; height: number } }): void
  /** Make the load in a zone one unit load (see {@link mark}). A load already joined is left as it is. */
  join(zone: string): void
  /**
   * True for the single tick after the user "used" this part (a pilot-mode interact / click) - the
   * interaction primitive (push buttons, switches). Requires `definePart({ interactive: true })` so the editor
   * offers the Use prompt + routes the click here. Edge-shaped: handle the press once (toggle a latch, pulse a
   * tag). Only fires while the sim runs (the behavior isn't ticking at idle). Deterministic given the inputs.
   */
  used(): boolean
  again(): void // in `react`: call me on the next tick too; asked on every call while the part times or moves something
  /**
   * Is the conveyor part with this `id` currently running (commanding a non-zero surface speed)? The
   * cross-part interlock primitive: a spawner passes its `partRef` param to pause the line while the feeding
   * conveyor is stopped, without a PLC program - the built-in box/pallet spawner's "pause when conveyor
   * stopped". `id` is a part id (from a `'partRef'` param). An empty id (unset) or an id that names no
   * speed-bearing part reads as `true` (no interlock / inert dangling ref), so the gate only ever holds on a
   * conveyor that exists and is genuinely stopped. Read-only + deterministic (the host snapshots every
   * conveyor's commanded speed once per tick, so all parts read the same values regardless of order).
   */
  conveyorRunning(id: string): boolean
}

/**
 * A three.js-shaped mesh emitted by a part's {@link PartDefinition.geometry} callback: flat buffers in
 * part-local metres, CCW front faces. The host realizes it into a real GPU geometry - the part never touches
 * the renderer. Plain data (never a live engine object) so it stays sandbox-safe + portable, and the same
 * description can feed render, physics/collision, snapping, and export.
 */
export interface MeshDescription {
  /** flat [x,y,z, …] vertex positions (metres, part-local) */
  positions: number[]
  /** triangle vertex indices (CCW = front) */
  indices: number[]
  /** flat [u,v, …] per-vertex texture coordinates */
  uvs: number[]
}

/**
 * One realized piece of a multi-material part: a {@link MeshDescription} plus how the host should surface it.
 * A `geometry()` may return an array of these so a part built from distinct materials (a belt = a scrolling
 * fabric bed + a steel frame + steel side guards + steel support legs) is expressed as separate submeshes the
 * host realizes with the right material, instead of merging everything into one flat mesh. `finish` picks the
 * host's built-in material - `'belt'` = the powered scrolling fabric (the conveying surface), `'frame'` /
 * `'guard'` / `'leg'` = structural steel, `'gapfill'` = the same steel tinted white (a spur's splayed
 * underbody / discharge-infeed metal, distinct from the blue frame), `'mesh'` = a plain neutral surface -
 * and `material` (a PartPackage material id) overrides it. A single-material part can return a bare {@link MeshDescription}.
 */
/** A drawn submesh's lamp ({@link MeshPart.lamps}); the fields mean what they mean on a rig link's lamp. */
export interface MeshLamp {
  /** the `ctx.lamps` key; required (a submesh has no name to default to) */
  name: string
  /** lit colour [r, g, b] 0..1 (linear). A `colorParam` on the submesh overrides it. */
  emissive: readonly [number, number, number]
  /** the colour it shows while dark [r, g, b] 0..1 (linear); omit for the material's own colour */
  offColor?: readonly [number, number, number]
  /** lit-state opacity (0..1] for a lens over an inner core; omit for an opaque lamp. Off is always opaque */
  opacity?: number
}

/**
 * A host finish: one of the app's own textured materials, the same set on a rig link (`RigLink.finish`) and a drawn
 * submesh ({@link MeshPart.finish}). A finish is only a look.
 * - `'frame'`, `'guard'`, `'leg'`, `'bolt'`: the conveyor steels.
 * - `'gapfill'`: the same steel tinted white (a spur's splayed underbody, distinct from the blue frame).
 * - `'roller'`: brushed roller metal, turned by the conveyor's speed.
 * - `'belt'`: the scrolling belt fabric.
 * - `'tread'`: steel tread plate, the walking surface of stairs and access platforms (raised lugs).
 * - `'deck'`: a solid concrete deck, the surface of an equipment platform.
 *   Both walking surfaces tile by the box's size on a box link; on a drawn submesh they are sampled in world space
 *   at the same density, so any shape reads as the same floor.
 * - `'mesh'`: the host's plain dark neutral.
 */
export type Finish = 'frame' | 'guard' | 'leg' | 'bolt' | 'gapfill' | 'roller' | 'belt' | 'tread' | 'deck' | 'mesh'

export interface MeshPart {
  desc: MeshDescription
  finish?: Finish
  material?: string
  /** A `collision: 'box'` submesh that is one of the conveyor's side guard walls, on its `'left'` (-Z) or
   *  `'right'` (+Z) side: its collider takes the shared guard cross-section (thickened outward from the inner
   *  face) and it merges with a collinear neighbour's guard into one wall. Drawn geometry only: on a rig, `geometry()`
   *  is render-only and a guard wall is a box link with `RigLink.sideGuard`. */
  sideGuard?: 'left' | 'right'
  /**
   * Names a `type: 'color'` param whose `#rrggbb` value tints this submesh's material - the author-pickable
   * colour channel for `geometry()` parts (a floor marking's primary/secondary bands, a painted housing).
   * The host gives the submesh its own material instance (finish materials are shared, so tinting one in place
   * would repaint every same-finish part) and re-applies the current param value on every param edit - the same
   * live tint the belt's `beltColor` gets, generalized to any submesh. An absent/malformed param value leaves
   * the material's own colour. Omit for untinted parts.
   */
  colorParam?: string
  /**
   * Makes this submesh a lamp, spelled like a rig link's (`RigLink.lamps`): at most one, since a submesh is one
   * material. `name` is the `ctx.lamps` entry (declared in `definePart({ lamps })`) that lights it. Lit, the submesh
   * glows in `emissive`; dark, it shows `offColor`, else its material's own colour. With a `colorParam` too, the
   * param sets both (the unlit base and the lit glow), like a coloured push-button cap. The host gives it its own
   * material instance; submeshes naming the same lamp share one material. Package format 3 spelled this
   * `lamp: name` + `emissive`.
   */
  lamps?: readonly MeshLamp[]
  /**
   * Scroll this submesh's texture along its U while the sim runs - a chain's links, a belt's weave, a cable carrier
   * - at the speed the behavior reports. Lay the submesh's U out in texture tiles along the direction of travel
   * (u = metres along × `tilesPerMeter`); the host then moves the texture `speed × tilesPerMeter` tiles a second,
   * so the pattern travels at `speed` m/s along the surface, toward +U for a positive speed. `speed` names a
   * reported value (`ctx.report`, else the param of that name) - so a program-commanded speed drives it. Omitted,
   * it is the conveyor's declared speed param (`conveyor.speedParam` in the manifest); a part that is no conveyor
   * must name it, or it is refused when built. Needs a package `material` with an `albedo` texture; the submesh gets its own copy of it. Frozen while
   * stopped. A scrolling submesh never merges across parts (its texture moves per part).
   */
  scroll?: { tilesPerMeter: number; speed?: string }
  /**
   * Spin this submesh about an axis while the sim runs - a pulley, a fan, a sprocket - at `speed ÷ radius` rad/s
   * (the no-slip rate of a surface moving at `speed` m/s at `radius`). `axis` is its direction, `center` a point on
   * it (default the origin of the submesh's link); a positive speed turns right-handed about `axis`. `speed` names a
   * reported value as for {@link scroll}, and is defaulted and required the same way. Frozen while stopped. A spinning submesh never merges across parts.
   * The submesh's own mesh turns, so its shape goes round with it (a sprocket's teeth).
   *
   * On an {@link instances} bank it turns every instance about its own axis (each roller of a bed on its own
   * axle). The host turns the bank's material grain for that, not the geometry, so there is no per-frame geometry work:
   * the template's axle must run along its local Z through its origin (`axis` `[0, 0, ±1]`; `center` is not
   * read), and the material must be one whose grain can turn - finish `'roller'`, or a package material with
   * `triplanar: { space: 'object' }`. Anything else holds still (check-part says so). The shape of a bank never
   * turns, so draw toothed wheels as submeshes of their own. A roller bed carrying cargo toward +X turns about
   * `[0, 0, -1]`.
   */
  spin?: { axis: readonly [number, number, number]; radius: number; center?: readonly [number, number, number]; speed?: string }
  /**
   * Compress this submesh along its link's local Y by `amount` (0..1] while the lamp `lamp` is lit, anchored at its
   * lowest point, and ease back when it goes dark or the sim stops: suction cups collapsing as a vacuum grips, the
   * lip staying seated on the load while the bellows fold up toward the mount. The geometry() counterpart of a mesh
   * link's `squash` (`RigLink.squash`). On an {@link instances} bank the whole bank compresses about its lowest point,
   * so lay every instance's rim on one plane. Rig parts only (it needs a {@link link} to compress along), and not
   * with {@link spin}. A squashing submesh never merges across parts.
   */
  squash?: { amount: number; lamp: string }
  /**
   * Attach this submesh to a rig link's group instead of the part root: the articulation bridge for
   * procedural geometry. Names a link in a `kind: 'rig'` package geometry; the host parents this submesh under
   * that link's group, so it follows the link's joint / rest pose (e.g. a wire-mesh safety-gate leaf that swings
   * with its hinge joint, or posts that stay put on the root). Collision is unchanged - a rig link owns its
   * collider (a `hidden` box link = a collision-only barrier the procedural mesh dresses), so a link-tagged
   * submesh is render-only. Omit ⇒ the part/rig root. An unknown link name falls back to the root. Ignored by
   * a `function`-geometry part (which has no links); there every submesh sits on the part root.
   *
   * On a posable array link (`array.posable`) the submesh is drawn once per copy and moves with it. On one that also
   * `conveys`, a `finish: 'belt'` submesh is that copy's belt: its weave scrolls at the copy's own belt speed
   * (`ctx.setSurfaceSpeed(speed, link, i)`), along the submesh's u, which a builder box runs along its length in +X. So
   * draw the belt with its length along the copy's +X, the way the deck conveys.
   */
  link?: string
  /**
   * Declares this submesh a physical solid the host should give a static collider (cargo can't pass through
   * it) - the collision channel for `geometry()` parts. Without it a function part has no physics beyond its
   * conveying deck (boxes slide off a belt's open sides). A declaration (like {@link ParamSpec.rest}): the part
   * states *what is solid*, the host decides *how* to collide it. Omit for decorative-only geometry. Two
   * channels, because the right approximation differs by shape:
   *
   * Drawn geometry only (`kind: 'drawn'`): on a rig, `geometry()` is render-only and its solids are links.
   *
   * - `'box'` - an axis-aligned box over the submesh's local AABB (yaw-placed at the part pose): an immovable
   *   wall/frame (belt side guards, a machine housing), and the only channel a cross-part guard merge can span
   *   (a spur's side guard butting a roller's: the merge is keyed by wall). A conveying belt realizes its
   *   `'box'` guards path-aware instead (per-run walls split at openings), since a bent guard's hull would be a
   *   wrong solid box.
   * - `'hull'` - a convex hull of the submesh's own vertices, for a solid that is not box-shaped (a round
   *   pillar, a wedge/ramp, a chamfered plinth). The submesh must be convex (a hull fills concavities, so split
   *   a concave solid into convex submeshes). Never merged, so not for guards. A submesh past the host's
   *   hull-point cap degrades to its AABB box rather than losing its collider, so hull the shape, not a dense
   *   visual mesh.
   */
  collision?: 'box' | 'hull'
  /**
   * The friction of this solid's surface, on the scale a conveyor's `frictionParam` uses (0 to 2; cargo's own friction
   * combines with it): a slide chute's low-friction plate, a rubber stop pad. Only for a submesh with a
   * {@link collision}. Omitted keeps the host's default: 0 for a `'box'` (walls cargo slides along) and 0.5 for a
   * `'hull'`, which a standard carton only slides down past about 27 degrees. A side guard always has none.
   */
  friction?: number
  /**
   * Render this submesh as one InstancedMesh: `desc` becomes a unit template drawn at each of these
   * per-instance transforms, for any author geometry (a roller bed's tubes, a rail's posts). N
   * copies of one shape cost one draw call, and because the host keys instancing on geometry content, the
   * same template across different parts merges into the scene-global instance pool automatically. Keep `desc` a
   * unit shape and put size in each instance's {@link InstanceTransform.scale} so differently-sized uses
   * still share it - the `unitBox` discipline the built-in leg/bolt hardware uses. Render-only, on the part
   * root (like other geometry() submeshes). Omit for a single static mesh; an empty array draws nothing.
   */
  instances?: readonly InstanceTransform[]
  /** Render-only shadow opt-out. `false` = casts no shadow (a decal / dead-plate / thin cue over solid
   *  geometry, e.g. the skew transfer plate). Default `true`. Receive-shadow is unchanged. */
  castShadow?: boolean
  /** Render both faces (`DoubleSide`) - a thin open sheet whose back is visible. Default `false`. The host
   *  gives such a submesh its own material instance (shared finish materials stay single-sided), like colorParam. */
  doubleSided?: boolean
}

/**
 * One instance in a {@link MeshPart.instances} bank - a transform of the part's unit template `desc`. Plain
 * data (core is renderer-free): the host composes position ∘ rotation ∘ scale into the instance matrix.
 */
export interface InstanceTransform {
  /** part-local position of this instance, metres */
  position: readonly [number, number, number]
  /** per-instance scale (default `[1, 1, 1]`). Put the piece's size here and keep `desc` a unit shape, so
   *  differently-sized instances still share one template geometry and pool together across parts.
   *
   *  NEVER mirror with a negative component. A bank is one InstancedMesh, so a negative-determinant instance
   *  reverses that copy's triangle winding. Its outward faces then rasterize as back faces, and the host's
   *  double-sided steel materials flip the shading normal inward, lighting that piece as if you were looking
   *  at its inside (three's per-object mirrored-winding fix doesn't apply to an instanceMatrix). To place the
   *  far-side copy of a symmetric piece, run it backwards instead: anchor at its far end with a 180° turn.
   *  That is the same solid with a positive determinant. */
  scale?: readonly [number, number, number]
  /** per-instance rotation quaternion `[x, y, z, w]` (default identity) - omit for axis-aligned pieces. */
  quaternion?: readonly [number, number, number, number]
  /** per-instance auxiliary data, interpreted by the host per finish. Only `finish: 'belt'` banks read
   *  it: `[uMul, uAdd, vMul?, vAdd?]`: u components in metres, reconstructing the belt-loop arc-length
   *  from the template's local u (`u·uMul + uAdd`), so the scrolling fabric tiles continuously across
   *  instanced bed pieces; the optional v pair (default `[1, 0]`) remaps `v·vMul + vAdd` so an instance
   *  that is a slice of the cross-belt width (a spur's staircased strips) samples its slice of the
   *  weave. Other roles ignore it; it never affects the transform. */
  data?: readonly number[]
}

/**
 * Facts the host works out about where this part meets its neighbours, handed to {@link PartDefinition.geometry}.
 * Today that is the roller grid as it falls for this placement, which no param can carry.
 *
 * Some geometry only makes sense relative to what the part meets. The roller conveyor's skew transfer plate
 * replaces the rollers the skew clips away at the head, so it must end where a roller would have, and a butted
 * neighbour's rollers sit on the shared world pitch grid, knowable only from the resolved grid. Ending it flush at
 * the bed end leaves up to (pitch − radius) of bare deck; a fixed lap cuts through the neighbour's first roller
 * whenever that roller is near the joint between the two beds.
 *
 * Every field is optional and the object may be empty. The host fills only what it resolved for this part:
 * nothing for a part with no world-phase roller array, and nothing when it builds the geometry away from any
 * placement, for example to check a part with no scene around it. A
 * part must therefore degrade to sensible geometry with an empty `ctx`, and must stay deterministic over
 * (params, ctx): same inputs, same mesh.
 */
export interface GeometryContext {
  /**
   * The part's world-phase roller grid as resolved for its placement: part-local `[x, y, z]` offsets along the
   * flow axis (local +X), so a part can place its own rollers on it and reason about where they are. Because
   * collinear beds share one world grid, `deltas` also fixes where a butted neighbour's rollers sit: the next
   * grid line past this bed's head is `last + pitch`, and the one before its tail is `first − pitch`. It comes from any rig link whose `array.distribute` is `worldPhase` -
   * a `frame` link draws and collides nothing, so it can carry the grid alone for rollers geometry() draws itself.
   * Absent when the rig declares no such array.
   */
  deltas?: ReadonlyArray<readonly [number, number, number]>
  /** Centre-to-centre spacing (m) of {@link deltas} - the rig array's declared `maxSpacing`. Given alongside
   *  `deltas` so a one-roller bed (where the step can't be inferred) still resolves the grid. */
  pitch?: number
  /**
   * Does each end of the bed abut a collinear neighbour on the shared grid? `head` is the +X end, `tail` the
   * −X end. This is the same test the host uses for its own roller beds, so it answers the only question end-of-bed geometry can't answer for itself: whether there is
   * anything out there to meet. Geometry that laps past the bed end must gate on it - a free end has no
   * neighbour, so a lip there would hang in the air.
   */
  butt?: { head: boolean; tail: boolean }
}

/**
 * The geometry toolkit handed to a part's {@link PartDefinition.geometry} callback - the constructive-op
 * vocabulary for emitting a {@link MeshDescription} without touching the renderer (the geometry analogue of
 * `ctx`'s command surface). Author by composing these deterministic, vertex-budgeted primitives,
 * not by hand-pushing raw vertices, so hand- or machine-authored geometry stays consistent and the host
 * can cap/validate it. The surface is meant to grow, like `ctx`.
 */
export interface GeometryBuilder {
  /**
   * Loft a closed 2-D cross-section `profile` along a 3-D `path` - the universal sweep primitive (a conveyor
   * bed, a frame rail, a chute). `profile` is `[up, width]` pairs ordered CCW (`up` = the section's vertical
   * offset, `width` = its cross-belt offset); `path` is the centreline as ≥2 `[x, y, z]` points. The section
   * follows the path in a path-aligned frame (the width axis is kept horizontal so the deck never banks). The ends
   * are left open unless `opts.caps` is set, which closes each with the section itself (any simple polygon,
   * concave included) - use it for a piece that visibly stops, like a guard or a frame rail, or its end reads
   * as a hollow tube. Throws if the result would exceed the host vertex budget.
   * A round tube of radius r: `[r * Math.cos(t), r * Math.sin(t)]` for t from 0 to 2*PI (up first; the other way
   * round turns it inside out, its faces pointing in).
   * `opts.frame: 'transport'` is for a path that runs vertical somewhere (a pipe bending up into a riser, a
   * coil): the section starts level and is then carried along with the least turn, instead of being held level,
   * which a vertical path cannot do. Leave it out for anything that stays mostly horizontal, a spiral chute included.
   */
  sweep(
    profile: ReadonlyArray<readonly [number, number]>,
    path: ReadonlyArray<readonly [number, number, number]>,
    opts?: { caps?: boolean; frame?: 'level' | 'transport' },
  ): MeshDescription
  /**
   * {@link sweep} with a cross-section that changes along the path: a hopper narrowing to its throat, a funnel, a
   * round-to-square duct transition, a tapered arm. `sections` is one section per path point, or exactly two (the
   * first at the start, the second at the end, blended by distance along the path in between). Every section has
   * the same number of points, and point j of each joins point j of the next, so start them at matching places (a
   * round-to-square transition gives its circle the square's point count, its first point under the square's
   * first corner). A section may shrink to one repeated point, a cone's tip. Sections, `caps`, `frame` and the
   * ends are the sweep's. A 1 m square hopper to a 0.3 m throat, 0.8 m tall, with `sq(s)` the square
   * `[[-s/2, -s/2], [s/2, -s/2], [s/2, s/2], [-s/2, s/2]]`: `g.loft([sq(1), sq(0.3)], [[0, 0.8, 0], [0, 0, 0]], { caps: true })`.
   */
  loft(
    sections: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
    path: ReadonlyArray<readonly [number, number, number]>,
    opts?: { caps?: boolean; frame?: 'level' | 'transport' },
  ): MeshDescription
  /**
   * Round the corners of an open polyline with tangent arcs of `radius` - the general fillet/smoothing
   * primitive. Each interior corner becomes a tangent arc (the inset auto-clamped to the adjacent segments);
   * the two endpoints are kept. Operates in the X-Y plane (Z carried through), `arcSegments` (default 6) points
   * per corner. This is how a part composes a bent path rather than the builder hard-coding one: a belt's
   * geometry() walks its `[length, tilt]` rows into a corner polyline, then `g.fillet(corners, beltHeight)`
   * smooths the bends into the centreline. Feed the result to {@link sweep}.
   */
  fillet(points: ReadonlyArray<readonly [number, number, number]>, radius: number, arcSegments?: number): ReadonlyArray<readonly [number, number, number]>
  /**
   * Sample a circular arc: `segments` + 1 points from `start` to `end` radians on a circle of `radius` centred
   * at `center`, in the X-Y plane (Z = the centre's). The general curved-path primitive - rounded ends, pulley
   * wraps, fan layouts - composed by the part and fed to {@link sweep} or stitched into a longer path.
   * `segments` defaults to 8.
   */
  arc(center: readonly [number, number, number], radius: number, start: number, end: number, segments?: number): ReadonlyArray<readonly [number, number, number]>
  /**
   * Concatenate several descriptions into one mesh (indices re-based) - assemble one material's pieces from
   * several swept parts (e.g. all the steel: frame + guards + legs). Throws if the combined vertex count would
   * exceed the host budget. To combine different materials, return separate {@link MeshPart}s instead.
   */
  merge(...parts: readonly MeshDescription[]): MeshDescription
  /**
   * An axis-aligned box of full `size` `[w, h, d]` (metres) centred at `center` `[x, y, z]` (part-local) - the
   * primitive for support legs, feet, blocks and other boxy structure a sweep can't place. Compose several
   * (a belt's legs) with {@link merge} into one steel {@link MeshPart}. Budget-capped like the other ops.
   */
  box(size: readonly [number, number, number], center: readonly [number, number, number]): MeshDescription
  /**
   * The low-level option: a raw vertex builder for shapes no high-level op composes
   * naturally (an end-drum belt wrap, an irregular casting). Push vertices and triangles by hand, then
   * `build()` a {@link MeshDescription}; the host derives normals. Prefer the high-level ops (sweep/fillet/
   * box) - they stay host-understood and hard to get wrong; reach for `surface()` only for the genuine
   * exceptions. Vertex-budget-capped like everything else. See {@link SurfaceBuilder}.
   */
  surface(): SurfaceBuilder
  /**
   * An axis-aligned box of full `size` at `center`, every edge chamfered by `bevel` - a housing, a plate, a block
   * that reads as machined rather than a sharp-edged primitive. An edge is chamfered only where both its faces are;
   * list faces that sit flush against a neighbour in `square` ('x-', 'y+', ...) so they don't cut a groove there.
   */
  bevelBox(size: readonly [number, number, number], center: readonly [number, number, number], bevel: number, square?: readonly ('x-' | 'x+' | 'y-' | 'y+' | 'z-' | 'z+')[]): MeshDescription
  /**
   * A turned part - a knob, a bezel, a roller, a bolt - spun from a profile of `[radius, height]` pairs about an
   * axis. Walk the profile with the outside on your right (radius to the right, height up): up an outer wall,
   * inward across a top, down an inner bore. A radius-0 point closes that end (flat cap, or a cone tip). Round
   * within each segment and creased between them; `smooth: false` gives flat facets (a hex head at `segments: 6`).
   * `center` is a point on the axis; facet vertices start at `startAngle` (radians), measured from +x (or +y for
   * the x axis) toward the next axis in x, y, z order.
   */
  lathe(profile: ReadonlyArray<readonly [number, number]>, opts?: { segments?: number; axis?: 'x' | 'y' | 'z'; center?: readonly [number, number, number]; startAngle?: number; smooth?: boolean }): MeshDescription
  /**
   * A flat plate: a 2-D `outline` (any simple polygon, concave allowed) extruded from `from` to `to` along `axis`
   * (default 'z'; the outline spans the other two axes in x, y, z order). `holes` cut straight through; `bevel`
   * chamfers the outline's edges on both faces, except the edges listed in `square` (edge i runs outline[i] →
   * outline[i+1]) - where the plate meets a neighbour.
   */
  extrude(outline: ReadonlyArray<readonly [number, number]>, from: number, to: number, opts?: { axis?: 'x' | 'y' | 'z'; holes?: ReadonlyArray<ReadonlyArray<readonly [number, number]>>; bevel?: number; square?: readonly number[] }): MeshDescription
  /**
   * Scale, rotate, then translate a description - author in the units and orientation a drawing gives, map once.
   * `rotate` is a unit quaternion [x, y, z, w]. Scale must be positive (uniform or per axis): a mirror would turn
   * every face inside out, so build the far side directly instead.
   */
  transform(desc: MeshDescription, opts: { scale?: number | readonly [number, number, number]; rotate?: readonly [number, number, number, number]; translate?: readonly [number, number, number] }): MeshDescription
  /**
   * A closed round cylinder of `radius` and full `height`, centred at `center` (default the origin) along `axis`
   * (default 'y'), `segments` facets round (default 24): flat caps, a smooth wall. The usual cutter for
   * {@link subtract} (a bore, a pin hole); a shaft or a post otherwise.
   */
  cylinder(radius: number, height: number, center?: readonly [number, number, number], opts?: { axis?: 'x' | 'y' | 'z'; segments?: number }): MeshDescription
  /**
   * `solid` with every one of `cutters` cut out of it: a bore through a lathed hub, a slot or a window through a
   * bevelled housing, a pocket in a plate, a notch. Each cutter's surface inside the solid lines the cut, in the
   * solid's own material. Every input must be a closed solid with its faces pointing out (a box, bevelBox,
   * cylinder, lathe whose profile starts and ends on the axis, extrude, or a sweep or loft with `caps`); an open
   * one throws. Make a through-cut a little longer than the wall it goes through, so no face is left a hair thick.
   * Round surfaces stay round and flat faces flat across the cut. A hub with a 20 mm bore:
   * `g.subtract(g.cylinder(0.05, 0.04), g.cylinder(0.01, 0.05))`. A cut costs far more than the other ops, so
   * keep the facet counts what the look needs; it runs on a param edit, never per tick.
   */
  subtract(solid: MeshDescription, ...cutters: readonly MeshDescription[]): MeshDescription
}

/**
 * A hand-driven vertex/triangle accumulator (the low-level {@link GeometryBuilder.surface} tier). Add
 * vertices (each returns its index), wire them into triangles/quads (CCW = front), then {@link build}.
 * Plain data out - the same {@link MeshDescription} the high-level ops emit - so a surface()-built part stays
 * exactly as sandbox-safe + portable as a composed one; the only thing you give up is the host understanding
 * the shape (no LOD/instancing), which is why it's the exception, not the default.
 */
export interface SurfaceBuilder {
  /** add a vertex (part-local metres) with optional UV (default 0,0); returns its index for triangle/quad */
  vertex(x: number, y: number, z: number, u?: number, v?: number): number
  /** a triangle from three vertex indices (CCW winding = front face) */
  triangle(a: number, b: number, c: number): void
  /** a quad from four CCW indices = two triangles (a,b,c)+(a,c,d) - convenience over {@link triangle} */
  quad(a: number, b: number, c: number, d: number): void
  /** finalize into a {@link MeshDescription} (normals derived host-side). Throws past the vertex budget. */
  build(): MeshDescription
}

/**
 * What a part script registers via `definePart(...)`. Generic over its own param schema `P` so the
 * `ctx` handed to `init`/`step`/`dispose` exposes `ctx.params` typed from `params`.
 */
/**
 * One mount a part lands onto a compatible host surface - the device half of declarative snapping (a sensor
 * onto a conveyor's side guard, a diverter onto a conveyor flank). Self-descriptive in the part's own local
 * frame: it names where on this part the contact sits and which surface kind it accepts, never a neighbour or
 * a world position. The host matches it against a surface advertising that kind, projects the contact onto the
 * surface, and resolves the pose - the part never sees the host (the same data-out / host-resolves contract as
 * {@link ParamSpec.rest}). A point-to-segment mount.
 */
export interface SnapMount {
  /** device-local point that seats on the host surface (the lens face, the push side, a button's back plate) */
  at: [number, number, number]
  /** the surface kind this mounts on - a tag the host surface advertises. `'conveyorGuard'` is a conveyor's
   *  side rail (advertised implicitly by every conveyor). `'face'` is reserved: every part implicitly
   *  advertises the four vertical side faces of its footprint box, and a `'face'` mount seats anywhere on the
   *  nearest face - sliding both along it and in height (clamped to the face rect) - a push button or HMI
   *  panel landing on a cabinet, a column, a machine frame. Any other tag matches a host's declared
   *  {@link SnapSurface} of that kind. */
  accepts: string
  /** does local +Z face toward the host (a sensor's beam across the belt) or away (a diverter's body, a
   *  wall-mounted button's front)? Default `'in'`. */
  face?: 'in' | 'out'
  /** push the body out from the surface along its outward normal, m (default 0) */
  outwardOffset?: number
  /** drop the origin below the contact, m (default 0) */
  yOffset?: number
  /** a sensor: auto-fit a beam-range param so it spans the host - names the `number` param the host writes.
   *  Ignored by `'face'` mounts (a face has no span to fit). */
  fitRangeParam?: string
  /** Attach on mount: committing this snap also soft-parents the device under its host in the scene tree, so
   *  moving the host carries the mounted device (a button moves with its cabinet). The device stays attached when
   *  later dragged free - detach is a tree operation ("Unparent") - and re-attaches to a new host on the next
   *  mount. Default false (mount is pose-only, like the built-in sensors). */
  attach?: boolean
  /** Cut the host where this mount seats: on a conveyor's side guard (`accepts: 'conveyorGuard'`), a gap as wide
   *  as the device's footprint along the guard, so what it pushes can cross (the pop-up diverter's arms). A
   *  sensor leaves it unset: its beam crosses the guard without a hole. */
  opens?: boolean
}

/**
 * A track anchor: this part seats onto a roller conveyor's bed, anchored to the rendered roller grid (the
 * blade stop's and chain transfer's snap). The host aligns the part with the
 * host track, anchors its origin to the grid - by default at the midpoint of the two nearest rollers (the
 * blade rises in the gap between them), or by lane parity when {@link lanes} is declared - seats it at the
 * bed surface (+ {@link targetLocalY}), and auto-fits the named width param to the host bed.
 */
export interface SnapTrack {
  /** auto-fit: the `number` param the host writes with the adopted bed width, clamped to the param's declared
   *  min/max. Without {@link lanes} the adopted width is the usable bed width
   *  (host width minus the frame walls - the blade fits between them); with `lanes` it is the full host bed
   *  width (the lanes run across the bed), scaled by {@link fitWidthScale}. Omit to keep size. */
  fitWidthParam?: string
  /** scale applied to the adopted width before it is written to {@link fitWidthParam} (default 1) - a lane
   *  whose length is a fixed fraction of the bed width (the chain transfer's lane length =
   *  width × 2/SNAP_NATIVE_Z_WIDTH). */
  fitWidthScale?: number
  /**
   * seat the part origin this far above the host bed surface, m (default 0 = on it). Negative recesses it into
   * the bed - what a pop-up transfer needs: its `conveys` deck is on a lift joint, and a flush seat would leave
   * two powered surfaces coplanar, so cargo touches both and whichever is idle brakes it (a surface velocity of
   * zero is a stopped belt, not neutral). Recessed, the host carries until the stroke lifts the load clear.
   */
  targetLocalY?: number
  /**
   * lane-parity anchoring (the chain transfer): the part is N parallel lanes stepped a whole number of host
   * roller pitches apart along the track, seated so every lane sits in a roller gap (never on a roller),
   * clamped so the outermost lanes stay on the bed.
   *
   * `countParam` names the `number` param holding the lane count. `pitchParam` optionally names the
   * lane-spacing param: the host rounds the value the author gave it to the nearest whole multiple of the host's
   * roller pitch (at least one, clamped to the param's declared range) and writes that back. Whole multiples are
   * what keeps the lanes in the gaps, so the spacing cannot be honoured exactly - but the bank keeps the size it
   * was authored at rather than collapsing onto the bare roller pitch. Omit `pitchParam` and the host cannot
   * know your spacing at all: it writes nothing back and anchors as though the lanes stepped one pitch apart,
   * so declare it on any bank whose spacing you want respected. Omit `lanes` entirely for a single-point seat
   * (the blade stop).
   */
  lanes?: { countParam: string; pitchParam?: string }
}

/**
 * A surface this part advertises for other parts to mount onto - the host half of declarative snapping, the
 * mirror of {@link SnapMount}. Self-descriptive in this part's own local frame: it names a surface kind (the
 * tag a mount's {@link SnapMount.accepts} matches) and the params giving the surface's extent; the host
 * projects a device's contact onto it and never lets this part see the device (the same data-out /
 * host-resolves contract as {@link ParamSpec.rest}). v1 models the conveyor's rail pair - two side rails at
 * z = ±width/2, centred on the origin along local X (x −length/2..+length/2), flat. A conveyor
 * advertises `'conveyorGuard'` implicitly (its rails are inferred from the bed), so an explicit surface is
 * only needed for a non-conveyor host (a stand, a bracket, a machine frame a sensor mounts to).
 */
export interface SnapSurface {
  /** the surface kind a {@link SnapMount.accepts} matches against. v1: `'conveyorGuard'`. */
  kind: string
  /** names the `number` param giving the rail length (rails run local x −length/2..+length/2) */
  lengthParam: string
  /** names the `number` param giving the cross width (rails at z = ±width/2) */
  widthParam: string
  /** Optional: names the `number` param giving the surface's elevation above its own base: a platform deck's
   *  height above the floor. A part standing on the floor ({@link SnapEdgeMount.fromFloor}) reads it to size itself so its
   *  top reaches the deck. Omit for a surface with no meaningful elevation (a conveyor's guard rail). */
  heightParam?: string
}

/**
 * Tiling: the part's footprint rectangle lands edge-to-edge against another part of its own kind, orientation
 * snapped to 90-degree steps of the target's yaw, sliding along the shared edge, at the target's height (coplanar:
 * decks meet as one floor). Both parts must declare `tile` in the same {@link group}: a floor marking tiles only
 * with floor markings, a deck only with decks. The rectangle is read from the named length/width params (so it
 * tracks a resized instance); the part never sees its neighbour. Unlike {@link SnapSpec.flush} (any neighbour's
 * face, height kept), this pairs only with its own kind. Package format 3 called it
 * `edges`.
 */
export interface SnapTile {
  /** parts whose edges snap together share this group tag (a floor marking's group, a deck's group, …) */
  group: string
  /** names the `number` param giving the rectangle length (footprint half-extent = length/2 along local X) */
  lengthParam: string
  /** names the `number` param giving the rectangle width (half-extent = width/2 along local Z) */
  widthParam: string
  /** also offer corner-flush candidates (a shared corner aligns), not only centre-slide along the edge -
   *  the floor-marking behaviour when a mover overhangs a smaller target. Default false (plain edge slide). */
  cornerFlush?: boolean
}

/**
 * End-to-end chaining for a linear part: the barrier snap (guard rails, fences, safety gates). The part
 * extends along its local +X (forward), half-length `length/2`. Dropped near a same-{@link group} part, it either
 * extends collinearly off the nearer end (facings roughly parallel) or forms a 90-degree L-corner (perpendicular). At an L-corner the two parts share one post, so the snap toggles the
 * named `omit*Param` booleans to draw it once. The moved part omits its mating post and the
 * target un-omits the shared end, and the host applies both as one undo entry.
 */
export interface SnapChain {
  /** parts chain only with same-group parts - guard rails chain with guard rails; a fence + a safety gate share
   *  a group; the two groups never mix. The declarative form of the barrier-family rule. */
  group: string
  /** names the `number` param giving the rail length (extends along local +X, half-length = length/2) */
  lengthParam: string
  /** engage reach in metres - how near a drop must be to chain (a guard rail's ~3 m, a fence's tighter ~1 m) */
  reach: number
  /** Optional: names the `boolean` param for the start-end (local −X) post; set false on a collinear extend and
   *  toggled at an L-corner so the shared post draws once. Omit for a linear part with no end posts. */
  omitStartParam?: string
  /** Optional: names the `boolean` param for the end-end (local +X) post - the twin of {@link omitStartParam}. */
  omitEndParam?: string
}

/** A param-driven shift of a point, like a link's `offsetParams`: `params[param] × scale + add` (clamped to
 *  `[min, max]`) is added to the point's `axis` coordinate. */
export interface SnapParamOffset {
  axis: 0 | 1 | 2
  param: string
  scale?: number
  add?: number
  min?: number
  max?: number
}

/**
 * Seat on a host's deck edge: the part seats on the nearest edge of a rectangular deck surface the host advertises
 * as a {@link SnapSurface} (a platform, a mezzanine). One connector for everything that meets a deck edge, told
 * apart by its options rather than by name:
 *  - a barrier along the rim: `facing: 'along'` (the default), coplanar with the deck;
 *  - a flight, ramp or ladder climbing onto it: `facing: 'into'`, standing on the host's floor (`fromFloor`),
 *    its far end ({@link at}) on the edge;
 *  - a gate or flight set into the railing: {@link opens}, so the host's railing parts where it meets the edge.
 * The part only describes itself. The host works out the pose and the cut.
 */
export interface SnapEdgeMount {
  /** the deck-surface kind this seats on - matched against a host {@link SnapSurface.kind}. v1: `'deck'`. */
  accepts: string
  /** names the `number` param giving the part's extent along the edge: a barrier's length, a flight's width
   *  (half of it clamps the slide along the edge, and it is the width of the gap {@link opens} cuts) */
  alongParam: string
  /** engage reach in metres - how near a drop must be to seat (a guard rail's ~3 m, a fence's tighter ~1 m) */
  reach: number
  /** `'along'` only: push the origin out from the edge along its outward normal, m: a guard rail's half-post
   *  standoff. Default 0 (seat flush on the edge, a fence). */
  outwardOffset?: number
  /** how the part meets the edge. `'along'` (default): local +X runs along the edge and +Z outward, the origin on
   *  the edge at the deck height. `'into'`: local +X points into the deck, the {@link at} point sits on the edge,
   *  and the {@link alongParam} extent runs along it (a flight whose top butts the rim). */
  facing?: 'along' | 'into'
  /** `'into'` only: the point on the part that meets the edge, in its local frame, moved by {@link atParams}
   *  (a flight's top: `numSteps × tread` along X, `numSteps × rise` up). Default the origin. */
  at?: [number, number, number]
  /** param-driven shifts of {@link at}, so the contact tracks the part's own size params */
  atParams?: SnapParamOffset[]
  /** `'into'` only: the part stands on the host's floor (the deck top less the deck's `heightParam`) and spans up
   *  to the deck. `param` names the `number` param the host fits so {@link at} reaches the deck top: it must drive
   *  an axis-1 {@link atParams} entry, whose `scale` is the rise per unit, and the fit rounds to whole units
   *  (a step count), clamped to the param's range. */
  fromFloor?: { param: string }
  /** where the part meets the edge, cut a gap in the host's links that run on that edge ({@link RigLink.onEdge}
   *  in the manifest), as wide as {@link alongParam}: a flight walks through the railing onto the deck */
  opens?: boolean
  /** where the part's footprint (origin to {@link at}, {@link alongParam} wide) crosses the deck plane, notch the
   *  host's `notchable` links: a stairwell through a mezzanine */
  notch?: boolean
  /** once met, raise the whole part so {@link at} sits flush on the deck top (the residual a whole-unit
   *  {@link fromFloor} fit leaves); links anchored to the floor (`anchor: 'floor'`) stretch back down */
  lift?: boolean
}

/**
 * A part's declarative snap features: the connection geometry the host's snap engine
 * matches across parts, supplied as static self-description instead of being inferred. Covers {@link SnapMount}
 * (a device mounting onto a host surface), {@link SnapTrack} (a blade-stop-style seat onto a roller bed),
 * {@link SnapSurface} (a surface other parts mount onto - the host half), {@link SnapTile} (edge-to-edge
 * structural tiling - floor markings, decks), {@link SnapChain} (end-to-end chaining of a linear part -
 * barriers), and {@link SnapEdgeMount} (seating along a host deck edge - a barrier on a platform rim). Every
 * kind compiles to the same connector model: plugs on the dragged part, sockets on the
 * host, matched by kind, solved per (plug shape, socket shape), and ranked by one rule.
 */
export interface SnapSpec {
  /** Ambient face-flush: dragged near another part, this part's footprint box sits flush against that
   *  part's nearest vertical footprint face (90-degree-stepped yaw, slide + corner-flush along the face,
   *  height untouched). Declare it on parts that get tiled - crates, pallets, racks - where flush-beside-
   *  the-last-one is wanted on nearly every drop (it compounds with Shift-drag duplicate into rapid row
   *  building). Ambient snapping is always declared intent, never inferred: a part without this flag never
   *  flushes on its own - the editor's hold-B Face mode is the explicit, universal alternative. */
  flush?: boolean
  /**
   * Points this part lands onto a compatible host surface (sensors, diverters, …).
   *
   * Every entry is tried against each candidate host and the best-fitting one is used (a body overlapping the
   * host first, then lowest cost - the same rule that ranks one host against another), so declaration order
   * does not decide. Since {@link SnapMount.accepts} names one surface kind, several entries are how a device
   * says it can seat on more than one kind of host: a sensor that mounts on a conveyor's guard rail
   * (`'conveyorGuard'`) or, failing that, flat on a bracket (`'face'`), is two mounts.
   */
  mounts?: SnapMount[]
  /** seat this part onto a roller conveyor bed, anchored to the roller grid (blade stops, …) */
  track?: SnapTrack
  /** surfaces this part advertises for other parts to mount onto - the host half (a rail a sensor lands on;
   *  a deck a barrier seats along) */
  surfaces?: SnapSurface[]
  /** edge-to-edge tiling with same-group parts, coplanar (floor markings tile, decks abut) */
  tile?: SnapTile
  /** end-to-end chaining of a linear part with same-group parts (barriers: collinear extend + L-corner) */
  chain?: SnapChain
  /** seat this part on a host deck edge: a barrier along a platform rim, a flight climbing onto it, a gate set
   *  into its railing ({@link SnapEdgeMount}) */
  edgeMount?: SnapEdgeMount
}

/**
 * How an authored {@link PartDefinition.unit | unit load} starts a run, from its own params. Every param named here
 * must be declared on the part: `joinWhen` and each `when` a boolean, `colorParam` a color, `opacityParam` a number.
 */
export interface UnitLoadDecl {
  /** start as one rigid body while this boolean param is true (a wrapped load); omit to always start joined */
  joinWhen?: string
  /** dressings fitted round the whole load (film, straps), each in one of this package's materials */
  dress?: { id: string; material: string; when?: string; colorParam?: string; opacityParam?: string }[]
  /** the parts a load that stacks itself is made of, by package id: its pallet and its cases. A project that places
   *  the load copies these in too. Omitted on a load stored before it declared them, which stacks
   *  `oip.pallet` and `oip.box`. */
  pieces?: { pallet: string; case: string }
}

/**
 * The manifest a part written as one `part.js` carries in {@link PartDefinition.manifest}: every field of a
 * `manifest.json` ({@link PackageManifest}), with `geometry` optional because {@link PartDefinition.rig} can compute it.
 */
export type PartSourceManifest = Omit<PackageManifest, 'geometry'> & { geometry?: PartPackageGeometry }

/** What {@link PartDefinition.rig} returns: a rig geometry ({@link RigGeometry}) without its `kind`. */
export type PartRigSource = Omit<RigGeometry, 'kind'>

export interface PartDefinition<P extends ParamSchema = ParamSchema, J extends string = string, G extends string = string, L extends string = string, S extends string = string> {
  /**
   * The part's manifest, for a part written as one `part.js`: everything a `manifest.json` holds, with the geometry
   * left out when {@link rig} computes it. A build step reads it (`npm run build-parts -- <folder>` writes it to the
   * folder's `manifest.json`) and leaves it out of the shipped `behavior.js`. The app ignores it: a part loads from
   * its `manifest.json`. See "Writing a part as one `part.js`" in the part authoring guide.
   */
  manifest?: PartSourceManifest
  /**
   * The part's rig as a function of its params, for a part written as one `part.js`: links, joints and bounds computed
   * with ordinary arithmetic. A build step runs it with each param moved and writes the manifest's rig geometry, turning
   * a number that follows a param into a param ref. Like {@link manifest}, only the build reads it; the app ignores it
   * and the shipped `behavior.js` leaves it out. See "Writing a part as one `part.js`" in the part authoring guide.
   */
  rig?(params: ParamsOf<P>): PartRigSource
  /** exported, inspector-editable params */
  params?: P
  /**
   * Names of the rig joints this part commands. Declaring them makes `ctx.joints` a typed, autocompleting
   * bag (`ctx.joints.shoulder`) so a misspelled joint is a compile error instead of a silent no-op. Names
   * must match the package's rig geometry (validated when the package is built). Omit for parts with no
   * articulation.
   */
  joints?: readonly J[]
  /** Names of the rig grippers this part opens/closes - typed into `ctx.grips`, exactly like {@link joints}. */
  grippers?: readonly G[]
  /** Names of the lamps this part lights - typed into `ctx.lamps`, like {@link joints}. Each must be a lamp the rig
   *  declares: an entry of a link's `lamps` (named, else the link's name), or of a submesh's `lamps` drawn by
   *  `geometry()` (validated when the package is built). */
  lamps?: readonly L[]
  /** Names of the rig's servo joints (a joint with `servo` in the manifest) this part drives, typed into
   *  `ctx.servos`, like {@link joints}. A servo is commanded through its {@link Servo} handle, never `ctx.joints`. */
  servos?: readonly S[]
  robot?: true | RobotDeclaration
  /** Mark the part as usable so the editor offers a "Use" prompt (pilot crosshair) and routes a click to the
   *  behavior, where `ctx.used()` reads true for that tick. Omit for non-interactive parts. */
  interactive?: boolean
  /**
   * Name the boolean param that is this device's hand state (the latch a `ctx.used()` press toggles - a
   * gate's `open`, a blade stop's `active`): the state a run starts from, which the author sets in the
   * Inspector. Use never writes it - a press operates the device (`ctx.used()` running; while stopped, a live
   * session of the behavior that the Inspector shows as operated, with a Reset). While a program drives the device's command tag the
   * Inspector shows this checkbox as the program's live command. Requires `interactive: true`, must name a
   * `boolean` param the script adopts, and `step()` must `ctx.report` it with the state the device is
   * actually in (all validated when the package is built).
   */
  useParam?: string
  /**
   * Declare this part a unit load product type: a container whose children in the scene (a pallet and the cases on
   * it) are one load. Membership is exactly its children, as the author parented them; nothing is inferred. The
   * part is selected and dragged as one (a click on a piece selects the load, a double-click drills in), its
   * params flagged `attribute` are the load's product attributes (an ID, whether it is wrapped), and at Run it
   * starts as {@link UnitLoadDecl} says: joined into one rigid body, dressed. A machine joining a load mid-run
   * (ctx.join) makes the same kind of thing. See {@link UnitLoadDecl}.
   */
  unit?: UnitLoadDecl
  /**
   * Emit the part's geometry procedurally (Tier 2 in the part authoring guide), for shapes the static manifest
   * can't list (a bent multi-segment belt, a lofted or revolved profile). It is param-driven and has no side
   * effects. The host calls it at author time and whenever a param changes, never per sim tick, and it must not
   * read tags or sim state: the only link to `step()` is the shared `params`. Compose the
   * {@link GeometryBuilder} ops and return a {@link MeshDescription} the host realizes. The same description
   * feeds render and collision. It must be deterministic and stay within the vertex budget, or it throws.
   * Omit it for parts whose geometry is fully described by the manifest.
   *
   * `ctx` carries what the host works out about where the part meets its neighbours, for geometry that has to
   * meet one (see {@link GeometryContext}). It is a plain object, empty when the host resolved nothing, so a part
   * that ignores it is unaffected. Determinism is over (params, ctx).
   */
  geometry?(g: GeometryBuilder, params: ParamsOf<P>, ctx: GeometryContext): MeshDescription | MeshPart[]
  /** One-time setup, run once at the start of the part's first tick, just before that tick's step(): `ctx`
   *  already holds the placed position, the params and the tags, and anything it commands (a joint, a lamp)
   *  takes effect in that tick unless step() overrides it. A throw is reported as that tick's error. */
  init?(ctx: PartContext<P, J, G, L, S>): void
  /** run every fixed sim tick; the tick's length is `ctx.dt` (seconds). A part has `step` or {@link react}, not both. */
  step?(ctx: PartContext<P, J, G, L, S>): void
  /** In place of `step`, for a part that only answers its inputs: called on the first tick, when something the host
   *  hands it changed, and after a call that asked with `ctx.again()`. Else what it last commanded stands. The part
   *  authoring guide's "`react`" section has the rules. */
  react?(ctx: PartContext<P, J, G, L, S>): void
  /** teardown when the part is removed */
  dispose?(ctx: PartContext<P, J, G, L, S>): void
}

/**
 * The global a part script calls to register itself; provided by the runtime. The `const` type param
 * captures the literal param schema so `ctx.params` is precisely typed inside the callbacks.
 */
export type DefinePart = <const P extends ParamSchema = ParamSchema, const J extends string = string, const G extends string = string, const L extends string = string, const S extends string = string>(
  def: PartDefinition<P, J, G, L, S>,
) => void
