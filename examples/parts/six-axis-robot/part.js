// Six-Axis robot — a pick-and-place arm, driven the way a real robot cell's PLC drives one. The robot owns its
// JOBS: short programs of steps (move to a waypoint, vacuum on or off, wait, wait for an input, set an output) that
// the author teaches in the Inspector. The PLC picks a job by number on the command tag, raises Execute, and waits
// for Done; the robot runs the whole job itself, and signals back on its outputs. Because the robot knows its next
// point, it blends through via points with no dependence on scan timing.
//
// The controller is the host's (`robot` below, run by ctx.robot.step(); src/core/robot/robotController.ts), the one
// every robot part runs. This script declares what it reads: the waypoints, jobs, motion and tag params, and the job
// steps' labels. A robot with NO jobs falls back to single moves: the command is a waypoint row, Execute moves there,
// the vacuum tag drives the gripper. With no tags named the arm holds its idle pose.
//
// The kinematics are a rig: a tree of transform-only 'frame' links (the joint pivots) carrying per-node 'mesh'
// links (the GLB linkages, geometry-only + placed by the rig), all wearing one shared ORM material built from the
// BaseColor + ORM textures. The tool is drawn by geometry() on the 'eoat' frame.
//
// This is the part's source. `npm run build-parts` writes behavior.ts (this script as the app ships it, with the
// _shared/ modules it imports joined in and `manifest` / `rig()` left out) and rig.json (the manifest, with the
// rig compiled from rig()).

const D2R = Math.PI / 180
const r8 = (n) => (Math.abs(n) < 1e-9 ? 0 : +n.toFixed(8)) // rig numbers at 8 decimals, near-zero to 0
const X = [1, 0, 0]
const Y = [0, 1, 0]
const Z = [0, 0, 1]
// The joints, with their travel limits in degrees; the names are the ctx.joints bag's
const JOINTS = [
  { name: 'j1', link: 'basePivot', axis: Y, min: -180, max: 180 },
  { name: 'j2', link: 'upperArm', axis: Z, min: -135, max: 135 },
  { name: 'j3', link: 'forearm', axis: Z, min: -160, max: 160 },
  { name: 'j4', link: 'wristRot', axis: Y, min: -180, max: 180 },
  { name: 'j5', link: 'wristPitch', axis: Z, min: -120, max: 120 },
  { name: 'j6', link: 'tool', axis: Y, min: -360, max: 360 },
]

// ---- kinematics (transcribed from render/parts/robotKinematics.ts) ---------------------------------------
// A transform is a basis's three ROWS and an origin.
const basis = (r0, r1, r2, o) => ({ rows: [r0, r1, r2], o })
const trans = (v) => basis(X, Y, Z, v)
// joint pivot positions
const POS_UPPER = [-0.72657037, -0.34717786, -0.0024254583]
const POS_FOREARM = [-0.018255234, 0.018255234, -0.09700517]
const POS_WRIST_ROT = [0.11355525, 0.87549424, 0.09818761]
const POS_WRIST_PITCH = [0, 0.33123374, 0]
const POS_TOOL = [0, 0.21365428, 0]
// Grab point at the suction-cup rim (the plane touching the box), not the abstract tool tip: the cups hang
// ~0.134 m down the approach axis (0.0318 tip→grip + 0.0806 grip→cup-origin + 0.0532 cup mesh depth), so
// anchoring here stops the arm with the cups on the box. Keep in sync with robotKinematics.GRIPPER_OFFSET.
const GRIPPER_OFFSET = [0, 0.165672, 0]
// static intermediate frames
const SHOULDER = trans([0, 0.9, 0])
const ELBOW = basis([1, -1.7462298e-8, 0], [-1.7462298e-8, 1, 0], [0, 0, 0.9999999], [0.014725149, 1.3262625, -0.00687705])
// per-mesh local transforms (raw mesh -> pivot frame)
const T_BASE = basis([-4.371139e-8, 0, -1], Y, [1, 0, -4.371139e-8], [0, 0, 0])
const T_L1 = basis([-4.371139e-8, 0, -1], Y, [1, 0, -4.371139e-8], [0, 0.23, 0])
const T_L2 = basis([1.3113414e-7, 1.0000002, 0], [-4.3711385e-8, 0, 1.0000004], [0.99999994, -1.3113419e-7, 4.3711402e-8], [0, 0, 0])
const T_L3 = basis([-4.3711374e-8, 0.9999999, 4.3711363e-8], [0, -4.3711385e-8, 0.99999946], [0.9999997, 4.3711385e-8, 0], [0, 0, 0])
const T_L4 = basis([-4.371139e-8, 0.9999999, 4.3711385e-8], [0, -4.3711385e-8, 0.9999999], [1, 4.3711385e-8, 0], [0, 0, 0])
const T_L5 = basis([-6.117369e-8, -1, 6.1173665e-8], [-3.4924597e-8, -6.117369e-8, -0.99999964], [1, -6.117369e-8, -3.492458e-8], [0, 0, 0])
const T_TS = basis([1, 0, -1.7462291e-8], [-1.7462298e-8, -4.371139e-8, -0.99999964], [3.4924597e-8, 1, -4.3711374e-8], [0, 0.02553463, 0])
const HYD_BASE_ANCHOR = basis([-0.0036329387, -0.15156513, -0.9884406], [0, 0.9884471, -0.15156613], [0.9999934, -0.00055063044, -0.0035909677], [0.31569114, 0.5505995, -0.22799234])
const HYD_ROD_ANCHOR = basis([0.0060681487, -0.8060916, 0.5917597], [0, 0.5917706, 0.80610645], [-0.9999816, -0.004891574, 0.003590952], [0.19884515, 0.00020599365, -0.228842])
// A transform as a rig link's { offset, quat }: the basis's columns normalised (the CAD export leaves them a few
// 1e-7 off unit length), then the rotation as a quaternion; quat is null within epsilon of identity.
const poseOf = (t) => {
  const m = t.rows
  const len = (j) => Math.sqrt(m[0][j] * m[0][j] + m[1][j] * m[1][j] + m[2][j] * m[2][j])
  const det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  const s = [det < 0 ? -len(0) : len(0), len(1), len(2)]
  if (s.some((k) => Math.abs(k - 1) > 1e-4)) throw new Error(`non-unit scale in a rig transform: ${s}`)
  const a = (i, j) => m[i][j] * (1 / s[j])
  const tr = a(0, 0) + a(1, 1) + a(2, 2)
  let q
  if (tr > 0) {
    const k = 0.5 / Math.sqrt(tr + 1)
    q = [(a(2, 1) - a(1, 2)) * k, (a(0, 2) - a(2, 0)) * k, (a(1, 0) - a(0, 1)) * k, 0.25 / k]
  } else if (a(0, 0) > a(1, 1) && a(0, 0) > a(2, 2)) {
    const k = 2 * Math.sqrt(1 + a(0, 0) - a(1, 1) - a(2, 2))
    q = [0.25 * k, (a(0, 1) + a(1, 0)) / k, (a(0, 2) + a(2, 0)) / k, (a(2, 1) - a(1, 2)) / k]
  } else if (a(1, 1) > a(2, 2)) {
    const k = 2 * Math.sqrt(1 + a(1, 1) - a(0, 0) - a(2, 2))
    q = [(a(0, 1) + a(1, 0)) / k, 0.25 * k, (a(1, 2) + a(2, 1)) / k, (a(0, 2) - a(2, 0)) / k]
  } else {
    const k = 2 * Math.sqrt(1 + a(2, 2) - a(0, 0) - a(1, 1))
    q = [(a(0, 2) + a(2, 0)) / k, (a(1, 2) + a(2, 1)) / k, 0.25 * k, (a(1, 0) - a(0, 1)) / k]
  }
  const identity = Math.abs(q[0]) < 1e-7 && Math.abs(q[1]) < 1e-7 && Math.abs(q[2]) < 1e-7 && Math.abs(q[3] - 1) < 1e-7
  return { offset: t.o.map(r8), quat: identity ? null : q.map(r8) }
}
const ARM = 'sixaxis' // the arm's shared material
const frame = (name, parent, t, aim) => ({ name, parent, kind: 'frame', t, aim })
const mesh = (name, parent, node, t) => ({ name, parent, kind: 'mesh', node, t })
// The two hydraulic-strut anchors aim their local +Z at each other so the struts stay connected as the arm
// bends; the aim constraint owns the rotation at runtime (the authored rest quat is only a fallback).
const ARM_LINKS = [
  mesh('base', null, 'Six-Axis_Base', T_BASE),
  frame('basePivot', null, trans([0, 0, 0])),
  mesh('linkage1', 'basePivot', 'Six-Axis_Linkage_01', T_L1),
  frame('hydBaseAnchor', 'basePivot', HYD_BASE_ANCHOR, { target: 'hydRodAnchor' }),
  mesh('hyd1', 'hydBaseAnchor', 'Six-Axis_Hydraulic_01', trans([0, 0, 0])),
  frame('shoulder', 'basePivot', SHOULDER),
  frame('upperArm', 'shoulder', trans(POS_UPPER)),
  mesh('linkage2', 'upperArm', 'Six-Axis_Linkage_02', T_L2),
  frame('hydRodAnchor', 'upperArm', HYD_ROD_ANCHOR, { target: 'hydBaseAnchor' }),
  mesh('hyd2', 'hydRodAnchor', 'Six-Axis_Hydraulic_02', trans([0, 0, 0])),
  frame('elbow', 'upperArm', ELBOW),
  frame('forearm', 'elbow', trans(POS_FOREARM)),
  mesh('linkage3', 'forearm', 'Six-Axis_Linkage_03', T_L3),
  frame('wristRot', 'forearm', trans(POS_WRIST_ROT)),
  mesh('linkage4', 'wristRot', 'Six-Axis_Linkage_04', T_L4),
  frame('wristPitch', 'wristRot', trans(POS_WRIST_PITCH)),
  mesh('linkage5', 'wristPitch', 'Six-Axis_Linkage_05', T_L5),
  frame('tool', 'wristPitch', trans(POS_TOOL)),
  mesh('toolSuction', 'tool', 'Six-Axis_Tool_Suction', T_TS),
  frame('gripper', 'tool', trans(GRIPPER_OFFSET)),
]
// The EOAT (end-of-arm tooling) frame: the resizable vacuum-plate tool, drawn by geometry() from the tool-size, cup
// pitch and cup margin params: a painted plate framed by four slotted aluminium rails with corner caps, the adapter
// plate the wrist flange bolts to, the vacuum LED, and the suction-cup bed. Built at its real size rather than
// stretched from a 0.5 m model, so the rails keep their section and the caps their shape at any size. The cups
// compress off the LED's signal (MeshPart.squash). Basis diag(-1,-1,1) = 180° about Z.
const EOAT_LINK = { name: 'eoat', parent: 'tool', shape: { kind: 'frame' }, offset: [0, 0.009, 0], quat: [0, 0, 1, 0] }
// The clamp gripper's paddles ride these (the app draws the tool: src/core/robot/robotTools.ts). fingerA opens along
// +X, fingerB follows it along -X; the controller drives the joint with the grip: open while it is off, closed onto
// the load it holds (or fully, holding nothing) while it is on. Cosmetic, so
// the pose gizmo and the PLC panel leave it alone. FINGER_TRAVEL is the app's travel per finger.
const FINGER_TRAVEL = 0.05
const FINGER_LINKS = [
  { name: 'fingerA', parent: 'eoat', shape: { kind: 'frame' }, offset: [0, 0, 0] },
  { name: 'fingerB', parent: 'eoat', shape: { kind: 'frame' }, offset: [0, 0, 0] },
]
const FINGER_JOINTS = [
  { name: 'grip', link: 'fingerA', type: 'prismatic', axis: X, min: -FINGER_TRAVEL, max: FINGER_TRAVEL, cosmetic: true },
  { name: 'grip2', link: 'fingerB', type: 'prismatic', axis: [-1, 0, 0], min: -FINGER_TRAVEL, max: FINGER_TRAVEL, mimic: { joint: 'grip' } },
]
// The pickup volume, and with it how many cases this tool takes - there is no single/multi mode, the footprint
// decides. It is the plate itself (toolSizeX × toolSizeZ, 1:1 - the plate is the vacuum, so anything under it is
// picked and anything beside it is not): sized to one case it picks one, sized to a layer it lifts the whole formed
// layer in one grip, which is what a palletizer does. The 0.7 m of vertical reach is centred on the cup rim, so it
// swallows the centre of any case up to 0.7 m tall standing under the plate without reaching down into the layer
// BELOW the one being picked. Only the zone: with one the sim reads no grip radius sphere (sim/world.ts), so
// declaring those would be dead knobs. The `gripper` frame shares the tool's axes and the plate hangs off `eoat`
// (180° about Z), so the X/Z sign flip between the two frames is irrelevant to a volume centred on the link.
const grabZone = (p) => ({ size: [p.toolSizeX, 0.7, p.toolSizeZ] })
// Overridden from the Inspector by the 'waypoints' param (its numberList grid, or captured by the editor's rig
// gizmo), which arrives already parsed + validated as number[][] — no JSON.parse, no try/catch, no fallback.
const DEFAULT_POSES = [
  [0, -45, 90, 25, 75, 0],   // 0 home
  [0, -15, 55, 0, 80, 0],    // 1 pick (reach down)
  [110, -15, 55, 0, 80, 0],  // 2 place (swing over)
]
const POSE_COLUMNS = ['J1 °', 'J2 °', 'J3 °', 'J4 °', 'J5 °', 'J6 °']

// The job step vocabulary. A step is the row [job, op, a, b]; the Inspector writes them from this declaration.
const MOVE = 1
const VACUUM = 2
const WAIT = 3
const WAIT_FOR = 4
const SET_OUT = 5
const IO_COUNT = 4
const ON_OFF = [{ value: 1, label: 'On' }, { value: 0, label: 'Off' }]
const ioOptions = (word, prefix) => Array.from({ length: IO_COUNT }, (_, i) => ({ value: i, label: word + ' ' + (i + 1), param: prefix + (i + 1) + 'Tag' }))
const JOB_OPS = [
  { code: MOVE, label: 'Move', desc: 'Move the arm to a waypoint. Stop arrives exactly and stands still; Blend rounds the corner and carries on into the next move, for poses that are only on the way somewhere.', args: [{ kind: 'row', of: 'waypoints', label: 'To' }, { kind: 'choice', label: 'Corner', options: [{ value: 0, label: 'Stop' }, { value: 1, label: 'Blend' }] }] },
  { code: VACUUM, label: 'Vacuum', desc: 'Switch the tool vacuum. The load is held from the step it goes on to the step it goes off.', args: [{ kind: 'choice', options: ON_OFF }] },
  { code: WAIT, label: 'Wait', desc: 'Stand still for a time, to let a grip seal or a load settle. The clock stops while the robot is not enabled.', args: [{ kind: 'number', unit: 's', min: 0, step: 0.1, default: 0.5 }] },
  { code: WAIT_FOR, label: 'Wait for', desc: 'Hold here until one of the robot inputs reads on (or off). This is how a job waits on the cell: a pallet in place, a zone clear.', args: [{ kind: 'choice', options: ioOptions('Input', 'in') }, { kind: 'choice', options: ON_OFF }] },
  { code: SET_OUT, label: 'Set', desc: 'Switch one of the robot outputs, to tell the PLC something the job has reached: clear of the table, load released.', args: [{ kind: 'choice', options: ioOptions('Output', 'out') }, { kind: 'choice', options: ON_OFF }] },
]
definePart({
  manifest: {
    id: 'oip.six-axis-robot',
    name: 'Six-Axis Robot',
    category: 'Equipment',
    // The arm wears its textures; the tool is plain finishes, colours LINEAR: orange paint (sRGB #d0601a) on the
    // plate and caps, black anodised aluminium rails, a steel adapter, blue rubber cups (sRGB #2b5ba8), and the
    // vacuum LED: a black plastic bezel round a lens that is dark green until it lights.
    materials: [
      { id: ARM, albedo: 'albedo', orm: 'orm' },
      { id: 'eoatPaint', color: [0.639, 0.116, 0.0066], metalness: 0, roughness: 0.55 },
      { id: 'eoatRail', color: [0.04, 0.04, 0.045], metalness: 0.7, roughness: 0.35 },
      { id: 'eoatSteel', color: [0.18, 0.18, 0.19], metalness: 0.85, roughness: 0.45 },
      { id: 'eoatCup', color: [0.024, 0.104, 0.4], metalness: 0, roughness: 0.75 },
      { id: 'eoatPlastic', color: [0.02, 0.02, 0.022], metalness: 0, roughness: 0.5 },
      { id: 'eoatLens', color: [0.03, 0.06, 0.03], metalness: 0, roughness: 0.25 },
    ],
    // the shipped public/models files, by URL
    assets: [
      { id: 'glb', mime: 'model/gltf-binary', url: '/models/SixAxisRobot.glb' },
      { id: 'albedo', mime: 'image/webp', url: '/models/sixaxis/BaseColor.webp' },
      { id: 'orm', mime: 'image/webp', url: '/models/sixaxis/ORM.webp' },
    ],
  },
  rig(p) {
    const links = ARM_LINKS.map((l) => {
      const { offset, quat } = poseOf(l.t)
      const shape = l.kind === 'frame' ? { kind: 'frame' } : { kind: 'mesh', asset: 'glb', node: l.node, material: ARM }
      const link = { name: l.name, shape, offset }
      if (l.parent) link.parent = l.parent
      if (quat) link.quat = quat
      if (l.aim) link.aim = l.aim
      if (l.name === 'gripper') link.grip = { zone: grabZone(p) }
      return link
    })
    links.push(EOAT_LINK, ...FINGER_LINKS)
    return {
      links,
      joints: [
        ...JOINTS.map((j) => ({ name: j.name, link: j.link, type: 'revolute', axis: j.axis, min: r8(j.min * D2R), max: r8(j.max * D2R) })),
        ...FINGER_JOINTS,
      ],
      // The footprint the Inspector, selection and placement use - the robot at its rest pose, measured by
      // `npm run check-part -- examples/parts/six-axis-robot` (x -0.936..0.478, z -0.411..0.378, up to 3.483 m).
      // Bounds are centred on the base, so length/width cover the far side of the reach. Without them the part gets
      // the default 1 m cube: a 3.5 m robot selected by a box a third its height.
      bounds: { length: 1.88, width: 0.83, top: 3.49 },
      posable: true, // opt into the in-scene pose gizmo
    }
  },
  joints: ['j1', 'j2', 'j3', 'j4', 'j5', 'j6', 'grip'],
  grippers: ['gripper'],
  lamps: ['vacuumLamp'],
  // a robot: the host runs its controller (waypoints, jobs, the PLC handshake) over the six joints
  robot: { gripper: 'gripper', lamp: 'vacuumLamp', tool: 'eoat', gripJoint: { name: 'grip', open: FINGER_TRAVEL, closed: -FINGER_TRAVEL } },
  params: {
    speed: { type: 'number', default: 120, min: 5, max: 180, step: 1, label: 'Joint speed (°/s)', group: 'Motion', desc: 'Top speed along the joint-space path. All six joints are driven from one path parameter, so they start and arrive together instead of the fastest one finishing early.' },
    accel: { type: 'number', default: 720, min: 20, max: 2000, step: 10, label: 'Joint accel (°/s²)', group: 'Motion', desc: 'How hard the arm ramps to and from the joint speed. Lower it for a heavier or more delicate payload; a short move may never reach top speed at all.' },
    scale: { type: 'number', default: 1, min: 0.1, max: 10, step: 0.1, label: 'Scale', desc: 'Uniform size multiplier on the whole robot, applied to its collision bodies as well as its appearance - so a scaled arm really does reach further, rather than just looking bigger.' },
    // EOAT (end-of-arm tooling): read by geometry() and the grab zone, never by step(). The orange rigSize dots resize it.
    tool: { type: 'enum', default: 'vacuum', label: 'Tool', group: 'EOAT', desc: 'What the robot carries on its flange: a vacuum plate that lifts what is under it, or a clamp gripper whose two paddles close on the sides of a load. Both pick a load of the tool size below, and the Vacuum steps and the vacuum tag work either one.', options: [{ value: 'vacuum', label: 'Vacuum plate' }, { value: 'gripper', label: 'Clamp gripper' }, { value: 'none', label: 'None' }] },
    toolSizeX: { type: 'number', default: 0.5, min: 0.5, max: 3, step: 0.01, label: 'Tool size X (m)', group: 'EOAT', handle: { kind: 'rigSize', link: 'eoat', axis: 'x', frameY: -0.075 }, desc: 'Length of the vacuum plate, or the width of the load the clamp closes on. The orange dots on the tool itself drag this in the viewport, and they ride the arm, so you can size the tool in whatever pose you are inspecting. Size it to the product you are picking - it is also the grab reach.' },
    toolSizeZ: { type: 'number', default: 0.5, min: 0.5, max: 3, step: 0.01, label: 'Tool size Z (m)', group: 'EOAT', handle: { kind: 'rigSize', link: 'eoat', axis: 'z', frameY: -0.075 }, desc: 'Width of the vacuum plate, or how deep the clamp paddles are, dragged by the same orange dots on the tool.' },
    cupPitchX: { type: 'number', default: 0.1, min: 0.01, max: 0.5, step: 0.005, label: 'Cup pitch X (m)', group: 'EOAT', desc: 'Centre-to-centre spacing of the suction cups along the plate length. The plate fits as many as the pitch allows, so tightening it adds cups rather than moving them.' },
    cupPitchZ: { type: 'number', default: 0.1, min: 0.01, max: 0.5, step: 0.005, label: 'Cup pitch Z (m)', group: 'EOAT', desc: 'Centre-to-centre spacing of the suction cups across the plate width.' },
    cupMarginX: { type: 'number', default: 0.05, min: 0, max: 0.5, step: 0.005, label: 'Cup margin X (m)', group: 'EOAT', desc: 'Inset from each end of the plate before the first cup, so the grid does not run off the edge.' },
    cupMarginZ: { type: 'number', default: 0.05, min: 0, max: 0.5, step: 0.005, label: 'Cup margin Z (m)', group: 'EOAT', desc: 'Inset from each side of the plate before the first cup.' },
    cupsEnabled: { type: 'boolean', default: true, label: 'Suction cups', group: 'EOAT', desc: 'Draw the cup grid under the plate. Appearance only - the grip itself comes from the vacuum tag, not from the cups being visible.' },
    commandTag: { type: 'tag', dir: 'in', stType: 'INT', default: '', label: 'Command tag (job number)', group: 'Comms', desc: 'Which job to run: 1 is the first job, 2 the second and so on. Set it BEFORE pulsing execute. A robot with no jobs takes a waypoint row here instead (0 is home). A number with no job or row behind it is ignored, and the arm stays put rather than guessing.' },
    executeTag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '', label: 'Execute tag (rising edge runs it)', group: 'Comms', desc: 'Pulse this false-to-true to start the job. It is edge-triggered, so holding it true does NOT repeat - drop it and raise it again for each job.' },
    doneTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Done tag (true while idle)', group: 'Comms', desc: 'Handshake back to the program: true whenever the robot is ready for the next command. A job that ends on a Blend move reports done as it rounds that corner, so the next job can carry straight on. Wait for it before pulsing execute again, or the edge lands mid-job and is dropped.' },
    enableTag: { type: 'tag', dir: 'in', stType: 'BOOL', onlyWhenDriven: true, default: '', label: 'Enable tag', group: 'Comms', desc: 'The robot moves only while this is true. Drop it and the arm brakes to a stop where it is and the job holds, timers and all; raise it and the job carries on. Wire it to the cell being safe to work in. Until a program drives it, or with it empty, the robot is always enabled, so a merely-typed tag does not hold it.' },
    gripperTag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '', label: 'Vacuum tag', group: 'Comms', desc: 'For a robot with no jobs: grip or release the load, read continuously, so hold it true for the whole carry. A robot with jobs switches its own vacuum with Vacuum steps and ignores this.' },
    in1Tag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '', label: 'Input 1 tag', group: 'Comms/Robot signals', desc: 'A signal a job can wait on (a Wait for step). Robots have banks of these; wire the ones your jobs use.' },
    in2Tag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '', label: 'Input 2 tag', group: 'Comms/Robot signals', desc: 'A signal a job can wait on (a Wait for step).' },
    in3Tag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '', label: 'Input 3 tag', group: 'Comms/Robot signals', desc: 'A signal a job can wait on (a Wait for step).' },
    in4Tag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '', label: 'Input 4 tag', group: 'Comms/Robot signals', desc: 'A signal a job can wait on (a Wait for step).' },
    out1Tag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Output 1 tag', group: 'Comms/Robot signals', desc: 'A signal a job switches (a Set step), to tell the program where it has got to. It holds its last value between jobs.' },
    out2Tag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Output 2 tag', group: 'Comms/Robot signals', desc: 'A signal a job switches (a Set step).' },
    out3Tag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Output 3 tag', group: 'Comms/Robot signals', desc: 'A signal a job switches (a Set step).' },
    out4Tag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', label: 'Output 4 tag', group: 'Comms/Robot signals', desc: 'A signal a job switches (a Set step).' },
    waypoints: { type: 'numberList', columns: POSE_COLUMNS, arity: 6, default: DEFAULT_POSES, rowNames: 'waypointNames', label: 'Waypoints', group: 'Motion', desc: 'The poses this robot knows, one row of six JOINT angles each - not a position in space, so the arm reaches a pose exactly as taught with no ambiguity about elbow or wrist. Name them, and jobs move to them by name. Pose the arm with the viewport gizmo and use Capture Pose to add one rather than typing angles.' },
    waypointNames: { type: 'string', default: 'Home\nPick\nPlace', hidden: true, label: 'Waypoint names' },
    blendWaypoints: { type: 'numberList', rowsOf: 'waypoints', arity: 1, default: [], label: 'Pass-through waypoints (robots without jobs)', group: 'Motion', desc: 'For a robot with no jobs: which waypoints are VIA points. The arm reports done before it reaches one, so the next move can start while it is still running and the corner is rounded instead of braked to a stop. Jobs say this on each Move step instead.' },
    blendDeg: { type: 'number', unit: '°', default: 12, min: 0, max: 60, step: 1, label: 'Corner blend', group: 'Motion', desc: 'How many joint degrees before a via point the arm starts cutting the corner. Larger rounds the path more and strays further from the taught pose; the arm caps it at a third of the move.' },
    jobs: { type: 'numberList', arity: 4, default: [], program: { names: 'jobNames', ops: JOB_OPS }, label: 'Jobs', desc: 'The robot\'s own programs. The PLC runs one by number (the command tag) and the robot does the whole thing: moves, vacuum, waits, and the signals it sends back. While the scene runs, the step being run is highlighted.' },
    jobNames: { type: 'string', default: '', hidden: true, label: 'Job names' },
    pose: { type: 'numberList', rows: 1, columns: POSE_COLUMNS, arity: 6, default: [DEFAULT_POSES[0]], label: 'Idle pose', group: 'Start state', desc: 'The pose a freshly placed robot rests in, and where one waiting for its first Execute sits. It is the arm you see in a stopped scene, so set it to something that reads as parked rather than mid-cycle.' },
  },
  // The controller is the host's (ctx.robot): it reads the params above by name, runs the jobs, moves the arm and
  // writes the joints, the gripper, the vacuum lamp and the tags.
  step(ctx) {
    ctx.robot.step()
  },
})
