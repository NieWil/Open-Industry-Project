#!/usr/bin/env node
// Second external oracle: replays the ST conformance corpus through STruC++, an IEC
// 61131-3 *3rd edition* compiler, alongside the MATIEC (2nd edition) gate.
//
// Why a second one: MATIEC is strict and old. It refuses every implicit conversion, but also
// things the standard has allowed since 2013, so one compiler cannot tell "our defect" from
// "the oracle's edition". Two compilers of different editions make that a measurement:
//
//   both reject                    -> our defect
//   MATIEC rejects, STruC++ takes  -> an edition difference, and the corpus says so
//   MATIEC takes, STruC++ rejects  -> worth a look; usually a gap in the younger compiler
//
// One measured asymmetry: MATIEC is the strictness oracle and STruC++ is not. At v0.6.2
// STruC++ accepts a missing statement separator and an assignment to a FOR control variable,
// both forbidden by IEC, so a program we reject that it accepts is reported, not failed.
//
// What this gate is for: STruC++'s coverage is narrower than MATIEC's in places (STRUCPP_GAPS
// below), so as a broad gate it would mostly report its own gaps. Its job is small: every
// case annotated `oracle.editionReject` must compile under it, so "IEC 3rd edition allows this"
// is checked on every push. It is also the compiler OpenPLC's editor ships.
// GPL-3.0: this invokes it as a build tool and never links or vendors it.
//
// THE RUN TIER (--execute). Every case that compiles is also BUILT with g++ against the release's
// runtime headers and stepped scan by scan, the image diffed against the goldens as MATIEC's tier 2
// does (oracle-matiec.mjs `diffCase`). The driver is src/plc/oracleStrucpp.ts, unit-tested; its
// scheduling is its own, so this tier checks the code STruC++ generates, not a runtime.
//
// Usage:
//   node scripts/oracle-strucpp.mjs                 # compile the corpus, check the claims
//   node scripts/oracle-strucpp.mjs --execute       # ... and build, run and diff what compiles (needs g++)
//   STRUCPP=/path/to/strucpp node scripts/oracle-strucpp.mjs
//   STRUCPP_RUNTIME=/path/to/runtime/include      # if the headers are not at <strucpp dir>/runtime/include
//   (every run writes the names the release's bundled libraries put in a build to .oracle-ed3/library-names.txt)

import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { CONFORMANCE_CASES } from '../src/plc/conformanceCases.ts'
import { renderIecText } from '../src/plc/exchange/exportText.ts'
import { parseStrucppHeader, renderStrucppHarness } from '../src/plc/oracleStrucpp.ts'
import { diffCase, watchedVars } from './oracle-matiec.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(ROOT, '.oracle-ed3')

/**
 * Known STruC++ gaps, observed at v0.6.2.
 *
 * A failure matching one of these is EXPECTED and does not fail the run - but the entry has
 * to say what and why, the same bar the corpus sets for its own annotations. If a gap stops
 * being observed the run says so, because an annotation that has outlived the toolchain is
 * itself a small lie waiting to be believed.
 */
const STRUCPP_GAPS = [
  // No `sized-string` entry. STruC++ 0.6.2 has no sized STRING in either
  // spelling, and neither does MATIEC (for unrelated reasons of its own), so no external
  // compiler here can check a string capacity at all. That is recorded where it belongs -
  // on the one corpus case whose subject IS the capacity, which is withheld from both
  // oracles with the full diagnosis. Keeping a gap entry for a case no run can reach would
  // just make every run print "gap no longer observed" and invite someone to retire it.
  {
    id: 'continue-statement',
    match: /Unexpected identifier `CONTINUE`/,
    why: 'CONTINUE is an IEC 3rd-edition statement that STruC++ 0.6.2 does not implement. MATIEC accepts it.',
  },
  {
    id: 'array-init-repetition',
    match: /Expected `RBracket`, found `\(`/,
    why: "IEC's `n(x)` array-initialiser repetition (`[3(0), 1]`) is not implemented in STruC++ 0.6.2. MATIEC accepts it.",
  },
  {
    id: 'power-operator',
    match: /Expected `Semicolon`, found `\*\*`/,
    why: 'The `**` exponentiation operator is not implemented in STruC++ 0.6.2. MATIEC accepts it, and agrees with this engine on where it binds.',
  },
  {
    id: 'qualified-enum-value',
    match: /unexpected character: ->#<-/,
    why: 'An enumeration value written with its type (`Mode#Idle`) does not lex in STruC++ 0.6.2. MATIEC accepts it.',
  },
  {
    id: 'struct-initializer',
    match: /Expected `RParen`, found `:=`/,
    why: 'A structured initial value (`p : Pkg := (id := 7, dest := 3)`) does not parse in STruC++ 0.6.2. MATIEC accepts it.',
  },
  {
    id: 'external-constant',
    match: /CONSTANT variable '[^']*' must have an initializer/,
    why: 'STruC++ 0.6.2 demands an initial value on a `VAR_EXTERNAL CONSTANT`, which IEC gives no place for: an external declares no storage of its own, and the VAR_GLOBAL it names carries the value. MATIEC accepts it.',
  },
  {
    id: 'shared-fb-global',
    match: /Shared global '[^']*' is a function-block instance and is invoked/,
    why: "STruC++ 0.6.2 cannot call a function-block instance held as a VAR_GLOBAL (\"Calling a shared function-block global is not yet supported in the mutex-based shared-global model - scalar globals only for now\"). IEC allows it, and MATIEC builds and agrees with it. The export writes one when the code outside every POU shares its variables with another POU.",
  },
  {
    id: 'omitted-input-no-initial',
    match: /is missing required input:/,
    why: "STruC++ 0.6.2 refuses a formal FUNCTION call that leaves out an input declaring no initial value (\"'SCALE' is missing required input: V\"); it builds one that leaves out only inputs that declare one. IEC gives an omitted input its initial value either way, and MATIEC builds and agrees with both. It is OpenPLC's compiler, so a program for OpenPLC gives such an input.",
  },
  {
    id: 'standard-named-args',
    match: /Cannot assign INT to STRING/,
    why: "STruC++ 0.6.2 binds a STANDARD function's arguments by position and ignores their names (LIMIT(MX := 9, IN := x, MN := 0) compiles to LIMIT(9, X, 0)). The corpus case trips it only where the swap crosses types, MID(P := 2, IN := s, L := 3); where it does not, it compiles and computes something else, which is why export warns about named arguments out of order. User functions bind by name there. MATIEC builds and agrees.",
  },
  {
    id: 'sub-date-date',
    match: /Cannot assign DATE to TIME/,
    why: "STruC++ 0.6.2 types SUB(DATE, DATE) as a DATE (\"Cannot assign DATE to TIME\"), as its generic SUB would. IEC's table of time functions makes it a TIME (SUB_DATE_DATE), which STruC++ itself gets right for `-`, and MATIEC builds and agrees with both spellings.",
  },
]

/**
 * Known STruC++ gaps in the RUN tier, observed at v0.6.2 (the tier's first run).
 *
 * Two kinds. `build`: STruC++ reports "Compilation successful" but the C++ it generated does not build -
 * with this driver or with its own `--build`, which uses the same g++ -std=c++17 (checked). `semantics`:
 * it builds and computes a different answer from the golden, which this engine and MATIEC agree on unless
 * the case's divergence note says otherwise. Each is a gap in STruC++, so in what OpenPLC's newer editor
 * builds; a listed case is reported, not failed, and an entry whose cases all agree again is named for
 * retirement, as STRUCPP_GAPS are. Matched by case NAME: a new disagreement anywhere else fails the run.
 *
 * The export warns where a program meets one of these (src/plc/exchange/export.ts `strucppWarnings`), except `library-name`
 * (the names come from the release's GPL libraries, which the app does not ship): retiring an entry here means
 * retiring its warning there too.
 */
const RUN_GAPS = [
  {
    id: 'bcd-functions',
    kind: 'build',
    cases: ['the BCD pair packs one decimal digit per nibble'],
    why: 'INT_TO_BCD and BCD_TO_INT compile but are declared nowhere in the runtime ("was not declared in this scope").',
  },
  {
    id: 'struct-holds-block',
    kind: 'build',
    cases: ['function blocks inside a struct are called and read through their fields'],
    why: 'The header declares every struct before any function block, so a struct holding one names a class not declared yet ("TON does not name a type").',
  },
  {
    id: 'library-name',
    kind: 'build',
    cases: ['a TYPE declared between two FUNCTION_BLOCKs'],
    why: "The block is named Window, and OSCAT basic, which STruC++ bundles into every build, has a FUNCTION WINDOW that hides the class (\"WINDOW does not name a type\"). Any user FUNCTION_BLOCK or STRUCT named like one of its bundled libraries' POUs fails so; a user FUNCTION of such a name builds (each run lists the names in .oracle-ed3/library-names.txt).",
  },
  {
    id: 'ref-to-aggregate',
    kind: 'build',
    cases: ['REF_TO reads and writes, through ^, the place REF() gives it, an element and a field included, and a call gives a block\'s REF_TO input one'],
    why: 'REF() of a struct or a function block does not build ("no matching function for call to REF(S&)"); REF() of an INT does, of an array element and of a struct\'s field too, and so do a REF_TO input given REF(), another REF_TO or NULL, and r <> NULL. (NULL on the LEFT of a comparison, NULL <> r, does not build either: "no match for operator!=".)',
  },
  {
    id: 'string-functions-on-literals',
    kind: 'build',
    cases: ['CONCAT joins; INSERT/DELETE/REPLACE edit at a position', 'the $ escapes decode to their control characters', 'INT_TO_STRING and STRING_TO_INT round trip', 'MIN and MAX order strings, since IEC makes them generic over ordered values', 'an out-of-range length or position clamps instead of erroring', 'standard blocks and a variable linked at %I*'],
    why: "A standard string function given a string LITERAL does not build: the literal reaches C++ as a const char[N], which no overload of CONCAT, LEN, LEFT, MIN or STRING_TO_INT takes.",
  },
  {
    id: 'string-compare',
    kind: 'build',
    cases: ['STRING compares lexicographically by character code'],
    why: 'Comparing two STRING variables with < <= > >= does not build: IECStringVar has no ordering operators (IECString does).',
  },
  {
    id: 'calendar-functions',
    kind: 'build',
    cases: ['the time and date functions compute what their operators do', 'a DT splits into its DATE and its TIME_OF_DAY'],
    why: "ADD_TOD_TIME, SUB_TOD_TIME and the like, and the TO_TIME_OF_DAY a DT_TO_TOD lowers to, are declared nowhere in the runtime. The operators (TOD + TIME) build.",
  },
  {
    id: 'method-output-unbound',
    kind: 'build',
    cases: ['a METHOD runs on its instance: its result, outputs and in-outs, and variables that start over on every call'],
    why: 'A METHOD call that leaves one of its outputs unbound is generated with that argument missing ("no matching function for call to ACC::PUT(int, IEC_INT&)"); binding every output builds.',
  },
  {
    id: 'method-on-same-name',
    kind: 'build',
    cases: ["EXTENDS: a derived block keeps its base's variables, overrides a method (SUPER^.M() reaches the base's), and runs its base's body only through SUPER^()"],
    why: 'Not EXTENDS or SUPER^: the program calls a METHOD on `fast : Fast`, an instance named like its block type. The member is renamed FAST_ where it is declared but not in the method call, so FAST.BUMP() names the class ("expected primary-expression before ."); calling the block itself builds.',
  },
  {
    id: 'real-to-int-ties',
    kind: 'semantics',
    cases: ['REAL_TO_INT rounds ties-to-even', 'an explicit REAL_TO_INT narrowing is accepted', 'every REAL-to-integer conversion rounds a tie to even'],
    why: 'A REAL or LREAL converted to an integer of any width rounds a tie AWAY from zero (REAL_TO_INT(2.5) is 3, REAL_TO_SINT(4.5) 5, LREAL_TO_DINT(6.5) 7), where this engine and MATIEC round to even (2, 4, 6).',
  },
  {
    id: 'not-of-a-literal',
    kind: 'semantics',
    cases: ['AND/OR/XOR on bit-strings are bitwise; NOT complements within the width'],
    why: 'NOT of an integer LITERAL stored into a WORD is generated as C++ `!0`, a logical NOT, so it gives 1 instead of 16#FFFF. NOT of a WORD variable complements correctly.',
  },
  {
    id: 'down-counter-falling-edge',
    kind: 'semantics',
    cases: ['CTD loads and counts down to zero', 'CTUD counts both directions with QU/QD thresholds'],
    why: "The library's CTD and CTUD detect CD with an F_TRIG, so they count down when CD FALLS, a scan after IEC's rising edge (which CU's R_TRIG gets right).",
  },
  {
    id: 'array-initial-value',
    kind: 'semantics',
    cases: ['arrays in one list get separate storage, not a shared initialiser', 'assigning an array copies every element', 'a FUNCTION takes a whole array by value', 'a named array type copies whole and starts from a [...] list'],
    why: "A PROGRAM's array loses its [...] starting value: the program's generated constructor initialises the scalars and leaves the array at zero. A function block's array and a FUNCTION's local array keep theirs (the case \"an array's starting value holds in a function block and in a FUNCTION\" agrees).",
  },
  {
    id: 'constant-from-constant',
    kind: 'semantics',
    cases: ['a CONSTANT can be defined from another CONSTANT'],
    why: "A PROGRAM's CONSTANT whose starting value is an expression (LAST : INT := ZONES - 1) starts at 0: the program's constructor writes LAST(0). Inside a function block it holds (the case \"a CONSTANT defined from another holds inside a function block\" agrees).",
  },
  {
    id: 'date-difference-in-days',
    kind: 'semantics',
    cases: ['the calendar operators: a TOD or DT plus or minus a TIME, and differences'],
    why: 'DATE - DATE yields the number of DAYS stored into a TIME (2 days reads as 2 ns), where IEC makes it the TIME between them; TOD and DT differences are right. See builtins.ts CALENDAR_UNITS.',
  },
  {
    id: 'calendar-to-string',
    kind: 'semantics',
    cases: ['calendar values print as their literals'],
    why: "DATE_TO_STRING, TOD_TO_STRING and DT_TO_STRING print the raw count (19782 days, nanoseconds) instead of the literal (D#2024-02-29).",
  },
  {
    id: 'taskless-program-on-first-task',
    kind: 'semantics',
    cases: ['a PROGRAM instance with no task runs on every tick, after the periodic tasks'],
    why: "A PROGRAM line with no WITH is put on the configuration's FIRST task by the generated code, so it runs with that task, before a lower-priority task due on the same tick. This engine runs it after the periodic tasks.",
  },
]

const gapOf = (c) => RUN_GAPS.find((g) => g.cases.includes(c.name))

function findStrucpp() {
  if (process.env.STRUCPP) return process.env.STRUCPP
  const local = [
    join(ROOT, 'strucpp', 'strucpp.exe'),
    join(ROOT, 'strucpp', 'strucpp'),
  ].find((p) => existsSync(p))
  if (local) return local
  return process.platform === 'win32' ? 'strucpp.exe' : 'strucpp'
}

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
}

/** Compile one rendered program. Returns {ok, why}. */
function compile(strucpp, file, outDir) {
  try {
    const out = execFileSync(strucpp, [file, '-o', join(outDir, 'out.cpp')], { stdio: 'pipe' }).toString()
    // STruC++ reports parse/type errors on stdout with a zero exit in some paths, so the
    // success banner is the signal rather than the exit code alone
    if (/Compilation successful/.test(out)) return { ok: true, why: '' }
    return { ok: false, why: firstError(out) }
  } catch (e) {
    return { ok: false, why: firstError(String(e.stdout ?? '') + String(e.stderr ?? e.message)) }
  }
}

function firstError(text) {
  // a diagnostic reads `error:`; a code-generator refusal is thrown as `Error:`, after the "Compiling" banner
  const line = text.split('\n').find((l) => /\berror:/i.test(l))
  return (line ?? text.split('\n').find(Boolean) ?? 'unknown failure').trim()
}

// ---- the names STruC++'s bundled libraries put in every build ----
//
// A user FUNCTION_BLOCK or STRUCT named like any of them does not build there (measured: OSCAT's WINDOW
// function hid a block named Window; "redefinition of class HYST" for a struct named Hyst; a user FUNCTION of such a
// name builds). The list is read from the installed release's own libs/*.stlib on every run and written only to the
// gitignored work dir: those libraries are GPL, so no copy of their names is committed or shipped in the app.

const LIBRARY_KINDS = new Set(['function', 'functionBlock', 'type'])

function libraryNames(strucpp) {
  const dir = join(dirname(resolve(strucpp)), 'libs')
  if (!existsSync(dir)) return null
  const names = new Set()
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.stlib'))) {
    for (const chunk of JSON.parse(readFileSync(join(dir, f), 'utf8')).chunks ?? []) {
      if (LIBRARY_KINDS.has(chunk.kind)) names.add(String(chunk.name).toUpperCase())
    }
  }
  return [...names].sort()
}

/** The runtime headers the generated C++ includes, shipped beside the compiler in a release. */
function runtimeInclude(strucpp) {
  if (process.env.STRUCPP_RUNTIME) return process.env.STRUCPP_RUNTIME
  const guess = join(dirname(resolve(strucpp)), 'runtime', 'include')
  return existsSync(guess) ? guess : null
}

const run = promisify(execFile)

/** Build one compiled case against the runtime, run it, and diff its image with the goldens. */
async function replay(c, outDir, include) {
  const facts = parseStrucppHeader(readFileSync(join(outDir, 'out.hpp'), 'utf8'))
  writeFileSync(join(outDir, 'harness.cpp'), renderStrucppHarness(c, watchedVars(c), facts), 'utf8')
  const bin = join(outDir, 'replay')
  // C++17, not 20: under 20 iec_types.hpp includes <concepts> from inside `namespace strucpp`, which no
  // generated file builds through (0.6.2; "strucpp::std::size_t has not been declared")
  await run('g++', ['-std=c++17', '-w', '-O0', '-I', include, '-I', outDir, join(outDir, 'out.cpp'), join(outDir, 'harness.cpp'), '-o', bin], { maxBuffer: 1 << 24 })
  const { stdout } = await run(bin, [], { timeout: 30_000 })
  return diffCase(c, stdout.split('\n').map((l) => l.trim()).filter(Boolean))
}

/** Run `jobs` with at most `width` in flight, keeping their order in the result. */
async function pool(jobs, width) {
  const out = new Array(jobs.length).fill(null)
  let next = 0
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++
      out[i] = await jobs[i]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, worker))
  return out
}

async function main() {
  const execute = process.argv.includes('--execute')
  const strucpp = findStrucpp()
  console.log('ST external oracle (STruC++, IEC 3rd edition)')
  let version = ''
  try {
    version = execFileSync(strucpp, ['--version'], { stdio: 'pipe' }).toString().trim()
  } catch {
    console.error(`\n  could not run '${strucpp}'.`)
    console.error('  Set STRUCPP=/path/to/strucpp, or unpack a release into ./strucpp/.')
    console.error('  Releases: https://github.com/Autonomy-Logic/STruCpp/releases')
    process.exit(2)
  }
  console.log(`  compiler: ${version}`)

  // the names its bundled libraries put in every build (the `library-name` gap), read from this release
  const names = libraryNames(strucpp)
  if (!names) console.log(`  no libs/ beside ${strucpp}: library names not listed`)

  const cases = CONFORMANCE_CASES.filter((c) => !c.oracle?.skip)
  console.log(`  corpus: ${CONFORMANCE_CASES.length} cases - ${cases.length} replayed\n`)

  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  if (names) {
    writeFileSync(join(WORK, 'library-names.txt'), names.join('\n') + '\n', 'utf8')
    console.log(`  library names: ${names.length}, in ${join(WORK, 'library-names.txt')}`)
  }

  const include = execute ? runtimeInclude(strucpp) : null
  if (execute && !include) {
    console.error(`  --execute: the runtime headers are not at ${join(dirname(resolve(strucpp)), 'runtime', 'include')}; set STRUCPP_RUNTIME`)
    process.exit(2)
  }

  const failures = []
  const lenient = []
  const gapsSeen = new Set()
  const runnable = [] // compiled cases with an answer to compare: [case, outDir]
  let compiled = 0

  for (const c of cases) {
    const stem = slug(c.name)
    const outDir = join(WORK, stem)
    mkdirSync(outDir, { recursive: true })
    const file = join(outDir, `${stem}.st`)
    writeFileSync(file, renderIecText(c.src, { banner: false }), 'utf8')

    const { ok, why } = compile(strucpp, file, outDir)
    const gap = ok ? null : STRUCPP_GAPS.find((g) => g.match.test(why))
    if (gap) gapsSeen.add(gap.id)

    // The measurement: a case we said MATIEC only refuses because it is 2nd-edition must
    // build on a 3rd-edition compiler. If it does not, the annotation is wrong and the
    // rejection was never about the edition.
    if (c.oracle?.editionReject) {
      if (ok) {
        compiled++
        runnable.push([c, outDir])
        console.log(`  ed3-ok    ${c.name}`)
      } else {
        failures.push({ name: c.name, detail: `annotated editionReject, but a 3rd-edition compiler also refuses it: ${why}` })
        console.log(`  CLAIM     ${c.name}`)
      }
      continue
    }

    if (c.rejects) {
      // NOT a gate. STruC++ is the EDITION oracle, not the strictness one: measured at
      // v0.6.2 it accepts a missing statement separator and an assignment to a FOR control
      // variable, both of which IEC forbids outright and MATIEC refuses by name. So it
      // accepting a program we refuse says the compiler is lenient there, not that we
      // invented a rule - MATIEC already confirmed every one of these. Counted and printed
      // so the leniency stays visible, and so a future tightening shows up as a change.
      if (ok) lenient.push(c.name)
      console.log(`  ${ok ? 'lenient  ' : 'rejected  '}${c.name}${ok ? '' : ' (as intended)'}`)
      continue
    }

    if (ok) {
      compiled++
      runnable.push([c, outDir])
      console.log(`  compiles  ${c.name}`)
    } else if (gap) {
      console.log(`  gap:${gap.id.padEnd(22)} ${c.name}`)
    } else {
      failures.push({ name: c.name, detail: why })
      console.log(`  REJECTED  ${c.name}`)
    }
  }

  console.log(`\n  ${compiled} compiled`)

  // ---- the run tier: does the code STruC++ generates compute the same answers? ----
  const diverged = []
  const runGapsSeen = new Set()
  if (execute) {
    console.log(`\n  building and running ${runnable.length} cases (g++, ${availableParallelism()} at a time)\n`)
    const results = await pool(
      runnable.map(([c, outDir]) => async () => {
        try {
          return { c, problems: await replay(c, outDir, include) }
        } catch (e) {
          return { c, harness: String(e.stderr || e.message).trim().split('\n').slice(0, 8).join('\n      ') }
        }
      }),
      availableParallelism(),
    )
    for (const { c, problems, harness } of results) {
      const gap = gapOf(c)
      const kind = harness ? 'build' : problems.length ? 'semantics' : null
      if (kind && gap?.kind === kind) {
        runGapsSeen.add(gap.id)
        console.log(`  gap:${gap.id.padEnd(30)} ${c.name}`)
      } else if (harness) {
        failures.push({ name: c.name, detail: `[build] ${harness}` })
        console.log(`  BUILD     ${c.name}`)
      } else if (problems.length) {
        ;(c.divergence ? diverged : failures).push({ name: c.name, detail: `[semantics] ${problems.join('\n      ')}` })
        console.log(`  ${c.divergence ? 'diverges' : 'MISMATCH'}  ${c.name}`)
      } else {
        console.log(`  agrees    ${c.name}`)
      }
    }
    const unseenRun = RUN_GAPS.filter((g) => !runGapsSeen.has(g.id))
    if (unseenRun.length) {
      console.log('\n  run-tier gaps no longer observed - retire these entries (or a case was renamed):')
      for (const g of unseenRun) console.log(`    ${g.id}`)
    }
    for (const g of RUN_GAPS.filter((x) => runGapsSeen.has(x.id))) console.log(`\n  known ${g.kind} gap: ${g.id}\n    ${g.why}`)
  }
  if (diverged.length) {
    console.log(`\n  documented divergences STruC++ also shows (the note may name only another toolchain - read it):`)
    for (const d of diverged) console.log(`  - ${d.name}\n      ${d.detail}`)
  }
  if (lenient.length) {
    console.log(`\n  ${lenient.length} program(s) we refuse that STruC++ accepts. MATIEC refuses all of them, which is`)
    console.log('  the evidence that they are non-portable; this compiler is lenient here:')
    for (const n of lenient) console.log(`    ${n}`)
  }
  const unseen = STRUCPP_GAPS.filter((g) => !gapsSeen.has(g.id))
  if (unseen.length) {
    console.log('\n  gaps no longer observed - the toolchain may have caught up, retire these entries:')
    for (const g of unseen) console.log(`    ${g.id}`)
  }
  for (const g of STRUCPP_GAPS.filter((x) => gapsSeen.has(x.id))) {
    console.log(`\n  known gap: ${g.id}\n    ${g.why}`)
  }

  if (failures.length) {
    console.log(`\n${failures.length} failure(s):`)
    for (const f of failures) console.log(`  - ${f.name}\n      ${f.detail}`)
    process.exit(1)
  }
  console.log(execute ? `\nno disagreements with a 3rd-edition compiler: ${runnable.length} cases built, run and compared.` : '\nno disagreements with a 3rd-edition compiler.')
}

await main()
