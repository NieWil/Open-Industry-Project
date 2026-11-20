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

// The clamp gripper's paddles ride these (the app draws the tool: src/core/robot/robotTools.ts). fingerA opens along
// +X, fingerB follows it along -X; the controller drives the joint with the grip: open while it is off, closed onto
// the load it holds (or fully, holding nothing) while it is on. Cosmetic, so
// the pose gizmo and the PLC panel leave it alone. FINGER_TRAVEL is the app's travel per finger.
const FINGER_TRAVEL = 0.05
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
