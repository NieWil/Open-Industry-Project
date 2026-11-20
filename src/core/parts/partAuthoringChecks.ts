// Author-time checks a part's data can fail while still loading: a param spec that contradicts itself, and a
// name - in the manifest or in a param spec - that points at a param or link that isn't there. Without these
// each one loads, bakes and then silently does nothing: a `showParam` typo keeps the link forever, a
// `sizeParams` entry naming a missing param freezes the size, an enum default outside its options renders a
// blank dropdown.
//
// These run in sim/validatePart.ts (authoring: the in-app editor, check-part, add-part, the build scripts) and
// not in core/parts/partValidate.validatePartPackage: a package problem drops the package when a saved
// document loads, and a typo'd reference is not worth deleting someone's placed part over. The author gets it
// where they can fix it (the same split as validateSnapParamRefs).

import type { Finish, ParamSchema, ParamSpec } from './partApi'
import { blankNonCode } from '../determinism'
import { editDistance } from '../editDistance'
import { rigLampNames } from './partPackage'
import { RIG_FINISHES } from './partValidateRig'
import { MAX_PITCH_INSTANCES, pitchArrayWanted } from '../rig/rigPose'
import type { PartPackageGeometry, RigLink, SizeParamRef } from './partPackage'

export interface AuthoringProblem {
  field: string
  message: string
}

type Want = 'number' | 'boolean' | 'enum' | 'numberList' | 'string' | 'tag' | 'any' | 'color|string'
const PARAM_TYPES = new Set(['number', 'boolean', 'string', 'tag', 'numberList', 'color', 'enum', 'partRef'])
const ST_TYPES = new Set(['BOOL', 'INT', 'DINT', 'REAL'])
const HEX_COLOR = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i

/** Contradictions inside the param schema itself (what `definePart({ params })` declared). */
export function checkParamSpecs(params: ParamSchema): AuthoringProblem[] {
  const out: AuthoringProblem[] = []
  const add = (key: string, sub: string, message: string): void => void out.push({ field: `params.${key}${sub}`, message })
  for (const [key, spec] of Object.entries(params)) {
    if (!spec || typeof spec !== 'object') {
      add(key, '', 'must be a param spec object')
      continue
    }
    const s = spec as ParamSpec
    if (!PARAM_TYPES.has(s.type)) {
      add(key, '.type', `"${String(s.type)}" is not a param type (${[...PARAM_TYPES].join(' / ')})`)
      continue
    }
    const d = s.default
    const is = { number: typeof d === 'number' && Number.isFinite(d), boolean: typeof d === 'boolean', string: typeof d === 'string' }
    const expect = (ok: boolean, what: string): void => {
      if (!ok) add(key, '.default', `a '${s.type}' param needs ${what} as its default (got ${JSON.stringify(d)})`)
    }
    switch (s.type) {
      case 'number':
        expect(is.number, 'a finite number')
        if (typeof s.min === 'number' && typeof s.max === 'number' && s.min > s.max) add(key, '.min', `min ${s.min} is above max ${s.max}`)
        if (is.number && typeof s.min === 'number' && (d as number) < s.min) add(key, '.default', `default ${String(d)} is below min ${s.min} - the Inspector would clamp it on first edit`)
        if (is.number && typeof s.max === 'number' && (d as number) > s.max) add(key, '.default', `default ${String(d)} is above max ${s.max} - the Inspector would clamp it on first edit`)
        if (s.step !== undefined && !(typeof s.step === 'number' && s.step > 0)) add(key, '.step', 'step must be a number > 0')
        break
      case 'boolean':
        expect(is.boolean, 'true or false')
        break
      case 'numberList':
        expect(Array.isArray(d) && d.every((r) => Array.isArray(r) && r.every((n) => typeof n === 'number' && Number.isFinite(n))), 'an array of number rows')
        if (s.arity !== undefined && Array.isArray(d) && d.some((r) => Array.isArray(r) && r.length !== s.arity)) add(key, '.default', `every row must have arity ${s.arity} numbers`)
        if (s.rows !== undefined && !(Number.isInteger(s.rows) && (s.rows as number) >= 1)) add(key, '.rows', 'rows must be a whole number of at least 1')
        else if (s.rows !== undefined && Array.isArray(d) && d.length !== s.rows) add(key, '.default', `a fixed-row list needs exactly ${s.rows} default row(s) - the Inspector offers no Add`)
        if (s.columns !== undefined && !(Array.isArray(s.columns) && s.columns.length === (s.arity ?? 1))) add(key, '.columns', `columns needs one header per column (${s.arity ?? 1})`)
        if (s.rowsOf !== undefined && (s.arity ?? 1) !== 1) add(key, '.rowsOf', 'rowsOf marks a list of row indices, so the list must be arity 1')
        break
      case 'color':
        // a list's default is its entries joined by commas, '' for none
        if (s.list === true) expect(is.string && ((d as string) === '' || (d as string).split(',').every((c) => /^#[0-9a-f]{6}$/i.test(c))), 'a comma-joined "#rrggbb" list (no alpha), or ""')
        else expect(is.string && HEX_COLOR.test(d as string), 'a "#rrggbb" string')
        break
      case 'enum': {
        expect(is.string, 'one of its option values')
        const opts = Array.isArray(s.options) ? s.options : null
        if (!opts || opts.length === 0) add(key, '.options', 'an enum needs a non-empty options list')
        else {
          const values = opts.map((o) => o?.value)
          if (values.some((v) => typeof v !== 'string')) add(key, '.options', 'every option needs a string value')
          const dup = values.find((v, i) => values.indexOf(v) !== i)
          if (dup !== undefined) add(key, '.options', `option value "${String(dup)}" appears twice`)
          if (is.string && !values.includes(d as string)) add(key, '.default', `default "${String(d)}" is not one of its options (${values.join(', ')}) - the dropdown would show blank`)
        }
        break
      }
      default: // string, tag, partRef
        expect(is.string, 'a string')
    }
    if (s.type === 'tag') {
      // required at authoring: a tag param with no declared signal is invisible to the wiring check (plc/wiring.ts),
      // which can only report a stored one as undeclared. Not in validatePartPackage, for the reason at the top.
      if (s.dir === undefined) add(key, '.dir', 'a tag param must declare dir: "in" (the part reads it) or "out" (the part writes it)')
      else if (s.dir !== 'in' && s.dir !== 'out') add(key, '.dir', `dir must be "in" or "out" (got ${JSON.stringify(s.dir)})`)
      if (s.stType === undefined) add(key, '.stType', `a tag param must declare stType: ${[...ST_TYPES].join(' / ')}`)
      else if (!ST_TYPES.has(s.stType)) add(key, '.stType', `stType must be one of ${[...ST_TYPES].join(' / ')} (got ${JSON.stringify(s.stType)})`)
    }
    // spec fields that name another param
    const ref = (sub: string, name: unknown, want: Want): void => refCheck(params, `params.${key}${sub}`, name, want, out)
    if (s.setpointFor !== undefined) ref('.setpointFor', s.setpointFor, 'any')
    if (s.visibleWhen !== undefined) {
      // a boolean `is` switches on a boolean param; a value (or a list of them) on an enum param, each one of its
      // options - a misspelt value would hide the field for good, with nothing to say why
      const is = s.visibleWhen?.is
      if (typeof is === 'boolean') ref('.visibleWhen.param', s.visibleWhen?.param, 'boolean')
      else {
        const values = typeof is === 'string' ? [is] : Array.isArray(is) ? is : null
        if (!values || values.length === 0 || values.some((v) => typeof v !== 'string')) add(key, '.visibleWhen.is', 'must be true / false (a boolean switch), or an option value or a non-empty list of them (an enum switch)')
        else if (params[s.visibleWhen?.param ?? '']?.type === 'string' && params[s.visibleWhen?.param ?? '']?.product === true) {
          // a product switch: its values are package ids, which no fixed list holds
        } else {
          ref('.visibleWhen.param', s.visibleWhen?.param, 'enum')
          const sw = params[s.visibleWhen?.param ?? '']
          const opts = sw?.type === 'enum' && Array.isArray(sw.options) ? sw.options.map((o) => o?.value) : null
          const bad = opts ? values.find((v) => !opts.includes(v)) : undefined
          if (bad !== undefined) add(key, '.visibleWhen.is', `"${bad}" is not one of ${String(s.visibleWhen?.param)}'s options (${opts!.join(', ')}) - the field would never show`)
        }
      }
    }
    if (s.stamps !== undefined) ref('.stamps', s.stamps, 'numberList')
    if (s.rowsOf !== undefined) ref('.rowsOf', s.rowsOf, 'numberList')
    if (s.rowNames !== undefined) {
      if (s.type !== 'numberList') add(key, '.rowNames', 'rowNames names the rows of a numberList param')
      else ref('.rowNames', s.rowNames, 'string')
    }
    if (s.program !== undefined) {
      if (s.type !== 'numberList') add(key, '.program', 'program edits a numberList param as programs of steps')
      else checkProgram(key, s, ref, add)
    }
    if (s.bits !== undefined) {
      if (s.type !== 'number') add(key, '.bits', 'bits edits a number param as a bitmask')
      else if (typeof s.bits === 'string') ref('.bits', s.bits, 'number')
      else if (!(Number.isInteger(s.bits) && s.bits >= 1 && s.bits <= 31)) add(key, '.bits', 'bits must be a bit count from 1 to 31, or the name of a number param holding it')
    }
    if (s.suggest !== undefined && (s.type !== 'string' || s.suggest !== 'marks')) add(key, '.suggest', "suggest: 'marks' applies to a string param")
    if (s.product !== undefined && (s.type !== 'string' || s.product !== true)) add(key, '.product', 'product: true applies to a string param')
    if (s.settings !== undefined) {
      const target = typeof s.settings === 'string' ? params[s.settings] : undefined
      if (s.product !== true) add(key, '.settings', 'settings applies to a product param')
      else if (!target || target.type !== 'string' || target.hidden !== true) add(key, '.settings', 'settings must name a hidden string param')
    }
    if (s.values !== undefined) {
      if (s.type !== 'tag' || (s.stType !== 'INT' && s.stType !== 'DINT')) add(key, '.values', 'values lists the codes of an INT or DINT tag param')
      else if (!Array.isArray(s.values) || s.values.some((v) => !v || !Number.isInteger(v.value) || typeof v.label !== 'string')) add(key, '.values', 'values must be a list of { value: <whole number>, label: <text> }')
    }
    if (s.imperialUnits !== undefined && s.type !== 'boolean') add(key, '.imperialUnits', 'imperialUnits marks a boolean units switch')
    if (s.whenAbsent !== undefined && s.type !== 'boolean') add(key, '.whenAbsent', 'whenAbsent applies to boolean params only')
    if (s.rest !== undefined && s.type !== 'number') add(key, '.rest', `rest: '${String(s.rest)}' fills a number param only`)
    const h = s.handle as Record<string, unknown> | undefined
    if (h) {
      const need = h.kind === 'path' || h.kind === 'flexPath' ? 'numberList' : 'number'
      if (s.type !== need) add(key, '.handle', `a '${String(h.kind)}' handle drags a '${need}' param, not a '${s.type}' one`)
      for (const f of ['angleFrontParam', 'angleBackParam', 'bayParam', 'widthParam', 'heightParam', 'innerRadiusParam', 'lengthParam']) if (h[f] !== undefined) ref(`.handle.${f}`, h[f], 'number')
      for (const f of ['bayGateParam', 'leftGuardParam', 'rightGuardParam', 'innerGuardParam', 'outerGuardParam', 'infeedBrakeParam', 'dischargeBrakeParam']) if (h[f] !== undefined) ref(`.handle.${f}`, h[f], 'boolean')
      const endGapParam = h.endGapParam as { param?: unknown; scale?: unknown; add?: unknown } | undefined
      if (endGapParam !== undefined) {
        ref('.handle.endGapParam.param', endGapParam?.param, 'number')
        for (const f of ['scale', 'add'] as const) if (endGapParam?.[f] !== undefined && (typeof endGapParam[f] !== 'number' || !Number.isFinite(endGapParam[f]))) add(key, `.handle.endGapParam.${f}`, `endGapParam.${f} must be a finite number`)
      }
      const scissor = h.scissor as { widthParam?: unknown; rollers?: unknown } | undefined
      if (scissor !== undefined) {
        ref('.handle.scissor.widthParam', scissor.widthParam, 'number')
        if (typeof scissor.rollers !== 'number' || !Number.isInteger(scissor.rollers) || scissor.rollers < 1) add(key, '.handle.scissor.rollers', 'scissor.rollers must be a whole number of rollers a section, at least 1')
      }
    }
  }
  return out
}

/** A `program` numberList: its ops are well formed, and its arity fits the op that takes the most arguments. */
function checkProgram(
  key: string,
  s: ParamSpec,
  ref: (sub: string, name: unknown, want: Want) => void,
  add: (key: string, sub: string, message: string) => void,
): void {
  const p = s.program!
  if (p.names !== undefined) ref('.program.names', p.names, 'string')
  const ops = Array.isArray(p.ops) ? p.ops : null
  if (!ops || ops.length === 0) {
    add(key, '.program.ops', 'a program needs at least one op')
    return
  }
  const codes = ops.map((o) => o?.code)
  if (codes.some((c) => !Number.isInteger(c))) add(key, '.program.ops', 'every op needs a whole-number code')
  const dup = codes.find((c, i) => codes.indexOf(c) !== i)
  if (dup !== undefined) add(key, '.program.ops', `op code ${String(dup)} appears twice`)
  let most = 0
  ops.forEach((op, i) => {
    const sub = `.program.ops[${i}]`
    if (typeof op?.label !== 'string' || op.label === '') add(key, `${sub}.label`, 'an op needs a label')
    const args = op?.args ?? []
    most = Math.max(most, args.length)
    args.forEach((a, j) => {
      const at = `${sub}.args[${j}]`
      if (a?.kind === 'row') ref(`${at}.of`, a.of, 'numberList')
      else if (a?.kind === 'choice') {
        if (!Array.isArray(a.options) || a.options.length === 0) add(key, `${at}.options`, 'a choice needs options')
        else
          a.options.forEach((o, k) => {
            if (!o || !Number.isFinite(o.value) || typeof o.label !== 'string') add(key, `${at}.options[${k}]`, 'an option needs a number value and a label')
            else if (o.param !== undefined) ref(`${at}.options[${k}].param`, o.param, 'tag')
          })
      } else if (a?.kind !== 'number') add(key, `${at}.kind`, `"${String((a as { kind?: unknown })?.kind)}" is not an argument kind (row / number / choice)`)
    })
  })
  if ((s.arity ?? 1) !== 2 + most) add(key, '.arity', `a program's rows are [program, op, ...args], so arity must be ${2 + most} (2 + the most args an op takes)`)
}

/** Every name the GEOMETRY uses for a param or a link, resolved against the schema and the rig. */
export function checkGeometryRefs(geometry: PartPackageGeometry, params: ParamSchema): AuthoringProblem[] {
  const out: AuthoringProblem[] = []
  const ref = (field: string, name: unknown, want: Want): void => refCheck(params, field, name, want, out)
  const refs = (field: string, list: readonly Pick<SizeParamRef, 'param' | 'mulParam'>[] | undefined): void =>
    (list ?? []).forEach((r, i) => {
      ref(`${field}[${i}].param`, r.param, 'number')
      if (r.mulParam !== undefined) ref(`${field}[${i}].mulParam`, r.mulParam, 'number')
    })

  if (geometry.kind !== 'rig') return out

  if (geometry.inclineParam !== undefined) ref('geometry.inclineParam', geometry.inclineParam, 'number')
  // the footprint following a param (snapping, selection and drop-rest read it)
  refs('geometry.bounds.params', geometry.bounds?.params)
  geometry.joints.forEach((j, i) => {
    if (j.rest) ref(`geometry.joints[${i}].rest.param`, j.rest.param, 'number')
    if (j.minParam) ref(`geometry.joints[${i}].minParam.param`, j.minParam.param, 'number')
    if (j.maxParam) ref(`geometry.joints[${i}].maxParam.param`, j.maxParam.param, 'number')
  })
  const links = new Map(geometry.links.map((l) => [l.name, l]))
  const lampNames = rigLampNames(geometry)
  geometry.links.forEach((l: RigLink, i) => {
    const at = `geometry.links[${i}]`
    refs(`${at}.offsetParams`, l.offsetParams)
    refs(`${at}.rotationParams`, l.rotationParams)
    refs(`${at}.grip.radiusParams`, l.grip?.radiusParams)
    refs(`${at}.zone.sizeParams`, l.zone?.sizeParams)
    refs(`${at}.grip.zone.sizeParams`, l.grip?.zone?.sizeParams)
    if (l.grip?.forks?.spreadParam !== undefined) ref(`${at}.grip.forks.spreadParam`, l.grip.forks.spreadParam, 'number')
    if (l.colorParam !== undefined) ref(`${at}.colorParam`, l.colorParam, 'color|string')
    l.lamps?.forEach((lamp, j) => {
      if (lamp.param !== undefined) ref(`${at}.lamps[${j}].param`, lamp.param, 'boolean')
    })
    if (l.showParam !== undefined) {
      // 'param=value' shows the link while an enum param is that value; otherwise a boolean param switches it
      const eq = l.showParam.indexOf('=')
      if (eq < 0) ref(`${at}.showParam`, l.showParam, 'boolean')
      else {
        const name = l.showParam.slice(0, eq)
        const value = l.showParam.slice(eq + 1)
        ref(`${at}.showParam`, name, 'enum')
        const spec = params[name]
        if (spec?.type === 'enum' && !(spec.options ?? []).some((o) => o.value === value))
          out.push({ field: `${at}.showParam`, message: `shows the link while "${name}" is '${value}', which is not one of its options - the link would never show` })
      }
    }
    if (l.finishParam !== undefined) {
      ref(`${at}.finishParam`, l.finishParam, 'enum')
      const spec = params[l.finishParam]
      if (spec?.type === 'enum') {
        const bad = (spec.options ?? []).filter((o) => !RIG_FINISHES.includes(o.value as Finish)).map((o) => `'${o.value}'`)
        if (bad.length) out.push({ field: `${at}.finishParam`, message: `names "${l.finishParam}", whose option${bad.length > 1 ? 's' : ''} ${bad.join(', ')} ${bad.length > 1 ? 'are not finishes' : 'is not a finish'} (${RIG_FINISHES.map((f) => `'${f}'`).join(', ')}) - choosing ${bad.length > 1 ? 'them' : 'it'} would show the link's own finish` })
      }
    }
    if (l.beam?.rangeParam !== undefined) ref(`${at}.beam.rangeParam`, l.beam.rangeParam, 'number')
    if (l.beam?.showParam !== undefined) ref(`${at}.beam.showParam`, l.beam.showParam, 'boolean')
    if (l.squash) {
      const lamp = l.squash.lamp ?? l.name
      if (!lampNames.has(lamp)) {
        const field = l.squash.lamp !== undefined ? `${at}.squash.lamp` : `${at}.squash`
        out.push({ field, message: l.squash.lamp !== undefined ? `names "${lamp}", which is not a lamp in this rig, so the squash never fires` : 'this link has no lamp of its own, so name the lamp that drives the squash (squash.lamp)' })
      }
    }
    const a = l.array
    if (a) {
      if (a.distribute) ref(`${at}.array.distribute.spanParam`, a.distribute.spanParam, 'number')
      if (a.pitch) {
        ref(`${at}.array.pitch.spanParam`, a.pitch.spanParam, 'number')
        ;(a.pitch.spanTerms ?? []).forEach((t, i) => ref(`${at}.array.pitch.spanTerms[${i}].param`, t.param, 'number'))
        // the row stops at MAX_PITCH_INSTANCES; span params that can ask for more would spread the copies out. Checked
        // with every span param at its max (a negative scale makes that a high bound, which only errs toward warning)
        const names = [a.pitch.spanParam, ...(a.pitch.spanTerms ?? []).map((t) => t.param)]
        const specs = names.map((n) => params[n])
        if (specs.every((sp) => sp?.type === 'number')) {
          const unbounded = names.filter((n) => typeof (params[n] as { max?: unknown }).max !== 'number')
          const atMax = Object.fromEntries(names.map((n) => [n, (params[n] as { max?: number }).max ?? 0]))
          const most = unbounded.length ? Infinity : pitchArrayWanted(a.pitch, atMax)
          if (most > MAX_PITCH_INSTANCES) {
            out.push({
              field: `${at}.array.pitch`,
              message: unbounded.length
                ? `"${unbounded[0]}" has no max, so the row can need more than the ${MAX_PITCH_INSTANCES} copies a pitch array holds: give the param a max`
                : `at ${names.map((n) => `${n} = ${atMax[n]}`).join(', ')} the row needs ${most} copies, past the ${MAX_PITCH_INSTANCES} a pitch array holds: lower a param's max or widen the pitch`,
            })
          }
        }
      }
      if (a.count !== undefined) ref(`${at}.array.count`, a.count, 'number')
      refs(`${at}.array.stepParams`, a.stepParams)
      for (const f of ['omitFirstParam', 'omitLastParam'] as const) if (a[f] !== undefined) ref(`${at}.array.${f}`, a[f], 'boolean')
      if (a.grid) {
        for (const ax of ['x', 'z'] as const) {
          const g = a.grid[ax]
          if (!g) continue
          ref(`${at}.array.grid.${ax}.sizeParam`, g.sizeParam, 'number')
          if (g.pitchParam !== undefined) ref(`${at}.array.grid.${ax}.pitchParam`, g.pitchParam, 'number')
          if (g.marginParam !== undefined) ref(`${at}.array.grid.${ax}.marginParam`, g.marginParam, 'number')
        }
      }
    }
    const s = l.shape
    const sh = `${at}.shape`
    if (s.kind === 'box' || s.kind === 'cylinder' || s.kind === 'mesh') refs(`${sh}.sizeParams`, s.sizeParams)
    if (s.kind === 'label' && s.textParam !== undefined) ref(`${sh}.textParam`, s.textParam, 'any')
    if (s.kind === 'leg') {
      for (const f of ['spanParam', 'widthParam', 'standParam'] as const) ref(`${sh}.${f}`, s[f], 'number')
      if (s.arc) ref(`${sh}.arc.radiusParam`, s.arc.radiusParam, 'number')
      if (s.frameDepthParam) ref(`${sh}.frameDepthParam.param`, s.frameDepthParam.param, 'number')
    }
  })
  // a `rigSize` handle resizes a named link
  for (const [key, spec] of Object.entries(params)) {
    const h = spec?.handle as { kind?: string; link?: unknown } | undefined
    if (h?.kind === 'rigSize' && (typeof h.link !== 'string' || !links.has(h.link))) {
      out.push({ field: `params.${key}.handle.link`, message: `names ${JSON.stringify(h.link)}, which is not a link in this rig` })
    }
  }
  return out
}

function refCheck(params: ParamSchema, field: string, name: unknown, want: Want, out: AuthoringProblem[]): void {
  if (typeof name !== 'string' || name === '') return // the shape itself is validatePartPackage's to report
  const spec = params[name]
  if (!spec) {
    const near = Object.keys(params).find((k) => k.toLowerCase() === name.toLowerCase())
    out.push({ field, message: `names "${name}", which is not a declared param${near ? ` (did you mean "${near}"?)` : ''} - it would silently do nothing` })
    return
  }
  const ok = want === 'any' || (want === 'color|string' ? spec.type === 'color' || spec.type === 'string' : spec.type === want)
  if (!ok) out.push({ field, message: `names "${name}", a '${spec.type}' param, but needs a '${want.replace('|', "' or '")}' one` })
}

/** A param the behavior reads that the part does not declare, where the script reads it. */
export interface UndeclaredParamRead {
  name: string
  /** 1-based */
  line: number
  /** 1-based */
  column: number
  /** a declared param one or two edits away, when there is one */
  near?: string
}

/**
 * Every `ctx.params.<name>` (or `ctx.params['<name>']`) the behavior reads that `params` does not declare. Such a read
 * gets `undefined` with no error, so a misspelt name leaves the part silently ignoring its Inspector field; the
 * TypeScript types catch it only when the script is type-checked, which a `.js` behavior never is. Lexical, like
 * checkDeterminism: comments and strings are blanked first (core/determinism.ts blankNonCode), and a read through
 * another name (`const p = ctx.params; p.x`, destructuring) is not seen.
 */
export function undeclaredParamReads(source: string, params: ParamSchema): UndeclaredParamRead[] {
  const code = blankNonCode(source)
  const out: UndeclaredParamRead[] = []
  const at = (index: number): { line: number; column: number } => {
    const before = source.slice(0, index)
    const nl = before.lastIndexOf('\n')
    return { line: before.split('\n').length, column: index - nl }
  }
  const report = (name: string, index: number): void => {
    if (Object.prototype.hasOwnProperty.call(params, name)) return
    const near = Object.keys(params).find((k) => editDistance(k.toLowerCase(), name.toLowerCase()) <= 2)
    out.push({ name, ...at(index), ...(near ? { near } : {}) })
  }
  for (const m of code.matchAll(/\bctx\s*\.\s*params\s*(\?\.|\.)\s*([A-Za-z_$][\w$]*)/g)) report(m[2]!, m.index! + m[0].length - m[2]!.length)
  // a bracketed literal: the key is blanked in `code`, so it is read from the source at the same position
  // (no trailing \s* on the code side: the blanked literal is spaces there, and it would be swallowed)
  for (const m of code.matchAll(/\bctx\s*\.\s*params\s*(\?\.)?\s*\[/g)) {
    const lit = /^(\s*)(['"`])([A-Za-z_$][\w$]*)\2\s*\]/.exec(source.slice(m.index! + m[0].length))
    if (lit) report(lit[3]!, m.index! + m[0].length + lit[1]!.length + 1)
  }
  return out
}
