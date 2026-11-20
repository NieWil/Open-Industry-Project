// Turntable Conveyor — a rotating redirect table: rotate → align → convey. The deck is a kinematic disc on
// the 'rotate' revolute joint; the hidden `conveys` lane box on top of it is the cargo surface. While slewing,
// the lane's linear velocity is held at 0 and cargo is spun with the platter instead: an arc surface-velocity
// field about the pivot, the same rotational field the deck imparts by friction. Once settled, the lane
// conveys at `speed` along the deck's current forward — the conveys body is static and its surface velocity
// world-space, so the direction is recomputed from the deck angle every tick. By default the deck slews to the
// manual `deckAngleDeg` and holds there — an angled cross-feed you orient from the Inspector, not a
// self-runner. With an angle tag named, a PLC commands the target angle instead. Its enable tag is the safety
// stop: dropped mid-turn, the deck brakes to a standstill in SAFE_STOP_S still gripping its load, and finishes the
// turn when the tag comes back. A turn not yet begun waits for it.
//
// This is the part's source. `npm run build-parts` writes behavior.ts (this script as the app ships it, with the
// _shared/ modules it imports joined in and `manifest` / `rig()` left out) and rig.json (the manifest, with the
// rig compiled from rig()).

import { rollerBed, yawQuat } from '../_shared/rollerBed.js'
import { FPM_MS, METRIC_ONLY, reportSpeed, speedFpmTagParam, speedUnitParams } from '../_shared/conveyorUnits.js'

const PLATE = 1.5 // TURNTABLE_PLATE_FACTOR - disc diameter = width * PLATE
const HEAVY = { radius: 0.04, pitch: 0.13 } // ROLLER_CLASSES.heavy

const D2R = Math.PI / 180

// wrap a degree angle/delta into (−180, 180] — the shortest-path wrap convention
const wrap180 = (a) => { let r = a % 360; if (r > 180) r -= 360; else if (r <= -180) r += 360; return r }

let angle = 0      // current deck angle (deg), kept wrapped in (−180, 180]
let seeded = false
// THE PLATTER CARRIES ITS LOAD — carry phase: 0 idle · 1 arming · 2 carrying · 3 arrived (still held).
// A real turntable holds its load in static contact: the acceleration it demands is an order of magnitude
// under the friction limit, so nothing slips, and the load reaches the outfeed at exactly the deck angle
// (which is the whole reason the machine exists — a few degrees out jams a wrapper or a truck pattern).
// Dragging cargo with the arc surface-velocity field cannot promise that: the field commands a RATE, so any
// slip is integrated into the final ANGLE and is never corrected. Measured before this: the same pallet came
// off 0.7° out one cycle and 4° the next, and on a bare plate it sometimes stopped tracking altogether while
// the deck spun under it. So the deck GRIPS what stands on it for the duration of the turn.
// The two extra phases exist for the two ENDS of the turn, each worth a step of skew if fumbled:
//   1 arming  — the grip closes while the deck stands STILL, so the host captures the load at the angle the
//               deck is actually at; closing and turning in the same tick bakes in one step of rotation.
//   3 arrived — the deck has landed and stays held for that tick, so its final pose is driven onto the load
//               before the release (a release tick drives nothing, it just lets go).
let carry = 0
// Drive RAMP. No real turntable steps to full speed in one tick — a VFD is given an acceleration time (this
// is literally a drive parameter), and the deck eases up to speed and back down onto the index. RAMP_S is
// that acceleration time: seconds from standstill to the commanded top speed, so the acceleration itself
// scales with whatever speed the author sets. `rate` is the current angular rate in °/s, ramped toward the
// commanded top speed and braked in time to land on the target without overshoot (a trapezoidal profile).
const RAMP_S = 0.5
// seconds from the top rate to a standstill on a dropped enable: under 3 degrees at the default 20 deg/s
const SAFE_STOP_S = 0.3
let rate = 0

definePart({
  manifest: {
    id: 'oip.turntable-conveyor',
    name: 'Turntable Conveyor',
    category: 'Equipment',
    conveyor: { bed: 'turntable', surface: 'roller', speedParam: 'speed' },
  },
  // The rig: a width-parametric deck disc + drum, the round roller bed's frame (geometry() draws the bed), the convey
  // lane and its cross arms, four static single-pole legs with foot plates, a slew gearmotor + ring gear that turn the
  // deck, and a deck-riding right-angle gearmotor that drives the rollers. Most of it clamps as the lane narrows or the
  // stand drops. It is worked out from the params, except the leg ring's x and z and the deck motor, which write their
  // refs out (each says why).
  rig(p) {
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)
    // the deck disc radius tracks the width param (radius = width*PLATE/2)
    const discR = (p.width * PLATE) / 2

    // the drum under the deck plate: its top at the plate top (0.072 under the datum = deck-local +0.05), its full
    // depth 0.428, and the gap it keeps above the floor on a stand too low for that depth
    const PLATE_TOP = 0.072
    const DRUM_TOP = 0.05
    const DRUM_H = 0.428
    const DRUM_GAP = 0.05

    // leg ring radius: 0.62 on a normal deck, pulled in on a NARROW one so the legs stay under the disc (radius
    // 0.75*width) and inside the drum. A fixed 0.62 puts the legs outside the plate below a ~0.9 m lane.
    // legR(w) = min(LEG_R, 0.75*w - LEG_INSET), floored at LEG_R_MIN.
    const LEG_R = 0.62
    const LEG_INSET = 0.13
    const LEG_R_MIN = 0.05
    const legAngle = (i) => (i / 4) * Math.PI * 2 + Math.PI / 4
    // one coordinate of a point on the leg ring at angle a: c * legR(width), with c = cos a or sin a
    const legRingRef = (axis, c) => {
      const [lo, hi] = [c * LEG_R, c * LEG_R_MIN].sort((p, q) => p - q)
      return { axis, param: 'width', scale: c * (PLATE / 2), add: -c * LEG_INSET, min: lo, max: hi }
    }
    // The legs' and feet's x and z write their refs out: the ring's slopes are cos/sin multiples that a compiled ref
    // would round to 8 decimals, which moves a leg by up to 4e-9 m. Their LEG_R_MIN floor lies below the narrowest
    // lane (width 0.3), so it never takes effect.
    // one static single pole (finish:'leg' = matte-grey galvanised steel). Its length + centre track `standHeight`
    // (the deck-above-floor distance the host fills via rest:'surfaceBelow'), top pinned at y = −0.1 - just under
    // the plate top at −0.072, so it hides beneath the disc instead of poking through - and its foot at
    // −standHeight, so translating the turntable up regrows the legs down to the surface.
    const LEG_TOP = 0.1 // pole top y = −LEG_TOP (below the plate top −0.072)
    const leg = (i) => {
      const a = legAngle(i)
      return {
        name: `leg${i}`,
        shape: { kind: 'box', size: [0.1, Math.max(p.standHeight - LEG_TOP, 0.05), 0.1] },
        offset: [Math.cos(a) * LEG_R, -0.5 * p.standHeight - LEG_TOP / 2, Math.sin(a) * LEG_R],
        offsetParams: [legRingRef(0, Math.cos(a)), legRingRef(2, Math.sin(a))],
        finish: 'leg',
      }
    }
    // a foot plate under each pole; its y tracks −standHeight so the plate rides the floor as the legs extend
    const foot = (i) => {
      const a = legAngle(i)
      return {
        name: `foot${i}`,
        shape: { kind: 'box', size: [0.26, 0.02, 0.26] },
        offset: [Math.cos(a) * LEG_R, -p.standHeight, Math.sin(a) * LEG_R],
        offsetParams: [legRingRef(0, Math.cos(a)), legRingRef(2, Math.sin(a))],
        finish: 'leg',
        collision: 'none',
      }
    }

    // The convey lane's CROSS arm, in two pieces. The lane box below reaches both rims down the lane axis; the
    // deck TURNS, so the cross axis needs the same level support - an outfeed seam is as real as an infeed one.
    // Each piece runs from the lane flank out to the rim (|z| from width/2 to width*PLATE/2), carrying
    // CAP_OVERLAP of overlap INWARD so float error can never open a slot between the two, and stopping dead ON
    // the rim so it stays clear of a cross-fed neighbour's deck.
    const CAP_OVERLAP = 0.02
    const laneCap = (sign) => ({
      name: sign < 0 ? 'laneCapLeft' : 'laneCapRight',
      shape: { kind: 'box', size: [p.width, 0.06, p.width * ((PLATE - 1) / 2) + CAP_OVERLAP] },
      offset: [0, -0.03, sign * (p.width * ((PLATE + 1) / 4) - CAP_OVERLAP / 2)],
      conveys: true,
      hidden: true,
      color: [0.12, 0.12, 0.13],
    })

    // the side motor block - a compact right-angle gearmotor riding the deck: gearbox, C-face adapter, a finned
    // induction motor, end bell, black fan cowl + grille, a terminal box on the outward flank, a nameplate. A
    // transform-only `frame` pivot parents the pieces and tracks the lane edge (z = width/2 + MOTOR_EDGE) so the
    // whole assembly reflows with `width`; every piece is decorative (collision: 'none').
    //
    // IT STAYS BELOW THE ROLLER TOPS. The motor stands beside the lane, where a load wider than the lane (a
    // pallet's overhang) passes over it, and a decorative link has no collider - a motor standing proud of the
    // rollers was drawn straight through every such load. So the motor is SET INTO A POCKET in the deck plate
    // (a dark opening with a steel rim, flush on the plate top) and sized so its highest point clears the cargo
    // datum by 5 mm. The terminal box sits on the outward flank rather than on top for the same reason.
    //
    // The pieces are FLAT painted colours, not a steel finish: the shared Metal.webp texture is tuned for large frame
    // members and washed a hand-sized motor out into one pale grey blob.
    const RZ90 = [0, 0, Math.SQRT1_2, Math.SQRT1_2] // cylinder local +Y → +X
    const RX90 = [Math.SQRT1_2, 0, 0, Math.SQRT1_2] // cylinder local +Y → +Z
    const MOTOR_EDGE = 0.1 // motor axis, out from the lane edge
    const motorPivot = { name: 'motorPivot', parent: 'deck', shape: { kind: 'frame' }, offset: [0, 0.09, p.width / 2 + MOTOR_EDGE] }
    // finishes (LINEAR rgb): gearmotor blue-grey paint (RAL 7031), the black fan cowl, bright machined steel, the
    // pocket's dark opening + its rim, the aluminium nameplate
    const PAINT = { color: [0.05, 0.075, 0.095], metalness: 0.15, roughness: 0.45 }
    const BLACK = { color: [0.015, 0.015, 0.017], metalness: 0.1, roughness: 0.55 }
    const GRILLE = { color: [0.004, 0.004, 0.005], metalness: 0, roughness: 0.9 }
    const STEEL = { color: [0.7, 0.7, 0.72], metalness: 0.9, roughness: 0.28 }
    const POCKET = { color: [0.006, 0.006, 0.007], metalness: 0, roughness: 0.95 }
    const RIM = { color: [0.03, 0.03, 0.035], metalness: 0.4, roughness: 0.6 }
    const NAMEPLATE = { color: [0.55, 0.56, 0.58], metalness: 0.7, roughness: 0.35 }
    // pivot-local frame: +x down the lane (motor axis), +z outward from the lane. The pivot sits 0.032 below the
    // cargo datum (deck-local 0.09, deck at −0.122), so the plate top is at y = −0.04 and the datum at +0.032.
    const DATUM = 0.032
    const DECK_TOP = -0.04
    const TOP = DATUM - 0.005 // the motor's highest point: 5 mm under the roller tops
    const BODY_R = 0.045
    const FIN_H = 0.011 // how far the cooling fins stand off the body
    const AXIS_Y = TOP - BODY_R - FIN_H // the top fins are the motor's highest point
    // the drive line: the heavy rollers' axles are HEAVY.radius below the datum, and the side rail (0.01 thick)
    // stands just outside the lane
    const DRIVE_Y = DATUM - HEAVY.radius // the centre roller's axle height, pivot-local
    const RAIL_OUT = -MOTOR_EDGE + 0.01 // the side rail's outer face, pivot-local z
    // SCALE WITH THE LANE. Full size at the default width and up; on a narrower turntable the whole assembly
    // shrinks in proportion (s = width / MOTOR_W0, floored at MOTOR_S_MIN) so it stays on the plate: its outer
    // corner reaches ~0.2 m past the lane edge, the plate only 0.25*width, so a fixed-size motor overhung the
    // disc below a ~0.8 m lane. Every piece scales about a point that must not move: x about the drive shaft
    // (x = 0), z about the side rail's outer face (the bearing stays bolted to the rail), y by `yMode` -
    //   'deck'  about the plate top, so the motor shrinks DOWN into its pocket and stays under the roller tops;
    //   'drive' about the roller axle line, so the shaft stays on the centre roller's axle;
    //   'fixed' not at all (the pocket + rim lie on the plate; the gearbox keeps its height so the axle line,
    //           which is fixed by the roller size, always lands inside it).
    // With the floor at half size it stays on the plate down to a ~0.62 m lane.
    // These refs are written out: their slopes are unrounded quotients, which a compiled ref would round to 8
    // decimals, moving a piece by up to 1e-8 m. An offset axis that sits on its fixed point never moves, so it is a
    // plain number with no ref.
    const MOTOR_W0 = 1.524
    const MOTOR_S_MIN = 0.5
    // one resolved value v0 * s about the fixed point c: c + (v0 - c) * clamp(width / MOTOR_W0, MOTOR_S_MIN, 1)
    const scaledRef = (axis, v0, c) => {
      const [lo, hi] = [v0, c + (v0 - c) * MOTOR_S_MIN].sort((p, q) => p - q)
      return { axis, param: 'width', scale: (v0 - c) / MOTOR_W0, add: c, min: lo, max: hi }
    }
    const scaledShape = (shape, yMode) => {
      if (shape.kind === 'cylinder') return { ...shape, sizeParams: [scaledRef(0, shape.radius, 0), scaledRef(1, shape.height, 0)] }
      const axes = yMode === 'fixed' ? [0, 2] : [0, 1, 2]
      return { ...shape, sizeParams: axes.map((i) => scaledRef(i, shape.size[i], 0)) }
    }
    const scaledOffset = (o, yMode) =>
      [
        [0, 0],
        [2, RAIL_OUT],
        ...(yMode === 'fixed' ? [] : [[1, yMode === 'drive' ? DRIVE_Y : DECK_TOP]]),
      ]
        .filter(([axis, c]) => o[axis] !== c)
        .map(([axis, c]) => scaledRef(axis, o[axis], c))
    const mp = (name, shape, offset, finish, orient, yMode = 'deck') => {
      const offsetParams = scaledOffset(offset, yMode)
      return {
        name,
        parent: 'motorPivot',
        shape: scaledShape(shape, yMode),
        offset,
        ...(offsetParams.length ? { offsetParams } : {}),
        ...orient,
        ...finish,
        collision: 'none',
      }
    }
    const GB = { x: 0.1, y: TOP - (AXIS_Y - 0.05), z: 0.09 } // gearbox case: top at TOP, 5 cm under the axis
    const GB_Y = TOP - GB.y / 2
    const BODY_X0 = GB.x / 2 + 0.015 // motor body starts past the gearbox + adapter
    const BODY_L = 0.15
    const BODY_X = BODY_X0 + BODY_L / 2
    const COWL_X0 = BODY_X0 + BODY_L + 0.012 // past the end bell
    // cooling fins: radial ribs around the body, leaving the top (nameplate) and the outward flank (terminal box)
    // clear, like a cast TEFC frame; the ones under the plate top are hidden in the pocket
    const FIN_ANGLES = [35, 60, 120, 145, 215, 240, 270, 300, 325]
    const fin = (deg) => {
      const a = (deg * Math.PI) / 180
      const r = BODY_R + FIN_H / 2
      return mp(`mFin${deg}`, { kind: 'box', size: [BODY_L - 0.02, FIN_H, 0.006] }, [BODY_X, AXIS_Y + Math.cos(a) * r, Math.sin(a) * r], PAINT, { rotation: [a, 0, 0] })
    }
    // the pocket: its footprint covers the whole motor (gearbox face to grille, lane side of the gearbox to the
    // terminal box), drawn as a dark opening 1 mm proud of the plate top with a thin steel rim round it
    const TB_Z = BODY_R + 0.018 // terminal box centre, out on the flank
    const POCKET_X = [-GB.x / 2 - 0.012, COWL_X0 + 0.05]
    const POCKET_Z = [-GB.z / 2 - 0.012, TB_Z + 0.03]
    const PX = (POCKET_X[0] + POCKET_X[1]) / 2
    const PZ = (POCKET_Z[0] + POCKET_Z[1]) / 2
    const PL = POCKET_X[1] - POCKET_X[0]
    const PW = POCKET_Z[1] - POCKET_Z[0]
    const RIM_W = 0.012
    const RIM_H = 0.004
    const motorParts = [
      mp('mPocket', { kind: 'box', size: [PL, 0.002, PW] }, [PX, DECK_TOP + 0.001, PZ], POCKET, undefined, 'fixed'),
      mp('mRimN', { kind: 'box', size: [PL + 2 * RIM_W, RIM_H, RIM_W] }, [PX, DECK_TOP + RIM_H / 2, POCKET_Z[0] - RIM_W / 2], RIM, undefined, 'fixed'),
      mp('mRimS', { kind: 'box', size: [PL + 2 * RIM_W, RIM_H, RIM_W] }, [PX, DECK_TOP + RIM_H / 2, POCKET_Z[1] + RIM_W / 2], RIM, undefined, 'fixed'),
      mp('mRimW', { kind: 'box', size: [RIM_W, RIM_H, PW] }, [POCKET_X[0] - RIM_W / 2, DECK_TOP + RIM_H / 2, PZ], RIM, undefined, 'fixed'),
      mp('mRimE', { kind: 'box', size: [RIM_W, RIM_H, PW] }, [POCKET_X[1] + RIM_W / 2, DECK_TOP + RIM_H / 2, PZ], RIM, undefined, 'fixed'),
      // right-angle gearbox: the cast case, its top at the clearance line
      mp('mGearbox', { kind: 'box', size: [GB.x, GB.y, GB.z] }, [0, GB_Y, 0], PAINT, undefined, 'fixed'),
      // output side (toward the lane): a shaft-mounted drive onto the CENTRE roller. The gearbox output sits on
      // that roller's axle line (DRIVE_Y, x = 0 - the bed's k = 0 roller), and the shaft runs through a flange
      // bearing bolted to the side rail's outer face into the roller end, so the motor visibly drives the bed.
      mp('mHousing', { kind: 'cylinder', radius: 0.026, height: 0.012 }, [0, DRIVE_Y, -GB.z / 2 - 0.006], PAINT, { quat: RX90 }, 'drive'),
      mp('mShaft', { kind: 'cylinder', radius: 0.012, height: MOTOR_EDGE - GB.z / 2 + 0.01 }, [0, DRIVE_Y, (-GB.z / 2 - MOTOR_EDGE - 0.01) / 2], STEEL, { quat: RX90 }, 'drive'),
      mp('mCollar', { kind: 'cylinder', radius: 0.018, height: 0.01 }, [0, DRIVE_Y, (-GB.z / 2 - 0.012 + RAIL_OUT) / 2], STEEL, { quat: RX90 }, 'drive'),
      mp('mBearing', { kind: 'box', size: [0.05, 0.05, 0.008] }, [0, DRIVE_Y, RAIL_OUT + 0.004], PAINT, undefined, 'drive'),
      ...[-1, 1].flatMap((sx) => [-1, 1].map((sy) => mp(`mBearingBolt${sx < 0 ? 'L' : 'R'}${sy < 0 ? 'B' : 'T'}`, { kind: 'cylinder', radius: 0.0035, height: 0.005 }, [sx * 0.017, DRIVE_Y + sy * 0.017, RAIL_OUT + 0.0105], STEEL, { quat: RX90 }, 'drive'))),
      // C-face adapter flange between the gearbox and the motor
      mp('mAdapter', { kind: 'cylinder', radius: BODY_R + 0.006, height: 0.015 }, [GB.x / 2 + 0.0075, AXIS_Y, 0], PAINT, { quat: RZ90 }),
      // the motor: body, fins, non-drive end bell
      mp('mBody', { kind: 'cylinder', radius: BODY_R, height: BODY_L }, [BODY_X, AXIS_Y, 0], PAINT, { quat: RZ90 }),
      ...FIN_ANGLES.map(fin),
      mp('mEndBell', { kind: 'cylinder', radius: BODY_R + 0.005, height: 0.012 }, [BODY_X0 + BODY_L + 0.006, AXIS_Y, 0], PAINT, { quat: RZ90 }),
      // fan cowl + its vent grille on the end face
      mp('mCowl', { kind: 'cylinder', radius: BODY_R + 0.004, height: 0.04 }, [COWL_X0 + 0.02, AXIS_Y, 0], BLACK, { quat: RZ90 }),
      mp('mGrille', { kind: 'cylinder', radius: BODY_R - 0.008, height: 0.003 }, [COWL_X0 + 0.0415, AXIS_Y, 0], GRILLE, { quat: RZ90 }),
      // terminal box on the outward flank: box, lid, and a cable gland out its end
      mp('mTerminal', { kind: 'box', size: [0.06, 0.05, 0.03] }, [BODY_X - 0.01, AXIS_Y, TB_Z], PAINT),
      mp('mTermLid', { kind: 'box', size: [0.066, 0.056, 0.006] }, [BODY_X - 0.01, AXIS_Y, TB_Z + 0.018], PAINT),
      mp('mGland', { kind: 'cylinder', radius: 0.007, height: 0.016 }, [BODY_X + 0.028, AXIS_Y, TB_Z], BLACK, { quat: RZ90 }),
      // nameplate on top of the body, between the fins
      mp('mNameplate', { kind: 'box', size: [0.05, 0.002, 0.026] }, [BODY_X, AXIS_Y + BODY_R + 0.001, 0], NAMEPLATE),
    ]

    // THE SLEW DRIVE - what turns the deck. The motor above drives the ROLLERS; nothing showed what rotates the
    // table. A real one: a ring gear on the underside of the rotating frame, and a gearmotor on the FIXED base whose
    // pinion meshes with it. So: a ring gear under the drum (parented to the deck, so it turns with it), an X of
    // base beams joining the legs just under it, and a vertical gearmotor at angle 0 (between two legs) with its
    // pinion on the ring's edge, carried by an arm off the beams' crossing.
    //
    // Heights hang from the drum bottom DB = max(−0.5, −standHeight + DRUM_GAP) (the drum's own rule above), each
    // piece at DB + k. The motor reaches SLEW_REACH below DB, so on a stand too low to fit it the whole drive RIDES
    // UP instead of reaching the floor: y = max(−0.5 + k, −standHeight + SLEW_REACH + FLOOR_GAP + k). It then sits
    // up inside the drum (hidden) with only the cowl showing under it - the drive of a low table lives in its base.
    // Widths track the lane like the legs: the ring radius is min(0.5, 0.75*width − 0.3) (floored at 0.05), so the
    // ring, pinion and motor stay under a narrow deck and clear of the leg ring.
    // The base beams' floor (2 * LEG_R_MIN) lies below the narrowest lane (width 0.3), so it never takes effect and
    // the compiled ref leaves it out.
    const SLEW_REACH = 0.298 // drum bottom → grille face
    const FLOOR_GAP = 0.007
    const slewY = (k, add = 0) => Math.max(-p.standHeight + SLEW_REACH + FLOOR_GAP + k + add, -0.5 + k + add)
    const DECK_Y = 0.122 // datum → deck-local (the deck link sits at y = −0.122)
    const RING_R = 0.5
    const RING_H = 0.025
    const PINION_R = 0.045
    const SLEW_X = RING_R + PINION_R - 0.004 // pinion + motor axis, radially out on +x (meshing the ring edge)
    // a value that tracks the ring radius: v at full size, v − (RING_R − ring(w)) on a narrow deck
    const ring = (v, floor) => clamp((p.width * PLATE) / 2 + v - RING_R - 0.3, floor, v)
    const GEAR = { color: [0.3, 0.3, 0.32], metalness: 0.8, roughness: 0.4 }
    const sp = (name, shape, k, x, finish, extra = {}) => ({
      name,
      shape,
      offset: [x ? ring(x, x - RING_R + 0.05) : 0, slewY(k), 0],
      ...finish,
      collision: 'none',
      ...extra,
    })
    const slewParts = [
      // the ring gear: a machined toothed band round a dark web, turning with the deck
      {
        name: 'slewRing',
        parent: 'deck',
        shape: { kind: 'cylinder', radius: ring(RING_R, 0.05), height: RING_H },
        offset: [0, slewY(-RING_H / 2, DECK_Y), 0],
        ...GEAR,
        collision: 'none',
      },
      {
        name: 'slewRingWeb',
        parent: 'deck',
        shape: { kind: 'cylinder', radius: ring(RING_R - 0.02, 0.03), height: RING_H + 0.002 },
        offset: [0, slewY(-RING_H / 2, DECK_Y), 0],
        ...RIM,
        collision: 'none',
      },
      // the fixed base: an X of beams leg to leg, 1 cm under the ring, their length tracking the leg ring
      ...[1, -1].map((sgn) => ({
        name: sgn > 0 ? 'baseBeamA' : 'baseBeamB',
        shape: { kind: 'box', size: [clamp(p.width * PLATE - 2 * LEG_INSET, 2 * LEG_R_MIN, 2 * LEG_R), 0.05, 0.08] },
        offset: [0, slewY(-0.06), 0],
        rotation: [0, (sgn * Math.PI) / 4, 0],
        finish: 'leg',
        collision: 'none',
      })),
      // the arm from the beams' crossing out to the slew motor
      {
        name: 'slewArm',
        shape: { kind: 'box', size: [ring(SLEW_X, SLEW_X - RING_R + 0.05), 0.04, 0.06] },
        // its centre is half its length, so it moves at half the ring's rate
        offset: [ring(SLEW_X, SLEW_X - RING_R + 0.05) / 2, slewY(-0.06), 0],
        finish: 'leg',
        collision: 'none',
      },
      // the slew gearmotor, standing on its axis: pinion on the ring edge, gearbox, motor body, cowl, grille
      sp('slewPinion', { kind: 'cylinder', radius: PINION_R, height: RING_H }, -RING_H / 2, SLEW_X, STEEL),
      sp('slewGearbox', { kind: 'box', size: [0.1, 0.07, 0.1] }, -0.06, SLEW_X, PAINT),
      sp('slewMotor', { kind: 'cylinder', radius: 0.042, height: 0.16 }, -0.175, SLEW_X, PAINT),
      sp('slewCowl', { kind: 'cylinder', radius: 0.046, height: 0.04 }, -0.275, SLEW_X, BLACK),
      sp('slewGrille', { kind: 'cylinder', radius: 0.036, height: 0.003 }, -SLEW_REACH + 0.0015, SLEW_X, GRILLE),
    ]

    const links = [
      // the rotating deck - a flat disc on the revolute 'rotate' joint; kinematic, finish:'frame' → blue plate
      // steel, width-parametric radius. Its top sits 72 mm below the conveys lane surface so the static lane owns
      // the cargo contact (coplanar bodies would fight for it): cargo off the lane rests on the disc and is
      // friction-carried as it turns. 72 mm is a STEP, not a seam, which is why the lane cross above spans the
      // plate to both rims - cargo should only ever reach this disc off the cross's diagonals. The plate top at y = −0.072 (−1.8 × the 0.04 roller radius) keeps the heavy
      // rollers proud of the plate, with the side frames / end brackets clearing it.
      // The deck also GRIPS: while it slews it carries whatever stands on it (see the behavior's carry note),
      // so the load leaves at exactly the deck angle instead of at whatever the friction drive happened to
      // deliver. The zone is the LANE square (width x width) rather than the plate circle, so it can never
      // reach a load standing on a butting conveyor: the plate rim is at 0.75*width from the pivot and this
      // box's own corner only reaches 0.707*width. It is tall (2.4 m) because the pick test is CENTRE-in-zone
      // and a full stack's top cases sit well above the deck - the same reason the AGV's fork zone is tall.
      // Local +y 1.272 puts it 0.05 m under the cargo datum (deck-local +0.122) and 2.35 m above it.
      {
        name: 'deck',
        shape: { kind: 'cylinder', radius: discR, height: 0.1 },
        offset: [0, -0.122, 0],
        finish: 'frame',
        bed: true,
        grip: { zone: { size: [p.width, 2.4, p.width], offset: [0, 1.272, 0] } },
      },
      // the drum below the deck - dark frame steel, hanging from the plate top (−0.072) down to −0.5. On a LOW
      // stand it stops DRUM_GAP above the floor instead: its depth was fixed, so any standHeight under 0.5 (typed
      // in, or the part moved down) sank the drum through the floor. The depth + centre both track standHeight
      // and clamp at the same stand height (0.55 = 0.072 + 0.428 + DRUM_GAP), so above that nothing changes.
      {
        name: 'drum',
        parent: 'deck',
        shape: {
          kind: 'cylinder',
          radius: discR - 0.05,
          height: clamp(p.standHeight - (PLATE_TOP + DRUM_GAP), 0.02, DRUM_H),
        },
        // centre = top − depth/2, in deck-local y; clamped at the same stand heights as the depth above
        offset: [0, clamp(DRUM_TOP + (PLATE_TOP + DRUM_GAP) / 2 - p.standHeight / 2, DRUM_TOP - DRUM_H / 2, DRUM_TOP - 0.01), 0],
        finish: 'frame',
        bed: true,
        collision: 'none',
      },
      // the round roller bed's frame on the deck: the behavior's geometry() draws the bed onto it (rollers fanned
      // across the plate, end brackets, the bolt ring), so it turns with the platter. Transform-only; the offset y
      // cancels the deck's, putting the bed's local origin on the cargo datum (roller tops at y = 0).
      { name: 'roller', parent: 'deck', shape: { kind: 'frame' }, offset: [0, 0.122, 0] },
      // the convey lane - the powered roller bed as a hidden `conveys` box whose top is the cargo datum (the part
      // origin). Static + root-level: a conveys body never rotates with a joint, so the behavior steers its
      // world-space surface velocity to track the deck's current yaw.
      //
      // IT REACHES THE RIM, and that is the whole point of its shape. A neighbour butts the PLATE (the snap end
      // sits at radius = width*PLATE/2, not at the lane edge - conveyorLocalEnds), the roller fan is drawn across
      // the full plate diameter, and conveyingSurfaceAt reports a flat surface over the whole platter. A
      // width x width SQUARE here would disagree with all three: a 0.25*width band inside the rim (0.38 m at the
      // default width, 0.4 m in the demo) carries no collider at the cargo datum at all, and the highest thing
      // under it is the deck plate, 72 mm down. Measured across that band: a pallet long enough to bridge it
      // hopped 3 mm over the lane's 60 mm lip, and a 0.4 m case dropped 37 mm into it, tilted 17 degrees and
      // JAMMED - it never reached the plate at all.
      //
      // A rotating rectangle cannot do this job: parented to the deck, a lane-wide box may only reach
      // sqrt(R^2 - (width/2)^2) ~ 0.56*width before its corners sweep outside the plate and into a butted
      // neighbour. So the support is static and shaped to the disc instead - this box down the lane axis to both
      // rims, plus the two `laneCap` pieces on the cross axis. On the diagonals the cross still falls 0.065 m
      // short of the rim, exactly as a square would; on the two axes a load rides level rim to rim.
      //
      // Both arms stop EXACTLY at the rim, which is what keeps them off the neighbours: an axially butted lane
      // begins at the radius this ends at, and a cross-fed one at |z| = radius, clear of this arm's width/2
      // flanks. No arm is ever coplanar with a neighbour's deck, so no two conveyor bodies fight one contact.
      {
        name: 'lane',
        shape: { kind: 'box', size: [p.width * PLATE, 0.06, p.width] },
        offset: [0, -0.03, 0],
        conveys: true,
        hidden: true,
        color: [0.12, 0.12, 0.13],
      },
      laneCap(-1), laneCap(1),
      // (the side-frame rails + end brackets come with the roller bed geometry() draws, so they stay aligned with
      //  the chord-clipped roller fan at every width)
      // four static legs (root-level - they do not rotate with the deck) + their foot plates
      leg(0), leg(1), leg(2), leg(3),
      foot(0), foot(1), foot(2), foot(3),
      motorPivot, ...motorParts,
      ...slewParts,
    ]
    // a continuous revolute: the behavior keeps the commanded angle wrapped in (−180°, 180°], so the limits are
    // just the host's clamp over the full wrap range, not a mechanical stop. `rest` binds the settled angle to a
    // param (deckAngleDeg° → radians) so the host can mirror the held pose without running the behavior. It is a ref
    // by nature: no number rig() returns is the settled angle.
    const joints = [{ name: 'rotate', link: 'deck', type: 'revolute', axis: [0, 1, 0], min: -Math.PI, max: Math.PI, rest: { param: 'deckAngleDeg', scale: Math.PI / 180 } }]
    const bounds = { length: 1.6, width: 1.6, top: 0.6 }
    return { links, joints, bounds }
  },
  joints: ['rotate'],
  grippers: ['deck'],
  params: {
    width: { type: 'number', default: 1.524, min: 0.3, step: 0.05, label: 'Lane width (m)', group: 'Size', desc: 'Width of the conveying lane across the deck. Size it to the conveyors it indexes between, since the lane is what actually carries product once the deck has settled.' },
    // deck height above the floor — drives the leg length. rest:'surfaceBelow' lets the host auto-fill it from
    // the surface beneath at drop/snap/translate, so raising the turntable regrows the legs to reach.
    standHeight: { type: 'number', default: 0.95, min: 0.1, max: 3, step: 0.01, rest: 'surfaceBelow', label: 'Stand height (m)', desc: 'Height of the deck above whatever is beneath it, which sets the leg length. The host fills this in when you drop or snap the turntable, so raising it regrows the legs to reach.' },
    ...speedUnitParams(1),
    speed: { type: 'number', unit: 'm/s', ...METRIC_ONLY, default: 1, min: -3, max: 3, step: 0.1, label: 'Speed', desc: 'How fast the lane conveys once the deck has SETTLED at its target angle. While the deck is still slewing the lane carries nothing forward - product just rides round with the platter - so this only applies between moves. Negative runs the lane backwards.' },
    deckAngleDeg: { type: 'number', default: 0, min: -180, max: 180, step: 15, label: 'Deck angle (°)', desc: 'Target angle for the deck, which then slews to it and holds. This is the whole control surface with no tags named: an angled cross-feed you aim from the Inspector rather than a self-runner. A program commands it through the angle tag below instead.' },
    // TOP speed, reached through the ramp below. 20°/s is a 90° index in ~5 s including both ramps, which is
    // where real units sit (3-6 s); the old 45°/s default was about double industry practice, and combined
    // with an instant start it demanded more of the deck than any real drive delivers.
    rotationSpeedDeg: { type: 'number', unit: '°/s', default: 20, min: 1, max: 360, step: 5, label: 'Rotation speed', desc: 'TOP slew rate, reached through a fixed acceleration ramp rather than instantly. The default indexes 90 degrees in about 5 seconds including both ramps, which is where real units sit - winding it much higher asks more of the deck than a real drive delivers, and product slides.' },
    angleTag: { type: 'tag', dir: 'in', stType: 'REAL', setpointFor: 'deckAngleDeg', default: '', label: 'Target angle tag', group: 'Comms', desc: 'The program commands the deck angle here, replacing the Deck angle field above. On the first scan the part SEEDS the tag with the authored angle, so a program that has not written yet does not slam the deck to zero.' },
    speedTag: { type: 'tag', ...METRIC_ONLY, dir: 'in', stType: 'REAL', setpointFor: 'speed', default: '', label: 'Speed tag', group: 'Comms', desc: 'The program commands lane speed here, replacing the Speed field above. Careful: once BOUND this takes over even if no program drives it, and an undriven tag reads 0.' },
    ...speedFpmTagParam('Comms'),
    doneTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Done tag (true once settled)', group: 'Comms', desc: 'Handshake back to the program: true once the deck has stopped at its target angle. Wait on this before commanding the lane to run, or product is pushed at a deck still turning under it.' },
    enableTag: { type: 'tag', dir: 'in', stType: 'BOOL', onlyWhenDriven: true, default: '', label: 'Enable tag', group: 'Comms', desc: 'The deck turns only while this is true. Drop it mid-turn and the deck brakes to a stop where it is, still holding its load; raise it and the turn finishes. Lane speed is not affected: command that through the speed tag. Until a program drives it, or with it empty, the deck is always enabled, so a merely-typed tag does not hold it.' },
  },
  // The round roller bed, drawn on the deck's 'roller' frame so it turns with the platter: rollers fanned across
  // the full plate diameter at the heavy pitch, each clipped to the plate circle (long across the lane, tapering
  // to the round rim), L end brackets on the tapered outer rollers the side rails don't reach, and a hex-bolt ring
  // rimming the plate. The rollers turn at the lane's conveying speed ('rollerSpeed', reported by step()).
  geometry(g, p) {
    var width = typeof p.width === 'number' && p.width > 0 ? p.width : 1.524
    var R = HEAVY.radius, PITCH = HEAVY.pitch
    var RIM = 0.06 //           rollers clip this far in from the plate rim
    var BRACKET = 0.06 //       length of one roller end-holder along the lane
    var WALL = 0.01 //          side-frame wall thickness
    var deckR = (width * PLATE) / 2, laneHalf = width / 2
    var rBed = Math.max(deckR - RIM, 0)
    var kMax = Math.floor(rBed / PITCH)
    var rollers = [], tapered = []
    for (var k = -kMax; k <= kMax; k++) {
      var s = k * PITCH
      var half = Math.min(laneHalf, Math.sqrt(Math.max(rBed * rBed - s * s, 0)))
      if (half <= 0.02) continue // a sliver at the very rim
      rollers.push({ x: s, z: 0, yaw: 0, length: half * 2 })
      if (half < laneHalf - 0.01) tapered.push({ s: s, half: half }) // shorter than the lane: past the side rails
    }
    var parts = rollerBed(g, rollers, { radius: R, y: -R, link: 'roller', speed: 'rollerSpeed' })
    // side-frame steel off the roller radius: from just below the plate top up to the frame top
    var plateTopY = -1.8 * R, baseY = plateTopY - 0.01, frameTopY = -0.3 * R
    var railH = Math.max(frameTopY - baseY, 0.02), railCY = baseY + railH / 2
    var boxes = []
    var railLen = 2 * Math.sqrt(Math.max(rBed * rBed - laneHalf * laneHalf, 0))
    if (railLen > 0.05) {
      var zc = laneHalf + WALL / 2
      boxes.push({ position: [0, railCY, zc], scale: [railLen, railH, WALL] }, { position: [0, railCY, -zc], scale: [railLen, railH, WALL] })
    }
    for (var t = 0; t < tapered.length; t++) {
      var z = tapered[t].half + WALL / 2
      boxes.push({ position: [tapered[t].s, railCY, z], scale: [BRACKET, railH, WALL] }, { position: [tapered[t].s, railCY, -z], scale: [BRACKET, railH, WALL] })
    }
    parts.push({ desc: g.box([1, 1, 1], [0, 0, 0]), finish: 'frame', link: 'roller', instances: boxes })
    // the perimeter bolt ring: hex studs seated on the plate rim, each pointing radially outward, one per ~0.25 m
    var count = Math.max(8, Math.round((2 * Math.PI * deckR) / 0.25))
    var boltY = plateTopY - 0.06, rBolt = deckR + 0.005
    var bolts = []
    for (var i = 0; i < count; i++) {
      var a = (2 * Math.PI * i) / count
      bolts.push({ position: [Math.cos(a) * rBolt, boltY, Math.sin(a) * rBolt], quaternion: yawQuat(Math.PI / 2 - a), scale: [0.012, 0.012, 0.01] })
    }
    var hex = g.lathe([[0, -0.5], [1, -0.5], [1, 0.5], [0, 0.5]], { axis: 'z', segments: 6, startAngle: Math.PI / 2, smooth: false })
    parts.push({ desc: hex, finish: 'bolt', link: 'roller', instances: bolts, castShadow: false })
    return parts
  },
  step(ctx) {
    // Setpoint precedence: the angle tag replaces the authored deckAngleDeg only while a tag is named. An empty
    // name reads 0, so without this check the deck would slew to zero and ignore its authored angle.
    const enabled = !ctx.tagDriven(ctx.params.enableTag) || ctx.readTag(ctx.params.enableTag) === true
    const bound = ctx.params.angleTag
    let target
    if (bound) {
      // seed-write once from the deck's authored angle so the PLC sees a sensible initial target; after that
      // the tag is read-only here (the PLC owns it).
      if (!seeded) ctx.writeNumber(ctx.params.angleTag, ctx.params.deckAngleDeg)
      target = seeded ? ctx.readNumber(ctx.params.angleTag) : ctx.params.deckAngleDeg
    } else {
      target = ctx.params.deckAngleDeg
    }
    seeded = true
    // shortest-path slew: wrap the delta to (−180, 180] so 350° from 0 takes the −10° road
    const topRate = ctx.params.rotationSpeedDeg
    const accel = topRate / RAMP_S // °/s², so the ramp TIME is fixed and the rate scales with the setting
    const d = wrap180(target - angle)
    const pending = Math.abs(d) > 1e-6
    // advance the carry phase (see the note by `carry`), then move only while actually carrying
    if (carry === 3) { carry = 0; rate = 0 }
    else if (carry === 0 && pending && enabled) carry = 1
    else if (carry === 1) carry = 2
    if (carry === 2) {
      // trapezoidal profile: brake once the remaining travel is only just enough to stop in (v²/2a),
      // otherwise keep accelerating toward the top rate. Landing snaps the last sub-step so a decaying
      // rate can't crawl at the target forever. With the enable dropped it brakes hard and holds, still carrying.
      const remaining = Math.abs(d)
      const brakeIn = (rate * rate) / (2 * accel)
      if (!enabled) rate = Math.max(0, rate - (topRate / SAFE_STOP_S) * ctx.dt)
      else rate = remaining <= brakeIn ? Math.max(0, rate - accel * ctx.dt) : Math.min(topRate, rate + accel * ctx.dt)
      const stepNow = rate * ctx.dt
      if (remaining <= stepNow || remaining <= 1e-6) { angle = wrap180(angle + d); carry = 3; rate = 0 }
      else angle = wrap180(angle + Math.sign(d) * stepNow)
    }
    const settled = !pending || carry === 3
    ctx.grips.deck = carry !== 0
    ctx.joints.rotate = angle * D2R // continuous revolute — the wrap keeps the command inside ±π
    // once settled, convey along the deck's current forward — ctx.forward (the part's world +X) rotated by the
    // deck angle; while slewing, spin resting cargo with the platter via the arc field instead
    const fpm = ctx.params.fpmUnits === true
    const setpointTag = fpm ? ctx.params.speedFpmTag : ctx.params.speedTag
    const setpointMs = (setpointTag ? ctx.readNumber(setpointTag) : fpm ? ctx.params.speedFpm : ctx.params.speed) * (fpm ? FPM_MS : 1)
    const speed = setpointMs
    ctx.report('speed', speed) // the lane conveys on 'speed' (m/s) whichever unit the Inspector shows
    reportSpeed(ctx, fpm, speed)
    ctx.report('deckAngleDeg', target)
    ctx.report('rollerSpeed', settled ? speed : 0) // the rollers turn with the lane, not while the deck slews
    if (settled) {
      const c = Math.cos(angle * D2R)
      const s = Math.sin(angle * D2R)
      const f = ctx.forward
      ctx.setSurfaceVelocity({ x: (f.x * c + f.z * s) * speed, y: 0, z: (f.z * c - f.x * s) * speed })
    } else {
      // the RAMPED rate, not the top speed: this field is the fallback for anything the deck grip did not
      // take (cargo that arrived mid-turn), and it should describe what the plate is actually doing
      ctx.setArcSurfaceVelocity({ center: { x: ctx.position.x, z: ctx.position.z }, omega: Math.sign(d) * rate * D2R })
    }
    if (ctx.params.doneTag) ctx.writeTag(ctx.params.doneTag, settled)
  },
})
