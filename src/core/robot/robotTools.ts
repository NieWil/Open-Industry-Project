// The tools a robot can carry, drawn by the host on the link a robot's declaration names (`robot.tool`): a vacuum plate
// or a two-finger gripper, picked by the robot's `tool` param and sized by its own params. Being host code, every
// robot shares them, imported arms included, and a fix reaches every robot in every project.
//
// Every tool is drawn in the tool frame: +Y toward the wrist, the tool hanging toward -Y, its grip point at
// (0, -TOOL_GRIP_Y, 0). A robot puts its `gripper` link (the grip zone) at that point, and its two finger links at the
// tool frame's origin, each on a sliding joint across +X / -X (the gripper's fingers ride them; the plate draws none).
//
// The vacuum plate is the six-axis robot's own tool, moved here unchanged: a painted plate framed by slotted rails with
// corner caps, the adapter the wrist flange bolts to, the vacuum LED, and a grid of turned suction cups that compress
// while the vacuum holds.

import type { GeometryBuilder, MeshPart, ParamValue } from '../parts/partApi'
import type { PartMaterial } from '../parts/partPackage'

export type RobotToolKind = 'vacuum' | 'gripper' | 'none'

/** the lamp a tool lights while it grips: the vacuum LED, the gripper's status light */
export const ROBOT_TOOL_LAMP = 'vacuumLamp'
/** the two finger links a robot carries for the gripper, children of its tool link at the tool frame's origin */
export const ROBOT_FINGER_LINKS = ['fingerA', 'fingerB'] as const
/** how far the grip point is below the tool frame's origin (m): the suction cups' rim, the gripper's finger pads */
export const TOOL_GRIP_Y = 0.165672 - 0.009

/** The materials the tools draw with. A robot that carries tools declares these in its manifest. Colours are linear. */
export const ROBOT_TOOL_MATERIALS: PartMaterial[] = [
  { id: 'eoatPaint', color: [0.639, 0.116, 0.0066], metalness: 0, roughness: 0.55 },
  { id: 'eoatRail', color: [0.04, 0.04, 0.045], metalness: 0.7, roughness: 0.35 },
  { id: 'eoatSteel', color: [0.18, 0.18, 0.19], metalness: 0.85, roughness: 0.45 },
  { id: 'eoatCup', color: [0.024, 0.104, 0.4], metalness: 0, roughness: 0.75 },
  { id: 'eoatPlastic', color: [0.02, 0.02, 0.022], metalness: 0, roughness: 0.5 },
  { id: 'eoatLens', color: [0.03, 0.06, 0.03], metalness: 0, roughness: 0.25 },
]

const num = (p: Readonly<Record<string, ParamValue>>, k: string, d: number): number => (typeof p[k] === 'number' && Number.isFinite(p[k]) ? (p[k] as number) : d)

/** The tool `params.tool` names (a vacuum plate when the robot has no `tool` param), drawn on `link`. */
export function robotToolParts(g: GeometryBuilder, params: Readonly<Record<string, ParamValue>>, link: string): MeshPart[] {
  const kind = typeof params.tool === 'string' ? params.tool : 'vacuum'
  if (kind === 'vacuum') return vacuumPlate(g, params, link)
  if (kind === 'gripper') return twoFingerGripper(g, params, link)
  return []
}

// The vacuum plate, in the tool frame (+Y toward the wrist, the cups hanging toward -Y). Its numbers are the tool
// model this replaced: plate back face -0.0517 and front face -0.101, rails 59 mm deep centred on -0.075 with their
// outer faces 3 mm outside ±size/2, cups mounted at -0.1035 and 53 mm tall, the adapter 192 x 318 mm reaching -0.013
// toward the flange. The cup grid is the host's `grid` array rule (count = floor(usable / pitch) + 1 per axis, spread
// edge to edge across ±usable/2, thinned to 256 cups by spreading the longer axis). The cups compress ~15% about the
// rim while the vacuum holds. The vacuum LED is the grip tell: a round lens in a black bezel on the plate's back face,
// riding the +X/+Z corner so it tracks the plate as the tool resizes.
function vacuumPlate(g: GeometryBuilder, p: Readonly<Record<string, ParamValue>>, link: string): MeshPart[] {
  const hx = num(p, 'toolSizeX', 0.5) / 2
  const hz = num(p, 'toolSizeZ', 0.5) / 2
  const RAIL_Y = -0.075 // rail centreline
  const RAIL_H = 0.059 // rail depth, back to front
  const RAIL_OUT = 0.003 // rail face, outside the plate edge
  const RAIL_W = 0.015 // rail width
  const CAP = 0.019 // corner cap, square in plan
  const out: MeshPart[] = []
  // plate and corner caps
  const paint = [g.box([2 * (hx - RAIL_W + RAIL_OUT) + 0.002, 0.0493, 2 * (hz - RAIL_W + RAIL_OUT) + 0.002], [0, -0.07635, 0])]
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      paint.push(g.bevelBox([CAP, RAIL_H + 0.004, CAP], [sx * (hx + RAIL_OUT - CAP / 2 + 0.002), RAIL_Y, sz * (hz + RAIL_OUT - CAP / 2 + 0.002)], 0.002))
    }
  out.push({ desc: g.merge(...paint), material: 'eoatPaint', link })
  // rails: a slotted extrusion between the caps
  const section = (edge: number): [number, number][] => {
    const o = edge + RAIL_OUT
    const i = o - RAIL_W
    const y0 = RAIL_Y - RAIL_H / 2
    const y1 = RAIL_Y + RAIL_H / 2
    const pts: [number, number][] = [
      [i, y0],
      [o, y0],
    ]
    for (const gy of [-0.015, 0.015]) pts.push([o, RAIL_Y + gy - 0.003], [o - 0.003, RAIL_Y + gy - 0.003], [o - 0.003, RAIL_Y + gy + 0.003], [o, RAIL_Y + gy + 0.003])
    pts.push([o, y1], [i, y1])
    return pts
  }
  const mirror = (pts: [number, number][]): [number, number][] => pts.map((q) => [-q[0], q[1]])
  const runZ = hz + RAIL_OUT - CAP + 0.002 // to the cap
  const runX = hx + RAIL_OUT - CAP + 0.002
  const swap = (pts: [number, number][]): [number, number][] => pts.map((q) => [q[1], q[0]]) // x-axis outline is (y, z)
  out.push({
    desc: g.merge(
      g.extrude(section(hx), -runZ, runZ, { axis: 'z', bevel: 0.0008 }),
      g.extrude(mirror(section(hx)), -runZ, runZ, { axis: 'z', bevel: 0.0008 }),
      g.extrude(swap(section(hz)), -runX, runX, { axis: 'x', bevel: 0.0008 }),
      g.extrude(swap(mirror(section(hz))), -runX, runX, { axis: 'x', bevel: 0.0008 }),
    ),
    material: 'eoatRail',
    link,
  })
  // adapter: a plate and a turned boss up to the flange. Its plate and bolt pattern shrink to fit a plate smaller than
  // them (a small arm's tool), keeping 30 mm of the plate clear each side; on a plate they fit, they are as drawn
  const ADAPTER_TOP = -0.0397
  const adapterX = Math.min(0.192, Math.max(0.05, 2 * hx - 0.06))
  const adapterZ = Math.min(0.318, Math.max(0.05, 2 * hz - 0.06))
  const boltX = Math.min(0.078, adapterX / 2 - 0.018)
  const boltZ = Math.min(0.14, adapterZ / 2 - 0.019)
  out.push({
    desc: g.merge(
      g.bevelBox([adapterX, 0.012, adapterZ], [0, -0.0457, 0], 0.002, ['y-']),
      g.lathe(
        [
          [0, ADAPTER_TOP],
          [0.07, ADAPTER_TOP],
          [0.07, -0.025],
          [0.062, -0.021],
          [0.062, -0.013],
          [0, -0.013],
        ],
        { segments: 40 },
      ),
    ),
    material: 'eoatSteel',
    link,
  })
  const bolts = []
  for (const bx of [-boltX, boltX])
    for (const bz of [-boltZ, 0, boltZ]) {
      bolts.push(
        g.lathe(
          [
            [0, ADAPTER_TOP],
            [0.008, ADAPTER_TOP],
            [0.008, ADAPTER_TOP + 0.005],
            [0, ADAPTER_TOP + 0.005],
          ],
          { segments: 6, smooth: false, center: [bx, 0, bz] },
        ),
      )
    }
  out.push({ desc: g.merge(...bolts), finish: 'bolt', link })
  // vacuum LED, 0.07 m in from the +X/+Z corner (nearer it on a small plate, so it stays clear of the adapter)
  const BACK = -0.0517 // plate back face
  const lx = hx - Math.min(0.07, hx * 0.3)
  const lz = hz - Math.min(0.07, hz * 0.3)
  out.push({
    desc: g.lathe(
      [
        [0, BACK],
        [0.0175, BACK],
        [0.0175, BACK + 0.005],
        [0.0155, BACK + 0.007],
        [0, BACK + 0.007],
      ],
      { segments: 32, center: [lx, 0, lz] },
    ),
    material: 'eoatPlastic',
    link,
  })
  out.push({
    desc: g.lathe(
      [
        [0, BACK + 0.007],
        [0.0135, BACK + 0.007],
        [0.012, BACK + 0.0105],
        [0.007, BACK + 0.0128],
        [0, BACK + 0.0135],
      ],
      { segments: 32, center: [lx, 0, lz] },
    ),
    material: 'eoatLens',
    link,
    lamps: [{ name: ROBOT_TOOL_LAMP, emissive: [0.15, 0.85, 0.2], offColor: [0.03, 0.06, 0.03] }],
  })
  // cup bed, squashed about the rims while the vacuum holds
  if (p.cupsEnabled !== false) {
    const axis = (size: number, pitch: number, margin: number): number[] => {
      const usable = Math.max(size - Math.max(margin, 0) * 2, 0)
      const n = Math.max(1, Math.min(64, Math.floor(usable / Math.max(pitch, 1e-4) + 1e-6) + 1))
      if (n === 1) return [0]
      const at: number[] = []
      for (let k = 0; k < n; k++) at.push(-usable / 2 + (k * usable) / (n - 1))
      return at
    }
    const cup = g.lathe(
      [
        [0, -0.0417], [0.0187, -0.0417], [0.0262, -0.047], [0.0286, -0.0532], [0.0328, -0.0532], [0.0338, -0.052],
        [0.0336, -0.0506], [0.0328, -0.0495], [0.0213, -0.0374], [0.0246, -0.0358], [0.0245, -0.035], [0.0152, -0.0232],
        [0.0112, -0.013], [0.0081, -0.0121], [0.0081, 0], [0, 0],
      ],
      { segments: 20 },
    )
    // at most 256 cups, thinned as the host's grid is
    const xs = axis(num(p, 'toolSizeX', 0.5), num(p, 'cupPitchX', 0.1), num(p, 'cupMarginX', 0.05))
    const zs = axis(num(p, 'toolSizeZ', 0.5), num(p, 'cupPitchZ', 0.1), num(p, 'cupMarginZ', 0.05))
    let nx = xs.length
    let nz = zs.length
    while (nx * nz > 256) {
      if (nx >= nz) nx--
      else nz--
    }
    const thin = (at: number[], n: number): number[] =>
      n === at.length ? at : n === 1 ? [0] : Array.from({ length: n }, (_, k) => at[0]! + ((at[at.length - 1]! - at[0]!) * k) / (n - 1))
    const instances: { position: [number, number, number] }[] = []
    for (const cx of thin(xs, nx)) for (const cz of thin(zs, nz)) instances.push({ position: [cx, -0.1035, cz] })
    out.push({ desc: cup, material: 'eoatCup', link, instances, squash: { amount: 0.15, lamp: ROBOT_TOOL_LAMP } })
  }
  return out
}

/** the gripper's finger travel, per finger (m): fully open is this far out from the grip width */
export const FINGER_TRAVEL = 0.05

// A two-finger clamp gripper, in the same tool frame: an adapter boss to the flange, a body block, a status light, and
// two paddle fingers that ride the finger links (fingerA out along +X, fingerB along -X). Tool size X is the load's
// width, so at joint 0 the pads stand that far apart, closed on it; tool size Z is how deep the paddles are. The
// controller opens them FINGER_TRAVEL each while the grip is off. The pads reach the grip point, where the plate's cup
// rims would be, so both tools pick a load of the size the grip zone (tool size X by Z) reads.
function twoFingerGripper(g: GeometryBuilder, p: Readonly<Record<string, ParamValue>>, link: string): MeshPart[] {
  const half = Math.max(0.005, num(p, 'toolSizeX', 0.5) / 2)
  const FINGER_D = Math.max(0.02, num(p, 'toolSizeZ', 0.5)) // paddle depth, along Z
  const BODY_TOP = -0.013
  const BODY_BOTTOM = -0.09
  const BODY_X = half + FINGER_TRAVEL + 0.04
  const FINGER_T = 0.018 // finger thickness, across the grip
  const fingerTop = BODY_BOTTOM + 0.01
  const fingerBottom = -TOOL_GRIP_Y - 0.015
  const out: MeshPart[] = [
    {
      desc: g.lathe(
        [
          [0, -0.025],
          [0.07, -0.025],
          [0.07, -0.013],
          [0.062, -0.009],
          [0, -0.009],
        ],
        { segments: 40 },
      ),
      material: 'eoatSteel',
      link,
    },
    { desc: g.bevelBox([2 * BODY_X, BODY_TOP - BODY_BOTTOM, 0.09], [0, (BODY_TOP + BODY_BOTTOM) / 2, 0], 0.004), material: 'eoatPaint', link },
    {
      desc: g.lathe(
        [
          [0, BODY_TOP - 0.03],
          [0.008, BODY_TOP - 0.03],
          [0.008, BODY_TOP - 0.024],
          [0, BODY_TOP - 0.024],
        ],
        { segments: 20, center: [BODY_X - 0.02, 0, 0.045] },
      ),
      material: 'eoatLens',
      link,
      lamps: [{ name: ROBOT_TOOL_LAMP, emissive: [0.15, 0.85, 0.2], offColor: [0.03, 0.06, 0.03] }],
    },
  ]
  for (const [finger, side] of [
    [ROBOT_FINGER_LINKS[0], 1],
    [ROBOT_FINGER_LINKS[1], -1],
  ] as const) {
    const x = side * (half + FINGER_T / 2)
    out.push({
      desc: g.merge(
        g.bevelBox([FINGER_T, fingerTop - fingerBottom, FINGER_D], [x, (fingerTop + fingerBottom) / 2, 0], 0.003),
        // the rail block the finger slides in, under the body
        g.box([FINGER_T + 0.02, 0.012, FINGER_D + 0.01], [x + side * 0.01, fingerTop + 0.006, 0]),
      ),
      material: 'eoatRail',
      link: finger,
    })
  }
  return out
}
