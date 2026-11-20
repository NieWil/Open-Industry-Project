// The behavior script of a robot part made by an import (a URDF arm): the params its controller reads, sized to the arm,
// and a step() that runs the host's controller. The controller itself is host code (robotController.ts), so this
// script is a declaration: a part made today runs tomorrow's controller.

import type { ParamSchema } from '../parts/partApi'
import { ROBOT_IO_COUNT, ROBOT_OP, robotUnit, type RobotDecl, type RobotJoint } from './robotController'

const ON_OFF = [
  { value: 1, label: 'On' },
  { value: 0, label: 'Off' },
]
const ioOptions = (word: string, prefix: string) =>
  Array.from({ length: ROBOT_IO_COUNT }, (_, i) => ({ value: i, label: `${word} ${i + 1}`, param: `${prefix}${i + 1}Tag` }))

export interface RobotPartOptions {
  /** draw the app's tools on the arm */
  tools?: boolean
  /** the arm has a hand of its own (RobotDeclaration.hand): the tool choice offers it first, and starts on it */
  hand?: boolean
  /** the Home waypoint and idle pose, native units by joint name (robotIk.ts robotReadyPose); else every joint at 0 */
  ready?: Readonly<Record<string, number>> | null
}

/** The robot params for an arm whose controller drives `joints`, in waypoint column order. */
export function robotParams(joints: readonly RobotJoint[], opts: RobotPartOptions = {}): ParamSchema {
  const columns = joints.map((j, i) => `J${i + 1} ${j.type === 'prismatic' ? 'mm' : '°'}`)
  // the ready pose to a tenth of a degree (a tilt of the tool under 0.2°; + 0 turns a -0 into 0), else the pose URDF describes the arm in:
  // every joint at 0, or the nearest its limits allow
  const ready = opts.ready
  const home = joints.map((j) =>
    ready && ready[j.name] !== undefined
      ? Math.round(Math.min(Math.max(ready[j.name]!, j.min), j.max) * robotUnit(j.type) * 10) / 10 + 0
      : Math.round(Math.min(Math.max(0, j.min), j.max) * robotUnit(j.type) * 1000) / 1000,
  )
  const arity = joints.length
  const ops = [
    {
      code: ROBOT_OP.move,
      label: 'Move',
      desc: 'Move the arm to a waypoint. Stop arrives exactly and stands still; Blend rounds the corner and carries on into the next move.',
      args: [
        { kind: 'row', of: 'waypoints', label: 'To' },
        { kind: 'choice', label: 'Corner', options: [{ value: 0, label: 'Stop' }, { value: 1, label: 'Blend' }] },
      ],
    },
    { code: ROBOT_OP.grip, label: 'Grip', desc: 'Close or open the gripper. The load is held from the step it closes to the step it opens.', args: [{ kind: 'choice', options: ON_OFF }] },
    { code: ROBOT_OP.wait, label: 'Wait', desc: 'Stand still for a time. The clock stops while the robot is not enabled.', args: [{ kind: 'number', unit: 's', min: 0, step: 0.1, default: 0.5 }] },
    {
      code: ROBOT_OP.waitFor,
      label: 'Wait for',
      desc: 'Hold here until one of the robot inputs reads on (or off): a part in place, a zone clear.',
      args: [{ kind: 'choice', options: ioOptions('Input', 'in') }, { kind: 'choice', options: ON_OFF }],
    },
    {
      code: ROBOT_OP.setOutput,
      label: 'Set',
      desc: 'Switch one of the robot outputs, to tell the PLC what the job has reached.',
      args: [{ kind: 'choice', options: ioOptions('Output', 'out') }, { kind: 'choice', options: ON_OFF }],
    },
  ]
  const tag = (dir: 'in' | 'out', stType: 'BOOL' | 'INT', label: string, desc: string, group = 'Comms') => ({ type: 'tag', dir, stType, default: '', label, group, desc })
  const params: Record<string, unknown> = {
    speed: { type: 'number', default: 60, min: 1, max: 360, step: 1, label: 'Joint speed (°/s)', group: 'Motion', desc: 'Top speed along the joint-space path, in degrees per second (millimetres for a sliding joint). Every joint is driven from one path, so they start and arrive together.' },
    accel: { type: 'number', default: 360, min: 10, max: 3000, step: 10, label: 'Joint accel (°/s²)', group: 'Motion', desc: 'How hard the arm ramps to and from the joint speed.' },
    blendDeg: { type: 'number', unit: '°', default: 10, min: 0, max: 60, step: 1, label: 'Corner blend', group: 'Motion', desc: 'How far before a via point the arm starts cutting the corner. The arm caps it at a third of the move.' },
    waypoints: { type: 'numberList', columns, arity, default: [home], rowNames: 'waypointNames', label: 'Waypoints', group: 'Motion', desc: 'The poses this robot knows, one row of joint positions each. Pose the arm with the viewport gizmo and use Capture Pose to add one.' },
    waypointNames: { type: 'string', default: 'Home', hidden: true, label: 'Waypoint names' },
    blendWaypoints: { type: 'numberList', rowsOf: 'waypoints', arity: 1, default: [], label: 'Pass-through waypoints (robots without jobs)', group: 'Motion', desc: 'For a robot with no jobs: the waypoints the arm only passes through, rounding the corner instead of stopping.' },
    jobs: { type: 'numberList', arity: 4, default: [], program: { names: 'jobNames', ops }, label: 'Jobs', desc: 'The robot\'s own programs. The PLC runs one by number (the command tag) and the robot does the whole thing: moves, grip, waits, and the signals it sends back.' },
    jobNames: { type: 'string', default: '', hidden: true, label: 'Job names' },
    pose: { type: 'numberList', rows: 1, columns, arity, default: [home], label: 'Idle pose', group: 'Start state', desc: 'The pose the robot rests in until its first command.' },
    commandTag: tag('in', 'INT', 'Command tag (job number)', 'Which job to run: 1 is the first job. A robot with no jobs takes a waypoint row here instead (0 is the first). Set it before pulsing Execute.'),
    executeTag: tag('in', 'BOOL', 'Execute tag (rising edge runs it)', 'Pulse this false to true to start the job. Holding it true does not repeat it.'),
    doneTag: tag('out', 'BOOL', 'Done tag (true while idle)', 'True whenever the robot is ready for the next command. Wait for it before pulsing Execute again.'),
    enableTag: { ...tag('in', 'BOOL', 'Enable tag', 'The robot moves only while this is true: drop it and the arm brakes to a stop and the job holds. Until a program drives it the robot is always enabled.'), onlyWhenDriven: true },
    gripperTag: tag('in', 'BOOL', 'Grip tag', 'For a robot with no jobs: close the gripper while this is true. A robot with jobs grips with its Grip steps.'),
  }
  for (let i = 1; i <= ROBOT_IO_COUNT; i++) {
    params[`in${i}Tag`] = tag('in', 'BOOL', `Input ${i} tag`, 'A signal a job can wait on (a Wait for step).', 'Comms/Robot signals')
    params[`out${i}Tag`] = tag('out', 'BOOL', `Output ${i} tag`, 'A signal a job switches (a Set step).', 'Comms/Robot signals')
  }
  if (opts.tools) {
    // the app's tools (robotTools.ts), drawn on the robot's tool mount and read by its grip zone
    params.tool = {
      type: 'enum',
      default: opts.hand ? 'hand' : 'vacuum',
      label: 'Tool',
      group: 'Tool',
      desc: opts.hand
        ? 'What the robot carries on its flange: its own hand, as its description has it, or in place of the hand a vacuum plate that lifts what is under it or a clamp gripper whose two paddles close on the sides of a load. The plate and the clamp pick a load of the tool size below.'
        : 'What the robot carries on its flange: a vacuum plate that lifts what is under it, or a clamp gripper whose two paddles close on the sides of a load. Both pick a load of the tool size below.',
      options: [
        ...(opts.hand ? [{ value: 'hand', label: 'Its own hand' }] : []),
        { value: 'vacuum', label: 'Vacuum plate' },
        { value: 'gripper', label: 'Clamp gripper' },
        { value: 'none', label: 'None' },
      ],
    }
    params.toolSizeX = { type: 'number', default: 0.25, min: 0.1, max: 3, step: 0.01, label: 'Tool size X (m)', group: 'Tool', desc: 'Length of the vacuum plate, or the width of the load the clamp closes on. Size it to the product you pick: it is also the grab reach.' }
    params.toolSizeZ = { type: 'number', default: 0.25, min: 0.1, max: 3, step: 0.01, label: 'Tool size Z (m)', group: 'Tool', desc: 'Width of the vacuum plate, or how deep the clamp paddles are.' }
    params.cupPitchX = { type: 'number', default: 0.06, min: 0.01, max: 0.5, step: 0.005, label: 'Cup pitch X (m)', group: 'Tool', desc: 'Centre-to-centre spacing of the suction cups along the plate length.' }
    params.cupPitchZ = { type: 'number', default: 0.06, min: 0.01, max: 0.5, step: 0.005, label: 'Cup pitch Z (m)', group: 'Tool', desc: 'Centre-to-centre spacing of the suction cups across the plate width.' }
    params.cupMarginX = { type: 'number', default: 0.04, min: 0, max: 0.5, step: 0.005, label: 'Cup margin X (m)', group: 'Tool', desc: 'Inset from each end of the plate before the first cup.' }
    params.cupMarginZ = { type: 'number', default: 0.04, min: 0, max: 0.5, step: 0.005, label: 'Cup margin Z (m)', group: 'Tool', desc: 'Inset from each side of the plate before the first cup.' }
    params.cupsEnabled = { type: 'boolean', default: true, label: 'Suction cups', group: 'Tool', desc: 'Draw the cup grid under the plate. Appearance only.' }
  }
  return params as ParamSchema
}

/** The behavior of a robot part: its declaration, its params, and a step() that runs the host's controller. */
export function robotBehavior(partName: string, decl: RobotDecl, joints: readonly RobotJoint[], opts: RobotPartOptions = {}): string {
  // the name goes into a // comment, so a line break in it would end the comment
  const name = partName.replace(/[\r\n\u2028\u2029]+/g, ' ')
  const driven = [...(decl.joints ?? []), ...(decl.gripJoint ? [decl.gripJoint.name] : [])]
  const lines = [
    `// ${name} - a robot. The controller is the app's: it runs the jobs and waypoints set in the Inspector, takes the`,
    `// PLC's job number and Execute, and moves the arm. This script declares the robot and the settings it reads.`,
    `definePart({`,
    `  joints: ${JSON.stringify(driven)},`,
    ...(decl.gripper || decl.hand ? [`  grippers: ${JSON.stringify([decl.gripper, decl.hand?.gripper].filter((g) => g !== undefined))},`] : []),
    ...(decl.lamp ? [`  lamps: ${JSON.stringify([decl.lamp])},`] : []),
    `  robot: ${JSON.stringify(decl)},`,
    `  params: ${JSON.stringify(robotParams(joints, opts), null, 2).replace(/\n/g, '\n  ')},`,
    `  step(ctx) {`,
    `    ctx.robot.step()`,
    `  },`,
    `})`,
    ``,
  ]
  return lines.join('\n')
}
