#!/usr/bin/env node
// EXTERNAL ORACLE for the ST engine - replays src/plc/conformanceCases.ts through MATIEC
// (`iec2c`), a real IEC 61131-3 compiler, so the corpus is checked against something that
// is not us.
//
// Why: the in-process suite (src/plc/conformance.test.ts) proves the engines agree with
// hand-derived goldens. It cannot prove the goldens are right. Silent divergence from a real
// runtime is the biggest risk for a tool whose claim is "this ST pastes into your PLC".
//
// TWO TIERS, run in order:
//
//   1. COMPILE GATE (default). Every non-skipped case is rendered as a spec-legal IEC
//      program (PROGRAM + CONFIGURATION + RESOURCE + TASK) and fed to iec2c. A case our
//      engine accepts but a real compiler REJECTS works in the sim and fails on the target.
//      Needs only iec2c; a CI gate.
//
//   2. EXECUTE + DIFF (--execute). The generated C is built and stepped scan-by-scan with
//      the corpus inputs, and the variable image is diffed against the same goldens: this
//      catches a wrong ANSWER rather than a wrong program. Also blocking in CI, with one
//      documented divergence (the FOR bound) reported rather than failed. It caught every
//      timer running one scan ahead of a real runtime, which three goldens had agreed with.
//      Its assumptions about iec2c's output are pinned by src/plc/oracleShape.test.ts.
//
// Locally, scripts/oracle-wsl.sh builds CI's pinned MATIEC in WSL and points this at it.
// Without a toolchain, `--dry-run` renders and structurally checks every case.
//
// Usage:
//   node scripts/oracle-matiec.mjs --dry-run          # render only, no toolchain needed
//   node scripts/oracle-matiec.mjs                    # tier 1: compile gate
//   node scripts/oracle-matiec.mjs --execute          # tier 1 + tier 2
//   IEC2C=/path/to/iec2c MATIEC_LIB=/path/to/matiec/lib node scripts/oracle-matiec.mjs
//   wsl -u root -- bash scripts/oracle-wsl.sh --execute   # Windows: build the toolchain first

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CONFORMANCE_CASES } from '../src/plc/conformanceCases.ts'
// What MATIEC's generated C looks like, and the replay driver written against it. Typed and
// unit-tested (src/plc/oracleShape.test.ts) because this tier only runs where MATIEC does.
import { SHIM_DECLARATIONS, declaredTypes, locatedNames, parseInstance, parseInstances, renderHarness, translationUnits } from '../src/plc/oracleShape.ts'
// The renderer is the PRODUCT's exporter, not a test fixture. Rendering the corpus through
// the exact code path a user's "export" button runs is what makes this gate mean something:
// it proves the artifact we hand people compiles with a real IEC compiler. If these ever
// diverge, CI is verifying a file nobody receives.
import { renderIecText } from '../src/plc/exchange/exportText.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(ROOT, '.oracle')

// ---- rendering a corpus case as a spec-legal IEC program ----
//
// The POU peeling and the CONFIGURATION wrapper both live in
// src/plc/exchange/exportText.ts, never duplicated here: a copy would let CI verify a rendering the
// product never produced -- the exact drift this gate exists to prevent.

/**
 * Render one case as a standalone IEC program. The corpus body is a bare statement list
 * with VAR sections, which is exactly a PROGRAM's contents; the CONFIGURATION/RESOURCE/TASK
 * wrapper around it is the part our subset does not have (see docs/st-conformance.md) and
 * is supplied here so the case can be compiled by a spec-complete toolchain at all.
 */
export function renderIec(c, { programName = 'Main' } = {}) {
  const content = renderIecText(c.src, { programName, banner: false })
  return [
    `(* generated from the oip-web ST conformance corpus - case: ${c.name} *)`,
    `(* DO NOT EDIT: regenerate with node scripts/oracle-matiec.mjs --dry-run *)`,
    content,
  ].join('\n')
}

/** A filesystem-safe stem for a case name. */
function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
}

// ---- toolchain discovery ----

function findTool(envVar, fallback) {
  const fromEnv = process.env[envVar]
  if (fromEnv) return fromEnv
  try {
    execFileSync(fallback, ['--help'], { stdio: 'ignore' })
    return fallback
  } catch {
    return null
  }
}

/** MATIEC's library dir holds the standard-function definitions iec2c needs via -I. */
function matiecLib(iec2c) {
  if (process.env.MATIEC_LIB) return process.env.MATIEC_LIB
  const guess = join(dirname(resolve(iec2c)), 'lib')
  return existsSync(guess) ? guess : null
}

// ---- tier 2: the C harness ----

/** A case that declares its own PROGRAMs or CONFIGURATION, rendered as written rather than wrapped. */
function declaresController(c) {
  return /^\s*(PROGRAM|CONFIGURATION)\s+[A-Za-z_]/im.test(c.src)
}

/** The generated resource file. The corpus names its resource Res0, as the exporter does. */
function resourceFile(outDir) {
  const resFile = readdirSync(outDir).find((f) => /^Res0\.c$/i.test(f)) ?? readdirSync(outDir).find((f) => /Res.*\.c$/i.test(f))
  if (!resFile) {
    throw new Error(`no resource .c in ${outDir} (saw: ${readdirSync(outDir).join(', ')})`)
  }
  return resFile
}

/**
 * Find the generated program instance on disk: locate the resource file, then hand its text
 * to the shape parser. The PARSING lives in src/plc/oracleShape.ts, where it is unit-tested
 * against real generated files; this is just the I/O and a failure message that names what
 * it searched.
 */
function discoverInstance(outDir, programName) {
  const resFile = resourceFile(outDir)
  const found = parseInstance(readFileSync(join(outDir, resFile), 'utf8'), programName)
  if (!found) {
    throw new Error(
      `could not find the '${programName.toUpperCase()}_data__' instance declaration in ${resFile}.` +
        ` Tier 2 assumes MATIEC's output shape here; see parseInstance() in src/plc/oracleShape.ts.`,
    )
  }
  return { ...found, resFile }
}

/** The generated .c files, as {name, text}, for {@link translationUnits}. */
function cSources(outDir) {
  return readdirSync(outDir)
    .filter((f) => f.endsWith('.c'))
    .map((name) => ({ name, text: readFileSync(join(outDir, name), 'utf8') }))
}

/** Every variable a case asserts on, with whether it must be read back as a float. */
export function watchedVars(c) {
  const out = new Map()
  for (const step of c.steps) {
    for (const k of Object.keys(step.expect ?? {})) {
      const v = step.expect[k]
      if (typeof v === 'string' || out.get(k)?.kind === 'string') {
        out.set(k, { name: k, kind: 'string' })
        continue
      }
      const real = typeof v === 'number' && !Number.isInteger(v)
      out.set(k, { name: k, kind: real || out.get(k)?.kind === 'real' ? 'real' : 'int' })
    }
    for (const k of Object.keys(step.close ?? {})) out.set(k, { name: k, kind: 'real' })
  }
  return [...out.values()]
}

// ---- diffing one case's replayed image against the goldens ----

export function diffCase(c, lines) {
  const problems = []
  const runnable = c.steps.filter((s) => !s.throws)
  if (lines.length !== runnable.length) {
    problems.push(`expected ${runnable.length} scan lines, got ${lines.length}`)
    return problems
  }
  runnable.forEach((step, i) => {
    let image
    try {
      image = JSON.parse(lines[i])
    } catch {
      problems.push(`scan ${i + 1}: unparseable output ${JSON.stringify(lines[i])}`)
      return
    }
    for (const [k, want] of Object.entries(step.expect ?? {})) {
      const got = image[k.toUpperCase()]
      const wantNum = typeof want === 'boolean' ? (want ? 1 : 0) : want
      if (got !== wantNum) problems.push(`scan ${i + 1}: ${k} expected ${wantNum}, oracle says ${got}`)
    }
    for (const [k, want] of Object.entries(step.close ?? {})) {
      const got = image[k.toUpperCase()]
      // MATIEC maps REAL to C float (32-bit) while ours is f64, so compare at float epsilon
      if (typeof got !== 'number' || Math.abs(got - want) > 1e-5 * Math.max(1, Math.abs(want))) {
        problems.push(`scan ${i + 1}: ${k} expected ~${want}, oracle says ${got}`)
      }
    }
  })
  return problems
}

// ---- main ----

function main() {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const execute = argv.includes('--execute')

  const cases = CONFORMANCE_CASES.filter((c) => !c.oracle?.skip)
  const skipped = CONFORMANCE_CASES.filter((c) => c.oracle?.skip)

  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })

  console.log(`ST external oracle (MATIEC)`)
  console.log(`  corpus: ${CONFORMANCE_CASES.length} cases - ${cases.length} replayed, ${skipped.length} withheld\n`)

  const rendered = cases.map((c) => {
    const stem = slug(c.name)
    const file = join(WORK, `${stem}.st`)
    writeFileSync(file, renderIec(c), 'utf8')
    return { c, stem, file }
  })

  if (dryRun) {
    // Self-check the rendering, since --dry-run is what CI can run everywhere and
    // splitProgram mis-peeling a POU is the one failure that would otherwise be silent
    // (a stray FUNCTION left inside the PROGRAM body still LOOKS like plausible ST).
    const bad = []
    for (const { c, file } of rendered) {
      const text = readFileSync(file, 'utf8')
      if (declaresController(c)) {
        // rendered as written, so there is no generated wrapper to check: only that a CONFIGURATION
        // (its own, or the one a lone PROGRAM is wrapped in) came out
        if (!text.includes('END_CONFIGURATION')) bad.push(`${c.name}: no CONFIGURATION in the rendering`)
        continue
      }
      const bodyStart = text.indexOf('\nPROGRAM Main')
      const body = text.slice(bodyStart, text.indexOf('\nEND_PROGRAM'))
      if (bodyStart < 0) bad.push(`${c.name}: no PROGRAM header`)
      if (!text.includes('END_CONFIGURATION')) bad.push(`${c.name}: no CONFIGURATION wrapper`)
      if (/\b(FUNCTION|FUNCTION_BLOCK|TYPE)\b/.test(body)) bad.push(`${c.name}: a POU definition leaked into the PROGRAM body`)
      if (/\bEND_(FUNCTION|FUNCTION_BLOCK|TYPE)\b/.test(body)) bad.push(`${c.name}: a POU terminator leaked into the PROGRAM body`)
    }
    if (bad.length) {
      console.error(`rendering is wrong for ${bad.length} case(s):`)
      for (const b of bad) console.error(`  - ${b}`)
      return 1
    }
    console.log(`rendered ${rendered.length} programs into ${WORK} (structure checked)`)
    for (const c of skipped) console.log(`  withheld: ${c.name}\n            ${c.oracle.skip}`)
    return 0
  }

  const iec2c = findTool('IEC2C', 'iec2c')
  if (!iec2c) {
    console.error(
      `iec2c not found. Install MATIEC and re-run, or set IEC2C=/path/to/iec2c.\n` +
        `  git clone https://github.com/nucleron/matiec && cd matiec && autoreconf -i && ./configure && make`,
    )
    return 2
  }
  const lib = matiecLib(iec2c)
  if (!lib) {
    console.error(`MATIEC's lib/ dir not found next to ${iec2c}; set MATIEC_LIB=/path/to/matiec/lib`)
    return 2
  }

  const failures = []
  const diverged = []

  for (const { c, stem, file } of rendered) {
    const outDir = join(WORK, stem)
    mkdirSync(outDir, { recursive: true })

    // ---- tier 1: does a real IEC compiler agree with our accept/reject verdict? ----
    let accepted = true
    let why = ''
    try {
      execFileSync(iec2c, ['-I', lib, '-T', outDir, file], { stdio: 'pipe' })
    } catch (e) {
      accepted = false
      why = String(e.stderr ?? e.stdout ?? e.message).trim()
    }
    if (c.rejects) {
      // we refuse this program; the whole point is that the target refuses it too, so
      // MATIEC *accepting* it means our strictness is inventing a rule the target lacks
      if (accepted) {
        failures.push({ name: c.name, tier: 'over-strict', detail: 'we reject this program but MATIEC accepts it - our rule is stricter than the standard' })
        console.log(`  OVERSTRICT ${c.name}`)
      } else {
        console.log(`  rejected  ${c.name} (as intended)`)
      }
      continue
    }
    if (c.oracle?.editionReject) {
      // MATIEC implements IEC 2nd edition, which has no implicit type conversions; 3rd
      // edition defines them and the vendors ship them. A rejection here is the EXPECTED
      // answer and says nothing about our engine. Acceptance is not a failure either - it
      // would just mean the annotation has outlived the toolchain, so say so and move on.
      console.log(`  ${accepted ? 'ed3-ok    ' : 'ed2       '}${c.name}`)
      if (accepted) {
        console.log(`            MATIEC now accepts this; the editionReject note can be retired`)
      }
      continue
    }
    if (!accepted) {
      failures.push({ name: c.name, tier: 'compile', detail: why })
      console.log(`  REJECTED  ${c.name}`)
      continue
    }
    console.log(`  compiles  ${c.name}`)
    if (!execute) continue

    // ---- tier 2: does it produce the same answers? ----
    try {
      const watched = watchedVars(c)
      const pous = join(outDir, 'POUS.h')
      const pousText = existsSync(pous) ? readFileSync(pous, 'utf8') : ''
      let facts
      if (declaresController(c)) {
        // several program instances: a watched `Instance.Name` is read off the instance it names
        const resFile = resourceFile(outDir)
        const instances = parseInstances(readFileSync(join(outDir, resFile), 'utf8')).map((i) => ({
          name: i.name,
          symbol: i.instance,
          structType: i.structType,
          types: declaredTypes(pousText, i.structType),
          located: locatedNames(pousText, i.structType),
        }))
        if (instances.length === 0) {
          throw new Error(`no program instances found in ${resFile}. Tier 2 assumes MATIEC's output shape here; see parseInstances() in src/plc/oracleShape.ts.`)
        }
        facts = { instance: instances[0].symbol, structType: instances[0].structType, watched, instances }
      } else {
        const { instance, structType } = discoverInstance(outDir, 'Main')
        facts = { instance, structType, watched, types: declaredTypes(pousText, structType), located: locatedNames(pousText, structType) }
      }
      writeFileSync(join(outDir, 'harness.c'), renderHarness(c, facts), 'utf8')
      const shimHeader = join(outDir, 'oracle_shims.h')
      writeFileSync(shimHeader, SHIM_DECLARATIONS, 'utf8')
      const cFiles = translationUnits(cSources(outDir))
      const bin = join(outDir, 'replay')
      // -include: MATIEC's own units call the _____time_* shims, so the DECLARATIONS have to
      // reach them. Left implicit, gcc assumes `int` for a function that returns a TIME
      // struct - it would still link, and quietly compute garbage.
      execFileSync('gcc', ['-w', '-include', shimHeader, '-I', join(lib, 'C'), '-I', outDir, ...cFiles.map((f) => join(outDir, f)), '-lm', '-o', bin], { stdio: 'pipe' })
      const out = execFileSync(bin, { stdio: 'pipe' }).toString()
      const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
      const problems = diffCase(c, lines)
      if (problems.length) {
        ;(c.divergence ? diverged : failures).push({ name: c.name, tier: 'semantics', detail: problems.join('\n      ') })
        console.log(`  ${c.divergence ? 'diverges' : 'MISMATCH'}  ${c.name}`)
      } else {
        console.log(`  agrees    ${c.name}`)
      }
    } catch (e) {
      const why = String(e.stderr ?? e.message).trim()
      failures.push({ name: c.name, tier: 'harness', detail: why })
      console.log(`  HARNESS   ${c.name}`)
    }
  }

  console.log()
  for (const c of skipped) console.log(`  withheld  ${c.name}\n            ${c.oracle.skip}`)

  if (diverged.length) {
    console.log(`\nknown divergences confirmed (documented, not failures):`)
    for (const d of diverged) console.log(`  - ${d.name}\n      ${d.detail}`)
  }

  if (failures.length) {
    console.log(`\n${failures.length} failure(s):`)
    for (const f of failures) console.log(`  - [${f.tier}] ${f.name}\n      ${f.detail}`)
    return 1
  }
  console.log(`\nall ${rendered.length} replayed cases agree with MATIEC.`)
  return 0
}

// importable for the unit test; only runs the CLI when invoked directly
if (process.argv[1] && resolve(process.argv[1]).endsWith('oracle-matiec.mjs')) {
  process.exit(main())
}
