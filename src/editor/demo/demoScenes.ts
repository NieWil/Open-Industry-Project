// Ready-made scene for the PLC/ST demo: a layer-forming palletizing cell, wired so the paired program drives
// it with no manual setup. Start/Stop latch the line. A spawner feeds cases onto the infeed; a pop-up diverter is
// held extended across the lane as a turning plow, so each case of the turned row catches it on a corner and pivots
// 90° as the rollers keep driving. Cases accumulate nose-to-tail against a blade stop into a row, and a chain
// transfer pushes each finished row aside to make room for the next, pressing it square on a layer stop. Two
// rows - 2 straight cases beside 3 turned ones - make one 1.2 x 1.0 m layer, built right on the forming lane.
// A big six-axis palletizer with a layer-sized vacuum plate then lifts all five cases in one grip and lays them on
// a pallet, spinning the plate 180° on the middle course so the stack interlocks. Three courses fill the pallet;
// the finished load leaves down the line, and an AGV forks it off the staging lane (pallet and stack together),
// carries it to the rack line and puts it away on a shelf, bay by bay, while a pallet spawner drops a fresh empty
// one on the build deck. A three-tier tower shows running / outfeed blocked / E-stop, and the cell's safety gate is a live
// interlock: opening it pauses the robot and the truck and turns the tower red until it is closed again.
//
// The cell is built around one pattern: `LAYER_PATTERN` below is one arrangement, and the whole 3-course load is
// that layer laid at 0°, 180°, 0°. So the line only builds one thing, cases need only one of two orientations, and
// the palletizer needs only two wrist angles. The cell's geometry follows from it too. Every row accumulates against
// the same stop, which puts cases at exactly the x offsets the pattern asks for. Both rows form on one lane, so a
// single 0.5 m push (away from the way the plow deflects) sets their z offsets.
//
// The working cell sits down the centre of a 40 x 30 m warehouse furnished with dressing: a pallet-rack line down
// one side, a pedestrian walkway down the other, a raised viewing gallery over the cell, and painted zones.
//
// Compass: +x is east and +z is south everywhere in this file (the plan view with north up). So the receiving dock
// is the west wall, the shipping dock the east one, the racks stand north of the line and the walkway and gallery
// south of it, and the cell's gate is on its south run (CELL_SOUTH_Z, the larger z). Comments and names both follow
// it: a "north" anything has the smaller z.
//
// Every part in the demo is a bundled SDK part (examples/parts/*) placed as a `custom` instance, so the
// demo runs entirely on parts authored against the public part SDK, wired to the PLC over the device-IO tag bridge. The only built-in types left are the
// pure-container `group` nodes and the warehouse `building` shell, which have no SDK equivalent.

import { createSdkPart, createPart, defaultBuilding, DEFAULT_BUILDING_RULES, nextId } from '../../core/scene/scene'
import { conveyorCenterOffsetX, flexPathOf, toWorldXZ } from '../../core/parts/partGeometry'
import { flexStations } from '../../core/conveyor/flexPath'
import { dockOpenings, PERSONNEL_DOOR_AT, personnelDoors } from '../../core/building/buildingDocks'
import { getPackage, registerPackage } from '../../core/parts/partRegistry'
import { uniqueName } from '../../core/parts/partDisplayName'
import { reseatContainers } from '../../core/scene/hierarchy'
import { holdPositions, holdsOf } from '../../core/heldStock'
import type { PartPackage } from '../../core/parts/partPackage'
import { buildPackage } from '../../sim/buildPackage'
// Import bundledPartById from bundledExamples (a re-export), not './bundledPackageData' directly: a direct
// importer with no HMR accept makes committed-part edits full-reload instead of hot-swap (see bundledExamples).
import { bundledPartById } from '../parts/bundledExamples'
import {
  AGV_LOAD_AHEAD,
  AGV_LOAD_UNDER_LIFT,
  AGV_TINE_HEEL,
  AGV_TINE_LENGTH,
  AGV_TINE_OFFSET,
  BUILDING_SECTION_SIZE,
  AGV_TINE_RISE,
  AGV_TINE_THICKNESS,
  AGV_TINE_WIDTH,
  PALLET_POCKET_HEIGHT,
  PALLET_SIZE,
  SCENE_VERSION,
  STAIRS_STANDARD_RISE,
  STAIRS_STANDARD_TREAD,
} from '../../core/types'
import type { PartInstance, PartType, SceneJSON } from '../../core/types'
import { FLOOR_SURFACE_Y } from '../../core/types'
import type { Controller } from '../../core/controller'

/**
 * Resolve a bundled first-party package by id: the live registry copy when the bundled-examples
 * loader has already run, else built fresh from the committed folder (examples/parts/<dir>) and
 * registered so the geometry seams (bedOf & co) resolve while the scene is being built.
 * The demo embeds every package it uses in scene.packages, so loading it is self-contained
 * (registerScenePackages) in any context. A build failure (never, once committed) returns null.
 */
function bundledPackage(id: string): PartPackage | null {
  const existing = getPackage(id)
  if (existing) return existing
  const d = bundledPartById(id)
  if (!d) return null
  try {
    const pkg = buildPackage(d.manifest, d.behavior)
    registerPackage(pkg)
    return pkg
  } catch {
    return null
  }
}

// The default building is in core/scene/scene, so the render layer can build the same warehouse as a viewport
// backdrop without importing the editor. Re-exported here for importers (New, the blank default scene)
// that reach for it via demoScenes.
export { DEFAULT_BUILDING_RULES, defaultBuilding }

// --- the load pattern, and the cell geometry that follows from it ---

/** the case the line handles: 0.6 x 0.4 m footprint, 0.4 m tall (the SDK box defaults) */
const CASE = { length: 0.6, width: 0.4, height: 0.4 } as const
/** The dock door the trailer is unloaded through: the first opening of the default shell's dock bay, whose leaf key
 *  the building's `openDoors` names (core/building/buildingDocks.ts). The shell is placed so this door is on the forming lane. */
const RECEIVING_LEAF = '1:0'
/** The shipping dock's wall section: perimeter cell 3 of the 3 x 4 shell, the east wall's southmost section (its two
 *  leaves are `3:0` and `3:1`, core/building/buildingDocks.ts). The outbound staging is laid out in front of it. */
const SHIPPING_CELL = 3
/** The personnel exit door's wall section: perimeter cell 8, the south wall's third bay from the dock wall (x 8-18). Its
 *  door, mid-bay at x 13, stands east of the viewing gallery and west of the outbound staging, so the walkway reaches
 *  it straight down the open floor between them. */
const EXIT_CELL = 8
/** the south wall's first perimeter cell (2 x the shell's 3 lengthSections), the one at the dock wall: the south wall's
 *  cells run east from DOCK_WALL_X, 10 m each */
const SOUTH_WALL_FIRST_CELL = 6
/** The dock wall's x: the shell is turned so its dock wall faces the line's infeed, and this is how far back from the
 *  infeed tail it stands - a 10 m apron, room for the dock plates, the flex, and the second door's pallets coming in
 *  beside it. It also sets the far wall (40 m on), which has to clear the rack truck's charge bay east of the racks. */
const DOCK_WALL_X = -12
/** how far into the trailer the flex reaches: where the unloader stands and puts cases on it */
const FLEX_INTO_TRAILER = 7
/** the flex's zone eye, as a fraction of a section (examples/parts/flex-conveyor EYE_AT): where a queued case waits
 *  with its nose, and - on the first section - the eye whose covering is the flex's full signal */
const FLEX_EYE_AT = 0.8
/** the clear gap the unloader leaves ahead of the case it puts down: it puts a case down a case length and this much
 *  behind the first zone's eye, so while that eye is clear the spot is too, and cases go on 0.3 m apart at the closest - one to
 *  a zone once they queue, where two put on touching would share one and wait together */
const FLEX_LOAD_GAP = 0.3
/** how many cases the flex starts with, queued from its discharge end */
const FLEX_STOCKED = 5
/** the unloading flex's bed: a 0.4 m case lengthwise with 5 cm each side, so it delivers onto the forming lane
 *  within a few centimetres of its centreline */
const UNLOAD_W = 0.5

/**
 * One canonical layer - the only arrangement the line ever builds. Case centres are given relative to the load
 * centre, and `turned` marks the cases standing 90° to the line.
 *
 * A 0.6 x 0.4 case on a 1.22 x 1.02 EUR pallet gives the classic 5-per-layer pattern: a row of 2 cases laid
 * straight (0.6 along x) beside a row of 3 turned ones (0.4 along x). Both rows are exactly 1.2 m long and
 * together they are 1.2 x 1.0 - a 100% fill of the pallet's usable face.
 */
export const LAYER_PATTERN: { dx: number; dz: number; turned: boolean }[] = [
  { dx: -0.3, dz: 0.3, turned: false }, { dx: 0.3, dz: 0.3, turned: false },
  { dx: -0.4, dz: -0.2, turned: true }, { dx: 0, dz: -0.2, turned: true }, { dx: 0.4, dz: -0.2, turned: true },
]
/** the load sits 13 mm off the pallet centre in x - 1.2 m of case on a 1.22 m pallet */
const LOAD_DX = 0.013
/** the first course's case centres, above the pallet centre: pallet half-thickness + half a case */
const COURSE0_DY = 0.2675
/** courses per pallet (exported for the program's twins, demoReference.ts) */
export const COURSES = 3

/** the height everything conveys at: the case line, and - level with it - the pallet line */
const SURFACE_H = 1.0
/**
 * The line's far rail: the -z side, the datum a turning case squares against. Everything across the line is
 * measured from here. It is the only edge cargo actually references, so it is the one held as a constant.
 */
const FAR_RAIL_Z = -0.762
/** the roller conveyor's own roller spacing (its rig distributes rollers at this maxSpacing) */
const ROLLER_PITCH = 0.075
/**
 * A row is 1.2 m long, and it is the same 1.2 m either way round - two 0.6 m cases laid straight, or three 0.4 m
 * cases turned. That is what lets one blade stop form both rows.
 */
const ROW_LENGTH = 2 * CASE.length

/**
 * How far a turned row ends up off the lane centreline, toward -z. Pivoting against the plow carries the case with
 * it, so a turned row does not come to rest where it formed. Measured off the running cell
 * (e2e/verify-layer-palletizer.mjs prints where every case sits when the layer completes).
 */
const PLOW_DRIFT_Z = 0.23
/**
 * How far a roller conveyor's side guard stands proud of its deck: the rig seats a guard's centre at
 * `width/2 + 0.0125` and it is 0.005 thick, so its inner face - the surface cargo actually touches - is half a bed
 * plus this.
 */
const GUARD_INSET = 0.01
/**
 * How far a roller conveyor's side frame stands proud of its deck: the outward equivalent of {@link GUARD_INSET}.
 * This is the one that matters to anything standing alongside a bed rather than riding on it.
 *
 * A bed's steel does not end at `width/2`: the L-rail's wall sits at `width/2 + 0.01` and its top flange lip
 * reaches `width/2 + 0.03` (examples/parts/roller-conveyor/rig.json - `wallL`/`flangeL` offsetParams), plus a leg
 * trestle under it. So half a bed is where the cargo stops, not where the conveyor stops, and a neighbour spaced
 * off half a bed is inside it.
 */
const ROLLER_FRAME_PROUD = 0.03
/**
 * The SDK fence's post half-width. A run draws its 0.06 m posts centred on its own ends (examples/parts/fence/part.js
 * distributes them from -length/2 to +length/2), so a fence butted flush against something overlaps it by this
 * much. That is why a fence end is spaced off a neighbour's face rather than laid on it.
 */
const FENCE_POST_HALF = 0.03
/**
 * The diffuse sensor package's lens reach (local +z), and how proud of a bed's deck edge its `conveyorGuard` mount
 * seats it (examples/parts/diffuse-sensor). An eye placed off these ends up where a drag onto the rail would, outside
 * the side guard instead of inside the bed behind it.
 */
const EYE_LENS_Z = 0.037
const EYE_MOUNT_OUTWARD = 0.02
/** ...and how far below the deck that mount seats it (its `yOffset`), so the housing clears the 0.15 m guard's top return */
const EYE_MOUNT_DROP = 0.02
/**
 * Where a frame-mounted eye's beam crosses its bed, above the deck: the lens is 0.1 over the sensor's origin
 * (examples/parts/diffuse-sensor/part.js EMIT_Y), which the mount seats EYE_MOUNT_DROP under the deck. A pallet standing on
 * that deck's rollers is PALLET_SIZE[1] (0.135) deep, so the beam is always inside it, for any deck height:
 * the eye seats off the same deck the pallet rests on. demoScenes.test.ts pins it for the pallet line's eyes.
 */
export const EYE_FRAME_BEAM_Y = 0.1 - EYE_MOUNT_DROP
/**
 * An eye on a floor stand, for an eye with no conveyor frame to bolt to (the turntable's, which slews; the layer eye
 * and the pallet-in-place eye, past a bed's end): a square galvanised post on a floor plate, the sensor's own bracket
 * bolted to its face. The bracket's toe stands across the beam beside the lens and below it (examples/parts/
 * _shared/sensorPhotoeye.js PHOTOEYE_BRACKET: from the housing's flank, halfX 0.0225, 0.052 wide; its back 0.01 past the
 * lens face; its top 0.025 below the sensor's origin), so the post stands there, a little toward the target and to
 * one side, and stops at the toe's top; the beam passes it. These are that geometry transcribed: the post's centre
 * in the sensor's own frame, and where its top is relative to the sensor's origin.
 *
 * A stopgap copy, like the bracket's own rail numbers: retire it when conveyors publish their rail profile and the
 * SDK's bracket helper draws from the seat a mount stores. Then a frame end can carry the layer and turntable eyes.
 */
const EYE_STAND_POST = 0.05
const EYE_STAND_SIDE = 0.0225 + 0.052 / 2
const EYE_STAND_INTO = EYE_LENS_Z + 0.01 + EYE_STAND_POST / 2
const EYE_STAND_TOP = -0.025
const EYE_STAND_PLATE = 0.16
/**
 * The top of an SDK fence post - where something bolted to a fence stands. Every run in this scene takes the
 * part's default 2 m height, and each post is finished with a 0.03 m cap (examples/parts/fence/part.js), so this is where
 * the steel actually ends rather than where the height param says it does. The status tower sits here.
 */
const FENCE_CAP_TOP_Y = 2 + 0.03
/**
 * Where the layer's far face is squared. This is a side guard on the row former, not a separate stop: the row
 * transfer pushes each row against the bed's own rail, the way a real one does. That makes it a property of the
 * bed rather than a part to place, so the bed's width and centreline are not free - see {@link BED_WIDTH}.
 *
 * The distance is set by the tighter of the two courses. A parked row has to stand clear of the arriving lane, and
 * how much room that needs depends on which row parked: a canonical course parks the 0.4 m straight row and
 * receives 0.6 m turned cases, while the mirrored course parks the 0.6 m turned row and receives 0.4 m straight
 * ones - 0.2 m less daylight. At 0.7 the mirrored course overlaps by 0.1 and its second row drives into the first;
 * 0.85 leaves both clear (0.15 canonical, 0.05 mirrored) and still puts the rows on the pattern's own dz offsets
 * either way round.
 */
const LAYER_STOP_Z = 0.85
/**
 * One bed width and centreline for the whole line, the infeed and the row former both. They are two conveyors
 * because they are driven separately (the row former stops while the arm lifts the layer off it; the infeed keeps
 * feeding), but they share a size: different widths put a step in the far rail at the seam, and that rail is the
 * datum a turning case squares against, so a step there is a lip for cargo to catch on where it is being turned.
 *
 * Both numbers are fixed by two edges:
 *  - the far rail is the turning datum (FAR_RAIL_Z), and
 *  - the +z guard face has to sit at the layer's far face, since that guard is the layer stop.
 */
const BED_WIDTH = LAYER_STOP_Z - GUARD_INSET - FAR_RAIL_Z
const BED_Z = FAR_RAIL_Z + BED_WIDTH / 2
/**
 * The case line's near (+z) steel: the L-rail's flange lip, not the deck edge and not the guard face. It is the
 * {@link PALLET_LINE_EAST_X} of this line: the face anything standing alongside the bed has to be measured off,
 * since {@link ROLLER_FRAME_PROUD} is what a deck-edge measurement misses.
 */
const BED_NEAR_FACE_Z = BED_Z + BED_WIDTH / 2 + ROLLER_FRAME_PROUD
/**
 * ...and the line's far (-z) steel, measured the same way. It is the face the guard line returns to on the north
 * side of the crossing, so it is the mirror of {@link BED_NEAR_FACE_Z} and not a number of its own.
 */
const BED_FAR_FACE_Z = BED_Z - BED_WIDTH / 2 - ROLLER_FRAME_PROUD
/**
 * The case line's near L-rail wall: the vertical side steel below the flange, which is what a device bolted to
 * the bed's flank rests against. Not {@link BED_NEAR_FACE_Z}: that is the flange lip, 0.02 m further out and only
 * at rail-top height, so a plate seated on it would stand off the wall it is supposed to be bolted to by that
 * much. It is the same face {@link LAYER_STOP_Z} names from the other side - the guard's inner face sits on this
 * wall, which is what {@link GUARD_INSET} measures.
 */
const BED_NEAR_WALL_Z = BED_Z + BED_WIDTH / 2 + GUARD_INSET
/**
 * A push button's box: the package draws it {@link PUSH_BUTTON_BOX} tall and square, its back plate
 * {@link BUTTON_PLATE_OFF} behind its origin (examples/parts/push-button, the `snap` mount).
 */
const PUSH_BUTTON_BOX = 0.09
const BUTTON_PLATE_OFF = 0.0317
/**
 * Where a push button's origin goes for its back plate to rest on that wall. The package draws its 0.09 m box
 * with the plate at z −0.0317, so the origin stands that far off the steel, and the 0.055 m deep housing then
 * stands proud of it the way a station box does.
 *
 * A drag does not put it here: `snapFaceMount` seats on the host's footprint face (the deck edge) plus the package's
 * own mount, 10 mm inside the steel, because a footprint knows nothing of {@link ROLLER_FRAME_PROUD}. This authors
 * the seat the steel offers.
 */
const BUTTON_Z = BED_NEAR_WALL_Z + BUTTON_PLATE_OFF
/**
 * ...and the height that plate rests at: the box's 0.09 m housing tucked up under the rail's top flange (5 mm
 * below the deck), on the upper half of the 0.17 m side wall (examples/parts/roller-conveyor `wallR`,
 * `frameHeight` default), the way a station is bolted to frame steel. That puts the caps at ~0.95 m, as high as
 * this steel goes. (The side guard's face would put them higher, but the station stays on the frame steel it is
 * bolted to.)
 */
const BUTTON_Y = SURFACE_H - 0.005 - PUSH_BUTTON_BOX
/**
 * Start, Stop and E-stop are one station: side by side at the box's own 0.09 m width plus a 20 mm gap, so one
 * operator standing at it reaches all three.
 */
const BUTTON_PITCH = 0.11
/** the station's first (Start) button: the infeed's upstream end, where the operator stands, clear of the release eye at x -1.5 */
const BUTTON_X0 = -1.2
/**
 * The line's other emergency stops, one at each place a person works it that the operator station's does not reach
 * (see the E-stops block at the end of the build). Those on the cell fence stand with the head at a standing
 * operator's hand, on a fence post: the part spaces its posts evenly, no more than {@link FENCE_MAX_SPAN} apart
 * (examples/parts/fence MAX_SPACING), so a run's posts are where the demo can compute them.
 */
const ESTOP_HEAD_Y = 1.1
const FENCE_MAX_SPAN = 1.5
/**
 * The trailer's E-stop clamps to the flex's load-end leg, whose top stands ~0.17 m under the rollers: its box is
 * hung with its top at the leg's, the head at ~0.79 m. That stand is the flex's first, at its origin, legs 44 mm
 * square at hw + 0.06 off the bed's centreline (examples/parts/flex-conveyor geometry(), `stand`).
 */
const FLEX_STATION_Y = SURFACE_H - 0.26
const FLEX_LEG_FACE = 0.06 + 0.022
/**
 * The chain deck spans the host bed, edge to edge, which is what the part's own snap fits it to
 * (snap.track.fitWidthScale = 1). So the cell authors the seat a snap would produce. Centred on the bed it then reaches to within the guard inset of the face it delivers
 * rows to, which is all the push needs: a row is pressed against the guard with its last 10 mm overhanging.
 */
const CHAIN_LANE_LENGTH = BED_WIDTH
/** the forming lane: the bed's own centreline, since nothing positions a case laterally - it rides where the bed is */
const LANE_Z = BED_Z


/**
 * The palletizer cell's south boundary - the fence run, and the painted line under it.
 *
 * It has to clear the far side of the line the arm picks from, because the layer, its guard and the arm's plate
 * all live out there: half a metre past the guard face leaves room for the gate leaf to swing out without
 * sweeping the conveyor, and keeps the fence out of the plate's own footprint when the arm is down on the layer.
 */
const CELL_SOUTH_Z = LAYER_STOP_Z + 0.5
/**
 * The cell's north boundary: the fence run, the painted line, and the edge the pallet outfeed leaves through.
 */
const CELL_NORTH_Z = -6.4
/**
 * How far the arm reaches in +x: the far edge of its swept envelope, measured off the running cell across the
 * home pose and all six trained waypoints (e2e/probes/arm-envelope.mjs prints its world AABB at each; the widest
 * is the pick apex, at 7.727). What reaches this way is the rear of the casting, not the plate: the arm faces
 * -x, so the counterweight swings out behind the shoulder while the tool works the line.
 *
 * It has to be measured: forward kinematics gives joint frames, not the shell hung on them, so nothing derivable
 * from the pose table knows where the back of the arm is, and a fence placed off it ends up inside the envelope.
 */
export const ARM_REACH_X = 7.73
/**
 * ...and how far it reaches the other way. -x is where the tool works rather than the counterweight: at the Pick
 * pose the vacuum plate (the size of the layer, 1.2 x 1.0) is down on the layer with its west edge here.
 *
 * Measured on the same instrument and for the same reason as {@link ARM_REACH_X} (e2e/probes/arm-envelope.mjs:
 * Pick and PickHigh both bottom out at x 3.062): nothing in the pose table says where a 1.2 m plate hung off the
 * wrist ends up.
 */
export const ARM_REACH_WEST_X = 3.06
/**
 * The cell's east boundary. The fence has to be outside the reach envelope, where the arm cannot hit it, so this
 * is {@link ARM_REACH_X} plus clearance rather than a number picked to make the cell a certain size. 0.77 m reads
 * as a real gap from any angle, and the rack line is then spaced off this edge rather than off the arm (see RACK_X).
 */
const CELL_EAST_X = 8.5
/**
 * Where the guard line crosses the case line: the west end of the south run, and the seam between the infeed
 * and the row former.
 *
 * A guard line crosses an infeed conveyor upstream of everything the robot reaches, product passing through the
 * opening rather than people. The arm picks the layer off the row former, reaching to {@link ARM_REACH_WEST_X},
 * so crossing at the row former's discharge end would leave the pick outside the steel. Here the row former, the
 * chain transfer and the layer are inside the cell and the infeed, plow and operator station outside, which is
 * also the line's own division of labour.
 *
 * Neither bed puts a leg at the seam: the infeed's last foot plate ends at 1.78 and the row former's first begins
 * at 2.22 (LEG_TAIL_OFFSET / LEG_SPACING / FOOT_PLATE_HALF_LEN in render/parts/common.ts), so a post at 2.0
 * stands centred in a 0.44 m gap.
 *
 * It is the cell's whole west edge: the same line carries on north of the case line to the north-west corner, one
 * straight edge broken only where a conveyor crosses it.
 *
 * The north runs do not share this number where they meet the pallet line. A fence end has to be spaced off what
 * it stands beside, and there it stands beside a bed's flank. See {@link OUTFEED_GAP_EAST_X}.
 */
const CELL_FENCE_WEST_X = 2.0
/**
 * Where the south run's guarding returns to the case line - the far end of the short panel that shuts the slot
 * between the fence line and the bed that carries cases across it.
 *
 * The south run stops at {@link CELL_FENCE_WEST_X} because the conveyor is what closes the boundary from there
 * on, which is right - but the two are not on the same line. The fence runs at {@link CELL_SOUTH_Z} and the bed's
 * near steel is at {@link BED_NEAR_FACE_Z}, half a metre short of it, so butting the run to the case line in x
 * alone left the corner post standing in open floor with a 0.389 m slot beside it: a person-wide way into an
 * interlocked cell that does not pass the gate, which is the one thing a guard line may not have. Where a
 * conveyor crosses a guard line the guarding returns to its rail; this is that return.
 *
 * Spaced the way {@link OUTFEED_GAP_EAST_X} is, and off the same kind of face - the bed's flank, so post
 * half-width plus a 50 mm reveal off the flange lip. The leg trestle reaches further out than the lip (0.089 vs
 * 0.03) but never at the crossing, which is a bed seam and so has no leg on either side of it - see
 * {@link CELL_FENCE_WEST_X} for the two foot plates it stands between.
 */
const CELL_FENCE_RETURN_Z = BED_NEAR_FACE_Z + FENCE_POST_HALF + 0.05
/**
 * ...and where it returns to the case line on the far side - the same handshake on the other flank, because a
 * conveyor crossing a guard line has two sides and the boundary has to return to both.
 *
 * Without it the north flank of the case line is walkable: round the west end of the infeed, back east under the
 * arm, and into the interlocked cell without passing the gate. (No truck uses this side: {@link RACK_ROUTE}.)
 *
 * Spaced off {@link BED_FAR_FACE_Z} exactly as {@link CELL_FENCE_RETURN_Z} is off the near one. The far rail
 * carries the row-complete eye, but that stands at x 3.21 - nowhere near the crossing.
 */
const CELL_FENCE_FAR_RETURN_Z = BED_FAR_FACE_Z - FENCE_POST_HALF - 0.05
/**
 * Where the painted boundary turns north - the same edge as the steel, so the same number. Paint and fence are
 * one boundary here; the marking is what says "this is the cell" from across the floor and the steel is what
 * enforces it, and they cannot describe different rectangles.
 *
 * Tied to the steel so the fence can never stand outside its own marking; it also clears the green build-station
 * box by 0.86 m.
 */
const CELL_ZONE_WEST_X = CELL_FENCE_WEST_X
const GATE_LEN = 1.1
/**
 * The access gate sits in the middle of the south run - hinge post at 4.70, latch post at 5.80 - so the two
 * fence runs flanking it are the same length.
 *
 * The SDK fence auto-spans its mesh at MAX_SPACING = 1.5 m (examples/parts/fence/part.js) and posts the span boundaries,
 * so an off-centre gate can leave one flank a hair over the limit, drawn as two short panels with a stray post.
 * Centred, at 2.0 -> 8.5 each flank is 2.70 m, two 1.35 m panels: one post rhythm across the whole south side.
 */
const GATE_X = (CELL_FENCE_WEST_X + CELL_EAST_X) / 2

/**
 * The pallet line: the deck the load is built on, and the conveyor that carries it out through a turntable to
 * the staging lane. It runs at one height end to end, level with the case line, because a pallet cannot step
 * between decks: whatever height the build deck is, the outfeed, the turntable and the staging lane are too.
 *
 * That height is the tightest number in the cell, and it is set by the arm rather than by the conveyors. The
 * pick never moves (a single 0.4 m layer on the case line, always 1.4 m), but the place climbs three courses
 * above the deck: level, the top one is placed at 2.34 m. Every pick and place still solves there. The lift-off above
 * the finished stack only just solves, which is why that apex is 0.22 m and the arm is 1.7x. scripts/palletizerWaypoints.mjs is the record: at 1.0 m exactly one
 * layout in 45 works, and it is this one.
 */
const PALLET_DECK_H = SURFACE_H
/** the pallet line's width - a EUR pallet is 1.22 x 1.02, so this clears it either way round */
const PALLET_LINE_W = 1.35
/** the build deck's run along the line. Shared: the outfeed butts its end, and the station's floor paint frames it */
const BUILD_DECK_LEN = 1.7
/** the turntable's square deck. Wider than the line: the load is never perfectly centred when it stops, and this
 *  is the slack that lets it index 90 degrees without a corner hanging off. */
const TURNTABLE_W = 1.6
/**
 * The plate radius: where a neighbouring lane butts, and not half the deck width. The part draws a round plate
 * that circumscribes its square powered deck (examples/parts/turntable-conveyor/rig.json: the deck cylinder's
 * radius is `width` x plateFactor/2, plateFactor 1.5), because that square has to be able to spin: the plate must
 * still be under the load's corners at 45 degrees. So the rim stands 0.4 m proud of the deck edge at 1.6 m wide,
 * and a lane butted at width/2 parks a third of a metre inside the disc, with its rollers buried in the plate.
 * This is the same end the editor's own snapping uses - core/parts/partGeometry.ts puts a rotating deck's ends at
 * +/-radius - so a lane placed here is where a drag would drop it. demoScenes.test.ts pins that.
 */
const TURNTABLE_R = (TURNTABLE_W * 1.5) / 2
/**
 * Where the line ends and the turntable begins. It sets the staging lane's line too (the lane runs east off the plate),
 * and that is what fixes it: the rack truck comes down the cross aisle facing the cell and pivots at the lane's lineup
 * to face the lane, so its bare forks swing toward the cell's north-east fence corner every trip. Each 0.75 m north
 * gives that swing about a metre more clearance and adds ~2 s of outfeed per load. At -8.0 it cleared by only 0.49 m.
 */
const TURNTABLE_Z = -8.75
/**
 * The wrap station on the outfeed: where a finished load stops to be stretch-wrapped before it leaves the cell. Three
 * things fix it. It is far enough down the outfeed that a load standing there has cleared the off-deck eye (its
 * trailing face is past deckEnd - 0.15 by half a metre), so the next empty pallet is already being fed while this one
 * is wrapped. The wrapper's arm sweeps a 1.45 m radius round the load (wide, so the web of film shows crossing to it),
 * and at z -4.9 that circle runs from -3.45 to -6.35: clear of the build deck's end (-3.05), inside the outfeed's
 * opening in the north fence (whose steel starts 0.79 m either side of the line, 1.7 m from the axis) short of its
 * light curtain (-6.53), and north of anywhere the palletizer's plate goes (its places stop short of -3.0). And its column stands on the east side, the side with open
 * floor: the west one has the cell fence 1.7 m from the line.
 */
const WRAP_Z = -4.9
/** how far each staging lane runs off the turntable */
const STAGE_LANE_LEN = 1.8

/**
 * The full 3-course load, derived from {@link LAYER_PATTERN}: course 0 and 2 laid as authored, course 1 the same layer
 * spun 180° about the load centre. That 180° is what interlocks the stack, and it is why the palletizer needs
 * only two wrist angles - a half-turn of the plate carries every case in the grip to its alternate slot.
 *
 * `turns` is in quarter-turns of the case itself: a straight case is 0 (or 2 after the spin) and a turned one
 * -1 (or 1), which is the same footprint either way - a box is symmetric under a half-turn - so a course only
 * ever presents the two orientations the bump turner produces.
 */
export const PALLET_STACK_PATTERN: { dx: number; dy: number; dz: number; turns: number }[] = Array.from({ length: COURSES }, (_, course) =>
  LAYER_PATTERN.map(({ dx, dz, turned }) => {
    const flip = course % 2 === 1 ? -1 : 1 // odd courses are the layer rotated a half-turn
    return {
      dx: LOAD_DX + flip * dx,
      dy: COURSE0_DY + course * CASE.height,
      dz: flip * dz,
      turns: (turned ? -1 : 0) + (flip < 0 ? 2 : 0),
    }
  }),
).flat()

/**
 * The cell, as one table of numbers - the scene, the robot's trained poses (scripts/palletizerWaypoints.mjs
 * solves against these exact values) and the program's calibration all read from here, so the layout can't
 * drift apart between them.
 */
export const CELL = {
  /** conveyor surface height: low enough that the pilot character (eye 1.7 m) can reach cases on it */
  surface: SURFACE_H,
  /**
   * The load centre in x, shared by the row former, the layer and the pallet. Both rows accumulate against the
   * same blade stop, so a 2-case row (centres ±0.3) and a 3-case row (centres -0.4, 0, +0.4) come to rest centred
   * on the same point - exactly the dx values the pattern asks for. Nothing has to position a case in x.
   */
  loadX: 3.7125,
  /**
   * How far the chain deck sits below the roller line when the chains are down. A conveys link that rides a joint
   * is built kinematic and re-posed from FK (world.ts attachRigConveyors), so the pop-up is real - but only if the
   * deck starts below the rollers. Seat it flush and the two surfaces are coplanar: a case then touches both, and
   * whichever is idle brakes it (a conveying surface at zero is not neutral). Dropped 0.03, cases ride the rollers
   * alone while a row builds, and the 0.095 m stroke lifts the finished row 0.065 clear of them to carry it.
   *
   * This is the part's own seat, not a demo-only correction: oip.chain-transfer declares the same recess as
   * `snap.track.targetLocalY`, so dragging one onto a roller bed in the editor puts it where this cell places it by
   * hand. demoScenes.test.ts pins the two together.
   */
  chainDropZ: 0.03,
  /** the blade stop the rows pack against; the row envelope is the 1.2 m upstream of it */
  rowStopX: 4.3125,
  /**
   * The forming lane: where the spawner drops every case and where both rows build. Nothing has to position a case
   * laterally (the spawner drops it centred and the rollers carry it straight), so the two rows form in the same
   * band, and one push of `pushZ` sets them flush.
   */
  laneZ: LANE_Z,
  /** the width of the whole line - infeed and row former alike - see {@link BED_WIDTH} */
  bedWidth: BED_WIDTH,
  /** the line's centreline, fixed between the turning datum rail and the guard face the layer squares on */
  bedZ: BED_Z,
  /** how far a guard's inner face - the surface cargo squares on - stands outside the deck edge */
  guardInset: GUARD_INSET,
  /**
   * How far the chain transfer pushes a finished row, and which way. The distance is what makes the two rows flush
   * given their different depths: the 0.4 m straight row is centred at ±0.2, the 0.6 m turned row at ±0.3, so
   * moving the first by 0.5 butts them exactly.
   *
   * The direction is +z, opposite the plow. A turning case is deflected -z as it pivots, so it does not always
   * come to rest dead-centre; push rows the same way and the next row forms straight into the one already parked
   * there. Pushing away from the deflection turns that collision into a small gap at worst.
   */
  pushZ: 0.5,
  /** how far a turned row drifts off the lane as it pivots - see {@link PLOW_DRIFT_Z} */
  plowDriftZ: PLOW_DRIFT_Z,
  /**
   * The finished layer's centre. Both rows are pushed: the first out to the guard, the second up against its
   * back - so the layer always ends 1.0 m deep with its far face on the guard.
   */
  layerZ: 0.35,
  /** the guard face the pushed row is pressed square against, on the far side from the plow */
  layerStopZ: LAYER_STOP_Z,
  /** the pallet build station */
  palletZ: -2.2,
  /** the pallet line's conveying height - the load is built on a deck, so it can leave under its own power */
  palletDeckH: PALLET_DECK_H,
} as const

/**
 * The palletizer arm: geometry + trained joint poses, solved offline by scripts/palletizerWaypoints.mjs against
 * the {@link cell} numbers above. The arm faces -X, which puts the transfer table and the pallet symmetric about
 * its centreline (±30° of base swing) instead of at the edge of its envelope.
 *
 * Every pose is tool-down with the vacuum plate's long axis on world X, so the 5 cases it lifts keep the layer's
 * own orientation. Down means exactly down, at the lift-off apexes as much as on the layer. The solver
 * is closed-form (every pose comes back at down = 1.000); an iterative one cannot tell "unreachable" from "not
 * converged" and returns apexes canted off level, so the arm carries the layer tilted. See the header of
 * palletizerWaypoints.mjs.
 *
 * The middle course is laid with the same wrist as the other two: the line reverses it (the row order flips),
 * so the interlock needs no extra wrist angle. The test editor/palletizerCell.test.ts re-validates these poses
 * through the shared forward kinematics, so a bad edit can't ship an arm that misses the layer, points
 * sideways, drives a joint onto its limit, or swings a carried layer through the stack it is building.
 */
export const PALLETIZER = {
  /**
   * A pedestal under the base. It is not cosmetic: it makes the top course reachable with the plate flat.
   * Holding the plate level needs j2 + j3 + j5 = 180°, so the further the arm has to reach up, the harder j5 (the wrist pitch, ±120°) is driven onto its stop; and three courses off a 1.0 m deck put the top
   * one at 2.34 m, well above this arm's 1.53 m shoulder. Raising the shoulder puts the whole working range
   * back inside the wrist's envelope, at ~3° of j5 per 100 mm of riser. 0.7 m leaves every joint 18° of travel
   * in hand at the tightest pose; without it, the pallet apex has no level solution at all.
   */
  robotPosition: [5.9, 0.7, -1.0] as [number, number, number],
  robotRotationY: Math.PI,
  /** how much of that y is the riser standing on the floor - the pedestal part is built to exactly this */
  pedestalHeight: 0.7,
  /**
   * 1.7x because the pallet line runs level with the case line: three courses off a 1.0 m deck put the top one at
   * 2.34 m, and a 1.5x arm solves every pick and place there but not the lift-off above it.
   */
  robotScale: 1.7,
  /**
   * The idle pose, solved like a real one - squared between the two stations on the base's own centreline
   * (j1 = -0.5), standing tall with the plate dead level and a metre of air under it.
   *
   * Not borrowed from a waypoint: an apex is only a lift-off above the layer, so parking on one leaves the arm
   * idling hunched over the table as though it were already picking. This one is solved to its own target,
   * clear of the table by 1.05 m.
   *
   * It is also not the SDK's generic default, which folds the elbow the other way (j3 +90 against these poses'
   * -43) and makes the arm flip its elbow through 130-odd degrees on the way to its first pick.
   */
  home: [-0.527, -24.644, -89.81, 0, -65.546, -0.527],
  waypoints: [
    // The lift-off apex, 1.1 m over the line. It is that tall for the carry, not for the pick. An apex is a
    // blend via-point: the arm hands off before reaching it (examples/parts/six-axis-robot), so a short leg like
    // this one is mostly blended away and the layer begins its swing well below the pose. Walked as flown, a
    // 0.7 m apex sent the third course across 19 mm into the second; at 1.1 the flown path keeps 63 mm of
    // daylight over a finished stack. scripts/palletizerWaypoints.mjs sweeps it, palletizerCell.test.ts pins it.
    { name: 'PickHigh', pose: [31.373, -51.018, -43.032, 0, -85.95, 31.373] }, //    index 1: apex over the layer
    { name: 'Pick', pose: [31.373, -57.346, -51.132, 0, -71.522, 31.373] }, //       index 2: plate down on the layer
    { name: 'PlaceHigh', pose: [-29.065, -47.616, -30.183, 0, -102.201, -29.065] }, // index 3: apex over the pallet
    { name: 'Place1', pose: [-29.065, -53.711, -54.291, 0, -71.998, -29.065] }, //   index 4: course 1
    { name: 'Place2', pose: [-29.065, -49.792, -50.028, 0, -80.18, -29.065] }, //    index 5: course 2 (same wrist)
    { name: 'Place3', pose: [-29.065, -47.47, -42.987, 0, -89.543, -29.065] }, //    index 6: course 3
  ],
  /**
   * The plate, which is also its pickup volume (C-multigrab grabZone). Authored in the arm's own units and then
   * multiplied by robotScale, like every other rig dimension - so to draw a plate the size of the layer these are
   * the layer divided by the scale. Author the layer size here directly and a 1.5x arm carries a 1.8 m plate.
   */
  toolSizeX: 1.2 / 1.7,
  toolSizeZ: 1.0 / 1.7,
} as const

/** The robot's waypoint rows: home, then PALLETIZER.waypoints in order (so PickHigh is row 1). */
export const palletizerRow = (name: string): number => {
  const i = PALLETIZER.waypoints.findIndex((w) => w.name === name)
  if (i < 0) throw new Error(`no palletizer waypoint ${name}`)
  return i + 1
}
/** What the robot's Inspector calls each waypoint row. */
export const PALLETIZER_WAYPOINT_NAMES = [
  'Home',
  ...PALLETIZER.waypoints.map((w) => (w.name === 'PickHigh' ? 'Above pick' : w.name === 'PlaceHigh' ? 'Above pallet' : w.name.replace(/^Place(\d)$/, 'Course $1'))),
]
/** The robot's job names: the PLC runs job 1 to pick and job 2 + n to place course n. */
export const PALLETIZER_JOB_NAMES = ['Pick layer', ...Array.from({ length: COURSES }, (_, n) => `Place course ${n + 1}`)]
// the robot's job ops (examples/parts/six-axis-robot, JOB_OPS)
const MOVE = 1
const VACUUM = 2
const WAIT = 3
const STOP = 0
const BLEND = 1
/**
 * The palletizer's jobs, the robot's own programs (its `jobs` param, rows `[job, op, a, b]`). Pick: over the layer,
 * down onto it, vacuum, a moment for the cups to seal, and up to the apex, which it blends through, so the job reports
 * done on the way up and the PLC's place job carries straight on into the swing. Place n: over the pallet, down onto
 * course n, release, a moment to let go, up and home. The apexes are pass-through points in both; the layer and the
 * courses are exact stops.
 */
export const PALLETIZER_JOBS: number[][] = [
  [0, MOVE, palletizerRow('PickHigh'), BLEND],
  [0, MOVE, palletizerRow('Pick'), STOP],
  [0, VACUUM, 1, 0],
  [0, WAIT, 0.4, 0],
  [0, MOVE, palletizerRow('PickHigh'), BLEND],
  ...Array.from({ length: COURSES }, (_, n) => [
    [1 + n, MOVE, palletizerRow('PlaceHigh'), BLEND],
    [1 + n, MOVE, palletizerRow(`Place${n + 1}`), STOP],
    [1 + n, VACUUM, 0, 0],
    [1 + n, WAIT, 0.4, 0],
    [1 + n, MOVE, palletizerRow('PlaceHigh'), BLEND],
    [1 + n, MOVE, 0, STOP],
  ]).flat(),
]

/**
 * The turning circle a pallet truck sweeps when it pivots on the spot. Every standoff in this file, and the aisle
 * the racks stand off, is sized against this radius.
 *
 * Derived from the two shapes, so it cannot go stale: the far corner of a carried load (it rides
 * {@link AGV_LOAD_AHEAD} ahead with its 1.02 m width along the blades and its 1.22 m length across them), or the
 * far corner of the empty blades, whichever reaches further. The blades (2.08 m of tine with the outer edge
 * 0.42 m off the centreline) reach further, which is why it takes the max: a truck sweeps its widest when it is carrying
 * nothing, and sizing the standoffs on the load alone leaves them 70 mm too tight.
 *
 * Don't copy the figure into prose: a swing radius says whether a truck can turn somewhere, so a stale one either
 * makes a workable route look impossible or ships a truck that swings through a rack.
 */
export const SWING_RADIUS = Math.max(
  Math.hypot(AGV_LOAD_AHEAD + PALLET_SIZE[2] / 2, PALLET_SIZE[0] / 2), //          a carried load's far corner
  Math.hypot(AGV_TINE_HEEL + AGV_TINE_LENGTH, AGV_TINE_OFFSET + AGV_TINE_WIDTH / 2), // ...or a bare blade tip
)
/** the daylight a truck keeps off a rack or a lane when it turns beside one - enough to read as clearance */
export const TURN_CLEARANCE = 0.5

/**
 * The rack line: three runs of selective pallet racking down the +x side, spaced in z with a wide aisle between
 * each pair.
 *
 * These are defined here with the routes rather than in the dressing that draws them, because the trucks put
 * loads away on them. A truck's placement depends on this rack (which position is free, how deep its frame is,
 * how high its beams stand), and a rack moved without the routes makes a truck drive into an upright.
 *
 * Sized for the one load this floor handles, as real racking is specified: every pallet here, stock and delivery
 * alike, stands with its 1.22 m (48 in) side along the beams and 1.02 m (40 in) deep. So two to a bay on 108 in
 * beams, with about 0.09 m (3.7 in) between pallet and pallet and pallet and upright, on a 0.9 m (36 in) frame the
 * pallet overhangs by 60 mm front and back - the usual rule, frame = pallet depth less 6 in. Three bays to a run.
 */
const RACK_BAY = 2.8 //            oip.rack's poleInterval, set below: an end frame every 2.8 m, one bay
const RACK_LEN = 3 * RACK_BAY
const RACK_SHELF_SPACING = 1.6
/** the rack's frame depth, front upright to back upright, set below */
const RACK_DEPTH = 0.9
/** half a rack's footprint in x: its authored length, plus the half-thickness of the 0.08 end uprights that
 *  stand on each end line - so the face a load or a person meets is RACK_X ± this, not ± RACK_LEN / 2 */
const RACK_HALF_X = RACK_LEN / 2 + 0.04
/** ...and half its footprint in z, the same way: RACK_DEPTH plus the front/back uprights' half-thickness. This
 *  is the face a truck lines up on and reverses out to, so it is what the bay standoff is measured from. */
const RACK_HALF_Z = RACK_DEPTH / 2 + 0.04
/**
 * The gap between the palletizer cell's east fence and the rack line's west face: a truck's full turning circle
 * (2 x {@link SWING_RADIUS}) plus clearance. The staging lane discharges at this aisle's north mouth, and the truck
 * serving it pivots 150° there with a load every trip, sweeping ~2.12 m; a narrower aisle turns its blades through
 * the rack's corner upright. demoScenes.test.ts walks both routes and pins the clearances.
 */
const CELL_RACK_AISLE = 2 * SWING_RADIUS + TURN_CLEARANCE
/**
 * The line's centre in x (a rack's length runs along x at rotationY 0), spaced off the cell's east edge by
 * {@link CELL_RACK_AISLE} rather than chosen, so the racks can never crowd the cell's fence or painted border.
 */
const RACK_X = CELL_EAST_X + CELL_RACK_AISLE + RACK_HALF_X
const RACK_Z = [-14.68, -6.7, 1.27] as const
/** half the storage zone's painted length: the rack line plus 0.5 m of floor past each end */
const STORAGE_ZONE_HALF_X = RACK_LEN / 2 + 0.5
/** the storage zone's painted border width */
const STORAGE_ZONE_BORDER = 0.12
/** the clearance either side of each pallet in a bay: the beam span (between 0.08 uprights) less two loads, in
 *  three equal gaps */
const RACK_PALLET_GAP = (RACK_BAY - 0.08 - 2 * PALLET_SIZE[0]) / 3
/** the six pallet positions along a run, west to east: two in each of its three bays, each standing one gap off
 *  the upright beside it and one gap off its neighbour */
const RACK_SPOTS = [-1, 0, 1].flatMap((b) =>
  [-1, 1].map((s) => RACK_X + b * RACK_BAY + s * (RACK_PALLET_GAP / 2 + PALLET_SIZE[0] / 2)))
/** shelf `level`'s slab top (1 = the bottom shelf): where a pallet stands (level x spacing + half the 0.04 slab,
 *  examples/parts/rack/part.js) */
const rackShelfTop = (level: number): number => level * RACK_SHELF_SPACING + 0.02
/** ...and the top of that level's shelf-edge lip beams (0.08 square, centred on the shelf level), which stand
 *  0.02 proud of the slab - so they, not the slab, are what a load and the tines under it clear on the way in */
const rackLipTop = (level: number): number => level * RACK_SHELF_SPACING + 0.04
/** the bottom shelf's slab top - where the dressing stock stands */
const RACK_SHELF_TOP = rackShelfTop(1)
/**
 * The shelf levels the rack truck puts away on: the bottom two of the rack's four. Not all four, because of the
 * truck's mast rather than its lift: AGV.glb's mast is a fixed 2.8 m with one inner stage riding at half the lift,
 * so the carriage climbs clear of it past ~5.5 m. Level 2 (forks at ~3.3 m) keeps the carriage on the stage; level 3
 * would leave 0.3 m of it and level 4 would float the carriage above the mast. Levels 3-4 stay racked stock, served
 * by nothing - which is also what a real warehouse's top beams look like from a counterbalance truck.
 */
const RACK_LEVELS = [1, 2] as const

// ---- the viewing gallery + its access stair ----------------------------------------------------------------------
/** the shell's south wall (its +z face, as placed round the receiving door: its centre 2.25 m off the door along the
 *  dock, half its 30 m length on) */
const SHELL_SOUTH_Z = CELL.laneZ - 2.25 + 15
/** ...and its north wall, the shell's 30 m depth (3 sections) away: the one the rack line backs onto */
const SHELL_NORTH_Z = SHELL_SOUTH_Z - 30
/**
 * How far the shell's wall columns stand in from the cladding's inner face: 1.0 m (measured off the rendered framing,
 * which is the GLB wall module's, not the procedural fallback's 0.24). Anything along the wall stands off these,
 * or a column and its X-brace run through it.
 */
const SHELL_COLUMN_PROUD = 1.0
const GALLERY_W = 1.9
/** the pedestrian walkway's painted width */
const WALK_W = 1.4
/** the walkway's main leg's centreline: its near edge ~0.5 m clear of the turner's stand (which reaches z 3.125) and
 *  the gate's caution marking on the line's south side, so the walkway never leads people into the plow;
 *  demoScenes.test.ts holds the clearance. */
const WALK_Z = 4.3
/**
 * How far a painted zone border stands off the wall columns' faces. Paint closer than this reads as a line drawn
 * round the column rather than a zone beside it; demoScenes.test.ts holds every marking to it.
 */
const PAINT_COLUMN_CLEAR = 0.25
/**
 * the stair's foot, where the walkway's south leg ends: the gallery runs east from its head. The leg runs down the
 * west side of the stair, between it and the dock wall, so this is set by the dock wall's columns: they stand
 * SHELL_COLUMN_PROUD in from the wall line there too (their X-brace feet 0.6), and the leg keeps 0.3 m off their faces.
 */
const GALLERY_STAIR_FOOT_X = DOCK_WALL_X + SHELL_COLUMN_PROUD + 0.3 + WALK_W
const GALLERY_STAIR_W = 1.2
/** 17 standard risers. The deck stands at exactly their height, so the flight meets it with no part-step for the
 *  deck connection's lift to take up (it lifts only LANDING_CLEARANCE) and every step is the same height */
const GALLERY_STEPS = 17
/** deck elevation, 3.03 m: high enough to see over the 2 m cell fence into the build deck. The platform's origin is
 *  the deck top, so this is also its y */
const GALLERY_H = GALLERY_STEPS * STAIRS_STANDARD_RISE
/**
 * The stair's seat: the distance from its foot to the point that has to butt the deck edge. That point is the top of
 * the run: the stairs' edgeMount contact (`at`), which `snapFeatures` seats on the edge and
 * `structureConnections` measures when it decides whether the top is connected. Connected, the stair drops its own
 * top landing and the deck is the landing.
 *
 * Getting this wrong fails silently and completely: a seat off the edge by more than the 0.15 m contact tolerance makes no
 * connection, so the platform keeps its west railing closed across the head of the flight (and that railing
 * carries the only collidable link in the assembly, so the deck is genuinely unreachable), the stair keeps a
 * landing standing on or beside the deck, and the flight stays unlifted below the deck.
 */
const GALLERY_STAIR_SEAT = GALLERY_STEPS * STAIRS_STANDARD_TREAD
/** ...so the foot stands a full seat back from the deck's west edge, and the flight ascends +x into it */
const GALLERY_STAIR_X = GALLERY_STAIR_FOOT_X
/** the deck runs east from the head of the west flight... */
const GALLERY_WEST_X = GALLERY_STAIR_X + GALLERY_STAIR_SEAT
/**
 * ...to where the east flight, descending east, puts its foot 1 m clear of the exit leg: that leg runs down to the
 * personnel door at EXIT_X, WALK_W wide. It ends past the arm, so the deck still spans the line and the build station.
 */
const EXIT_X = DOCK_WALL_X + (EXIT_CELL - SOUTH_WALL_FIRST_CELL) * BUILDING_SECTION_SIZE + PERSONNEL_DOOR_AT
const GALLERY_EAST_X = EXIT_X - WALK_W / 2 - 1.0 - GALLERY_STAIR_SEAT
const GALLERY_LEN = GALLERY_EAST_X - GALLERY_WEST_X
const GALLERY_X = GALLERY_WEST_X + GALLERY_LEN / 2
/** just south of the walkway, its deck edge (and the stair's north flank) 0.5 m off the walkway's paint, so its
 *  columns and the flight stand clear of the route people walk */
const GALLERY_Z = WALK_Z + WALK_W / 2 + 0.5 + GALLERY_W / 2

// ---- impact protection ----------------------------------------------------------------------------------------
/** a rack end protector's post radius: its base plate (4.5 radii across, 0.27 m) has to fit the 0.34 m of bare floor
 *  between the end frame and the storage zone's border */
const RACK_BOLLARD_R = 0.06
/** ...so its centre stands in the middle of that strip, its plate on neither the paint nor the frame */
const RACK_BOLLARD_OFF = (STORAGE_ZONE_HALF_X - STORAGE_ZONE_BORDER - RACK_HALF_X) / 2
/** the exit door's keep-clear area stops this far short of the wall's inner face: clear of the door frame, which
 *  stands 0.05 m proud */
const EXIT_PAINT_OFF = 0.15
/** ...and is this wide along the wall (the 1.0 m door and frame with 0.3 m either side) and this deep into the room */
const EXIT_KEEP_CLEAR_W = 1.6
const EXIT_KEEP_CLEAR_D = 1.2
/** the depth of the hazard stop bar that ends the walkway at the outbound staging */
const WALK_STOP_W = 0.4
/** the walkway guard rail's centreline, off the walkway's north edge */
const WALK_RAIL_OFF = 0.1

/**
 * Where a carried load rides, in the truck's own frame - derived from the two shapes, not measured off a run.
 *
 * A pallet's fork pockets are real (core PALLET_BLOCK_*, sim/world palletShape), so the blades go all the way in
 * and the load ends up in the one place the geometry allows: centred on the blade, hanging in the pocket. Both
 * numbers are derived from core/types, and `rise` is negative because the blade is inside the pallet rather than under
 * it, so the load's underside sits below the lift datum. Keep it derived: a carry offset measured off a run goes
 * stale silently when the lane or turntable changes.
 */
export const CARRY = { fwd: AGV_LOAD_AHEAD, left: 0, rise: AGV_LOAD_UNDER_LIFT } as const
/** heading 0 = +x and -90 = +z, the AGV behavior's convention (yaw = atan2(-forward.z, forward.x)) */
const headingAxes = (deg: number): { fx: number; fz: number; lx: number; lz: number } => {
  const yaw = (deg * Math.PI) / 180
  const fx = Math.cos(yaw), fz = -Math.sin(yaw)
  return { fx, fz, lx: -fz, lz: fx }
}
/** where the load stands when the truck holding it is at (x, z) facing `deg` */
export const carriedLoadSpot = (x: number, z: number, deg: number): [number, number] => {
  const { fx, fz, lx, lz } = headingAxes(deg)
  return [x + CARRY.fwd * fx + CARRY.left * lx, z + CARRY.fwd * fz + CARRY.left * lz]
}
/** ...and its inverse: the spot a truck must stand on, facing `deg`, for its load to end up at (x, z) */
const standFor = (x: number, z: number, deg: number): [number, number] => {
  const { fx, fz, lx, lz } = headingAxes(deg)
  return [x - CARRY.fwd * fx - CARRY.left * lx, z - CARRY.fwd * fz - CARRY.left * lz]
}

/**
 * The fork heights the routes are written in. A load rides {@link carry}.rise from the lift datum, so each of
 * these except the two enter/withdraw heights sets where the load's underside goes:
 * `liftFor(h)` is "hold the load's underside at h".
 *
 * The two exceptions are the heights at which the blade is threading a pocket with nothing on it yet (or nothing
 * on it any more). There the blade's own span is what has to clear, so they are written against it.
 */
const liftFor = (loadUnderside: number): number => loadUnderside - CARRY.rise
/** blade centred in the pocket of a load standing on a surface at `standing` - the height it drives in at */
const forkEnter = (standing: number): number =>
  standing + (PALLET_POCKET_HEIGHT - AGV_TINE_THICKNESS) / 2 - AGV_TINE_RISE
/** ...and the height it withdraws at: blade still in the pocket of a load now standing on `standing`, but off it
 * - low enough not to drag the load out, high enough to stay clear of what the load is standing on */
const forkWithdraw = (standing: number): number => standing + 0.03 - AGV_TINE_RISE

const FORK_ENTER = forkEnter(PALLET_DECK_H) //         thread the pockets of a load standing on the lane deck
const FORK_CARRY = liftFor(PALLET_DECK_H + 0.05) //    ...then pick it up off the lane
/** stand the load down on shelf `level`'s slab */
const forkShelf = (level: number): number => liftFor(rackShelfTop(level))
/** in over the beams: the load is what has to clear the lip now, and it hangs below the blade, so it sets this */
const forkOver = (level: number): number => liftFor(rackLipTop(level) + 0.02)
/** and back out through the pockets, above the slab: dropping the tines to withdraw drags them through the shelf
 *  the load was just set on. */
const forkWithdrawShelf = (level: number): number => forkWithdraw(rackShelfTop(level))
/**
 * How far off the bay a truck lines up - the spot it drives to, turns on, and later reverses back to.
 *
 * It is the truck's swing that sets it, so it is derived from it rather than typed: the lineup stands
 * `CARRY.fwd` back from the bay centre already, of which {@link RACK_HALF_Z} is inside the rack's own
 * footprint, so the standoff adds the rest of {@link SWING_RADIUS} plus {@link TURN_CLEARANCE}.
 * At the bay itself the truck is 0.71 m off the rack's front face, so one that arrives and turns there sweeps
 * straight through the uprights and through whatever is standing in the next bay along. Lined up back here it
 * turns 2.62 m clear of the face, then drives straight in and straight back out, and nothing ever swings
 * inside the rack. It is sized off SWING_RADIUS, not the load's swing, because the truck turns for home with
 * bare blades; `agvRouteClearance` in demoScenes.test.ts holds it. It must stay inside the AGV's reverseRange so
 * the withdrawal is a reverse and not a turn (the test pins that too).
 */
const RACK_STANDOFF = SWING_RADIUS + TURN_CLEARANCE - (CARRY.fwd - RACK_HALF_Z)

/**
 * The rack truck's route, as [worldX, worldZ, headingDeg, forkHeight] rows.
 *
 * It never goes near the palletizer. The finished load leaves the cell on the pallet line under its own power, and
 * the truck only serves the end of the staging lane: drive to it, fork up, carry it to the racks, put it away. The
 * lane lets the line put a load down and go straight back to building the next one without waiting for a truck.
 *
 * The truck drives its blades into the load, because a pallet has fork pockets it can drive them into (core
 * PALLET_BLOCK_*, sim/world palletShape). Both ends of the run are the sequence a real truck uses, and both are
 * the same shape: line up clear, set the blade to pocket height standing still, drive straight in, take the
 * weight (or set it down), reverse straight out. Nothing is ever raised or lowered while it is inside something.
 *
 * Row 0 is home, and the truck is placed there - see the note in createPlcDemoScene about why it is derived
 * from the route rather than written out a second time as a position.
 *
 * A pick is five rows and a put-away four, and the row that matters most in each is the one that does nothing but
 * change height at a spot the truck is already standing on, clear of everything: raising the tines once they are
 * inside the staging conveyor sweeps them through its bed, and arriving with them raised but not at pocket height
 * rams the load down the lane.
 *
 * It puts loads away in the near rack's aisle face, all six pallet positions on its bottom two levels
 * ({@link RACK_LEVELS}), filling them in turn from the west so a later delivery is not set down on an earlier one. The
 * quarter turn from the lane to the rack stands each load the other way round from the dressing loads, on the same
 * footprint: 1.22 m along the beams, 1.02 m deep.
 */
/**
 * How far back down the lane a truck lines up to pick - the spot it turns on, raises its blades on, and reverses
 * back to with the load. Same job as {@link RACK_STANDOFF} and set the same way, by the swing.
 *
 * This lineup is the tightest spot on the floor: it stands between the palletizer cell's north-east fence post
 * and the rack line's west end, and the truck pivots there from facing south to facing west, sweeping the
 * south-west quadrant where that post stands. Standing further back is the only way to clear it.
 *
 * It is capped by the withdrawal, which must stay a straight reverse: past the AGV's `reverseRange` the truck
 * turns round instead and sweeps its load back across the lane. 3.05 m needs a truck told it can back out that
 * far, which the demo's two are (reverseRange 3.5 where the part's default is 3).
 */
const LANE_STANDOFF = 3.05
/** ...and what the trucks are told, so that back-out stays a reverse (see above; the part's default is 3) */
const AGV_REVERSE_RANGE = 3.5
/**
 * How far a staged load coasts past its eye. A diffuse eye stops the lane when the load's leading face breaks the
 * beam, and it rolls a little further before the rollers let go - measured once: on the lane a load settled with its
 * leading face at x 6.224 against a beam at 6.200. One number for the lane, since it is the same lane speed,
 * load and eye, and the only measured quantity left in the trucks' geometry.
 *
 * If it drifts, e2e/verify-agv-lane-pick.mjs is what says so: it prints how far the blade ends up through the
 * pallet, and fails outright once a truck is lining up short enough to be reaching for the load rather than
 * carrying it. Re-measure by reading that number rather than by eye.
 */
const LANE_COAST = 0.024
const PALLET_X = CELL.loadX - LOAD_DX // the pallet line's centre in x - build deck, outfeed, both turntables
/**
 * The rack aisle's line: the z the rack truck drives the aisle on, and the line its charge bay and the near rack's
 * lineups stand on. A turning circle off that rack's south face, for the same reason as {@link RACK_STANDOFF}.
 */
const RACK_AISLE_Z = RACK_Z[0] + RACK_HALF_Z + SWING_RADIUS + TURN_CLEARANCE
/**
 * The staging lane's far end. It runs +x off the turntable, toward the racks, so a truck picks from it standing on
 * the cross aisle it already drives.
 *
 * One lane is enough: a load leaves the cell every ~78 s and the truck clears the lane ~20 s after it arrives, so a
 * second lane would never buffer anything. If the cell ever outruns the truck, add a truck or lengthen this lane;
 * a lane pointing away from the racks can only be reached round its back, past the wall columns.
 */
const LANE_END_X = PALLET_X + TURNTABLE_R + STAGE_LANE_LEN
/** the pallet line's east edge: the outer face of its frame flange ({@link ROLLER_FRAME_PROUD}), not its deck edge */
const PALLET_LINE_EAST_X = PALLET_X + PALLET_LINE_W / 2 + ROLLER_FRAME_PROUD
/** ...and its west edge, the same way: the other side of the opening the outfeed leaves the cell through */
const PALLET_LINE_WEST_X = PALLET_X - PALLET_LINE_W / 2 - ROLLER_FRAME_PROUD
/**
 * The outfeed opening in the north run: the two posts that stand either side of the gap the finished load leaves
 * the cell through, and the second of the boundary's two conveyor crossings (the first is {@link CELL_FENCE_WEST_X}).
 *
 * They are measured off the pallet line's steel rather than off its deck, because a bed's flank has two terms a
 * deck-edge measurement misses: the side rail and its lip (a post spaced off the deck edge stands inside the bed's
 * rail and leg trestle). Both terms are counted here, and then a reveal on top: 50 mm, the smallest that reads as
 * steel beside steel from across the cell rather than as a touch.
 *
 * What closes the opening itself is the outfeed bed, the same way the case line closes its own crossing: 80 mm of
 * reveal either side of 1.41 m of conveyor, so there is nothing a person fits through.
 */
const OUTFEED_GAP_EAST_X = PALLET_LINE_EAST_X + FENCE_POST_HALF + 0.05
const OUTFEED_GAP_WEST_X = PALLET_LINE_WEST_X - FENCE_POST_HALF - 0.05
/**
 * The pallet supply. Empty pallets come from a dispenser outside the cell: a magazine that sets one down on its own
 * infeed, which carries it in through the west fence to the build deck's flank, where a pop-up chain transfer takes it
 * across the deck against an end stop. The dispenser cannot stand in line with the deck, where one usually goes: the
 * case line runs 0.6 m past the deck's south end and the outfeed leaves its north end, so the only way on is across.
 *
 * The transfer is seated like the layer former, {@link cell}.chainDropZ below the rollers, so its 0.095 m stroke
 * raises the chain tops {@link PALLET_XFER_RISE} above the deck. The infeed runs at exactly that height: a pallet
 * steps off its last roller onto the raised chains, and when they drop it is standing on the deck's own rollers.
 */
const PALLET_XFER_RISE = 0.095 - CELL.chainDropZ
const PALLET_INFEED_H = PALLET_DECK_H + PALLET_XFER_RISE
/**
 * The dispenser's centre: a loaded truck's turning circle west of the fence. The supply truck turns on this line,
 * just north of the machine, to face into its open side (see SUPPLY_ROUTE), and its blades sweep SWING_RADIUS
 * wherever it turns, so this spacing keeps them out of the cell's fence while it does.
 */
/** how far a fence run's steel stands off its line: its posts and their caps, rounded up (examples/parts/fence/part.js) */
const FENCE_STEEL_HALF = 0.05
const DISPENSER_X = CELL_FENCE_WEST_X - FENCE_STEEL_HALF - SWING_RADIUS - TURN_CLEARANCE
/**
 * The infeed's width. Narrower than the pallet line (which clears a pallet either way round) because every pallet
 * on it travels the same way, 1.22 m along it - and because the supply truck reaches a stack in over its north side:
 * a truck's chassis stops 0.135 m short of its load, so a side rail wider than the pallet by more than that is a rail
 * the truck drives into. 1.1 m leaves it 0.065 m.
 */
const PALLET_INFEED_W = 1.1
/** the infeed: from just behind the dispenser's bay, through the fence, to the build deck's west flank */
const PALLET_INFEED_TAIL_X = DISPENSER_X - 0.62
const PALLET_INFEED_HEAD_X = PALLET_LINE_WEST_X
/** The infeed opening in the west run, measured the way the outfeed's is: off the infeed's steel, plus the reveal */
const INFEED_GAP_SOUTH_Z = CELL.palletZ + PALLET_INFEED_W / 2 + ROLLER_FRAME_PROUD + FENCE_POST_HALF + 0.05
const INFEED_GAP_NORTH_Z = CELL.palletZ - PALLET_INFEED_W / 2 - ROLLER_FRAME_PROUD - FENCE_POST_HALF - 0.05
/**
 * The light curtains, one at each of the three openings above: the case line's crossing, the pallet infeed's and the
 * outfeed's. The bed closes each opening below its deck, but above the deck it is open to the height of the fence, and
 * that column of air is the way into the cell that does not pass the gate. Real guarding puts a muted light curtain in
 * it, which is what these are (examples/parts/light-curtain): the program mutes the curtain for a load on its way
 * through (MutingSeq, reading two photo-eyes on the conveyor blocked in order), and anything else in a beam drops the
 * line's run permit (the program's `running`), so it needs a Start to come back.
 *
 * Each stands on the fence's outside, its columns in line with the opening's two fence end posts and set back from
 * the fence line far enough for its floor plates to clear theirs: fence plate half (0.06) + curtain plate half
 * (0.055) + 15 mm. The case line's crossing is a bed seam with no leg for 0.22 m either side of it (see
 * {@link CELL_FENCE_WEST_X}), and that setback puts the plates inside the gap.
 */
const CURTAIN_SETBACK = 0.13
/** a curtain column's half-width across the opening (the part's 0.036 m profile), so its width is the post gap less both */
const CURTAIN_COLUMN_HALF = 0.018
/** the lowest beam, over the conveying surface: nothing passes between that and the deck */
const CURTAIN_OVER_DECK = 0.1
/** from the lowest beam to the highest: on a 1.0 m deck that is 1.9 m up, and the columns top out at 2.0, level with the fence */
const CURTAIN_SPAN = 0.8
/** the curtain's `width` for an opening whose end posts stand at `a` and `b` */
const curtainWidth = (a: number, b: number): number => Math.abs(a - b) - 2 * CURTAIN_COLUMN_HALF
/** the end stop's face, where a pallet centred on the build station has its east face */
const PALLET_STOP_FACE_X = PALLET_X + PALLET_SIZE[0] / 2
/**
 * The transfer's centre along the deck: the roller gap nearest the station. Its lanes are two roller pitches apart
 * and odd in number, so with the middle one in a gap every lane stands in one (the deck's rollers sit on the world
 * pitch grid, z = k x pitch, because it runs along -z).
 */
const PALLET_XFER_Z = (Math.floor(CELL.palletZ / ROLLER_PITCH) + 0.5) * ROLLER_PITCH
/**
 * The staging lane's eye, defined here because it is shared: it stops a load, so it also fixes the spot the
 * truck stands on to pick it up (see {@link pickRows}). Written in one place so the two
 * cannot disagree; createPlcDemoScene places the sensor at these same coordinates.
 *
 * It is placed by where it should leave the load rather than at a chosen offset: right down at the discharge
 * end, {@link LANE_STAGE_CLEARANCE} short of running off it, so the load is presented at the end the way a real
 * staging lane does and the truck does not reach across bare roller to get it.
 */
const LANE_STAGE_CLEARANCE = 0.08
const LANE_EYE_X = LANE_END_X - LANE_STAGE_CLEARANCE - LANE_COAST
/**
 * One lane's pick, as five rows. `beam` is where the eye sits along the lane and `dir` which way the load runs
 * (+1 or −1), so the load's resting centre - and with it the spot the truck must stand on to have the load
 * centred on its blade - comes off the lane's own eye rather than a hand-typed position.
 *
 * A load presents its 1.02 m width down the lane (after the turntable's quarter turn), so a truck coming up
 * the lane meets its long face and its blades line up with the pockets spaced along the pallet's 1.22 m length -
 * 0.46 m of channel for a 0.11 m blade. core/palletForkFit.test.ts pins that.
 */
const pickRows = (beam: number, dir: 1 | -1, deg: number, across: number): number[][] => {
  const { fx, fz } = headingAxes(deg)
  // the leading face stops on the beam (plus its coast), so the load's centre is half a pallet behind that -
  // upstream, back the way it came. Add that half instead of subtracting it and the truck lines up a metre past
  // where the load actually is, reaching for it with the very tip of its blades.
  const loadCentre = beam + dir * LANE_COAST - dir * (PALLET_SIZE[2] / 2)
  //   ...and the truck stands CARRY.fwd short of it, facing back up the lane (so it drives against `dir`)
  const along = loadCentre + dir * CARRY.fwd
  const spot = (a: number): [number, number] => (deg === -90 || deg === 90 ? [across, a] : [a, across])
  const [px, pz] = spot(along)
  const [ax, az] = [px - LANE_STANDOFF * fx, pz - LANE_STANDOFF * fz]
  return [
    [ax, az, deg, 0], //             1 line up back down the lane, blades down - the only place it turns
    [ax, az, deg, FORK_ENTER], //    2 ...raise to pocket height standing still, in free air short of the lane
    [px, pz, deg, FORK_ENTER], //    3 straight in: the blades thread the pockets, over the lane bed, not through it
    [px, pz, deg, FORK_CARRY], //    4 take the weight standing still (the grip latches here, on the resting pose)
    [ax, az, deg, FORK_CARRY], //    5 straight back out to the spot it can turn on
  ]
}
/** one bay's put-away onto shelf `level`: line up square with it → in over the beams → down onto the slab → back
 *  out through the pockets. Rows 1 and 4 are the same spot at two fork heights - the truck comes back out to the
 *  place it turned on, which is the only place in the run where it is clear to turn again. */
const putAway = (bayX: number, rackZ: number, deg: number, level: number): number[][] => {
  const [sx, sz] = standFor(bayX, rackZ, deg)
  const { fx, fz } = headingAxes(deg)
  const [ax, az] = [sx - RACK_STANDOFF * fx, sz - RACK_STANDOFF * fz]
  return [
    [ax, az, deg, forkOver(level)],
    [sx, sz, deg, forkOver(level)],
    [sx, sz, deg, forkShelf(level)],
    [ax, az, deg, forkWithdrawShelf(level)],
  ]
}
/**
 * The charge bays: where each truck parks between trips, as [x, z, headingDeg].
 *
 * These are defined here with the routes because they are route rows: a truck's home is row 0 of its own table,
 * and the floor paint that draws each bay reads the same numbers, so a bay and the truck that sits in it
 * cannot drift apart the way a hand-typed rectangle would.
 *
 * Each stands on a line its truck already drives, facing the way it leaves, so the first move of a trip is a
 * straight pull out of the bay, and both stay out of the dock door aprons (the floor a warehouse keeps clear).
 *
 * Nothing is marked at the dock itself: the dock bay is render geometry with no collision (dockDoor.ts; the sim
 * knows nothing of a dock), so nothing there can take a load. Loads end at the rack line.
 */
/**
 * The cross aisle: the one piece of floor both trucks travel on. A truck's pick is pinned to its lane's axis and
 * its bays to the rack line, so a haul driven as one leg is a diagonal across open floor; broken at the aisle (out
 * of the lane, along the aisle, into the bay) every leg runs on x or z, and the traffic reads as a warehouse.
 *
 * It runs as close to the rack line as a loaded truck can turn: the corner rows are pivots, and a pivot needs
 * {@link SWING_RADIUS} + {@link TURN_CLEARANCE} off the racking, exactly like a bay lineup does.
 */
const CROSS_AISLE_X = RACK_X - RACK_HALF_X - (SWING_RADIUS + TURN_CLEARANCE)
/** a transit row: a corner on the cross aisle, and the heading the truck leaves it on (i.e. where it goes next) */
const way = (z: number, deg: number, fork: number): number[] => [CROSS_AISLE_X, z, deg, fork]

const pick = pickRows(LANE_EYE_X, 1, 180, TURNTABLE_Z)
/** position by position from the west, and within a position low then high - so every trip goes to a different height, and the
 *  low load is already in when the one above it goes in (nothing is ever reached in over a load being set down) */
const bays = RACK_SPOTS.flatMap((x) => RACK_LEVELS.flatMap((level) => putAway(x, RACK_Z[0]!, 90, level)))
/**
 * A pallet truck's real footprint about its origin, read off AGV.glb (`npm run inspect-glb`): the chassis ends AGV_TAIL
 * behind it, the blade tips {@link AGV_TIP} ahead, the fork carriage AGV_HALF_W either side. The origin is not the
 * centre, so anything drawn round a truck (a parking bay) is drawn round this, or the forks stick out of it.
 */
const AGV_TAIL = 0.675
const AGV_TIP = AGV_TINE_HEEL + AGV_TINE_LENGTH
const AGV_HALF_W = 0.63
/** a parking bay's clear margin round that footprint */
const BAY_MARGIN = 0.25
/**
 * The rack truck's charge bay: at the rack aisle's far east end, past the racks, facing back down the aisle, so its
 * blade tips are what face the rack line. Derived, not typed: its parking bay (blade tips plus BAY_MARGIN) butts the
 * storage zone's east border, an alcove off the zone sharing that line. Not further east: the truck comes home
 * forks first and pivots here, and the east wall's columns are behind it (demoScenes.test.ts walks that sweep). Not
 * further west either, or the parked blades lie across the zone's border and the bay's line doubles it. Derived so
 * it moves with the racks.
 */
const CHARGE = [RACK_X + STORAGE_ZONE_HALF_X + BAY_MARGIN + AGV_TIP, RACK_AISLE_Z, 180] as const

/**
 * The transit block: the corners of each of a trip's three legs (home→lane, lane→bay, bay→home), and only the
 * corners each leg actually has, so the PLC walks each leg's own count rather than a fixed block. Out to the lane is
 * one (west down the rack aisle, then turn down the cross aisle), back to the bays one (up the cross aisle, then face
 * the racks), and home none: its bays and its charge bay share one aisle, so it carries on east.
 *
 * Padding a leg to a fixed length would run (a repeated row is a no-op move whose `doneTag` handshake still
 * completes), but it would add a handshake for standing still.
 */
const WAYS = {
  toLane: [way(RACK_AISLE_Z, -90, 0)],
  toBay: [way(RACK_AISLE_Z, 0, FORK_CARRY)],
  toHome: [] as number[][],
}
const wayRows = [...WAYS.toLane, ...WAYS.toBay, ...WAYS.toHome]

/** The rack truck's route: its whole waypoint table */
export const RACK_ROUTE: readonly (readonly number[])[] = [
  [...CHARGE, 0], //    0 home / park, east of the racks, facing back down the aisle it works
  ...pick, //           1..5 the pick, facing back down the lane it runs +x
  ...wayRows, //        6..7 its corners: one out to the lane, one to a bay, none home
  ...bays, //           8..55 the near rack's six pallet positions on its bottom two levels, 4 rows each
]
/** row 0 is home, so the pick starts here and runs 5 rows */
export const AGV_PICK_BASE = 1
/** ...then the transit block: each leg's corners in trip order, home->lane, lane->bay, bay->home */
export const AGV_WAY_BASE = 6
/** How many corners each leg has - the counts the program walks, so a route that gains or loses a corner needs no
 *  edit to the program at all. */
export const RACK_WAYS = { out: WAYS.toLane.length, mid: WAYS.toBay.length, in: WAYS.toHome.length } as const
/** ...so the bays start after home + the pick + the transit block, and run 4 rows each */
export const RACK_BAY_BASE = AGV_WAY_BASE + wayRows.length
/** How many bays the truck fills before it parks for good. Derived from the route and interpolated into the program
 *  below, so adding a bay to the route is the whole edit - a hand-typed count in the program that disagrees with the
 *  table either skips a bay or commands a row that isn't there. */
export const RACK_SLOTS = (RACK_ROUTE.length - RACK_BAY_BASE) / 4

/**
 * The pallet supply truck: the demo's second truck, and the one that keeps the pallet dispenser loaded.
 *
 * It takes a stack of empty pallets off a floor stock and sets it down in the dispenser's magazine through the
 * machine's open north side (examples/parts/pallet-dispenser: its forks work the pallet's ends, leaving the long
 * sides free, because a truck can only fork a pallet through its long faces). The program sends it when the
 * magazine reads empty and the bay under it is clear, so it never sets a stack on a pallet waiting there.
 *
 * Everything happens on one north-south line, x = DISPENSER_X, with one turning spot on it, SUPPLY_TURN_Z: a
 * loaded truck's turning circle north of the dispenser, so it can face either way there - north to pick a stack,
 * south to load the machine. The stock stands further north by the same margin, so turning with bare blades before
 * a pick does not sweep through the stack it is about to take. Stack 2 stands behind stack 1 and is only reached
 * once stack 1 has gone into the machine.
 */
const DISPENSER_HALF_Z = 0.83 // the dispenser's footprint half-width: its column base plates (rig.json bounds)
const SUPPLY_TURN_Z = CELL.palletZ - DISPENSER_HALF_Z - SWING_RADIUS - TURN_CLEARANCE
/** the floor stock's stack centres, nearest first - the order the truck takes them in */
export const SUPPLY_STOCK_Z = [0, 1].map((i) => SUPPLY_TURN_Z - SWING_RADIUS - TURN_CLEARANCE - PALLET_SIZE[2] / 2 - i * 1.4)
/** how many empty pallets make one stack of stock */
export const SUPPLY_STACK = 8
const FLOOR_ENTER = forkEnter(0) //                      thread the pockets of a stack standing on the floor
const FLOOR_CARRY = liftFor(0.05) //                     ...and lift it clear
const MAG_OVER = liftFor(PALLET_INFEED_H + 0.06) //      in over the infeed's side rail
const MAG_SET = liftFor(PALLET_INFEED_H) //              stand it on the infeed, inside the magazine
const MAG_WITHDRAW = forkWithdraw(PALLET_INFEED_H) //    and back out through its pockets
const supplyPick = (stockZ: number): number[][] => {
  const [sx, sz] = standFor(DISPENSER_X, stockZ, 90)
  return [
    [DISPENSER_X, SUPPLY_TURN_Z, 90, 0], //              line up facing north, blades down
    [DISPENSER_X, SUPPLY_TURN_Z, 90, FLOOR_ENTER], //    raise to pocket height standing still
    [sx, sz, 90, FLOOR_ENTER], //                        straight in
    [sx, sz, 90, FLOOR_CARRY], //                        take the weight
    [DISPENSER_X, SUPPLY_TURN_Z, 90, FLOOR_CARRY], //    straight back out to the turning spot
  ]
}
const [magX, magZ] = standFor(DISPENSER_X, CELL.palletZ, -90)
const supplyDrop: number[][] = [
  [DISPENSER_X, SUPPLY_TURN_Z, -90, MAG_OVER], //        turn to face the machine, stack up over the rail
  [magX, magZ, -90, MAG_OVER], //                        straight in through the open side
  [magX, magZ, -90, MAG_SET], //                         set it down on the infeed, in the magazine
  [DISPENSER_X, SUPPLY_TURN_Z, -90, MAG_WITHDRAW], //    straight back out through its pockets
]
/** its park: on its turning spot, facing the machine it serves. The whole supply operation - dispenser, parked truck,
 *  stock - then stands on one north-south line, and the truck never comes near the pedestrian walkway to the west */
const SUPPLY_HOME = [DISPENSER_X, SUPPLY_TURN_Z, -90] as const
/** the supply truck's rows: home, a five-row pick per stack, and the four-row load into the magazine per stack
 *  (the same four rows each time: the program's truck block steps its drop by four rows a trip) */
export const SUPPLY_ROUTE: readonly (readonly number[])[] = [
  [...SUPPLY_HOME, 0],
  ...SUPPLY_STOCK_Z.flatMap(supplyPick),
  ...SUPPLY_STOCK_Z.flatMap(() => supplyDrop),
]
/** what the program's truck block is told: its pick for trip n is 5n rows on, and its drop 4n (the same rows) */
export const SUPPLY = {
  pickBase: 1,
  pickStride: 5,
  dropBase: 1 + 5 * SUPPLY_STOCK_Z.length,
  slots: SUPPLY_STOCK_Z.length,
} as const

/**
 * The scene-tab name a fork of the demo gets - whichever way the demo was reached (`?scene=demo` or the
 * in-app "Demo" action; both open it as an ephemeral view via EditorStore.enterDemoSession). The fork is
 * the user's first persisting edit, handled by EditorStore.stashDemoSession, which names the slot.
 * The demo itself is never a saved scene: it is rebuilt from {@link createPlcDemoScene} every time it is
 * shown, so it always matches the running build.
 */
export const DEMO_SCENE_NAME = 'Palletizing demo'

/**
 * The opening camera for a `?scene=demo` visit, applied once at controller mount (controller.ts).
 *
 * Every scene otherwise opens at the view's fixed default - (9,7,9) looking at the origin (view.ts) - which
 * suits the empty warehouse but crops this one, whose origin is the infeed tail: most of the line falls outside
 * the shot.
 *
 * This is a 3/4 from the south-west at ~28 deg elevation, aimed past the cell toward the racks, so the flow reads
 * in the order it runs: the trailer flex at the lower left, the line and the arm in the middle, the pallet supply
 * beside it, the rack line at the back. The dock sits just off the left edge; framed in too, the line and the arm
 * shrink to a strip. The camera stands over the walkway, north of the viewing gallery: from behind it (z 12), the
 * deck filled the lower right quarter of the frame.
 *
 * Only an opening view: it frames a scene nobody has framed yet, and the first orbit
 * controls the camera from then on. Where that orbit ends up is remembered per scene and takes precedence
 * over this on every later visit (editor/store/storePrefs viewport state, EditorController.restoreCamera). That
 * also makes opening the demo and reloading it agree, since the peek's camera carries over when
 * the first edit turns it into the user's own scene. "Reset View" puts it back.
 */
export const DEMO_OPENING_VIEW = { px: -9, py: 9, pz: 4.5, tx: 4, ty: 0.6, tz: -5 } as const

/**
 * The demo's PLC program, each POU in the language that suits it, the way a real project mixes them: PalletTruck, the
 * block each pallet truck runs, and MutingSeq, the light curtains' muting block, in Structured Text (route arithmetic,
 * a small state machine), and Palletizer, the cell's program, in ladder (it is contacts, coils and steps), calling
 * both as boxes on its rungs. {@link DEMO_CONTROLLER} runs Palletizer as Main. It reads and writes the controller's tags
 * declared at the end, which are what {@link createPlcDemoScene} is wired to by name; the POUs come before them because
 * the engine reads code outside every POU as the controller's only after the POUs.
 *
 * Palletizer and PalletTruck each have a twin in the other language (demoReference.ts, for the tests only), and the
 * tests hold the program to being the same machine, scan for scan, as the demo all in Structured Text and all in
 * ladder. MutingSeq has no twin: all three call the shipped one, and demoMuting.test.ts holds it on its own.
 */
export const DEMO_PROGRAM = `(* The palletizing cell. Palletizer, the cell's program, is ladder; PalletTruck, the block each pallet truck runs,
   and MutingSeq, the light curtains' muting, are Structured Text, called as boxes on Palletizer's rungs. The
   Controller runs Palletizer as Main. *)

(* One pallet truck's trips, a move at a time. A trip runs out along its waypoints (WayOut rows from WayBase), into
   the pick (five rows from the pick's base), forks up, down the aisle (WayMid rows), into the drop bay for this trip's
   Slot (four rows from DropBase), forks down, and home (WayIn rows). Each move is sent as a route row on Cmd with an
   Exec pulse, and the next waits until the truck has left Idle and come back to it.
   Want / Grant is the handshake for a shared aisle: Want asks for it, Grant lets the truck go. The demo's two trucks
   share none, so both are always granted.
   Each trip fills the next slot. Done latches once the last one is filled, and the truck takes no more requests:
   for the rack truck that is the end state of a long run, the rack full and the lane left standing full. *)
FUNCTION_BLOCK PalletTruck
VAR_INPUT
  Enable   : BOOL;
  Request  : BOOL;
  Idle     : BOOL;
  Grant    : BOOL;
  PickBase : INT;
  PickStride : INT;
  WayBase  : INT;
  WayOut   : INT;
  WayMid   : INT;
  WayIn    : INT;
  DropBase : INT;
  Slots    : INT;
END_VAR
VAR_OUTPUT
  Cmd  : INT;
  Exec : BOOL;
  Fork : BOOL;
  Want : BOOL;
  Step : INT;
  Slot : INT;
  Done : BOOL;
END_VAR
VAR
  Moving  : BOOL;
  Started : BOOL;
  Send    : INT;
  wi      : INT;
  Lift    : TON;
  Drop    : TON;
  pk      : INT;
END_VAR

IF Moving THEN
  IF NOT Idle THEN Started := TRUE; END_IF;
  IF Started THEN Exec := FALSE; END_IF;
  IF Started AND Idle THEN Moving := FALSE; END_IF;
END_IF;

Lift(IN := Enable AND (Step = 20) AND NOT Moving, PT := T#600ms);
Drop(IN := Enable AND (Step = 30) AND NOT Moving, PT := T#600ms);

(* this trip's pick: PickStride 0 picks from the same rows every trip; above 0, each trip's pick starts that many
   rows further on *)
pk :=PickBase + PickStride * Slot;
Send := -1;
IF Enable THEN
  CASE Step OF
    0:  IF Request AND Idle AND NOT Done THEN Want := TRUE;         Step := 5;  END_IF;
    5:  IF Grant THEN wi := 0;                                      Step := 6;  END_IF;
    6:  IF NOT Moving THEN
          IF wi < WayOut THEN  Send := WayBase + wi; wi := wi + 1;
          ELSE                 Send := pk;                    Step := 12; END_IF;
        END_IF;
    12: IF NOT Moving THEN     Send := pk + 1;                Step := 14; END_IF;
    14: IF NOT Moving THEN     Send := pk + 2;                Step := 16; END_IF;
    16: IF NOT Moving THEN     Send := pk + 3;                Step := 20; END_IF;
    20: IF NOT Moving THEN
          Fork := TRUE;
          IF Lift.Q THEN       Send := pk + 4; wi := 0;       Step := 22; END_IF;
        END_IF;
    22: IF NOT Moving THEN
          IF wi < WayMid THEN  Send := WayBase + WayOut + wi; wi := wi + 1;
          ELSE                 Send := DropBase + 4 * Slot;         Step := 24; END_IF;
        END_IF;
    24: IF NOT Moving THEN     Send := DropBase + 4 * Slot + 1;     Step := 25; END_IF;
    25: IF NOT Moving THEN     Send := DropBase + 4 * Slot + 2;     Step := 30; END_IF;
    30: IF NOT Moving THEN
          Fork := FALSE;
          IF Drop.Q THEN       Send := DropBase + 4 * Slot + 3; wi := 0; Step := 32; END_IF;
        END_IF;
    32: IF NOT Moving THEN
          IF wi < WayIn THEN   Send := WayBase + WayOut + WayMid + wi; wi := wi + 1;
          ELSE
            Slot := Slot + 1;
            IF Slot > Slots - 1 THEN Slot := Slots - 1; Done := TRUE; END_IF;
            Send := 0;                                             Step := 40;
          END_IF;
        END_IF;
    40: IF NOT Moving THEN      Want := FALSE;                      Step := 0;  END_IF;
  END_CASE;
END_IF;
IF Send >= 0 THEN
  Cmd := Send; Exec := TRUE; Moving := TRUE; Started := FALSE;
END_IF;
END_FUNCTION_BLOCK

(* Two-sensor sequential muting for a light curtain on a one-way conveyor opening, the muting ended by the curtain
   (the arrangement PLCopen Safety's SF_MutingSeq generalises, here in the variant where the curtain itself, not a
   second pair of eyes past it, ends the muting).
   A1 A2 | curtain along the direction of travel, A1 the outer eye. A load arriving blocks A1, then A2 while A1 is still
   blocked: that ORDER starts the muting. It ends once the load has broken the curtain and the curtain is clear again
   with both eyes clear, so it closes as soon as the load's tail is through. Someone who walks in after that trips it;
   someone close enough behind the load to block an eye before its tail clears the curtain keeps the muting open and
   gets through, which is the limit of any muting by eyes, and why their spacing matters.
   Anything else that breaks the curtain (a person, a box set down in the opening, a load coming the wrong way, which
   meets the curtain before any eye) drops Clear; blocking only the eyes never does. MaxTime ends a muting that lasts
   too long, a load parked in the opening. On a real line this runs in the SAFETY program; its settings and the eyes'
   spacing are the engineer's to get right. *)
FUNCTION_BLOCK MutingSeq
VAR_INPUT
  Enable  : BOOL;
  Ossd    : BOOL;
  A1      : BOOL;
  A2      : BOOL;
  MaxTime : TIME;
END_VAR
VAR_OUTPUT
  Clear   : BOOL;
  Muted   : BOOL;
  Expired : BOOL;
END_VAR
VAR
  State   : INT; (* 0 idle, 1 the outer eye blocked, 2 muted, 9 expired *)
  Broken  : BOOL; (* the load has reached the curtain in this muting *)
  Limit   : TON;
END_VAR

IF NOT Enable THEN
  State := 0;
ELSE
  CASE State OF
    0: IF A1 AND NOT A2 THEN State := 1; END_IF;
    1: IF NOT A1 THEN State := 0; ELSIF A2 THEN State := 2; Broken := FALSE; END_IF;
    2: IF NOT Ossd THEN Broken := TRUE; END_IF;
       IF Broken AND Ossd AND NOT (A1 OR A2) THEN State := 0; END_IF;
    9: IF NOT (A1 OR A2) THEN State := 0; END_IF;
  END_CASE;
END_IF;
Limit(IN := State = 2, PT := MaxTime);
IF Limit.Q THEN State := 9; END_IF;
Muted := State = 2;
Expired := State = 9;
Clear := Ossd OR Muted;
END_FUNCTION_BLOCK

PROGRAM Palletizer
VAR
  running    : BOOL := TRUE;
  CaseMuting : MutingSeq;
  FeedMuting : MutingSeq;
  OutMuting  : MutingSeq;
  caseClear  : BOOL := TRUE;
  feedClear  : BOOL := TRUE;
  outClear   : BOOL := TRUE;

  InfeedSpeed : REAL := 1.0;
  RunSpeed   : REAL := 1.0;
  ShiftRate  : REAL := 1.0;
  safe       : BOOL;

  rowPhase   : INT;
  rowsPushed : INT;
  turnedFirst : BOOL;
  thisRowTurned : BOOL;
  rowTarget  : INT;
  rowSent    : INT;
  RowPacked  : TON;
  rowDone    : BOOL;
  shifting   : BOOL;
  ShiftPulse : TON;
  Raised     : TON;
  Shifted    : R_TRIG;
  layerDone  : BOOL;

  Step       : INT;
  OutStep    : INT := 100;
  Moving     : BOOL;
  Started    : BOOL;
  InPlace    : TON;
  TurnSettle : TON;
  LoadLeft   : F_TRIG;

  layerIdx   : INT;
  placeIdx   : INT;
  palletFull : BOOL := TRUE;
  picking    : BOOL;

  LineSpeed  : REAL := 0.4;
  FeedSpeed  : REAL := 0.6;
  PalletFeed : BOOL;

  outRun     : BOOL;
  laneRun    : BOOL;
  blocked    : BOOL;

  Truck      : PalletTruck;
  TruckStep  : INT;
  TruckSlot  : INT;
  TruckDone  : BOOL;
  Supply     : PalletTruck;
  MagEmpty   : TON;
  S3Step     : INT;
  S3Slot     : INT;
  S3Done     : BOOL;

  (* what a rung has to hold in a variable: a number tested as a bit, a step as the scan found it *)
  half, even : INT;
  phase0, phase1 : BOOL;
  armNow, outNow : INT;
  lastLayer, outIdle, layerStep : BOOL;
  request, resupply : BOOL;
  feeding, shiftRun, outMoving, deckMoving, turnMoving, laneMoving, feedRun : BOOL;

  (* the tower's green, and the Start lamp's steady light: on while the line is moving *)
  RunLamp    : BOOL;
  (* the Start lamp's flasher: two timers that run each other, half a second lit and half dark *)
  BlinkOn    : TON;
  BlinkOff   : TON;
  ready      : BOOL;
  (* something that drops the run: an E-stop struck, the guard open, a curtain broken unmuted *)
  tripCause  : BOOL;
  (* the scan the run dropped *)
  RunFell    : F_TRIG;
  (* the run was dropped by a trip, not by an operator Stop; held until the line runs again *)
  tripped    : BOOL;
  (* every emergency stop on the line released: their normally-closed contacts in series, as on a safety relay *)
  eStopOk    : BOOL;
END_VAR
LADDER
  (* the emergency stops: the operator station's, the trailer's, the cell gate's, the pallet supply's and the
     outfeed's. Any one struck stops the whole line, the flex in the trailer with it *)
  |EStop| |EStopDock| |EStopGate| |EStopSupply| |EStopOutfeed| (eStopOk);
  |eStopOk| (FlexRun);
  (* each conveyor opening's curtain, muted for a load arriving the way loads do (MutingSeq); the muting lights the
     curtain's lamp *)
  CaseMuting(Enable, Ossd := CaseCurtain, A1 := CaseMuteA1, A2 := CaseMuteA2, MaxTime := T#30s, Clear => caseClear, Muted => CaseMuted);
  FeedMuting(Enable, Ossd := FeedCurtain, A1 := FeedMuteA1, A2 := FeedMuteA2, MaxTime := T#30s, Clear => feedClear, Muted => FeedMuted);
  OutMuting(Enable, Ossd := OutCurtain, A1 := OutMuteA1, A2 := OutMuteA2, MaxTime := T#30s, Clear => outClear, Muted => OutMuted);
  (* the line runs from Start until Stop, an E-stop, the guard opening or a curtain tripping unmuted. Each of those
     drops the run itself, not just a permit, so closing the guard or clearing a beam never restarts the line: it
     needs a Start to come back *)
  [|Start|, |running|] |Stop| |eStopOk| |Guard| |caseClear| |feedClear| |outClear| (running);
  (* safe: every drive and the robot may move. Today that is the run itself, which already holds every E-stop, the
     guard and the curtains *)
  |running| (safe);
  (* the robot moves only while it is safe to run: open the guard and it brakes where it is, job and all, and carries
     on from there after a Start *)
  |safe| (ArmEnable);
  (* the machines that run a cycle of their own, the wrapper, the pallet dispenser and the turntable, are held the
     same way: a Stop or a trip stops them where they are, mid-cycle, and they carry on from there after a Start, so
     a load is never left half-wrapped *)
  |safe| (CycleEnable);
  (* odd layers start with the turned row; a turned row is three cases, a straight one two *)
  DIV(IN1 := layerIdx, IN2 := 2, OUT => half);
  MUL(IN1 := half, IN2 := 2, OUT => even);
  NE(IN1 := layerIdx, IN2 := even, OUT) (turnedFirst);
  EQ(IN1 := rowPhase, IN2 := 0, OUT) (phase0);
  EQ(IN1 := rowPhase, IN2 := 1, OUT) (phase1);
  [|turnedFirst| |phase0|, |/turnedFirst| |phase1|] (thisRowTurned);
  SEL(G := thisRowTurned, IN0 := 2, IN1 := 3, OUT => rowTarget);
  (* a case arriving at the eye counts toward the row, and toward the running total *)
  |P BoxAtEye| ADD(IN1 := rowSent, IN2 := 1, OUT => rowSent) ADD(IN1 := Cases, IN2 := 1, OUT => Cases);
  (* a packed row pushes across once the stop has held it a second, twice a layer *)
  GE(IN1 := rowSent, IN2 := rowTarget, OUT) |RowReady| |/shifting| |/picking| RowPacked(IN, PT := T#1000ms);
  LT(IN1 := rowsPushed, IN2 := 2, OUT) |RowPacked.Q| |/shifting| (rowDone);
  [|rowDone|, |shifting|] |/ShiftPulse.Q| (shifting);
  |shifting| ShiftPulse(IN, PT := T#2000ms);
  |shifting| Raised(IN, PT := T#200ms);
  EQ(IN1 := rowsPushed, IN2 := 0, OUT) |P shifting| MOVE(IN := 1, OUT => rowPhase) MOVE(IN := 0, OUT => rowSent);
  |ShiftPulse.Q| Shifted(CLK) ADD(IN1 := rowsPushed, IN2 := 1, OUT => rowsPushed);
  GE(IN1 := rowsPushed, IN2 := 2, OUT) |Shifted.Q| MOVE(IN := 0, OUT => rowSent);
  GE(IN1 := rowsPushed, IN2 := 2, OUT) |LayerReady| (layerDone);
  (* the arm: a job has started once the robot leaves idle, and is over when it is idle again *)
  |Moving| |/ArmIdle| (S Started);
  |Moving| |Started| (R ArmExec);
  |Moving| |Started| |ArmIdle| (R Moving);
  |PalletFeed| |PalletIn| InPlace(IN, PT := T#800ms);
  EQ(IN1 := OutStep, IN2 := 115, OUT) TurnSettle(IN, PT := T#1200ms);
  |LoadOut| LoadLeft(CLK);
  (* the arm's cycle: every step tests the step as the scan found it. The robot runs its own jobs (its Inspector):
     job 1 picks the layer and lifts it clear, job 2 + n places it as course n and goes home *)
  MOVE(IN := Step, OUT => armNow);
  GE(IN1 := placeIdx, IN2 := ${COURSES - 1}, OUT) (lastLayer);
  EQ(IN1 := OutStep, IN2 := 0, OUT) (outIdle);
  (* 0: a layer is ready and the pallet has room: pick it *)
  EQ(IN1 := armNow, IN2 := 0, OUT) |safe| (R picking);
  EQ(IN1 := armNow, IN2 := 0, OUT) |safe| |layerDone| |/palletFull| MOVE(IN := layerIdx, OUT => placeIdx) MOVE(IN := 1, OUT => ArmCmd) MOVE(IN := 10, OUT => Step) (S ArmExec) (S Moving) (R Started) (S picking);
  (* 10: the layer is up off the deck, so the deck is clear for the next one; place this one *)
  EQ(IN1 := armNow, IN2 := 10, OUT) |safe| |/Moving| MOVE(IN := 0, OUT => rowPhase) MOVE(IN := 0, OUT => rowSent) MOVE(IN := 0, OUT => rowsPushed) ADD(IN1 := layerIdx, IN2 := 1, OUT => layerIdx) ADD(IN1 := placeIdx, IN2 := 2, OUT => ArmCmd) MOVE(IN := 20, OUT => Step) (R picking) (S ArmExec) (S Moving) (R Started) (layerStep);
  GE(IN1 := layerIdx, IN2 := ${COURSES}, OUT) |layerStep| MOVE(IN := 0, OUT => layerIdx);
  (* 20: placed and home; after the last layer the pallet goes out, once the outfeed is free *)
  EQ(IN1 := armNow, IN2 := 20, OUT) |safe| |/Moving| |lastLayer| |outIdle| MOVE(IN := 100, OUT => OutStep) MOVE(IN := 0, OUT => Step) (S palletFull);
  EQ(IN1 := armNow, IN2 := 20, OUT) |safe| |/Moving| |/lastLayer| MOVE(IN := 0, OUT => Step);
  (* the outfeed: its steps test the step as the scan found it, after the arm may have started it *)
  MOVE(IN := OutStep, OUT => outNow);
  (* 100: the load may leave once the staging lane is clear: square the turntable to receive it. A load leaving the
     cell counts toward the running total *)
  EQ(IN1 := outNow, IN2 := 100, OUT) |safe| |/LaneFull| MOVE(IN := 0.0, OUT => TurnCmd) MOVE(IN := 105, OUT => OutStep) ADD(IN1 := Pallets, IN2 := 1, OUT => Pallets);
  (* 105: the turntable is square: run the load off the deck, toward the wrapper *)
  EQ(IN1 := outNow, IN2 := 105, OUT) |safe| |TurnDone| MOVE(IN := 106, OUT => OutStep) (S outRun);
  (* 106: into the stretch wrapper; its station eye stops the load under the arm, and one edge on WrapStart wraps it *)
  EQ(IN1 := outNow, IN2 := 106, OUT) |safe| |WrapInPos| MOVE(IN := 107, OUT => OutStep) (R outRun) (S WrapStart);
  (* 107: wrapped and the arm parked: on to the turntable *)
  EQ(IN1 := outNow, IN2 := 107, OUT) |safe| |WrapDone| MOVE(IN := 110, OUT => OutStep) (R WrapStart) (S outRun);
  (* 110: the pallet is on the turntable; it settles, then turns a quarter to face the lane *)
  EQ(IN1 := outNow, IN2 := 110, OUT) |safe| |TurnEye| MOVE(IN := 115, OUT => OutStep) (R outRun);
  EQ(IN1 := outNow, IN2 := 115, OUT) |safe| |TurnSettle.Q| MOVE(IN := -90.0, OUT => TurnCmd) MOVE(IN := 120, OUT => OutStep);
  EQ(IN1 := outNow, IN2 := 120, OUT) |safe| |TurnDone| MOVE(IN := 130, OUT => OutStep) (S laneRun);
  (* 130: into the lane until it is full *)
  EQ(IN1 := outNow, IN2 := 130, OUT) |safe| |LaneFull| MOVE(IN := 0.0, OUT => TurnCmd) MOVE(IN := 140, OUT => OutStep) (R laneRun);
  (* 140: square again for the next load *)
  EQ(IN1 := outNow, IN2 := 140, OUT) |safe| |TurnDone| MOVE(IN := 0, OUT => OutStep);
  (* the empty pallet that replaces it is fed as soon as the finished load is off the build deck, not when it
     reaches the turntable, so the arm is not left waiting out the rest of the route; it is in once it has stood
     against the stop for a moment *)
  |safe| |palletFull| |LoadLeft.Q| (S PalletFeed);
  |safe| |PalletFeed| |InPlace.Q| (R PalletFeed) (R palletFull);
  (* the rack truck fetches the load once the lane is full, and not while it is still filling. A truck box's power
     flow in is its Enable and out is its Exec, which is what the coil after it carries to the truck *)
  |LaneFull| |/laneRun| (request);
  |safe| Truck(Enable, Idle := RackIdle, Grant := TRUE, Request := request, PickBase := ${AGV_PICK_BASE}, WayBase := ${AGV_WAY_BASE}, WayOut := ${RACK_WAYS.out}, WayMid := ${RACK_WAYS.mid}, WayIn := ${RACK_WAYS.in}, DropBase := ${RACK_BAY_BASE}, Slots := ${RACK_SLOTS}, Cmd => RackCmd, Fork => RackFork, Step => TruckStep, Slot => TruckSlot, Done => TruckDone) (RackExec);
  (* the supply truck loads the dispenser once its magazine is empty and nothing is waiting in its bay - held a second,
     because the magazine reads empty the moment its last pallet is set down, a moment before the bay eye sees it *)
  EQ(IN1 := MagLevel, IN2 := 0, OUT) |/PalletReady| MagEmpty(IN, PT := T#1000ms);
  |MagEmpty.Q| (resupply);
  |safe| Supply(Enable, Idle := SupplyIdle, Grant := TRUE, Request := resupply, PickBase := ${SUPPLY.pickBase}, PickStride := ${SUPPLY.pickStride}, WayBase := 0, WayOut := 0, WayMid := 0, WayIn := 0, DropBase := ${SUPPLY.dropBase}, Slots := ${SUPPLY.slots}, Cmd => SupplyCmd, Fork => SupplyFork, Step => S3Step, Slot => S3Slot, Done => S3Done) (SupplyExec);
  (* the drives: at their speed, or stopped *)
  |safe| |/picking| (feeding);
  SEL(G := feeding, IN0 := 0.0, IN1 := InfeedSpeed, OUT => Infeed);
  SEL(G := feeding, IN0 := 0.0, IN1 := RunSpeed, OUT => RowForm);
  |safe| |shifting| |Raised.Q| (shiftRun);
  SEL(G := shiftRun, IN0 := 0.0, IN1 := ShiftRate, OUT => ShiftSpeed);
  LT(IN1 := rowSent, IN2 := rowTarget, OUT) |safe| |/layerDone| |/picking| (SpawnRun);
  (* the trailer unloader's load light: put cases on the flex while there is room at its load point *)
  |safe| |/FlexFull| (LoadFlex);
  |safe| |outRun| (outMoving);
  SEL(G := outMoving, IN0 := 0.0, IN1 := LineSpeed, OUT => PalletOut);
  (* the build deck runs only until the load is off it: the fresh pallet lands on it while the outfeed still runs *)
  |safe| |outRun| |palletFull| |/PalletFeed| (deckMoving);
  SEL(G := deckMoving, IN0 := 0.0, IN1 := LineSpeed, OUT => DeckRun);
  |safe| [|outRun|, |laneRun|] (turnMoving);
  SEL(G := turnMoving, IN0 := 0.0, IN1 := LineSpeed, OUT => TurnRun);
  |safe| |laneRun| (laneMoving);
  SEL(G := laneMoving, IN0 := 0.0, IN1 := LineSpeed, OUT => Lane);
  (* the pallet supply: the transfer is up for the whole feed, the infeed and chains run once the dispenser lets go *)
  |safe| |PalletFeed| (PalletLift);
  |safe| |PalletFeed| |/DispBusy| (feedRun);
  SEL(G := feedRun, IN0 := 0.0, IN1 := FeedSpeed, OUT => PalletInfeed);
  SEL(G := feedRun, IN0 := 0.0, IN1 := FeedSpeed, OUT => PalletXfer);
  (* ...and between feeds the dispenser keeps a pallet waiting in its bay *)
  |safe| |/PalletFeed| |/PalletReady| |/DispBusy| (PalletDispense);
  (* the row former: Turn puts its turning plow into the lane for a turned row (nothing to do with the outfeed
     turntable's TurnCmd, TurnRun and TurnDone), and Shift raises the chains that push a packed row across *)
  |safe| |thisRowTurned| (Turn);
  |shifting| |safe| (Shift);
  (* the tower, a bit per lamp (1 green, 2 amber, 4 red): green running, amber the finished load has no lane to go
     to, red an E-stop struck or the guard open. Red is the emergency colour (IEC 60204-1), so neither a normal Stop
     nor a curtain trip is red: the tower goes dark, and the flashing Start lamp is what tells a trip from a Stop *)
  |safe| (RunLamp);
  EQ(IN1 := OutStep, IN2 := 100, OUT) |LaneFull| (blocked);
  MOVE(IN := 0, OUT => Tower);
  |RunLamp| ADD(IN1 := Tower, IN2 := 1, OUT => Tower);
  |blocked| ADD(IN1 := Tower, IN2 := 2, OUT => Tower);
  [|/eStopOk|, |/Guard|] ADD(IN1 := Tower, IN2 := 4, OUT => Tower);
  (* the Start lamp: steady while the line is moving, flashing while a TRIP left it down and a Start would bring it
     back (every E-stop released, the guard closed, every curtain clear), so the line says what it is waiting for. An
     operator Stop is not a trip, and nor is anything that happens to a line already stopped: it is down on purpose
     and the lamp stays dark, since a flash asks for attention. So a trip is latched only on the scan the run drops *)
  |/BlinkOff.Q| BlinkOn(IN, PT := T#500ms);
  |BlinkOn.Q| BlinkOff(IN, PT := T#500ms);
  [|/eStopOk|, |/Guard|, |/caseClear|, |/feedClear|, |/outClear|] (tripCause);
  |running| RunFell(CLK);
  [|RunFell.Q| |tripCause|, |tripped|] |/running| (tripped);
  |/running| |tripped| |Stop| |eStopOk| |Guard| |caseClear| |feedClear| |outClear| (ready);
  [|RunLamp|, |ready| |BlinkOn.Q|] (StartLamp);
END_LADDER
END_PROGRAM

(* The controller's tags: the cell's I/O, which the scene is wired to by name, and which the program reads and
   writes *)
VAR_INPUT
  Start      : BOOL;
  Stop       : BOOL := TRUE;
  EStop      : BOOL := TRUE;
  EStopDock  : BOOL := TRUE;
  EStopGate  : BOOL := TRUE;
  EStopSupply : BOOL := TRUE;
  EStopOutfeed : BOOL := TRUE;
  Guard      : BOOL := TRUE;
  CaseCurtain : BOOL := TRUE;
  FeedCurtain : BOOL := TRUE;
  OutCurtain : BOOL := TRUE;
  CaseMuteA1, CaseMuteA2 : BOOL;
  FeedMuteA1, FeedMuteA2 : BOOL;
  OutMuteA1, OutMuteA2 : BOOL;
  BoxAtEye   : BOOL;
  RowReady   : BOOL;
  LayerReady : BOOL;
  ArmIdle    : BOOL;
  TurnDone   : BOOL := TRUE;
  TurnEye    : BOOL;
  LoadOut    : BOOL;
  LaneFull   : BOOL;
  RackIdle   : BOOL := TRUE;
  SupplyIdle : BOOL := TRUE;
  PalletIn   : BOOL;
  DispBusy   : BOOL;
  PalletReady : BOOL;
  MagLevel   : INT := -1;
  WrapInPos  : BOOL;
  WrapDone   : BOOL;
  FlexFull   : BOOL;
END_VAR
VAR_OUTPUT
  Infeed     : REAL;
  RowForm    : REAL;
  ShiftSpeed : REAL;
  SpawnRun   : BOOL;
  LoadFlex   : BOOL;
  FlexRun    : BOOL;
  Turn       : BOOL;
  Shift      : BOOL;
  ArmCmd     : INT;
  ArmExec    : BOOL;
  ArmEnable  : BOOL;
  PalletOut  : REAL;
  DeckRun    : REAL;
  TurnRun    : REAL;
  TurnCmd    : REAL;
  Lane       : REAL;
  RackCmd    : INT;
  RackExec   : BOOL;
  RackFork   : BOOL;
  SupplyCmd  : INT;
  SupplyExec : BOOL;
  SupplyFork : BOOL;
  PalletDispense : BOOL;
  PalletLift : BOOL;
  PalletInfeed : REAL;
  PalletXfer : REAL;
  WrapStart  : BOOL;
  CycleEnable : BOOL;
  CaseMuted, FeedMuted, OutMuted : BOOL;
  StartLamp  : BOOL;
  Tower      : INT;
  Cases      : DINT;
  Pallets    : DINT;
END_VAR
`

/**
 * The task the demo's program runs on, and its instance: Main is Palletizer. Without a table the default one would
 * name the instance after its type, and the cell's watch keys and the scripts that read them say `Main.X`.
 *
 * 10 ms is the store's default scan (DEFAULT_SCAN_MS). Naming it here makes the demo run at one known rate
 * everywhere, since a stored table's interval is what both the sim and the test runner scan on, and the rate
 * matters: at 100 ms the arm never picks, the lanes never stage and a truck stalls at its pick.
 */
export const DEMO_CONTROLLER: Controller = {
  tasks: [{ name: 'MainTask', intervalMs: 10, priority: 10 }],
  programs: [{ name: 'Main', type: 'Palletizer', task: 'MainTask' }],
}

function setParams(part: PartInstance, values: Record<string, unknown>): void {
  Object.assign(part.params as Record<string, unknown>, values)
}

/** A part-placing helper backed by a growing parts list: `place(type, …)` for the two remaining
 *  built-in types (group containers, via createPart) and `placeSdk(packageId, …)` for the bundled
 *  SDK parts everything else in the demo is made of. */
function scenePlacer(): {
  parts: PartInstance[]
  packages: Map<string, PartPackage>
  sceneSoFar: () => SceneJSON
  place: (type: PartType, pos: [number, number, number], rotY: number, name: string, params?: Record<string, unknown>) => PartInstance
  placeSdk: (packageId: string, pos: [number, number, number], rotY: number, name: string, params?: Record<string, unknown>) => PartInstance
} {
  const parts: PartInstance[] = []
  const packages = new Map<string, PartPackage>()
  const sceneSoFar = (): SceneJSON => ({ version: SCENE_VERSION, parts })
  // v3 tail-origin: the demo authors conveyor positions as bed centres (the pre-v3
  // convention); convert to the tail so the geometry ends up exactly where authored.
  const toTailOrigin = (p: PartInstance, rotY: number): void => {
    const off = conveyorCenterOffsetX(p)
    if (off !== 0) {
      p.position[0] -= off * Math.cos(rotY)
      p.position[2] += off * Math.sin(rotY)
    }
  }
  const place = (type: PartType, pos: [number, number, number], rotY: number, name: string, params?: Record<string, unknown>): PartInstance => {
    const p = createPart(type, nextId(sceneSoFar(), type), pos, rotY)
    p.name = name
    if (params) setParams(p, params)
    toTailOrigin(p, rotY)
    parts.push(p)
    return p
  }
  // Place a bundled SDK part: baked package defaults + the given overrides, and the package collected
  // for embedding in scene.packages. A package that fails to build (never, once committed) degrades to
  // an empty group container so the rest of the scene still loads.
  const placeSdk = (packageId: string, pos: [number, number, number], rotY: number, name: string, params?: Record<string, unknown>): PartInstance => {
    const pkg = bundledPackage(packageId)
    if (!pkg) return place('group', pos, rotY, name)
    packages.set(pkg.id, pkg)
    const p = createSdkPart(pkg, nextId(sceneSoFar(), 'part'), pos, rotY)
    p.name = name
    if (params) setParams(p, params)
    toTailOrigin(p, rotY) // the SDK belt shares the built-in belt's tail origin
    parts.push(p)
    return p
  }
  return { parts, packages, sceneSoFar, place, placeSdk }
}

/**
 * A layer-forming palletizing cell: a spawner-fed infeed, a diverter used as a bump turner, a row former with a
 * chain transfer onto a layer table, a big six-axis palletizer that lifts a whole formed layer at once, and an
 * AGV that hauls each finished load away. Every part is a bundled SDK custom part (see the module header).
 */
export function createPlcDemoScene(): SceneJSON {
  const { parts, packages, sceneSoFar, place, placeSdk } = scenePlacer()

  // The demo is authored pre-grouped: related parts are filed under empty `group` container
  // nodes (PART_DEFS.group - no geometry, no sim body, a pure soft-parent anchor) so the scene
  // tree opens as a handful of collapsible sections (Layer-forming line / Palletizer cell / Set dressing)
  // instead of one ~120-row flat list. Soft parenting keeps every position world-space, so the
  // grouping is organisational only - the rendered/simulated scene is byte-for-byte unchanged.
  // group(name[, parent]) makes a container; under(parent, ...kids) files parts beneath it. A
  // container is created at the origin and re-seated on its members' centroid once parenting is set
  // (reseatContainers, at the end). Never hand-place one: its origin is the subtree's pivot.
  const group = (name: string, parent?: PartInstance): PartInstance => {
    const g = place('group', [0, 0, 0], 0, name)
    if (parent) g.parent = parent.id
    return g
  }
  const under = (parent: PartInstance, ...kids: PartInstance[]): void => {
    for (const k of kids) k.parent = parent.id
  }
  /**
   * A presence eye on its own floor stand (EYE_STAND_*): [eye, post, plate]. `at` is where the beam starts as the
   * caller means it. The eye steps back EYE_STAND_INTO along its beam, onto the post's face, and its maxRange grows
   * by the same, so the stand moves neither the beam's line nor its end; the post stands level with `at` along the
   * beam and EYE_STAND_SIDE to one side.
   * The post and plate are the eye's children, so moving the eye carries its stand: file only the eye under a group.
   */
  const standEye = (at: [number, number, number], rotY: number, name: string, params: Record<string, unknown> & { maxRange: number }): [PartInstance, PartInstance, PartInstance] => {
    const [bx, bz] = [Math.sin(rotY), Math.cos(rotY)] // the beam, local +z
    const [sx, sz] = [Math.cos(rotY), -Math.sin(rotY)] // the bracket's side, local +x
    const eye = placeSdk('oip.diffuse-sensor', [at[0] - bx * EYE_STAND_INTO, at[1], at[2] - bz * EYE_STAND_INTO], rotY, name, {
      ...params, maxRange: params.maxRange + EYE_STAND_INTO,
    })
    const [px, pz] = [at[0] + sx * EYE_STAND_SIDE, at[2] + sz * EYE_STAND_SIDE]
    const steel = '#9aa3ad' // galvanised
    const post = placeSdk('oip.shape', [px, 0, pz], rotY, `${name} post`, {
      shape: 'box', length: EYE_STAND_POST, width: EYE_STAND_POST, height: at[1] + EYE_STAND_TOP, color: steel,
    })
    const plate = placeSdk('oip.shape', [px, 0, pz], rotY, `${name} base`, {
      shape: 'box', length: EYE_STAND_PLATE, width: EYE_STAND_PLATE, height: 0.02, color: steel,
    })
    post.parent = eye.id
    plate.parent = eye.id
    return [eye, post, plate]
  }

  // A finished pallet load: an authored unit load (oip.unit-load) that stacks the standard load itself, a pallet and
  // `courses` courses of the palletizer's own layer (core/frame UNIT_LAYER is LAYER_PATTERN, demoScenes.test.ts pins
  // it), so a stack the robot never touched looks identical to one it just built. Wrapped: one body in its film from
  // the first step, marked wrapped, with its own load ID. The pieces are real cargo (a truck lifts the load, a sensor
  // sees each case) but not a scene part per case, which is why the demo can fill its racks and its dock lanes with
  // live loads. `film` is the slot letter of the tables below: clear, B(lack) or W(hite).
  let loadNo = 0
  const FILMS: Record<string, { filmColor: string; filmOpacity: number }> = {
    C: { filmColor: '#dcecf2', filmOpacity: 0.42 },
    B: { filmColor: '#1b1c1e', filmOpacity: 0.95 },
    W: { filmColor: '#f4f4f2', filmOpacity: 0.95 },
  }
  const unitLoad = (at: [number, number, number], rotationY: number, name: string, courses = COURSES, film = 'C'): PartInstance =>
    placeSdk('oip.unit-load', at, rotationY, name, {
      wrapped: true, loadId: `L-${String(++loadNo).padStart(4, '0')}`, courses, ...(FILMS[film] ?? FILMS.C),
    })
  const palletStack = (x: number, py: number, z: number, parent?: PartInstance): PartInstance => {
    const load = unitLoad([x, py - PALLET_SIZE[1] / 2, z], 0, 'Racked load')
    if (parent) load.parent = parent.id
    return load
  }

  /**
   * The warehouse shell: the default building (a loading dock with two doors and a trailer backed into each), cut to
   * fit and turned so the dock faces the line.
   *
   * The flow runs one way through the building: cases come off the trailer in the receiving door, straight down a flex
   * conveyor into the line, through the palletizer, and out to the racks. The shell is placed around that, not the
   * other way round: turned a quarter (its dock wall, local -z, faces world -x), the receiving door on the forming
   * lane, and the wall DOCK_WALL_X back from the infeed. The second door stands beside the pallet supply, the way
   * empty pallets come in. 3 x 4 sections: 30 m across the line - the rack aisles to the north of it (the north wall
   * ~1.5 m behind the last rack), the walkway, gallery and outbound staging to the south (the south wall just behind
   * the outbound staging) - and 40 m from the dock wall to the far one, past the racks and the rack truck. Sized to the process:
   * a section more is a 10 m strip of floor with no job in it.
   */
  const shell = defaultBuilding('bld_1')
  shell.rotationY = Math.PI / 2
  shell.params.lengthSections = 3
  // The default wall rules are painted by perimeter index, which moves when a section goes: re-aimed at the same
  // cells of the 3-section perimeter (front 0-2, back 3-5, left 6-9, right 10-13; the sections went from the south
  // end, local -x), so each wall keeps the modules it had - the default's own rules would wrap round the shorter
  // perimeter and shuffle them.
  shell.params.rules = [
    { wall: 'B', run: 1, gap: 1, count: 2, start: 0, doorCount: 1, trailer: true },
    { wall: 'B', run: 1, gap: 1, count: 1, start: 5, doorCount: 1, trailer: true },
    // the side walls brace their middle bays: the dock walls' Wall_B accents take three of their four corner cells here,
    // and a corner braced on both walls runs the two walls' brace tubes into each other
    { wall: 'A', run: 2, gap: 0, count: 1, start: 7, doorCount: 1, trailer: true },
    { wall: 'A', run: 2, gap: 0, count: 1, start: 11, doorCount: 1, trailer: true },
    { wall: 'dock_door', run: 1, gap: 1, count: 1, start: 1, doorCount: 2, trailer: true },
    // The shipping dock: the east wall's southmost section (z ~3-13), opposite the receiving dock, so the floor flows
    // through - received on the west, made in the middle, stored north-east, shipped east. Its doors stay shut (a
    // trailer backed to each, waiting for its load); the outbound staging is laid out from its openings.
    { wall: 'dock_door', run: 1, gap: 1, count: 1, start: SHIPPING_CELL, doorCount: 2, trailer: true },
    // A personnel exit door in the south wall, where the people side of the floor is. It replaces one of that wall's
    // two braced bays with a plain one (the other stays braced).
    { wall: 'personnel_door', run: 1, gap: 1, count: 1, start: EXIT_CELL, doorCount: 1, trailer: false },
  ]
  {
    const door = dockOpenings(shell).find((o) => o.key === RECEIVING_LEAF)!
    // turned a quarter, a local (x, z) maps to world (x0 + z, z0 - x): put the door's wall line on DOCK_WALL_X and
    // its centre on the lane
    shell.position[0] = DOCK_WALL_X - door.z
    shell.position[2] = CELL.laneZ + door.x
  }
  // the receiving door stands open: the trailer backed into it is being unloaded (see "Trailer unloading")
  shell.params.openDoors = [RECEIVING_LEAF]
  parts.push(shell)

  const C = CELL

  // --- Layer-forming line ---
  const lineG = group('Layer-forming line')

  // Infeed roller conveyor: cases ride +x on powered rollers at a low surface (y = 1.0) so the pilot character
  // can reach them. The PLC commands it with a REAL speed setpoint and reads back its shaft encoder, which
  // the bump turner's distance tracking runs on. That is speed-independent, so retuning RunSpeed needs no program
  // change. The -z guard is kept: it is the rail a bumped case turns against, and the stop that leaves it square.
  // The +z guard is dropped so the turner's blade can reach in across the lane.
  const infeed = placeSdk('oip.roller-conveyor', [-0.1, C.surface, C.bedZ], 0, 'Infeed', {
    length: 4.2, width: C.bedWidth, standHeight: C.surface, leftGuard: true, rightGuard: true,
    speedTag: 'Infeed',
  })
  // The cases come off the trailer (see "Trailer unloading" below), down a flex conveyor that runs straight onto the
  // infeed tail, on the forming lane. The layer is assembled on that lane, so this fixes where every row
  // forms. They arrive with their length along x, the straight orientation; the turner makes the turned ones.
  // Interlocked through the PLC itself: the flex queues cases and lets them go only while SpawnRun is on, so the
  // program releases exactly one row's worth of cases at a time and nothing moves before it runs.
  // 30/min is one case every 2 s, or 2 m of lane at the line's 1 m/s. What limits the rate is how the row packs:
  // cases that arrive close behind each other meet at speed and rebound, and the row-complete filter can expire
  // while one is still creeping back in. Raise it one change at a time against verify-layer-palletizer's
  // layer-geometry check (a too-quick pop-up also loosens layers: see the layer former's raiseTime).
  // Every note in the scene is a live one. This is the case count the program keeps at the release eye (its
  // partner, the pallet count, stands over the pallet outfeed, so the cell's input and output both read on the
  // layout). A count rather than the infeed speed because it changes: a number climbing as cases go by shows the
  // program working. It reads `--` until the program runs: a 0 would look like a line that has produced nothing.
  //
  // No station labels: a note is added only when it says something the scene cannot show by itself.
  //
  // Parented to the conveyor, so it follows the conveyor when the cell is rearranged.
  const infeedNote = place('annotation', [0.8, C.surface + 1.15, C.bedZ], 0, 'Case count', {
    text: 'Cases', icon: 'count', tag: 'Cases', unit: '', decimals: 0,
  })
  under(infeed, infeedNote)
  // --- Trailer unloading ---
  // The trailer in the receiving door is unloaded onto a flex conveyor that runs out of it, across the dock apron and
  // straight onto the infeed tail, on the forming lane. The flex and the scan arch over it are the only things on the
  // apron, as on a real dock, and the flex can be pulled into another shape by hand in walk mode.
  //
  // How it is fed, and how the line takes it. The flex accumulates (zero pressure): every section is a zone with a
  // photo-eye near its discharge end, and a zone stops when it holds a case and the zone ahead holds one too, so cases
  // queue a zone apart and never push. The line takes them at the discharge end: the last zone lets its case go only
  // while the program's release (SpawnRun) is on, metered 2 s apart - the spacing the row former is tuned to (see the
  // 30/min note above), which a queue let go at once would not keep. The row count stays at the release eye on the
  // infeed, so the program's row logic is unchanged. At the other end the unloader in the trailer works to the flex:
  // its first zone's eye covered (FlexFull) means no room to put the next case down, and the program's load light
  // (LoadFlex) is what the case source runs on. The flex starts with a queue on it, so the line is fed
  // from the first second, not after the 16 s it takes a case to come down it.
  const unloadG = group('Trailer unloading')
  /** the infeed's tail end (a centre-origin bed) */
  const infeedTailX = infeed.position[0] - (infeed.params as { length: number }).length / 2
  // the flex: its infeed FLEX_INTO_TRAILER inside the trailer, heading +x through the door. Its deck reaches a hair past
  // its end hinge (the part's section overlap), so the end hinge stops short of the infeed tail by that and a gap.
  const flexOrigin: [number, number] = [DOCK_WALL_X - FLEX_INTO_TRAILER, C.laneZ]
  const flexLen = infeedTailX - 0.07 - flexOrigin[0]
  const flexPoints: [number, number][] = [[flexLen / 3, 0], [(2 * flexLen) / 3, 0], [flexLen, 0]]
  const flex = placeSdk('oip.flex-conveyor', [flexOrigin[0], C.surface, flexOrigin[1]], 0, 'Trailer flex', {
    points: flexPoints, width: UNLOAD_W, standHeight: C.surface, speed: 1, runTag: 'FlexRun',
    accumulate: true, releaseTag: 'SpawnRun', meterGap: 2, fullTag: 'FlexFull',
  })
  const flexFit = flexStations(flexPoints, flexPathOf(flex)?.sections ?? 1)
  setParams(flex, { length: flexFit.pitch * flexFit.headings.length })
  // The case source: the man in the trailer putting cases on the flex, one every 2 s while the load light is on,
  // lengthwise to the flow, a case length and FLEX_LOAD_GAP behind the first zone's eye (whose covering is FlexFull).
  const FEED_S = FLEX_EYE_AT * flexFit.pitch - CASE.length / 2 - FLEX_LOAD_GAP
  const boxSource = placeSdk('oip.box-spawner', [flexOrigin[0] + FEED_S, C.surface + 0.45, flexOrigin[1]], 0, 'Case source', {
    boxesPerMinute: 30, boxColor: '#ffffff', runTag: 'LoadFlex',
    length: CASE.length, width: CASE.width, height: CASE.height,
  })
  // The flex starts with a queue on it, the way it stands when the line has been waiting: one case to a zone from the
  // discharge end back, each waiting with its nose at its zone's eye (examples/parts/flex-conveyor EYE_AT).
  const stocked: PartInstance[] = []
  const zoneCount = flexFit.headings.length
  for (let k = 0; k < FLEX_STOCKED; k++) {
    const d = (zoneCount - 1 - k + FLEX_EYE_AT) * flexFit.pitch - CASE.length / 2
    const w = toWorldXZ(flex, d, 0)
    stocked.push(placeSdk('oip.box', [w.x, C.surface + CASE.height / 2, w.z], 0, 'Case', { length: CASE.length, width: CASE.width, height: CASE.height }))
  }
  // The load still in the trailer: floor-loaded cases stacked across it, the face the unloader is working, just behind
  // the flex's load end, so the cases have a visible source. The trailer's inside is 2.35 m wide
  // and 2.32 m high, its floor level with the dock's (render/parts/dockDoor.ts, ContainerTrailer.glb), so five cases
  // lengthwise to it fit across and five courses stand under the roof. A trailer is loaded from its nose, so what is
  // left runs from the nose (11.65 m out from the dock wall's line) forward to the face, six cases deep, which leaves
  // the unloader ~0.8 m to stand in between the face and the flex's load end. Hand-written like the racked stock, so it
  // reads as a picture: course by course from the floor, each a column from the face back to the nose, five across;
  // '#' a case, '.' one already taken. Top courses go first, so the face steps back as it rises. Loose cargo (instanced
  // draws, ~130 bodies that sleep once settled), clear of the flex so its start never wakes them, and real: a pilot
  // can knock one off.
  const TRAILER_LOAD = [
    ['#####', '#####', '#####', '#####', '#####', '#####'],
    ['#####', '#####', '#####', '#####', '#####', '#####'],
    ['##..#', '#####', '#####', '#####', '#####', '#####'],
    ['.....', '#.###', '#####', '#####', '#####', '#####'],
    ['.....', '...##', '#####', '#####', '#####', '#####'],
  ]
  const LOAD_GAP = 0.02
  const LOAD_NOSE_X = DOCK_WALL_X - 11.65 + 0.05 // the trailer's inside nose wall, and a hair off it
  const loadDepth = TRAILER_LOAD[0]!.length
  const loadG = group('Trailer load', unloadG)
  TRAILER_LOAD.forEach((course, l) => course.forEach((row, k) => [...row].forEach((slot, j) => {
    if (slot !== '#') return
    const x = LOAD_NOSE_X + CASE.length / 2 + (loadDepth - 1 - k) * (CASE.length + LOAD_GAP)
    const z = flexOrigin[1] + (j - 2) * (CASE.width + LOAD_GAP)
    const y = CASE.height / 2 + l * (CASE.height + 0.002)
    under(loadG, placeSdk('oip.box', [x, y, z], 0, 'Trailer case', { length: CASE.length, width: CASE.width, height: CASE.height }))
  })))
  // Receiving scan: an arch over the flex, SCAN_INSIDE_DOCK in from the dock wall, reading every case that comes off the
  // trailer. The scan makes this a receiving line (it checks what arrived against what was shipped) rather than a
  // line that is only fed from a truck. It reads each case once and keeps its own count on the arch,
  // with no wiring: its read / count tags are there for the program that wants them (a no-read reject, a count checked
  // against the shipment), and nothing in today's program does. Centred between two of the flex's hinges, where no
  // stand is, and the arch clears the stands' legs either way.
  const SCAN_INSIDE_DOCK = 3
  const scanAt = DOCK_WALL_X + SCAN_INSIDE_DOCK - flexOrigin[0] // along the flex (it runs straight +x)
  const hinges = flexFit.stations.map((s) => s[0])
  const scanSection = Math.max(0, hinges.findIndex((x) => x > scanAt) - 1)
  const scanW = toWorldXZ(flex, (hinges[scanSection]! + hinges[scanSection + 1]!) / 2, 0)
  const scanner = placeSdk('oip.barcode-scanner', [scanW.x, 0, scanW.z], Math.PI / 2, 'Receiving scanner', {
    width: UNLOAD_W + 0.4, surfaceHeight: C.surface, clearance: CASE.height + 0.2,
  })
  // The source and the scan arch are placed from the flex's own stations, so they are its children.
  under(flex, boxSource, scanner)
  under(unloadG, flex, ...stocked)
  // Release eye, beaming (-z) across the bed immediately downstream of the drop. Every case trips it and the
  // program counts releases off it to know a row's worth has gone down the lane, so this has to sit at the
  // spawner, not further along. A metre down the belt the count lags by the transit time (1.6 s over 1.6 m at the
  // line's 1 m/s), so the gate closes a case late and the row gets an extra one. Both sides of that comparison are
  // tuning knobs (the lag is line speed, the budget is the spawn period), so an eye further down the lane could
  // break again on any retune. At the spawner the count is exact.
  //
  // It sits on the near rail at the seat its own guard mount produces (the mirror of the row eye's on the far one),
  // outside the side guard rather than buried in it.
  //
  // It is retro-reflective, the way an eye across a conveyor usually is: its reflector stands on the far guard, and
  // the range is the one a drag onto the rail fits (the bed plus the 20 mm stand-off at each edge), which is what
  // puts the reflector there.
  const RELEASE_EYE_Z = C.bedZ + C.bedWidth / 2 + EYE_LENS_Z + EYE_MOUNT_OUTWARD
  const sortEye = placeSdk('oip.diffuse-sensor', [-1.5, C.surface - EYE_MOUNT_DROP, RELEASE_EYE_Z], Math.PI, 'Release eye', {
    maxRange: C.bedWidth + 2 * EYE_MOUNT_OUTWARD, mode: 'retro', tag: 'BoxAtEye',
  })
  // Turning plow: the pop-up diverter, mounted on the +z guard line (the conveyor-snap transform:
  // y = surface - 0.2, z = half-width + DIVERTER_PUSH_HALF_Z + a 0.05 clearance). It is not a pusher here and it
  // is not pulsed: the program extends it and holds it out for the whole turned row, so it stands in the lane as a
  // fixed obstruction. Each passing case catches it on one corner, pivots 90 degrees as the rollers keep driving,
  // and carries on past. A plow rather than a kick makes the turn repeatable without timing anything.
  // The stroke reaches just far enough to catch a case's near edge (see divertDistance); the far rail takes the
  // turn to square. It retracts for the straight row.
  /**
   * Where along the lane the plow stands, and so where its own stand's feet go, between the infeed's leg
   * stations.
   *
   * The turn does not care where on the run it happens; the infeed's legs do. Its stations put foot plates over
   * x -0.23 .. 0.23 and 1.32 .. 1.78 (LEG_TAIL_OFFSET / LEG_SPACING / FOOT_PLATE_HALF_LEN in
   * render/parts/common.ts, on this 4.2 m bed), and the plow's feet stand 0.27 m either side of its centreline on
   * 0.06 m plates (examples/parts/diverter), so centred in the window between those stations they clear both by
   * about 0.2 m. That leaves the turn 1.225 m to finish before the row former at 2.0, and 2.675 m of settling from
   * the spawner drop at -1.9, twice what a case needs.
   */
  const PLOW_X = (0.23 + 1.32) / 2
  const PLOW_Z = 1.875
  const PLOW_STROKE = 0.65
  const bumpTurner = placeSdk('oip.diverter', [PLOW_X, C.surface - 0.2, PLOW_Z], 0, 'Turning plow', {
    // The stroke is fast because it is a changeover: it has to be standing in the lane before the
    // first case of a turned row reaches it, and the row behind it is already moving when the phase flips.
    tag: 'Turn', divertTime: 0.12, divertDistance: PLOW_STROKE,
    // it stands on its own legs, to the floor: what a drop or a snap would resolve (rest: 'surfaceBelow')
    standHeight: C.surface - 0.2 - FLOOR_SURFACE_Y,
  })
  // Plow guard. The plow stands outside the cell, on open floor a couple of metres from the operator station, and
  // throws its paddle 0.65 m in 0.12 s, so it gets a fixed guard that returns to the infeed's near rail the way the
  // cell's returns do. Three runs: the south one has both corner posts, the two flanks end at the rail. No interlock, since
  // nothing in it needs reaching in normal running. Full height: the plow's hood tops out near 1.46 m, so a panel
  // lower than the cell's 2 m would leave it reachable over the top.
  //
  // Spaced off the plow's footprint (examples/parts/diverter/rig.json bounds: 0.73 m long, z from local -1.103 to
  // divertDistance - 0.501) by a post half-width plus a 50 mm reveal. Both flanks clear the infeed's foot plates
  // (x 0.23 and 1.32, see PLOW_X) by 40 mm.
  const PLOW_GUARD_REVEAL = FENCE_POST_HALF + 0.05
  const plowGuardWestX = PLOW_X - 0.73 / 2 - PLOW_GUARD_REVEAL
  const plowGuardEastX = PLOW_X + 0.73 / 2 + PLOW_GUARD_REVEAL
  const plowGuardSouthZ = PLOW_Z + PLOW_STROKE - 0.501 + PLOW_GUARD_REVEAL
  const plowGuardNorthZ = BED_NEAR_FACE_Z + PLOW_GUARD_REVEAL
  const plowGuardSouth = placeSdk('oip.fence', [PLOW_X, 0, plowGuardSouthZ], 0, 'Plow guard', {
    length: plowGuardEastX - plowGuardWestX,
  })
  const plowGuardFlank = (x: number): PartInstance =>
    placeSdk('oip.fence', [x, 0, (plowGuardSouthZ + plowGuardNorthZ) / 2], Math.PI / 2, 'Plow guard', {
      length: plowGuardSouthZ - plowGuardNorthZ, omitPostStart: true, // south corner: the south run's post
    })
  const plowGuardWest = plowGuardFlank(plowGuardWestX)
  const plowGuardEast = plowGuardFlank(plowGuardEastX)

  // Row former: the bed the chain transfer is seated in, where cases accumulate nose-to-tail against the stop.
  //
  // Both guards are up, and each is a working surface rather than trim. The -z rail is what a turning case squares
  // against, and the +z rail is what a pushed row squares against: it is the layer stop. A real machine works
  // the same way: a row transfer shoves against the bed's own rail, and there is no separate blade in the way of the
  // robot picking the layer straight up out of the bed.
  //
  // It is the guard that fixes this bed's size, not the other way round: see BED_WIDTH.
  //
  // It runs with the chain deck rather than against it. The two are coplanar - a `conveys` link is a static body,
  // so the chains cannot rise above the rollers - which means anything standing where they overlap touches both,
  // and a surface held at zero brakes what is on it rather than being neutral. So neither is ever parked while
  // cargo is moving over it: both drive +x while a row builds, and during a push the rollers keep holding the row
  // against the stop while the chains carry it across.
  // Its placement is named rather than typed inline because the layer eye's post stands off this bed's discharge
  // end - see ROW_FORMER_END_X.
  const ROW_FORMER_X = 3.2
  const ROW_FORMER_LEN = 2.4
  const rowFormer = placeSdk('oip.roller-conveyor', [ROW_FORMER_X, C.surface, C.bedZ], 0, 'Row former', {
    // the same width and centreline as the infeed - see BED_WIDTH. Two conveyors because they are driven
    // separately, one bed because a step in the far rail is a lip where cargo is being turned.
    length: ROW_FORMER_LEN, width: C.bedWidth, standHeight: C.surface, leftGuard: true, rightGuard: true,
    speedTag: 'RowForm',
  })
  /** the bed's discharge end - the downstream steel the layer eye's post stands off */
  const ROW_FORMER_END_X = ROW_FORMER_X + ROW_FORMER_LEN / 2
  // The stop the rows pack against, always raised. It squares each case's leading face and puts every row on the
  // same centre, which gives the pattern's x offsets. Wide enough (1.6 m) to span both bands - the forming lane and
  // the pushed row beside it - so the deck keeps the finished row pressed square in x while the next one builds.
  //
  // How far the blade stands proud of the surface is shared with the layer eye, which has to see over it: a beam
  // laid across this band at case height meets the raised blade first. See the eye's beam height below.
  const ROW_STOP_RAISE = 0.15
  const rowStop = placeSdk('oip.blade-stop', [C.rowStopX, C.surface, C.bedZ], 0, 'Row stop', {
    width: C.bedWidth - 0.03, raiseHeight: ROW_STOP_RAISE, active: true,
  })
  // Chain transfer: the row and layer former. It spans the forming lane plus the strip beside it, and on command drives
  // its deck to -z, pushing the finished row over to make room for the next one. The layer is built right here on
  // the lane: with two rows there is exactly one push, and the row formed last never moves.
  //
  // Seated a chain drop below the roller line (C.chainDropZ), the same recess the part's own track snap
  // uses (examples/parts/chain-transfer, snap.track.targetLocalY), so a hand-placed cell and a snapped one
  // agree. A `conveys` link that rides a joint is built kinematic and re-posed from FK each tick (world.ts
  // attachRigConveyors), so the pop-up is physical: down, the deck is clear of cargo and the rollers alone carry;
  // up, the 0.095 m stroke takes the row off them and the deck's -z surface velocity pushes it aside. Seat it
  // flush instead and the two conveying surfaces are coplanar - a case touches both, and whichever is idle brakes
  // it.
  const chainTransfer = placeSdk('oip.chain-transfer', [C.loadX, C.surface - C.chainDropZ, C.bedZ], Math.PI, 'Layer former', {
    // Across the line (x) the bank is seated the way dragging it onto this bed would seat it, rather than typed:
    // the lane pitch is two roller pitches (a lane in every other roller gap, the parity the snap solves for),
    // and the count is however many of those span a whole row. Typed by hand they go out of sync with the bed
    // as soon as it is resized, and a bank sized loosely to the row leaves the trailing case half off the last
    // lane, where the push abandons it.
    //
    // Along the push (z) it is centred on the bed, where dropping one on would seat it, and long enough to reach
    // the guard from there - see CHAIN_LANE_LENGTH.
    chains: Math.round(ROW_LENGTH / (ROLLER_PITCH * 2)),
    distance: ROLLER_PITCH * 2,
    laneLength: CHAIN_LANE_LENGTH,
    // the authored fallback, used when no program is driving ShiftSpeed - kept equal to the program's own
    // ShiftRate so popping the chains by hand behaves like the running cell rather than a slower copy of it
    speed: 1.0,
    // Don't shorten this. The lift is a linear tween, so the deck carries the row up at RAISE/raiseTime; when it
    // stops at the top the cases keep going, by v²/2g. At 0.15 s that is 0.63 m/s and a ~20 mm hop, which the row
    // survives; halving the time quadruples the hop and the row comes down with its packing gone. The pop-up is ~0.15 s
    // of a ~2 s push anyway. A quicker lift needs easing (accelerate, then decelerate), not a shorter linear one.
    raiseTime: 0.15,
    popupTag: 'Shift', speedTag: 'ShiftSpeed',
  })
  // Row-complete eye, one row-length upstream of the stop, beaming (+z) across the forming lane only. It reads
  // true once the row has packed tight against the stop - the same for a 2-case row and a 3-case row, since both
  // are 1.2 m long.
  //
  // It watches from the far side of the lane, and its range is what matters: the beam has to reach a case standing
  // in the forming lane (a straight one presents its near edge at z -0.2) and stop short of the row already pushed
  // aside.
  //
  // The tightest constraint is the mirrored course, whose parked row is the 0.6 m turned one starting at z 0.1.
  // Reach past that and the beam sits inside the parked row and never reads false again; the case count then
  // decides the row is done on its own, and since cases are counted at release, 5 m upstream, the next row gets
  // pushed while still in transit and the arm lifts a part-built layer (on the second course only).
  //
  // It sits on the far rail, at the seat core/snap/snapRails.seatOnRail computes for the sensor package's
  // `conveyorGuard` mount (examples/parts/diffuse-sensor: lens at local +z EYE_LENS_Z, seated EYE_MOUNT_OUTWARD
  // proud of the rail, facing in), so a drag puts it where this places it.
  //
  // A snap would also auto-fit maxRange to the whole bed, which this eye must not have: a beam across the full
  // bed sits inside the parked row for ever. The range is derived off ROW_EYE_FAR_Z instead.
  /** the guard seat on the bed's far rail: the rail, less the lens reach, less the standoff */
  const ROW_EYE_Z = FAR_RAIL_Z - EYE_LENS_Z - EYE_MOUNT_OUTWARD
  /**
   * Where the beam ends: 0.13 m inside a straight case standing in the forming lane, and 0.28 m short of the
   * nearest a parked row ever comes (the mirrored course's turned one, whose near face rests at z 0.25).
   */
  const ROW_EYE_FAR_Z = -0.028
  const rowEye = placeSdk('oip.diffuse-sensor', [C.rowStopX - 1.1, C.surface - EYE_MOUNT_DROP, ROW_EYE_Z], 0, 'Row complete', {
    maxRange: ROW_EYE_FAR_Z - (ROW_EYE_Z + EYE_LENS_Z), tag: 'RowReady',
  })
  // (What the pushed row squares against is the row former's own +z side guard, so there is no part to place here.
  // The chains keep driving while the row is held against it, which squares the row, and the row formed next butts
  // straight up against its back.)
  //
  // Layer-complete eye, beaming (-x) along the pushed row's band from a post off the bed's discharge end. Covered
  // only once a row is parked on the layer stop, so together with a packed forming lane it means the layer is
  // whole: the arm's go signal.
  //
  // It looks down the band rather than across it because neither rail can carry it: the +z one is the face the row
  // squares on (an eye in it is struck by every row, and the guard is a 0.3 m wall standing in any beam at case
  // height), and the -z one has the whole forming lane in front of it.
  //
  // Its beam height is what matters: the raised row stop stands ROW_STOP_RAISE proud right across this band, so the
  // beam runs midway between the blade top and a case top, ~125 mm clear of each. The sim cannot catch a beam
  // through the blade, because core/beamCast casts against cargo only (world.ts frame beams).
  //
  // It stands on its own floor stand (standEye), the turntable eye's kind, since LAYER_EYE_Z is mid-bed and the eye
  // sits past the bed's end with nothing under it; the stand is 0.1 m off the discharge end, and maxRange includes
  // that offset. It stays diffuse: its target is the parked row itself, and the far end of its band is where the
  // arm picks.
  /** the sensor package's lens height above its own mount point (examples/parts/diffuse-sensor/part.js EMIT_Y) */
  const EYE_LENS_Y = 0.1
  /** inside both parked rows: a 0.4 m straight one spans z 0.45..0.85, a 0.6 m turned one 0.25..0.85 */
  const LAYER_EYE_Z = 0.65
  const layerEyeX = ROW_FORMER_END_X + 0.1 + EYE_STAND_POST / 2
  const layerEyeY = C.surface + (ROW_STOP_RAISE + CASE.height) / 2 - EYE_LENS_Y
  const [layerEye] = standEye([layerEyeX, layerEyeY, LAYER_EYE_Z], -Math.PI / 2, 'Layer complete', {
    maxRange: 1.5 + (layerEyeX - (C.loadX + 0.75)), tag: 'LayerReady',
  })
  // No zone border round the layer former: it stands hard against the cell's west and south boundary, so any
  // rectangle round it doubles the cell's own lines.
  // The plow's guard is placed from the plow's stroke and blade, so it is the plow's child.
  under(bumpTurner, plowGuardSouth, plowGuardWest, plowGuardEast)
  under(lineG, infeed, sortEye, bumpTurner, rowFormer, rowStop, chainTransfer, rowEye, layerEye)

  // operator station: Start/Stop/E-stop on the infeed's +z frame near its -x end, and the status tower
  // The Start cap is a green illuminated pushbutton (buttonColor tints the cap unlit + lit). Its light block is
  // wired to the program, not to its own contact (lampSource 'tag' reading StartLamp), so the cap glows green
  // while the line runs rather than lighting only while pressed, and flashes while the line is down but a
  // Start would bring it back. That wiring is declared, not inferred from the binding: a bound lampTag alone does
  // not take the lamp over.
  const startBtn = placeSdk('oip.push-button', [BUTTON_X0, BUTTON_Y, BUTTON_Z], 0, 'Start', {
    tag: 'Start', text: 'START', buttonColor: '#14b30f', lampSource: 'tag', lampTag: 'StartLamp',
  })
  // fail-safe Stop: normally-closed, so closed = run permit and pressed = open. Black, not the part's default red:
  // IEC 60204-1 prefers black for a stop and advises against red beside an emergency stop, which this one is.
  // Unlit, like a real black stop: a black lens has nothing to show
  const stopBtn = placeSdk('oip.push-button', [BUTTON_X0 + BUTTON_PITCH, BUTTON_Y, BUTTON_Z], 0, 'Stop', {
    tag: 'Stop', normallyClosed: true, buttonColor: '#1a1a1a', lampSource: 'off',
  })
  // the E-stop: a mushroom head that latches in when struck and stays in until it is used again (the twist-out).
  // It is normally closed by construction, and it breaks the same run latch Stop does, so releasing it does not
  // restart the line - that still takes a Start
  const eStopBtn = placeSdk('oip.push-button', [BUTTON_X0 + 2 * BUTTON_PITCH, BUTTON_Y, BUTTON_Z], 0, 'Operator E-stop', {
    emergencyStop: true, tag: 'EStop', text: 'E-STOP', lampSource: 'off',
  })
  // three-tier status tower, driven by one INT bitmask tag (the SDK stack light's interface): bit0 green running,
  // bit1 amber outfeed blocked, bit2 red E-stop struck / guard open - the fixed SDK segment colours cycle bottom-up
  // green → amber → red, exactly the trio the demo needs. value 0 keeps every segment dark before the program runs.
  //
  // Amber means attention, so it lights only for the one state that needs a person: a finished load with the staging
  // lane still full, the outfeed parked until the truck clears it. Not for the pallet change, which is automatic:
  // a lamp lit through normal running trains people to ignore it. Amber beside green is the usual "running, but
  // look".
  //
  // It is bolted to the cell fence, on the cap of the south run's west end post. On the line's side guard the
  // lenses would sit at ~1.4 m, inboard over the deck and hidden from most of the floor; the fence post (0.06 m, a
  // shade narrower than the light's 0.064 m foot) puts them at 2.2-2.4 m. That post because it is the one at the
  // crossing (see CELL_FENCE_WEST_X): in the operator's sightline, looking over the floor west of the cell and the
  // build deck at once. The other three are in the far corners of the guarding, facing away.
  //
  // It is that fence's child (filed below, once the fence exists), so moving the cell carries it.
  const tower = placeSdk('oip.stack-light', [CELL_FENCE_WEST_X, FENCE_CAP_TOP_Y, CELL_SOUTH_Z], 0, 'Status tower', {
    segments: 3, value: 0, tag: 'Tower',
  })
  // The buttons are the infeed's children, as a snap onto its frame would make them.
  under(infeed, startBtn, stopBtn, eStopBtn)

  // --- Palletizer cell ---
  // A big six-axis arm with a layer-sized vacuum plate, the pallet build station it stacks onto, and the AGV
  // that hauls each finished load out. Fully guarded, with one live interlock gate on the operator side and two
  // conveyor crossings - the case line in, the pallet outfeed out - as the only other ways through the boundary.
  const cellG = group('Palletizer cell')
  const P = PALLETIZER

  // the palletizer. The plate's footprint is its pickup volume, so sizing the plate to the layer (1.2 x 1.0)
  // makes one vacuum command lift all five cases of a formed layer, riding rigidly in formation, and leaves
  // anything standing beside the table behind.
  const palletizer = placeSdk('oip.six-axis-robot', P.robotPosition, P.robotRotationY, 'Palletizer', {
    scale: P.robotScale,
    toolSizeX: P.toolSizeX,
    toolSizeZ: P.toolSizeZ,
    // Coarse cups, as a layer head really has: big pads on a wide pitch, not the dense little grid a
    // single-case tool uses. The cup bed is a param-driven grid (count = floor(usable/pitch)+1 per axis), so on a
    // 1.2 x 1.0 m plate the stock 0.1 m pitch lays down ~120 cups, enough on its own to break the demo's draw budget.
    cupPitchX: 0.2,
    cupPitchZ: 0.2,
    commandTag: 'ArmCmd',
    executeTag: 'ArmExec',
    doneTag: 'ArmIdle',
    enableTag: 'ArmEnable',
    waypoints: [P.home, ...P.waypoints.map((w) => w.pose)],
    waypointNames: PALLETIZER_WAYPOINT_NAMES.join('\n'),
    // the robot's own programs: the ladder runs job 1 to pick and job 2 + n to place, and the robot does the rest
    // (the moves, the vacuum, the dwell), blending through the apexes so the arm flows up-and-over in one arc
    jobs: PALLETIZER_JOBS,
    jobNames: PALLETIZER_JOB_NAMES.join('\n'),
    pose: [P.home],
  })
  // The riser the arm stands on. See PALLETIZER.robotPosition: it gives the wrist enough pitch travel to hold the
  // plate flat over the top course, so the poses depend on it. Built to pedestalHeight exactly: an oip.shape
  // cylinder grows from y = 0, so its top face is where the base sits.
  //
  // 1.5 m across because that is the arm's actual foot, measured off the rendered casting: the base plate is
  // ~1.28 m round (max radius 0.743 at scale 1.7), so a 0.75 m radius caps it with a little pedestal showing, the
  // way a mounting plate does. Sized to the casting's widest point instead (1.73 m), the arm looks like it stands
  // on an oversized drum. The one lug that does overhang is the connector box on its -x flank, as on a real arm.
  // It stays centred on the arm's own j1 axis, not on the casting's visual centre, because that is the axis it
  // slews about.
  const armStand = placeSdk('oip.shape', [P.robotPosition[0], 0, P.robotPosition[2]], 0, 'Palletizer pedestal', {
    shape: 'cylinder', length: 1.5, width: 1.5, height: P.pedestalHeight, sides: 24, color: '#3f4650',
  })
  // The build deck. The load is built on a powered deck, not on the floor, so it can leave the cell on its own
  // instead of waiting to be carried off. It is held stopped for the whole build and only runs once the third
  // course is down. A conveying surface at zero brakes what stands on it, so the stopped deck keeps the pallet
  // from creeping while the arm presses courses onto it.
  const palletX = PALLET_X // = C.loadX - LOAD_DX; the trucks' routes are measured off it too, so it is shared
  const buildDeck = placeSdk('oip.roller-conveyor', [palletX, PALLET_DECK_H, C.palletZ], Math.PI / 2, 'Build deck', {
    length: BUILD_DECK_LEN, width: PALLET_LINE_W, standHeight: PALLET_DECK_H, leftGuard: false, rightGuard: false,
    speedTag: 'DeckRun',
  })
  // one pallet on it, positioned so its load centre is on the cell's load line
  const buildPallet = placeSdk('oip.pallet', [palletX, PALLET_DECK_H + 0.0675, C.palletZ], 0, 'Build pallet')
  // And a finished load already standing on it, as though the cell had just finished one. With it the demo
  // opens with the whole pallet line working: the load runs the full route (out of the cell, through the
  // turntable, onto a staging lane, away on a truck) in the first half-minute, instead of three courses of case
  // handling having to happen first. The program starts in its discharge step to match; the two go together, and
  // demoScenes.test.ts pins them so neither can be changed without the other.
  const prestaged = group('Prestaged load', cellG)
  PALLET_STACK_PATTERN.forEach((b) => under(prestaged, placeSdk('oip.box',
    [palletX + b.dx, PALLET_DECK_H + 0.0675 + b.dy, C.palletZ + b.dz], b.turns * (Math.PI / 2), 'Case')))
  // The pallet transfer, which moves a fresh pallet onto the deck once the finished load has conveyed clear: it
  // arrives on the infeed from the west (see PALLET_XFER_RISE), and while PalletLift holds the chains up they carry it
  // east, across the deck, against the end stop. They drop once it has stood there a moment, and the pallet is left
  // on the deck's rollers. Seven lanes span a pallet's 1.02 m width; turned -90 degrees, its divert direction is +x.
  const palletXfer = placeSdk('oip.chain-transfer', [palletX, PALLET_DECK_H - C.chainDropZ, PALLET_XFER_Z], -Math.PI / 2, 'Pallet transfer', {
    chains: 7, distance: ROLLER_PITCH * 2, laneLength: PALLET_LINE_W, speed: 0.6,
    speedTag: 'PalletXfer', popupTag: 'PalletLift',
  })
  // The end stop: a bar on the deck's east edge, low enough to pass under the first course (0.13 m against a pallet's
  // 0.135), that the chains square the pallet against - so the load is built where the arm's poses were solved for,
  // not wherever the chains happened to stop. Its face is PALLET_STOP_FACE_X. 0.8 m long, short of the pallet's
  // 1.02 m face, so the eye below can see the pallet past the bar's end instead of through it.
  const PALLET_STOP_LEN = 0.8
  const palletStop = placeSdk('oip.shape', [PALLET_STOP_FACE_X + 0.02, PALLET_DECK_H, C.palletZ], 0, 'Pallet stop', {
    shape: 'box', length: 0.04, width: PALLET_STOP_LEN, height: 0.13, color: '#f2bd0f',
  })
  // ...and the eye that says a pallet is there, looking -x at the pallet's east face from a post clear of the deck,
  // in the strip between the stop's end and the pallet's corner, so its beam never crosses the bar. Its beam runs
  // 0.07 m over the deck, which is inside the pallet raised (0.065-0.2) and lowered (0-0.135) and under the first
  // course, so it only ever means the pallet. The beam leaves the lens 0.1 m above the sensor's origin
  // (examples/parts/diffuse-sensor), and it stands on the same floor stand as every other eye with no rail under it
  // (standEye), which keeps the beam on this line and its far end where it was.
  const palletInEyeX = PALLET_STOP_FACE_X + 0.3
  const palletInEyeY = PALLET_DECK_H + 0.07 - 0.1
  const palletInEyeZ = C.palletZ + (PALLET_STOP_LEN / 2 + PALLET_SIZE[2] / 2) / 2
  const [palletInEye] = standEye([palletInEyeX, palletInEyeY, palletInEyeZ], -Math.PI / 2, 'Pallet in place', {
    maxRange: 0.4, tag: 'PalletIn',
  })
  // Guarding. The boundary encloses the hazard: the south run at CELL_SOUTH_Z, clear of the conveyor's +z rail,
  // puts the arm, the pallet station and the layer it picks from on one side of the fence, with the gate the only
  // way in. The case line passes through the boundary at the seam between its two beds (CELL_FENCE_WEST_X),
  // upstream of every pose the arm has, so cases cross the line instead of people. The east run is set off
  // {@link ARM_REACH_X} (measured, since FK cannot say where the back of a casting is), and the corners, the
  // painted line and the rack line beyond follow from that edge.
  //
  // Shared posts. A fence and a gate each draw a post at both their ends, so runs butted end to end double a post at
  // every junction. The barrierFence snap chain toggles `omitPostStart` / `omitPostEnd` on a drag; a scene authored
  // by coordinate sets them by hand. Each junction has one owner: the east run draws both corners, the gate draws
  // both of its frame posts, and everything butting them omits the post on that side. (Standing a run off the gate
  // instead leaves a see-through slot beside the door.)
  const fenceEast = placeSdk('oip.fence', [CELL_EAST_X, 0, (CELL_SOUTH_Z + CELL_NORTH_Z) / 2], Math.PI / 2, 'Cell fence', {
    length: CELL_SOUTH_Z - CELL_NORTH_Z,
  })
  // the north run stops short of the pallet line rather than crossing it (that gap is the outfeed's way out of the
  // cell), and it stops clear of the line's frame, not of its deck edge: see {@link OUTFEED_GAP_EAST_X}.
  const fenceNorth = placeSdk('oip.fence', [(OUTFEED_GAP_EAST_X + CELL_EAST_X) / 2, 0, CELL_NORTH_Z], 0, 'Cell fence', {
    length: CELL_EAST_X - OUTFEED_GAP_EAST_X, omitPostEnd: true, // NE corner: the east run's post
  })
  // ...and the rest of that side, on the far side of the outfeed: from the opening's west post out to the cell's
  // north-west corner, whose post the west run draws rather than doubling it.
  const fenceNorthWest = placeSdk('oip.fence', [(CELL_FENCE_WEST_X + OUTFEED_GAP_WEST_X) / 2, 0, CELL_NORTH_Z], 0, 'Cell fence', {
    length: OUTFEED_GAP_WEST_X - CELL_FENCE_WEST_X, omitPostStart: true, // NW corner: the west run's post
  })
  // The west run, without which a person could walk round the infeed to the layer. It runs the cell's full depth on
  // the same line the south run's crossing stands on, from the case line's
  // far rail down to the north-west corner, which it owns. Two conveyors cross this boundary and nothing else does:
  // the case line at the top of it (the bed itself is the barrier between the two returns) and the outfeed at the
  // bottom, in the north side's opening.
  //
  // It is two runs, either side of the pallet infeed's opening (INFEED_GAP_SOUTH_Z / _NORTH_Z): the third conveyor
  // through the boundary, and closed the same way as the other two, by the bed standing in it.
  const fenceWest = placeSdk('oip.fence', [CELL_FENCE_WEST_X, 0, (INFEED_GAP_NORTH_Z + CELL_NORTH_Z) / 2], Math.PI / 2, 'Cell fence', {
    length: INFEED_GAP_NORTH_Z - CELL_NORTH_Z,
  })
  const fenceWestSouth = placeSdk('oip.fence', [CELL_FENCE_WEST_X, 0, (CELL_FENCE_FAR_RETURN_Z + INFEED_GAP_SOUTH_Z) / 2], Math.PI / 2, 'Cell fence', {
    length: CELL_FENCE_FAR_RETURN_Z - INFEED_GAP_SOUTH_Z,
  })
  // the south run closes down to the case line's crossing (CELL_FENCE_WEST_X) and ends at the gate's hinge
  // post, which carries the leaf, so the fence omits that post rather than doubling it
  const fenceFront = placeSdk('oip.fence', [(CELL_FENCE_WEST_X + GATE_X - GATE_LEN / 2) / 2, 0, CELL_SOUTH_Z], 0, 'Cell fence', {
    length: GATE_X - GATE_LEN / 2 - CELL_FENCE_WEST_X, omitPostEnd: true, // gate's hinge post
  })
  // ...and the return that closes that west end to the conveyor: the run stands half a metre off the bed in z, and
  // without this panel the slot beside the corner post is a way into the cell past the interlocked gate. It omits
  // its own corner post in favour of the run it butts, so the corner stays a single post with a single cap (the one the
  // status tower stands on). See {@link CELL_FENCE_RETURN_Z} for where its far end sits.
  const fenceReturn = placeSdk('oip.fence', [CELL_FENCE_WEST_X, 0, (CELL_SOUTH_Z + CELL_FENCE_RETURN_Z) / 2], Math.PI / 2, 'Cell fence', {
    length: CELL_SOUTH_Z - CELL_FENCE_RETURN_Z, omitPostStart: true, // SW corner: the south run's west post
  })
  // ...and the rest of the south side, butted to the gate's latch post and running out to the east corner, omitting
  // the post at each end: continuous steel from the gate to the corner.
  const gateLatchX = GATE_X + GATE_LEN / 2
  const fenceFrontEast = placeSdk('oip.fence', [(gateLatchX + CELL_EAST_X) / 2, 0, CELL_SOUTH_Z], 0, 'Cell fence', {
    length: CELL_EAST_X - gateLatchX, omitPostStart: true, omitPostEnd: true, // gate's latch post / SE corner
  })
  // the access gate is a live interlock: closed (NC) = run permit; open pauses the arm and the truck. A negative
  // openAngle swings the leaf outward (+z, away from the cell) so it never sweeps into the arm's envelope and
  // egress follows the escape direction - the standard machine-guarding convention for a hazardous-cell gate.
  const gate = placeSdk('oip.safety-gate', [GATE_X, 0, CELL_SOUTH_Z], 0, 'Cell gate', {
    length: GATE_LEN, open: false, normallyClosed: true, tag: 'Guard', openAngle: -110,
  })
  // ...and the three conveyor openings, each with its light curtain (see CURTAIN_SETBACK) and the two photo-eyes that
  // mute it for a load, which the program reads (MutingSeq): A1 A2 before the curtain along the conveyor's travel. The
  // curtain is a plain device; the muting is the program's.
  const curtain = (pos: [number, number, number], rotY: number, name: string, width: number, deck: number, tag: string, lampTag: string): PartInstance =>
    placeSdk('oip.light-curtain', pos, rotY, name, {
      width, fieldBottom: deck + CURTAIN_OVER_DECK, fieldHeight: CURTAIN_SPAN, tag, mutingLampTag: lampTag,
    })
  /**
   * An opening's two muting eyes, on the conveyor's side the way the line's other eyes are mounted (on the guard line,
   * EYE_MOUNT_OUTWARD out and EYE_MOUNT_DROP down, so the beam crosses the deck just above the rollers), looking across
   * it, before the curtain in the direction of travel: outside the cell at the infeeds, inside it at the outfeed.
   * `travel` is the conveyor's direction as a world XZ unit vector; A1 stands `outer` back from the curtain, A2 0.25 m
   * back (clear of the fence line, 0.13 m from the curtain). None stand after it: MutingSeq ends a muting by the curtain
   * itself. Their spacing is the design: the gap must be shorter than the shortest load (so the load blocks both at once)
   * and, to keep a person walking the conveyor from muting it, longer than a person is deep (~0.6 m). On the pallet lines
   * both hold. On the case line they cannot: a case (0.4 m) is shorter than a person, so a person walking in along it
   * mutes that curtain, a flaw of the layout the sim shows rather than hides.
   *
   * They are retro-reflective, the usual muting sensor: each one's reflector stands on the far side of the bed, at the
   * range a drag onto the rail fits (the bed plus the 20 mm stand-off at each edge).
   */
  const mutingEyes = (at: [number, number, number], travel: [number, number], deck: number, bedWidth: number, outer: number, prefix: string, name: string): PartInstance[] => {
    const [tx, tz] = travel
    const [nx, nz] = [tz, -tx] // the side the eyes stand on
    const off = bedWidth / 2 + EYE_LENS_Z + EYE_MOUNT_OUTWARD
    const rot = Math.atan2(-nx, -nz) // local +Z (the beam) looks back across the deck
    return ([['A1', -outer], ['A2', -0.25]] as const).map(([pin, s]) =>
      placeSdk('oip.diffuse-sensor', [at[0] + tx * s + nx * off, deck - EYE_MOUNT_DROP, at[2] + tz * s + nz * off], rot, `${name} muting ${pin}`, {
        maxRange: bedWidth + 2 * EYE_MOUNT_OUTWARD, mode: 'retro', tag: `${prefix}Mute${pin}`,
      }))
  }
  const casePos: [number, number, number] = [CELL_FENCE_WEST_X - CURTAIN_SETBACK, 0, (CELL_FENCE_RETURN_Z + CELL_FENCE_FAR_RETURN_Z) / 2]
  const caseCurtain = curtain(casePos, Math.PI / 2,
    'Case infeed curtain', curtainWidth(CELL_FENCE_RETURN_Z, CELL_FENCE_FAR_RETURN_Z), C.surface, 'CaseCurtain', 'CaseMuted')
  const caseEyes = mutingEyes(casePos, [1, 0], C.surface, C.bedWidth, 0.55, 'Case', 'Case infeed')
  const feedPos: [number, number, number] = [CELL_FENCE_WEST_X - CURTAIN_SETBACK, 0, C.palletZ]
  const feedCurtain = curtain(feedPos, Math.PI / 2,
    'Pallet infeed curtain', curtainWidth(INFEED_GAP_SOUTH_Z, INFEED_GAP_NORTH_Z), PALLET_INFEED_H, 'FeedCurtain', 'FeedMuted')
  const feedEyes = mutingEyes(feedPos, [1, 0], PALLET_INFEED_H, PALLET_INFEED_W, 0.9, 'Feed', 'Pallet infeed')
  const outPos: [number, number, number] = [PALLET_X, 0, CELL_NORTH_Z - CURTAIN_SETBACK]
  const outCurtain = curtain(outPos, 0,
    'Outfeed curtain', curtainWidth(OUTFEED_GAP_EAST_X, OUTFEED_GAP_WEST_X), PALLET_DECK_H, 'OutCurtain', 'OutMuted')
  const outEyes = mutingEyes(outPos, [0, -1], PALLET_DECK_H, PALLET_LINE_W, 0.9, 'Out', 'Outfeed')
  // floor markings: a yellow border framing the cell, a green pallet-station box, and a hazard strip at the gate.
  // The border tracks the fence footprint rather than being its own rectangle - it is the painted line for the
  // same boundary, so if one moves and the other does not the cell reads as having two different edges. It is the
  // same rectangle the steel encloses, on all four sides.
  const cellZone = placeSdk('oip.floor-marking', [(CELL_ZONE_WEST_X + CELL_EAST_X) / 2, 0, (CELL_SOUTH_Z + CELL_NORTH_Z) / 2], 0, 'Cell zone', {
    length: CELL_EAST_X - CELL_ZONE_WEST_X, width: CELL_SOUTH_Z - CELL_NORTH_Z, style: 'border', borderWidth: 0.12, primaryColor: '#f2b705',
  })
  // The station box frames the build deck, a reveal wider than it (a box the deck's own size is hidden under it).
  // Only the flanks carry the reveal, since the outfeed butts the deck's north end, so it reads as a green line down
  // both sides of the station for the deck's full length.
  const BUILD_ZONE_REVEAL = 0.1
  const palletZone = placeSdk('oip.floor-marking', [palletX, 0, C.palletZ], 0, 'Build station', {
    length: PALLET_LINE_W + 2 * BUILD_ZONE_REVEAL, width: BUILD_DECK_LEN,
    style: 'border', borderWidth: 0.1, primaryColor: '#16a34a',
  })
  // The strip starts just outside the gate posts' floor plates. Those are 0.12 m square and 0.01 m thick, which is
  // exactly the marking's paint height, so a strip that ran under them would z-fight the plate tops.
  const GATE_FOOT_HALF = 0.06, GATE_CAUTION_LEN = 0.48
  const gateCautionNear = CELL_SOUTH_Z + GATE_FOOT_HALF + 0.01
  const gateCaution = placeSdk('oip.floor-marking', [GATE_X, 0, gateCautionNear + GATE_CAUTION_LEN / 2], Math.PI / 2, 'Gate caution', {
    length: GATE_CAUTION_LEN, width: GATE_LEN + 0.05, style: 'hazard', stripeSize: 0.3,
  })
  // The riser is the arm's child, the way an eye's post is the eye's: moving the arm carries what it stands on.
  under(palletizer, armStand)
  under(cellG, palletizer, buildDeck, palletXfer, palletStop, palletInEye, palletZone)
  // the finished load is its pallet and its cases
  under(prestaged, buildPallet)
  // The boundary and every way through it, in a group of its own so the cell's own rows stay readable.
  const guardG = group('Guarding', cellG)
  under(guardG, fenceEast, fenceNorth, fenceNorthWest, fenceWest, fenceWestSouth, fenceFront, fenceReturn, fenceFrontEast, gate, caseCurtain, feedCurtain, outCurtain, cellZone, gateCaution)
  // the status tower stands on the cap of this run's west end post (see the operator station)
  under(fenceFront, tower)
  // A muting pair is its curtain's children, not its conveyor's: the eyes stand where they do by their distance from
  // the curtain, so moving a curtain carries its pair, and a conveyor can slide along its line without them.
  under(caseCurtain, ...caseEyes)
  under(feedCurtain, ...feedEyes)
  under(outCurtain, ...outEyes)

  // --- Pallet supply: the dispenser and its infeed ---
  // Outside the cell, west of the fence, where a forklift can reload the magazine without anyone entering the
  // guarding. The line keeps one pallet waiting in the dispenser's bay: the program commands a dispense (a rising
  // edge on PalletDispense) whenever the bay eye (PalletReady) reads empty and no feed is running, so when the build
  // deck comes free the pallet only has to be conveyed, not dispensed first. DispBusy holds the infeed until the
  // stack is lifted clear of the pallet it set down. Auto dispense is off: nothing puts a pallet down on its own. A
  // Stop or a trip drops CycleEnable, which holds the carriage and forks where they are until the next Start.
  const supplyG = group('Pallet supply')
  const palletInfeed = placeSdk('oip.roller-conveyor', [(PALLET_INFEED_TAIL_X + PALLET_INFEED_HEAD_X) / 2, PALLET_INFEED_H, C.palletZ], 0, 'Pallet infeed', {
    length: PALLET_INFEED_HEAD_X - PALLET_INFEED_TAIL_X, width: PALLET_INFEED_W, standHeight: PALLET_INFEED_H, leftGuard: false, rightGuard: false,
    speedTag: 'PalletInfeed',
  })
  const dispenser = placeSdk('oip.pallet-dispenser', [DISPENSER_X, PALLET_INFEED_H, C.palletZ], 0, 'Pallet dispenser', {
    standHeight: PALLET_INFEED_H, autoFeed: false, dispenseTag: 'PalletDispense', enableTag: 'CycleEnable', busyTag: 'DispBusy', bayTag: 'PalletReady',
    levelTag: 'MagLevel',
  })
  under(supplyG, palletInfeed, dispenser)
  // (its one pallet of stock is placed at the end of the build, so every part id minted after this one stays put)

  // --- Pallet outfeed: turntable + staging lane ---
  // Where a finished load goes. It conveys out of the cell to a turntable, which turns it a quarter so its deck drives
  // it out across the line onto the staging lane, running east toward the racks. That turn presents the
  // pallet's long, forkable face to the truck coming up the lane (LANE_END_X says why there is one lane, not two).
  // The lane is the line's buffer: the palletizer can put a load down and start the next while it waits for the truck.
  //
  // The whole line sits at PALLET_DECK_H, the height the load was built at, so nothing has to lift it on the way.
  const outG = group('Pallet outfeed')
  // out of the cell: butts the build deck at one end and the turntable at the other, so a pallet is never
  // unsupported between them
  const deckEnd = C.palletZ - BUILD_DECK_LEN / 2
  const turnNear = TURNTABLE_Z + TURNTABLE_R
  const outfeed = placeSdk('oip.roller-conveyor', [palletX, PALLET_DECK_H, (deckEnd + turnNear) / 2], Math.PI / 2, 'Outfeed conveyor', {
    length: deckEnd - turnNear, width: PALLET_LINE_W, standHeight: PALLET_DECK_H, leftGuard: false, rightGuard: false,
    speedTag: 'PalletOut',
  })
  // The cell's output, beside the case count at its input: loads the program has sent out of the cell. Counted as a load
  // leaves rather than as the last course goes down, so the finished load the scene opens with counts too, and the note
  // moves in the first half-minute instead of reading 0 for the minutes a whole load takes to build. It floats clear
  // of a passing load (a full one stands ~1.3 m) and rides with the outfeed, like the case count does with the infeed.
  const palletNote = place('annotation', [palletX, PALLET_DECK_H + 1.9, (deckEnd + turnNear) / 2], 0, 'Pallet count', {
    text: 'Pallets', icon: 'count', tag: 'Pallets', unit: '', decimals: 0,
  })
  under(outfeed, palletNote)
  // The stretch wrapper. Every finished load is wrapped before it leaves: bare stacked cases do not go down a lane,
  // onto a truck and into a rack. It is a rotary-arm wrapper standing over the outfeed, so the load stays put on
  // the rollers and the arm turns round it (a load spun on a turntable would be sixteen loose bodies centrifuging
  // off a pallet). The program runs the load in until the wrapper's station eye stops it under the arm, starts one
  // cycle, and carries on when the wrapper says done; the film it lays is the load's from then on (core/cargoWrap).
  // A Stop or a trip drops CycleEnable, which brakes the arm and holds the cycle until the next Start.
  const wrapper = placeSdk('oip.stretch-wrapper', [palletX, PALLET_DECK_H, WRAP_Z], 0, 'Stretch wrapper', {
    standHeight: PALLET_DECK_H, startTag: 'WrapStart', enableTag: 'CycleEnable', doneTag: 'WrapDone', inPositionTag: 'WrapInPos',
  })
  // The turntable. Its deck is square and it rotates about its own centre, so the same rollers that received the
  // load along the line drive it out at 90 degrees once indexed. angleTag is the command (0 = square with the line to
  // receive, -90 = across to the lane) and doneTag is what the program waits on before driving again - conveying
  // mid-slew would walk the load off the deck. A Stop or a trip drops CycleEnable, which brakes a turn in
  // hand and holds it until the next Start.
  const turntable = placeSdk('oip.turntable-conveyor', [palletX, PALLET_DECK_H, TURNTABLE_Z], Math.PI / 2, 'Outfeed turntable', {
    width: TURNTABLE_W, standHeight: PALLET_DECK_H, speed: 0.4, rotationSpeedDeg: 60,
    angleTag: 'TurnCmd', speedTag: 'TurnRun', doneTag: 'TurnDone', enableTag: 'CycleEnable',
  })
  // A EUR pallet is 1.22 x 1.02, and it travels the line presenting 1.02 along it, so after the turntable's quarter
  // turn it presents 1.02 down the lane too. So a truck coming up the lane meets a load's long face and its
  // blades line up with the pockets spaced along the pallet's 1.22 m length. Where its eye sits is set by where it
  // should leave the load (LANE_EYE_X, up by RACK_ROUTE): down at the discharge end.
  const lane = placeSdk('oip.roller-conveyor', [palletX + TURNTABLE_R + STAGE_LANE_LEN / 2, PALLET_DECK_H, TURNTABLE_Z], 0, 'Staging lane', {
    length: STAGE_LANE_LEN, width: PALLET_LINE_W, standHeight: PALLET_DECK_H, leftGuard: false, rightGuard: false,
    speedTag: 'Lane',
  })

  // Eyes. Each beams across its lane rather than down it, so the beam is a station the load passes rather than a
  // range measurement, and nothing is left standing where a truck needs to park.
  //
  // Two are on their conveyors' frames, the way the pallet infeed's muting eyes are: the lane's and the off-deck
  // eye. This line runs guardless end to end (a pallet is rigid and self-tracking, so it needs no rail to hold it
  // square the way a carton does, and `leftGuard`/`rightGuard` would be 0.3 m collider walls down a lane a fork truck
  // picks from), and the eye's bracket bolts to the frame's wall, not to a guard. A frame-seated beam runs only
  // EYE_FRAME_BEAM_Y over the deck, through a 0.135 m pallet. That margin follows from the geometry, not tuning: the eye seats off the deck the pallet rests on, so no
  // retune of the deck, the rollers or the truck can move one without the other (a lifted load rises 0.05 and still
  // covers the beam, as it covered the stack's). Only loaded pallets run here, so the pallet means the load.
  //
  // The turntable's eye stays on a floor stand (standEye): it cannot mount on the turntable, whose every link above
  // its legs turns with the deck, so anything on it would swing away exactly when the eye is meant to be the fixed
  // station saying "the load is centred, safe to turn". It aims at the stack, from a post that clears the plate's
  // sweep by EYE_STANDOFF.
  const eyeY = PALLET_DECK_H + 0.6
  /** how far the turntable eye's post stands off the plate's rim, clear of it as it slews; it fixes the post's
   *  centre line, which is what the beam hangs off */
  const EYE_STANDOFF = 0.12
  /** the post's centre-line offset from a deck edge: the standoff plus its own half-width */
  const EYE_OFF = EYE_STANDOFF + EYE_STAND_POST / 2
  // on the turntable: stops the load with its centre near the deck's, which is what makes the quarter turn safe.
  // Its post clears the plate rim rather than the lane's half-width: the plate is TURNTABLE_R across, wider
  // than the line it sits in, and it sweeps that radius every time it indexes. x is solved at the eye's fixed z,
  // so the beam stays on that chord.
  const turnEyeDZ = 0.5
  const turnEyeDX = Math.sqrt((TURNTABLE_R + EYE_OFF) ** 2 - turnEyeDZ ** 2)
  const [turnEye] = standEye([palletX - turnEyeDX, eyeY, TURNTABLE_Z - turnEyeDZ], Math.PI / 2, 'On turntable', {
    maxRange: 1.2 + (turnEyeDX - 1.15), tag: 'TurnEye',
  })
  // The lane's eye and the off-deck eye are on their conveyors' frames, the guardless rail the pallet infeed's muting
  // eyes bolt to, seated where a drag onto that rail puts them (EYE_MOUNT_*) and looking across the bed (the -z / -x
  // side, away from the side a truck picks from). Their beams cross EYE_FRAME_BEAM_Y over the deck, inside any pallet
  // standing on it: see EYE_FRAME_BEAM_Y. The lane eye's position along the lane is still LANE_EYE_X, which the
  // truck's pick is worked out from.
  const laneEye = placeSdk('oip.diffuse-sensor', [LANE_EYE_X, PALLET_DECK_H - EYE_MOUNT_DROP, TURNTABLE_Z - PALLET_LINE_W / 2 - EYE_LENS_Z - EYE_MOUNT_OUTWARD], 0, 'Lane staged', {
    maxRange: PALLET_LINE_W + 2 * EYE_MOUNT_OUTWARD, tag: 'LaneFull',
  })
  // off the build deck: just past its north end, on the west side (the arm works the east one). The load passing it
  // and clearing it is what lets the next empty pallet in, a whole route earlier than waiting for the turntable.
  const loadOutEye = placeSdk('oip.diffuse-sensor', [palletX - PALLET_LINE_W / 2 - EYE_LENS_Z - EYE_MOUNT_OUTWARD, PALLET_DECK_H - EYE_MOUNT_DROP, deckEnd - 0.15], Math.PI / 2, 'Load off deck', {
    maxRange: PALLET_LINE_W + 2 * EYE_MOUNT_OUTWARD, tag: 'LoadOut',
  })

  // The two trucks. A fork volume spans a loaded pallet, so each lifts the pallet and the stack riding on it as
  // one rigid load. Otherwise a 3-course stack falls apart when driven away.
  //
  // Every height these run at is in the route (a row is [x, z, headingDeg, forkHeight]): the lane deck to pick
  // off, over the rack beams to come in on, the shelf slab to stand the load on, and under the shelf to back
  // out at. The tines close on the load where they come to rest and let go where they come to rest (see
  // examples/parts/agv), so what the truck sets down is a stack placed on the shelf, not dropped onto it.
  // maxLiftHeight is only the mast's travel, the ceiling every one of those heights is clamped to.
  //
  // Each is placed at its own home waypoint. A route row starts [x, z, headingDeg] but a placement is [x, y, z],
  // so writing the park spot out a second time as a position risks a transposition that buries a truck in the floor.
  const truck = (route: readonly (readonly number[])[], name: string, tag: string): PartInstance => {
    const home = route[0]!
    return placeSdk('oip.agv', [home[0]!, 0, home[1]!], (home[2]! * Math.PI) / 180, name, {
      // 3.5: over the second shelf's beams (RACK_LEVELS) with room to spare, and short of where the mast runs out
      driveSpeed: 1.0, maxLiftHeight: 3.5, reverseRange: AGV_REVERSE_RANGE,
      commandTag: `${tag}Cmd`, executeTag: `${tag}Exec`, doneTag: `${tag}Idle`, forkTag: `${tag}Fork`,
      waypoints: route.map((w) => [w[0]!, w[1]!, w[2]!, w[3]!]),
    })
  }
  const rackTruck = truck(RACK_ROUTE, 'Rack truck', 'Rack')

  // (No painted drop zone here: the loads go into the racks.)
  // (the rack truck is filed with the storage it puts away into, below)
  under(outG, outfeed, wrapper, turntable, lane, turnEye, laneEye, loadOutEye)

  // The supply truck and its stock: two stacks of empty pallets on the floor north of the dispenser, which it loads
  // into the magazine one stack at a time (SUPPLY_ROUTE). Real pallets, stacked as they would be delivered.
  const supplyTruck = truck(SUPPLY_ROUTE, 'Supply truck', 'Supply')
  const stockG = group('Pallet stock', supplyG)
  SUPPLY_STOCK_Z.forEach((sz, k) => {
    const stack = group(`Empty stack ${k + 1}`, stockG)
    for (let i = 0; i < SUPPLY_STACK; i++) {
      under(stack, placeSdk('oip.pallet', [DISPENSER_X, PALLET_SIZE[1] * (i + 0.5), sz], 0, 'Pallet'))
    }
  })
  // ...framed as a zone of its own, in the same paint as the cell and the storage area: from just north of the case
  // line down past the far stack, around the dispenser, the truck's lane and the stock
  const supplySouthZ = CELL.palletZ + DISPENSER_HALF_Z + 0.22
  const supplyNorthZ = SUPPLY_STOCK_Z[SUPPLY_STOCK_Z.length - 1]! - PALLET_SIZE[2] / 2 - 0.4
  const supplyZone = placeSdk('oip.floor-marking', [DISPENSER_X, 0, (supplySouthZ + supplyNorthZ) / 2], 0, 'Pallet supply zone', {
    length: 3.3, width: supplySouthZ - supplyNorthZ, style: 'border', borderWidth: 0.12, primaryColor: '#f2b705',
  })
  under(supplyG, supplyTruck, supplyZone)

  // --- Static warehouse dressing ---
  // The working cell sits in a 40 x 30 m shell (3x4 sections). The rest is furnished as a believable
  // warehouse so the cell reads as one station on a busy floor: a pallet-rack line down the +x side, a
  // pedestrian walk area down the -x side, and a raised viewing gallery beside the walkway, facing the cell.
  // None of it is comms-wired. The rack line is its own Storage section, since the rack truck works it; the rest is
  // static set dressing, subordinate to the cell.
  const dressG = group('Set dressing')

  // Pallet returns: two more stacks of empties in the corner north of the second dock door - the door empty pallets
  // come in by - framed in the supply's own paint, so the corner reads as that supply's overflow rather than bare
  // floor. The same stacks as the truck's stock (SUPPLY_STACK high, oip.pallet), so they join its instanced cargo
  // batch: no new draws, and 16 bodies that settle and sleep. Kept 2 m off the dock wall's columns, clear of the
  // second door's leveler, and far west of anything the supply truck sweeps (it turns on DISPENSER_X).
  const RETURNS_X = DOCK_WALL_X + SHELL_COLUMN_PROUD + 2.0 + PALLET_SIZE[0] / 2
  const RETURNS_Z = [-9.5, -10.9] as const
  const returnsG = group('Pallet returns', dressG)
  RETURNS_Z.forEach((z, k) => {
    const stack = group(`Returns stack ${k + 1}`, returnsG)
    for (let i = 0; i < SUPPLY_STACK; i++) {
      under(stack, placeSdk('oip.pallet', [RETURNS_X, PALLET_SIZE[1] * (i + 0.5), z], 0, 'Pallet'))
    }
  })
  {
    const south = RETURNS_Z[0] + PALLET_SIZE[2] / 2 + 0.4, north = RETURNS_Z[1] - PALLET_SIZE[2] / 2 - 0.4
    under(returnsG, placeSdk('oip.floor-marking', [RETURNS_X, 0, (south + north) / 2], 0, 'Pallet returns zone', {
      length: 3.3, width: south - north, style: 'border', borderWidth: 0.12, primaryColor: '#f2b705',
    }))
  }

  // storage: a single line of three runs of pallet racking down the +x side, spaced in z near the
  // dock for staging. A rack's length runs along x at rotationY 0. The -x side is left to people.
  // This line is not pure dressing: it is where the trucks put their loads away, so its geometry
  // is shared with their routes (RACK_X / RACK_Z / RACK_SPOTS, up by RACK_ROUTE).
  // So it is a section of its own, not set dressing, and it holds the truck that serves it.
  const storageG = group('Storage')
  under(storageG, rackTruck)
  const rackedG = group('Racked stock', storageG)
  // SDK rack = corner posts + full-width shelves on a 1.6 m pitch; the bottom slab top is at
  // RACK_SHELF_TOP (1.62 m) - the same shelf height the loads below were stacked for.
  // Each rack carries its aisle number on a sign across both end frames, and (the part's default) a location
  // label on every bay's beams - the numbering a warehouse system would put there.
  RACK_Z.forEach((z, i) => under(storageG, placeSdk('oip.rack', [RACK_X, 0, z], 0, 'Storage rack', {
    length: RACK_LEN, depth: RACK_DEPTH, poleInterval: RACK_BAY, aisle: `AISLE 0${i + 1}`,
  })))
  // part-stock the bottom shelf with full interlocked pallet loads (the same stack the palletizer builds, so they
  // read alike), each in one of the run's six pallet positions (RACK_SPOTS: two per bay) but different positions per
  // rack, so they don't line up across the racks (storage fills unevenly). Each also stands where no truck
  // delivers, so the stock and the deliveries never contend for a slot - demoScenes.test.ts pins that (every
  // delivery > 1 m from stock). Pallet centre y = slab top + half a pallet; the ~1.2 m stack clears the next shelf
  // at 3.2.
  //
  // A display decision rather than a warehouse one: a rack is 6 positions x 4 levels, so the line is 72 slots and
  // the truck's route names 12 of them, and with only the truck's loads the line read mostly bare. Each is a
  // wrapped unit load, one compound body however many cases it holds.
  const stockY = RACK_SHELF_TOP + 0.0675
  // (none on the near rack's bottom shelf: that whole shelf is the truck's, RACK_ROUTE's bays)
  for (const [r, spots] of [[1, [0, 1, 4]], [2, [2, 3, 5]]] as const) {
    for (const i of spots) palletStack(RACK_SPOTS[i]!, stockY, RACK_Z[r]!, rackedG)
  }
  // ...and levels 2-4 hold racked stock: the same wrapped unit loads, one compound body each (the 32 here as loose
  // cargo would be ~510 bodies; joined they are 32, asleep on their slabs). The table is the fill, rack by rack
  // (RACK_Z order), level 2 first, position by position from -x (two to a bay): C = a full clear-wrapped load, c = a
  // part-picked one (two courses), B / W = black / white film, '.' = an empty slot. Hand-written rather than
  // generated so it can be read and edited as a picture, and so it fills unevenly the way a real rack does. Odd
  // positions stand the other way round. The near rack's level 2 is empty for the same reason its bottom shelf is:
  // the truck puts away there too.
  const RACKED_STOCK = [
    ['......', 'WCC.CW', 'CC.WC.'],
    ['.CCcB.', 'CW.CCC', 'C.CCWC'],
    ['Cc.CWC', '.CCBC.', 'WC.CCB'],
  ]
  RACKED_STOCK.forEach((levels, r) => levels.forEach((row, l) => [...row].forEach((slot, b) => {
    if (slot === '.') return
    const y = rackShelfTop(l + 2)
    under(rackedG, unitLoad([RACK_SPOTS[b]!, y, RACK_Z[r]!], b % 2 ? Math.PI : 0, 'Racked load', slot === 'c' ? 2 : 3, slot.toUpperCase()))
  })))
  // zone paint: a yellow border framing the rack line and its aisles, from PAINT_COLUMN_CLEAR off the north wall's
  // columns down to 0.3 m short of the walkway. Both edges are derived, so the paint keeps its clearance when the
  // shell or the walkway moves.
  {
    const north = SHELL_NORTH_Z + SHELL_COLUMN_PROUD + PAINT_COLUMN_CLEAR, south = WALK_Z - WALK_W / 2 - 0.3
    under(storageG, placeSdk('oip.floor-marking', [RACK_X, 0, (north + south) / 2], 0, 'Storage zone', {
      length: 2 * STORAGE_ZONE_HALF_X, width: south - north, style: 'border', borderWidth: STORAGE_ZONE_BORDER, primaryColor: '#f2b705',
    }))
  }

  // Outbound staging: finished loads waiting at the shipping dock, in lanes squared to its two doors - the end of the
  // floor's flow, and why the south-east is open floor. Laid out from the doors (dockOpenings), so the lanes
  // follow the dock if it moves. Wrapped unit loads like the racks' (3 courses clear / white / black, 2 courses clear).
  // The lanes stop OUT_APRON short of the wall, leaving room for the dock's own levelers and the turn a forklift makes off them.
  const OUT_APRON = 4.0
  const OUT_PITCH = 1.5 //                    along a lane: a 1.22 m load and the gap a fork needs between two
  const OUT_LANE_HALF = 0.7 //                two lanes per door, either side of its centreline
  const OUT_LANES = ['CCWC', 'CBC', 'cC', 'CWC'] // per lane, dock end first: what stands in it
  const outboundG = group('Outbound staging', dressG)
  const shipDoors = dockOpenings(shell)
    .filter((o) => o.key.startsWith(`${SHIPPING_CELL}:`))
    // turned a quarter, a local (x, z) maps to world (x0 + z, z0 - x) (see the shell above)
    .map((o) => ({ x: shell.position[0] + o.z, z: shell.position[2] - o.x }))
    .sort((a, b) => a.z - b.z)
  const outLoads: { x: number; z: number; slot: string }[] = []
  shipDoors.forEach((door, d) => [-1, 1].forEach((side, s) => {
    const lane = OUT_LANES[d * 2 + s] ?? ''
    ;[...lane].forEach((slot, i) => outLoads.push({
      x: door.x - OUT_APRON - PALLET_SIZE[0] / 2 - i * OUT_PITCH, z: door.z + side * OUT_LANE_HALF, slot,
    }))
  }))
  for (const l of outLoads) {
    under(outboundG, unitLoad([l.x, 0, l.z], 0, 'Outbound load', l.slot === 'c' ? 2 : 3, l.slot.toUpperCase()))
  }
  const OUT_X0 = Math.min(...outLoads.map((l) => l.x)) - PALLET_SIZE[0] / 2 - 0.4
  const OUT_X1 = Math.max(...outLoads.map((l) => l.x)) + PALLET_SIZE[0] / 2 + 0.4
  const OUT_Z0 = Math.min(...outLoads.map((l) => l.z)) - PALLET_SIZE[2] / 2 - 0.4
  // ...and only 0.25 on the south: the south wall's column at x 18 stands at the bay's west corner, its face 1.0 m in
  // (SHELL_COLUMN_PROUD), and the 0.4 the other sides get would put the paint within 0.09 m of it
  const OUT_Z1 = Math.max(...outLoads.map((l) => l.z)) + PALLET_SIZE[2] / 2 + 0.25
  under(outboundG, placeSdk('oip.floor-marking', [(OUT_X0 + OUT_X1) / 2, 0, (OUT_Z0 + OUT_Z1) / 2], 0, 'Outbound staging zone', {
    length: OUT_X1 - OUT_X0, width: OUT_Z1 - OUT_Z0, style: 'border', borderWidth: 0.12, primaryColor: '#f2b705',
  }))

  // the south side is the people side, kept as one connected route (not scattered props) so it reads as planned:
  // a pedestrian walkway from the dock apron along the line, past the cell gate, to the shipping dock, with a leg
  // down the dock wall to the gallery stair.
  const walkG = group('Walk area', dressG)
  // white striped pedestrian walkway with see-through gaps (a fully-transparent secondary,
  // #rrggbb00, emits no off-stripe bands: the SDK marking's alpha-discard), in two legs: along the south side of
  // the line, from the dock apron past the operator station and the cell gate to the rack aisle, then down the west
  // side of the floor onto the gallery stair.
  //
  // The legs are derived from the points they run between rather than typed as centres and widths, so the route
  // cannot come apart (an unpainted band across a corner, a leg stopping short of the stair). Every end is a real
  // place: the dock apron, the cross aisle, the foot of the flight. The dock-apron end is the south leg's corner
  // square, 0.3 m off the dock wall's columns (GALLERY_STAIR_FOOT_X); a separate apron leg would lie on the south
  // leg, two coplanar striped decals z-fighting.
  /** it runs on to the outbound staging, stopping short of its border: the rack truck's whole route, swing
   *  included, stays north of z -6.6, so nothing drives across it */
  const WALK_EAST_X = OUT_X0 - 0.5
  /** the south leg runs down the west side of the stair and its east edge is at the foot, so the paint ends at step 1 */
  const WALK_STAIR_X1 = GALLERY_STAIR_X
  const WALK_STAIR_X0 = WALK_STAIR_X1 - WALK_W
  /** ...and it runs past the flight's far flank, so the full width of the stair opens off painted floor */
  const WALK_STAIR_Z1 = GALLERY_Z + GALLERY_STAIR_W / 2
  const span = (a: number, b: number): { c: number; w: number } => ({ c: (a + b) / 2, w: Math.abs(b - a) })
  // the main leg starts on the south leg's east edge, so the corner square belongs to the south leg alone: two
  // striped decals overlapping would be coplanar at y = 0 and z-fight, and their stripes run different ways
  // ...short of its east end by the stop bar painted there (below)
  const main = span(WALK_STAIR_X1, WALK_EAST_X - WALK_STOP_W)
  const southLeg = span(WALK_Z - WALK_W / 2, WALK_STAIR_Z1)
  const walkwayLegs: { pos: [number, number, number]; rotY: number; width: number }[] = [
    { pos: [main.c, 0, WALK_Z], rotY: Math.PI / 2, width: main.w },
    { pos: [(WALK_STAIR_X0 + WALK_STAIR_X1) / 2, 0, southLeg.c], rotY: 0, width: southLeg.w },
  ]
  for (const w of walkwayLegs) {
    under(walkG, placeSdk('oip.floor-marking', w.pos, w.rotY, 'Walkway', {
      length: WALK_W, width: w.width, style: 'stripes', primaryColor: '#ffffff', secondaryColor: '#1a1a1a00',
    }))
  }
  // No inbound staging bay: receiving is loose cases down the flex, so palletised inbound loads would have nowhere
  // to go.

  // A raised viewing gallery facing the cell, reached by a stair at its west end where the walkway brings you; both
  // stand on the floor. From the deck you look over the cell fence onto the arm and the pallet it builds, and down the
  // line. The SDK stair is floor-origin ascending +x, and what has to sit on the deck edge is its seat: the end of
  // the top landing, not the end of the run (see GALLERY_STAIR_X). Placed there, the platform reacts the way
  // structureConnections.ts intends: it opens its west railing over the flight's width, takes no deck notch, and the
  // stair lifts flush to the deck. A gallery is walked on, not loaded with equipment, so its deck is tread plate like
  // the stair's treads (a platform carrying conveyors takes 'deck').
  const galleryG = group('Viewing gallery', dressG)
  under(galleryG,
    placeSdk('oip.platform', [GALLERY_X, GALLERY_H, GALLERY_Z], 0, 'Gallery deck', {
      length: GALLERY_LEN, width: GALLERY_W, height: GALLERY_H, deckSurface: 'tread',
    }),
    placeSdk('oip.stairs', [GALLERY_STAIR_X, 0, GALLERY_Z], 0, 'Gallery stair', {
      numSteps: GALLERY_STEPS, width: GALLERY_STAIR_W,
    }),
  )

  // A marked bay for each truck to park in. Paint only - nothing in the cell reads it - but drawn from the
  // same numbers the routes use (CHARGE up by RACK_ROUTE, SUPPLY_HOME by SUPPLY_ROUTE), so a bay and the truck standing in
  // it cannot drift apart the way a hand-typed rectangle would.
  //
  // A bay is drawn around the truck's real footprint, forks included (AGV_TAIL .. AGV_TIP along its heading, AGV_HALF_W
  // across), with BAY_MARGIN all round. It is turned with the truck's heading, so the supply truck's bay (parked at
  // -90) runs along z, and centred where that footprint is centred: ahead of the origin, toward the blade tips.
  // Each bay is filed with its truck, so a section moved as a unit takes its parking with it.
  for (const [nm, c, home] of [['Rack truck', CHARGE, storageG], ['Supply truck', SUPPLY_HOME, supplyG]] as const) {
    const h = (c[2] * Math.PI) / 180, ahead = (AGV_TIP - AGV_TAIL) / 2
    // a part's local +x maps to world (cos h, -sin h), and a truck's blades point down its local +x
    under(home, placeSdk('oip.floor-marking', [c[0] + ahead * Math.cos(h), 0, c[1] - ahead * Math.sin(h)], h, `${nm} bay`, {
      length: AGV_TAIL + AGV_TIP + 2 * BAY_MARGIN, width: 2 * (AGV_HALF_W + BAY_MARGIN),
      style: 'border', borderWidth: 0.1, primaryColor: '#f2b705',
    }))
  }

  /**
   * No paint on the truck routes. Centrelines per leg read badly: parallel lines 1.26 m apart look like a drafting
   * error, every line ends at a lineup in open floor short of the racking, and it is a third paint language on the
   * floor. The routing itself (every leg on x or z, {@link CROSS_AISLE_X}) is what reads as deliberate. If the
   * aisles want marking, use a bordered area in the same yellow, one per aisle, and never overlap two floor
   * markings: they are coplanar and z-fight (which is why the walkway's legs tile).
   */

  // Unique-name rule (the same one store.rename enforces): the demo is authored with descriptive but
  // repeated labels - many "Box", "Pallet", "Storage rack", "Pallet load" - so dedupe them
  // with an auto (" 2", " 3", …) suffix in placement order, scoped per parent (parenting is fully set by now). Each
  // "Pallet load" group thus restarts its cargo at "Box"; no two sibling rows share a name, but the same label
  // recurs across branches. Identity is the id; this only sets the display label.
  const usedByParent = new Map<string | undefined, Set<string>>()
  for (const p of parts) {
    if (!p.name) continue
    let used = usedByParent.get(p.parent)
    if (!used) usedByParent.set(p.parent, (used = new Set()))
    p.name = uniqueName(used, p.name)
    used.add(p.name)
  }

  // The dispenser's stock is authored like every other pallet here: one real pallet held at the magazine's bottom
  // position (what the Inspector's Fill places, core/heldStock). It opens nearly empty so the supply truck's first
  // load happens in the first minute rather than ten loads in. Placed last, so it mints the next id rather than
  // renumbering every part built after the dispenser (the snap golden and any saved reference to a demo id).
  const magazine = holdsOf(dispenser)
  const bottomSlot = magazine && dispenser.type === 'part' ? holdPositions(dispenser, magazine.pkg, magazine.holds)[0] : undefined
  if (bottomSlot) under(dispenser, placeSdk('oip.pallet', bottomSlot.centre, dispenser.rotationY, 'Pallet'))

  // The E-stops. An emergency stop has to be within reach wherever a person works the line (IEC 60204-1, ISO 13850),
  // and the operator station's reaches none of the other places people do: the unloader is in the trailer, 18 m up
  // the flex, and the cell gate, the pallet supply and the outfeed lane are each on another side of the fence. So
  // each has its own, and they are one chain: the program puts their five normally-closed contacts in series
  // (eStopOk), so any one of them drops the whole line, the flex in the trailer included (FlexRun). Placed last,
  // like the magazine's pallet, so they mint new ids rather than renumbering the parts above. Each is a child of the
  // steel it is bolted to, as a snap onto that mount would make it, so moving the fence or the flex carries it.
  const eStop = (at: [number, number, number], rotY: number, tag: string, name: string): PartInstance =>
    placeSdk('oip.push-button', at, rotY, name, { emergencyStop: true, tag, text: 'E-STOP', lampSource: 'off' })
  /** an E-stop on the `k`th post of a fence run (from its local -x end), its face toward `out`, the way off the guarding */
  const onFencePost = (fence: PartInstance, k: number, out: [number, number], tag: string, name: string): PartInstance => {
    const len = (fence.params as { length: number }).length
    const along = -len / 2 + (k * len) / Math.ceil(len / FENCE_MAX_SPAN)
    const r = fence.rotationY ?? 0
    const stand = FENCE_POST_HALF + BUTTON_PLATE_OFF
    return eStop([
      fence.position[0] + along * Math.cos(r) + out[0] * stand,
      ESTOP_HEAD_Y - PUSH_BUTTON_BOX / 2,
      fence.position[2] - along * Math.sin(r) + out[1] * stand,
    ], Math.atan2(out[0], out[1]), tag, name)
  }
  // the trailer: on the flex's load-end leg, beside the unloader, facing across the trailer
  under(flex, eStop([flexOrigin[0], FLEX_STATION_Y, flexOrigin[1] + UNLOAD_W / 2 + FLEX_LEG_FACE + BUTTON_PLATE_OFF], 0, 'EStopDock', 'Dock E-stop'))
  // the gate: on the first post east of its latch, outside, clear of the leaf (it swings out from the hinge, west)
  under(fenceFrontEast, onFencePost(fenceFrontEast, 1, [0, 1], 'EStopGate', 'Gate E-stop'))
  // the pallet supply: on the west fence, outside, north of the pallet infeed's opening and its muting eyes
  under(fenceWest, onFencePost(fenceWest, 1, [-1, 0], 'EStopSupply', 'Supply E-stop'))
  // the outfeed: on the north fence, outside, over the staging lane, where a person stands between the two
  under(fenceNorth, onFencePost(fenceNorth, 1, [0, -1], 'EStopOutfeed', 'Outfeed E-stop'))

  // Impact protection, placed last like the E-stops so it mints new ids. Bollards are render-only (no collider), so
  // they stop nothing in the sim; the truck-sweep test holds the rack truck clear of them anyway. The dock doors
  // need none: the shell's dock module draws its own jamb bollards.
  // End-of-aisle protectors on each rack's west end frame, the end that faces the cross aisle and the cell: one post
  // in front of each upright. Children of their rack, which fixes where they stand.
  for (const rack of parts.filter((p) => p.type === 'part' && p.packageId === 'oip.rack')) {
    under(rack, placeSdk('oip.bollards', [RACK_X - RACK_HALF_X - RACK_BOLLARD_OFF, 0, rack.position[2]], Math.PI / 2, 'Rack end bollards', {
      count: 2, spacing: RACK_DEPTH, height: 1.0, radius: RACK_BOLLARD_R,
    }))
  }
  // A pedestrian guard rail along the walkway's north edge where it passes the storage zone, so the walkway does not
  // open onto the racking. It runs from the zone's west border to the walkway's east end, between the zone's paint
  // and the walkway's (the rail stands on neither).
  {
    const x0 = RACK_X - STORAGE_ZONE_HALF_X, x1 = WALK_EAST_X
    under(walkG, placeSdk('oip.guard-rail', [(x0 + x1) / 2, 0, WALK_Z - WALK_W / 2 - WALK_RAIL_OFF], 0, 'Walkway guard rail', {
      length: x1 - x0,
    }))
  }
  // The exit route, placed last too: a walkway leg from the main leg's south edge straight to the personnel door, ending
  // at the door's keep-clear area, hazard stripes painted in front of it a hand's width short of its frame so nothing
  // is stood against the exit. The leg butts both the main leg and the keep-clear area rather than overlapping them, for
  // the same z-fighting reason as the walkway's corner square.
  {
    const door = personnelDoors(shell).map((o) => ({ x: shell.position[0] + o.z, z: shell.position[2] - o.x }))[0]!
    const keepClear = span(SHELL_SOUTH_Z - EXIT_PAINT_OFF - EXIT_KEEP_CLEAR_D, SHELL_SOUTH_Z - EXIT_PAINT_OFF)
    const leg = span(WALK_Z + WALK_W / 2, keepClear.c - keepClear.w / 2)
    under(walkG,
      placeSdk('oip.floor-marking', [door.x, 0, leg.c], 0, 'Walkway to exit', {
        length: WALK_W, width: leg.w, style: 'stripes', primaryColor: '#ffffff', secondaryColor: '#1a1a1a00',
      }),
      placeSdk('oip.floor-marking', [door.x, 0, keepClear.c], 0, 'Exit keep-clear', {
        length: EXIT_KEEP_CLEAR_W, width: keepClear.w, style: 'hazard',
      }),
    )
  }
  // A hazard-striped stop bar across the walkway's east end, where it meets the outbound staging: past it is forklift
  // floor, so people stop and look rather than walk on into the bay. It fills the last WALK_STOP_W of the walkway's run,
  // butting the main leg, and keeps the walkway's 0.5 m off the staging zone's border.
  under(walkG, placeSdk('oip.floor-marking', [WALK_EAST_X - WALK_STOP_W / 2, 0, WALK_Z], 0, 'Walkway stop bar', {
    length: WALK_STOP_W, width: WALK_W, style: 'hazard',
  }))
  // The gallery's second way down, at its east end: a flight descending east (the stair turned half round, so it
  // ascends -x into the deck's east edge), its foot clear of the exit leg (GALLERY_EAST_X). Two ways off the deck make
  // it a route rather than a dead end.
  under(galleryG, placeSdk('oip.stairs', [GALLERY_EAST_X + GALLERY_STAIR_SEAT, 0, GALLERY_Z], Math.PI, 'Gallery east stair', {
    numSteps: GALLERY_STEPS, width: GALLERY_STAIR_W,
  }))

  // Seat every container on its members' centroid (parenting is fully set by now). A container's
  // origin is the pivot its subtree rotates about, so a hand-typed anchor is an invisible pivot off
  // in space. Soft parenting keeps positions world-space, so this moves nothing it contains.
  const seated = reseatContainers(parts, (p) => p.type === 'group')
  parts.length = 0
  parts.push(...seated)

  // embed every SDK package the demo used so it is self-contained (registerScenePackages on load). The demo is
  // metric: its conveyors are built here in m/s (fpmUnits takes whenAbsent, false), and a part added to it should match.
  return { ...sceneSoFar(), packages: [...packages.values()], units: 'metric' }
}
