// PLC control for a joint without code: the Joint section's PLC control modes. The panel writes the whole behavior
// script from a config line kept at its top, so the mode is read back from the script itself and nothing is added to
// the manifest format.
//   Two positions (a sliding or turning joint with limits): a BOOL command tag (TRUE drives to B = max, FALSE back to
//     A = min), two BOOL end-position tags and a stroke time; the joint ramps at a constant speed.
//   Spin (a joint that spins endlessly, a wrapping servo): a BOOL run tag, an optional speed tag in rpm (empty: the
//     placed copy's own speed), and a BOOL at-speed tag; the host runs the servo at that velocity.

import type { RigJoint } from '../core/parts/partPackage'

/** One joint's Two positions control. `time` is the stroke time A to B, in seconds. */
export interface TwoPositions {
  mode: 'twoPositions'
  time: number
  /** The stem of the joint's param keys, kept once written so a placed copy's tag names stay bound to them. */
  key?: string
}

/** One spinning joint's control: the PLC starts and stops it, and may set its speed. */
export interface Spin {
  mode: 'spin'
  key?: string
}

export type JointPlcMode = TwoPositions | Spin

/** The joints the panel drives, by joint name. */
export type JointPlcConfig = Record<string, JointPlcMode>

const CONFIG_PREFIX = '// oip-panel '

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export const DEFAULT_STROKE_TIME = 1

/** The script with comments and whitespace removed: a new part's template reduces to this. */
const EMPTY_SCRIPT = 'definePart({params:{},step(ctx){},})'

/** The panel's config from a behavior script, or null when the script is not one the panel wrote. */
export function readJointPlcConfig(behavior: string): JointPlcConfig | null {
  const line = behavior.split('\n').find((l) => l.startsWith(CONFIG_PREFIX))
  if (!line) return null
  try {
    const raw = JSON.parse(line.slice(CONFIG_PREFIX.length)) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const out: JointPlcConfig = {}
    for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
      const c = v as { mode?: unknown; time?: unknown; key?: unknown } | null
      // the key becomes source text, so only a plain identifier is kept
      const key = typeof c?.key === 'string' && KEY_RE.test(c.key) ? { key: c.key } : {}
      if (c?.mode === 'twoPositions' && typeof c.time === 'number' && c.time > 0) out[name] = { mode: 'twoPositions', time: c.time, ...key }
      else if (c?.mode === 'spin') out[name] = { mode: 'spin', ...key }
    }
    return out
  } catch {
    return null
  }
}

/** True when the script has nothing of its own: the new-part template, or a script the panel wrote. */
export function isReplaceableBehavior(behavior: string): boolean {
  if (readJointPlcConfig(behavior)) return true
  const code = behavior.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/\s+/g, '')
  return code === EMPTY_SCRIPT
}

/** Whether a joint can take Two positions: a spinning (servo) joint is posed by the host, not by ctx.setJoint. A
 *  joint with param-driven limits is left out, since the script writes min and max as numbers and a placed copy's
 *  params can narrow them. */
export function canTwoPositions(joint: RigJoint): boolean {
  return !joint.servo && !joint.cosmetic && !joint.mimic && !joint.minParam && !joint.maxParam && joint.min < joint.max
}

/** Whether a joint can take Spin: one that spins endlessly (a revolute wrapping servo, the panel's Spins endlessly). */
export function canSpin(joint: RigJoint): boolean {
  return joint.type === 'revolute' && joint.servo?.modulo !== undefined && !joint.cosmetic && !joint.mimic
}

/** Whether `mode` can drive `joint`. */
function fits(mode: JointPlcMode, joint: RigJoint): boolean {
  return mode.mode === 'spin' ? canSpin(joint) : canTwoPositions(joint)
}

/** The param keys of one joint: identifiers made from its name, unique within the script. */
function keyBase(name: string, taken: Set<string>): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean)
  let base = words.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join('')
  if (!base || /^[0-9]/.test(base)) base = `j${base}`
  let key = base
  for (let n = 2; taken.has(key); n++) key = `${base}${n}`
  taken.add(key)
  return key
}

/** Each configured joint's key stem: the one it was written with, else a new one made from its name in config order.
 *  A script written before stems were kept gets the same stems back, since it was written in that same order. */
function keyStems(config: JointPlcConfig): Record<string, string> {
  const taken = new Set<string>()
  const out: Record<string, string> = {}
  for (const [name, c] of Object.entries(config)) {
    if (c.key && !taken.has(c.key)) {
      taken.add(c.key)
      out[name] = c.key
    }
  }
  for (const name of Object.keys(config)) out[name] ??= keyBase(name, taken)
  return out
}

/** The PLC-facing param keys the script declares for each configured joint. */
export function jointPlcKeys(config: JointPlcConfig): Record<string, { toB: string; atA: string; atB: string; time: string; run: string; speed: string; atSpeed: string; rpm: string }> {
  const out: ReturnType<typeof jointPlcKeys> = {}
  for (const [name, k] of Object.entries(keyStems(config))) {
    out[name] = { toB: `${k}ToB`, atA: `${k}AtA`, atB: `${k}AtB`, time: `${k}Time`, run: `${k}Run`, speed: `${k}Speed`, atSpeed: `${k}AtSpeed`, rpm: `${k}Rpm` }
  }
  return out
}

const num = (n: number): string => String(Math.round(n * 1e9) / 1e9)
const RPM = (2 * Math.PI) / 60

/**
 * The behavior script for `config` over the rig's joints. A configured joint that no longer exists or can no longer
 * take its mode is dropped. An empty config gives the new-part template back.
 */
export function jointPlcBehavior(rawPartName: string, config: JointPlcConfig, joints: readonly RigJoint[]): string {
  // the name goes into a // comment, so a line break in it would end the comment
  const partName = rawPartName.replace(/[\r\n\u2028\u2029]+/g, ' ')
  // stems over the whole config, before any joint is dropped, so the joints that stay keep theirs
  const stems = keyStems(config)
  const live: JointPlcConfig = {}
  for (const [name, c] of Object.entries(config)) {
    const j = joints.find((x) => x.name === name)
    if (j && fits(c, j)) live[name] = { ...c, key: stems[name]! }
  }
  const names = Object.keys(live)
  if (names.length === 0) {
    return [
      `// ${partName} - a custom part. Its geometry (links/joints) lives in manifest.json; edit it in the`,
      `// app (select a node → Inspector) or here. This script is the behavior, run every simulation tick.`,
      `definePart({`,
      `  params: {},`,
      `  step(ctx) {`,
      `    // Command joints with ctx.setJoint('name', value); read your params via ctx.params.*`,
      `  },`,
      `})`,
      ``,
    ].join('\n')
  }
  const keys = jointPlcKeys(live)
  // one joint: plain labels. Several: each label names its joint.
  const label = (name: string, text: string): string => JSON.stringify(names.length > 1 ? `${name}: ${text}` : text)
  const params: string[] = []
  const calls: string[] = []
  const posed = names.filter((n) => live[n]!.mode === 'twoPositions')
  const spun = names.filter((n) => live[n]!.mode === 'spin')
  for (const name of names) {
    const j = joints.find((x) => x.name === name)!
    const k = keys[name]!
    const c = live[name]!
    if (c.mode === 'twoPositions') {
      const unit = j.type === 'revolute' ? 'rad' : 'm'
      params.push(
        `    ${k.toB}: { type: 'tag', dir: 'in', stType: 'BOOL', default: '', group: 'Comms', label: ${label(name, 'Command (to B)')},`,
        `      desc: 'TRUE moves to B (${num(j.max)} ${unit}), FALSE moves back to A (${num(j.min)} ${unit}). Empty: stays at A.' },`,
        `    ${k.atA}: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', group: 'Comms', label: ${label(name, 'At A')},`,
        `      desc: 'TRUE while the joint is at A.' },`,
        `    ${k.atB}: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', group: 'Comms', label: ${label(name, 'At B')},`,
        `      desc: 'TRUE while the joint is at B.' },`,
        `    ${k.time}: { type: 'number', default: ${num(c.time)}, min: 0.05, max: 60, step: 0.1, label: ${label(name, 'Stroke time (s)')},`,
        `      desc: 'Time to travel from A to B, and back.' },`,
      )
      calls.push(`    twoPositions(ctx, ${JSON.stringify(name)}, ${num(j.min)}, ${num(j.max)}, p.${k.toB}, p.${k.atA}, p.${k.atB}, p.${k.time})`)
    } else {
      // the joint's own speed is the most it runs at: a servo refuses a velocity past its maximum
      const maxRpm = Math.round((j.servo!.maxVelocity / RPM) * 1000) / 1000
      params.push(
        `    ${k.run}: { type: 'tag', dir: 'in', stType: 'BOOL', default: '', group: 'Comms', label: ${label(name, 'Run')},`,
        `      desc: 'TRUE spins the joint, FALSE stops it. Empty: it stays still.' },`,
        `    ${k.speed}: { type: 'tag', dir: 'in', stType: 'REAL', default: '', group: 'Comms', label: ${label(name, 'Speed (rpm)')}, setpointFor: '${k.rpm}',`,
        `      desc: 'The speed the PLC asks for, in rpm, up to ${num(maxRpm)}; negative turns the other way. Empty: the Speed below.' },`,
        `    ${k.atSpeed}: { type: 'tag', dir: 'out', stType: 'BOOL', default: '', group: 'Comms', label: ${label(name, 'At speed')},`,
        `      desc: 'TRUE while the joint runs at the speed asked for.' },`,
        `    ${k.rpm}: { type: 'number', default: ${num(maxRpm)}, min: 1, max: ${num(maxRpm)}, step: 10, label: ${label(name, 'Speed (rpm)')},`,
        `      desc: 'The speed when no speed tag is wired.' },`,
      )
      // the speed in force, which the copy's Speed field shows while the PLC sets it (the speed tag's setpointFor)
      calls.push(`    ctx.report('${k.rpm}', spin(ctx, ${JSON.stringify(name)}, ${num(j.servo!.maxVelocity)}, p.${k.run}, p.${k.speed}, p.${k.atSpeed}, p.${k.rpm}))`)
    }
  }
  const helpers: string[] = []
  if (posed.length > 0) {
    helpers.push(
      `// Moves a joint between A (min) and B (max) at a constant speed while the command tag says so, and reports`,
      `// the end it is at. ctx.joints holds the position this script last commanded.`,
      `function twoPositions(ctx, joint, a, b, toB, atA, atB, time) {`,
      `  const goB = toB ? ctx.readTag(toB) : false`,
      `  const now = Math.min(b, Math.max(a, ctx.joints[joint]))`,
      `  const target = goB ? b : a`,
      `  const stepSize = ((b - a) / Math.max(time, 0.05)) * ctx.dt`,
      `  // within one step (plus rounding) of the end: land on it exactly, so At A / At B turn on`,
      `  const next = Math.abs(target - now) <= stepSize * 1.001 ? target : now + Math.sign(target - now) * stepSize`,
      `  ctx.setJoint(joint, next)`,
      `  if (atA) ctx.writeTag(atA, next <= a)`,
      `  if (atB) ctx.writeTag(atB, next >= b)`,
      `}`,
      ``,
    )
  }
  if (spun.length > 0) {
    helpers.push(
      `// Runs a spinning joint's servo at the speed asked for while the run tag is TRUE, and stops it otherwise. The`,
      `// speed is the speed tag's when one is wired, else the placed copy's own, held to the joint's maximum (rad/s).`,
      `// Returns the speed asked for, in rpm.`,
      `function spin(ctx, joint, max, run, speedTag, atSpeed, rpm) {`,
      `  const s = ctx.servos[joint]`,
      `  s.power(true)`,
      `  const on = run ? ctx.readTag(run) === true : false`,
      `  const asked = speedTag ? ctx.readNumber(speedTag) : rpm`,
      `  const w = on && Number.isFinite(asked) ? Math.max(-max, Math.min(max, (asked * Math.PI) / 30)) : 0`,
      `  s.moveVelocity(w)`,
      `  if (atSpeed) ctx.writeTag(atSpeed, w !== 0 && Math.abs(s.velocity - w) <= Math.abs(w) * 0.02)`,
      `  return asked`,
      `}`,
      ``,
    )
  }
  return [
    `// ${partName} - written by the Part Editor (Joint > PLC control). Changing a joint's PLC control or limits there`,
    `// writes this script again, so edits made here are lost. Set every joint's PLC control to None to write your own.`,
    `${CONFIG_PREFIX}${JSON.stringify(live)}`,
    ``,
    ...helpers,
    `definePart({`,
    `  params: {`,
    ...params,
    `  },`,
    ...(posed.length > 0 ? [`  joints: ${JSON.stringify(posed)},`] : []),
    ...(spun.length > 0 ? [`  servos: ${JSON.stringify(spun)},`] : []),
    `  step(ctx) {`,
    `    const p = ctx.params`,
    ...calls,
    `  },`,
    `})`,
    ``,
  ].join('\n')
}
