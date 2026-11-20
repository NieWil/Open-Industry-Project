#!/usr/bin/env node
// Fifth external oracle: does OpenPLC's own editor read what we export, and build the same program
// from it?
//
// Why: the other oracles ask whether a compiler takes our file (MATIEC, STruC++) or a schema takes our
// XML (TC6). OpenPLC's editor does something else: it reads the file into its own project model, then
// regenerates ST and compiles that. A reader that drops a declaration without a word (it does; see
// KNOWN below) yields a program that compiles and is not the one that was simulated.
//
// What runs: OpenPLC's own code at a pinned commit of Autonomy-Logic/openplc-editor, loaded through vite
// (only the import closure of the entry points below, ~80 files), with its npm dependencies and STruC++
// at the versions it pins, so editor and compiler are the pair that shipped together. One SHA is the pin.
//
// TWO DOORS INTO THE EDITOR, both checked for every corpus case:
//
//   xml    File > Import PLCopen XML, fed our `plcopen-xml` export. The GUI's whole-program door.
//   files  A project folder: our `iec-text` export split into the files OpenPLC keeps (one POU per
//          `pous/<kind>/<Name>.st`, one type per `datatypes/<Name>.dt`, the CONFIGURATION in
//          `project.json`). The door `openplc-cli compile` and a hand-copied POU both use.
//
// Each door then runs the editor's compile chain - resolveProjectAliases → injectLibraryBlocks →
// preprocessPous → toIpcProjectData → the ST transpiler → runProgramBuildPipeline (STruC++) - and
// the regenerated program is REPLAYED through this engine against the corpus goldens, which catches
// a program that still builds but no longer means what it meant. A case fails at the first bad stage:
//
//   load       the editor's reader warned, refused, or silently kept no declarations
//   transpile  the editor could not regenerate ST from what it read
//   compile    STruC++ refused the REGENERATED program although it builds OUR export - the editor
//              changed the program on the way
//   meaning    the regenerated program runs, but not to the goldens
//
// A program STruC++ refuses in both forms is a compiler gap, not an editor defect. It is reported
// and does not fail the run: the STruC++ job (oracle-strucpp.mjs) covers that.
//
// What is not the editor: three seams belong to this script.
//   - The zustand store is skipped: `getCompileReadyProjectData()` is `resolveProjectAliases(data,
//     aliasIndex)`, called here with an empty index, exact for a project with no devices.
//   - The ladder and FBD XML readers are stubs that throw (they pull in the whole React editor, and
//     our export never writes those bodies, so reaching one is itself a failure).
//   - STruC++ is handed to the editor through `__setStrucppRuntimeForTests`, the editor's own seam
//     for this: its loader uses `require`, which vite's module runner does not provide.
// RETIRE THIS when `openplc-cli` (the editor's headless front end, not yet released) is in a
// release: `openplc-cli compile` runs the same chain with no seams at all.
//
// GPL-3.0. The editor's sources and STruC++ are FETCHED into a gitignored directory and invoked as a
// tool, never vendored or linked - the same terms the STruC++ job already runs under.
//
// Usage:
//   npm run st-oracle:openplc                    # fetch (cached), install, check every case
//   npm run st-oracle:openplc -- --offline       # use only what is already cached
//   npm run st-oracle:openplc -- --case timer    # only cases whose name contains "timer"
//   npm run st-oracle:openplc -- --door xml      # only one door

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createServer } from 'vite'
import {
  compileChain,
  EDITOR,
  ensureDeps,
  ensureEditorSources,
  firstLine,
  HarnessError,
  loadEditor,
  projectFolder,
  ROOT,
  setOffline,
  STUBS,
  WORK,
} from './lib/openplc-editor.mjs'

/**
 * What the editor does to our exports that we KNOW about, each with its diagnosis. A verdict is
 * known only when EVERY problem line in it matches an entry for that door and stage, so a new problem
 * arriving beside a known one still fails the run. An entry that stops matching is reported, because
 * an annotation that outlived its cause is a small lie waiting to be believed. Same bar as STRUCPP_GAPS.
 *
 * Measured at the pinned editor: the XML door passes 77 of 90 cases (the rest are the entries below
 * and STruC++ gaps). The files door stops every case at load on the line layout; a probe with one
 * declaration per line showed what fails next (an array bound written as an expression, and a comment
 * naming its POU's END_ keyword cutting the body there), with 82 of 90 then passing.
 */
const KNOWN = [
  {
    id: 'xml-structured-initial',
    door: 'xml',
    stage: 'load',
    match: /^variable "[\w.]+" lost its (array|structured) starting value, without a warning$/,
    why: 'OpenPLC\'s PLCopen reader takes a starting value only from `<simpleValue>` (variable-xml.ts, parseVariableXml). An `<arrayValue>` or `<structValue>`, which is how TC6 writes `[1, 2, 3]` or `(x := 1)`, is read as no starting value at all, so the variable starts at zero. Its own text reader keeps the same value, so the files door does not lose it.',
  },
  {
    id: 'xml-taskless-instance',
    door: 'xml',
    stage: 'load',
    match: /^PROGRAM instance "\w+", which has no task, was dropped without a warning$/,
    why: 'OpenPLC\'s PLCopen reader collects program instances only from inside a `<task>` (instances-xml.ts). TC6 writes an instance with no task as a `<pouInstance>` directly on the resource, and that one is not read, so the program never runs.',
  },
  {
    id: 'xml-alias-type',
    door: 'xml',
    stage: 'load',
    match: /Unrecognized dataType derivation/,
    why: 'OpenPLC\'s PLCopen reader THROWS on a <dataType> whose base is an elementary type (a plain alias, `TYPE Count : INT; END_TYPE`) or a subrange (`<subrangeSigned>`, `TYPE Percent : INT (0..100); END_TYPE`), so the whole import fails. Its project model has neither.',
  },
  {
    id: 'xml-pointer-base-type',
    door: 'xml',
    stage: 'compile',
    match: /^STruC\+\+ builds our export but not the editor's regeneration of it: (\[[^\]]+\] \S+: error: Expected `TO`, found `;`\.(; )?)+$/,
    why: 'OpenPLC\'s PLCopen reader reads TC6\'s `<pointer><baseType>...</baseType></pointer>` (how the export writes a REF_TO) without its base type, and regenerates the variable as a bare `POINTER;`, which its own compiler refuses ("Expected `TO`, found `;`").',
  },
  {
    id: 'files-var-line',
    door: 'files',
    stage: 'load',
    match: /declares variables and was loaded with none, without a warning/,
    why: 'OpenPLC\'s POU reader is line-based. A declaration on the same line as its VAR keyword loses the whole section, and so does a section that opens on the line of the previous END_VAR: silently, with no warning and no raw text kept. The corpus writes `VAR a : INT; END_VAR` throughout and the export passes text through verbatim, so every case stops here. Measured beside it: two declarations on one line, a comma list, a declaration split over two lines, a comment line between declarations and a `;` inside a string literal each fall back to raw text WITH a warning (and then do not compile); one declaration per line is the only layout it reads.',
  },
  {
    id: 'files-struct-line',
    door: 'files',
    stage: 'load',
    match: /^Data type file "datatypes\/\w+\.dt" could not be parsed and was preserved as-is: invalid declaration: "\w+ : STRUCT\b/,
    why: 'The `.dt` reader takes a structure only in the shape its own serializer writes: `Name : STRUCT` on a line of its own, one field per line, then `END_STRUCT;`. A structure declared on one line (as the corpus writes them) is kept as raw text with a warning. The same line rule as files-var-line, in a different reader; with the fields on their own lines every one of these loaded.',
  },
  {
    id: 'files-alias-type',
    door: 'files',
    stage: 'load',
    match: /^Data type file "datatypes\/\w+\.dt" could not be parsed and was preserved as-is: invalid declaration: "\w+ : \w+;"/,
    why: 'A `.dt` file holds an enumeration, a structure or an array. A plain alias (`Count : INT;`) has no representation there, so the loader keeps the file as raw text with a warning.',
  },
  {
    id: 'files-subrange-type',
    door: 'files',
    stage: 'load',
    match: /^Data type file "datatypes\/\w+\.dt" could not be parsed and was preserved as-is: invalid declaration: "\w+ : \w+ \(-?\d+\.\.-?\d+\);"/,
    why: 'The same reader, and the same absence as files-alias-type: a subrange (`Percent : INT (0..100);`) is none of enumeration, structure or array, so the loader keeps the file as raw text with a warning.',
  },
  {
    id: 'files-type-name-line',
    door: 'files',
    stage: 'load',
    match: /^Data type file "datatypes\/\w+\.dt" could not be parsed and was preserved as-is: a \.dt file must declare exactly one data type$/,
    why: 'The same line rule as files-struct-line, one line earlier: a type declared with its name alone on a line (`Pt :`, then `STRUCT` or `(` below it) is not read as a declaration at all, so the file holds "no" type and is kept as raw text with a warning. The corpus has three cases written that way (a data type closing without its `;`, STRUCT field defaults, an enumeration over a base type).',
  },
  {
    id: 'files-interface',
    door: 'files',
    stage: 'load',
    match: /^INTERFACE "\w+" has no place in an OpenPLC project folder$/,
    why: 'An OpenPLC project folder keeps POUs under pous/programs, pous/function-blocks and pous/functions, and nothing else: there is no file an INTERFACE could be written to, so a program that declares one cannot be loaded whole (scripts/lib/openplc-editor.mjs projectFolder).',
  },
  {
    id: 'xml-methods-addData',
    door: 'xml',
    stage: 'load',
    match: /^POU "\w+" lost its METHOD \w+(, METHOD \w+)*, without a warning$/,
    why: 'TC6 has no element for a METHOD, so the export writes each one, as its ST, in the POU\'s `<addData>` (TC6\'s extension point) under this project\'s own name, http://www.openindustryproject.org/plcopenxml/method. OpenPLC\'s PLCopen reader reads no `addData` anywhere, so every member is dropped silently and a block whose code lives in its methods arrives as an empty shell.',
  },
]

const argv = process.argv.slice(2)
setOffline(argv.includes('--offline'))
const caseFilter = argv.includes('--case') ? argv[argv.indexOf('--case') + 1].toLowerCase() : null
const doorFilter = argv.includes('--door') ? argv[argv.indexOf('--door') + 1] : null
const DOORS = ['xml', 'files'].filter((d) => !doorFilter || d === doorFilter)


function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
}

// ---- loading both sides ----

async function loadOurs() {
  const vite = await createServer({ configFile: false, root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true } })
  try {
    const m = async (p) => vite.ssrLoadModule(p)
    return {
      ...(await m('/src/plc/conformanceCases.ts')),
      ...(await m('/src/plc/exchange/export.ts')),
      ...(await m('/src/plc/exchange/exportText.ts')),
      ...(await m('/src/plc/exchange/importText.ts')),
      ...(await m('/src/plc/exchange/importXml.ts')),
      ...(await m('/src/plc/interpreter.ts')),
      ...(await m('/src/plc/scanEngine.ts')),
      ...(await m('/src/plc/checker.ts')),
    }
  } finally {
    await vite.close()
  }
}


// ---- one door, one case ----


/** STruC++ on OUR export, with the options the editor's pipeline passes. */
function baselineBuild(editor, text) {
  try {
    const r = editor.strucpp.compile(text, { headerFileName: 'generated.hpp', fileName: 'program.st', debug: true, lineMapping: true, libraries: editor.archives })
    return r.success
  } catch {
    return false
  }
}

/** Run a program through this engine against a case's steps; returns every disagreement. */
function replay(ours, source, c) {
  const p = ours.compile(source)
  const scheduled = p.tasks.length > 0
  const sched = new ours.TaskScheduler({ tasks: p.tasks, tick: (dt) => p.scan(dt), tickTask: (i, dt) => p.scanTask(i, dt) }, { maxCatchUp: 64 })
  const run = (dt) => void (scheduled ? sched.advance(dt) : p.scan(dt))
  const wrong = []
  for (const [n, step] of c.steps.entries()) {
    for (const [k, v] of Object.entries(step.in ?? {})) p.setInput(k, v)
    const dt = step.dt ?? 0.1
    if (step.throws) {
      try {
        run(dt)
        wrong.push(`step ${n}: expected a fault matching ${step.throws}, the scan completed`)
      } catch (e) {
        if (!step.throws.test(String(e?.message ?? e))) wrong.push(`step ${n}: faulted with '${e?.message ?? e}', expected ${step.throws}`)
      }
      return wrong
    }
    run(dt)
    for (const [k, v] of Object.entries(step.expect ?? {})) {
      if (!Object.is(p.get(k), v)) wrong.push(`step ${n}: ${k} = ${String(p.get(k))}, expected ${String(v)}`)
    }
    // the same f32-relative tolerance conformance.test.ts applies
    for (const [k, v] of Object.entries(step.close ?? {})) {
      const got = p.get(k)
      if (typeof got !== 'number' || !(Math.abs(got - v) < (1e-6 * Math.max(1, Math.abs(v))) / 2)) wrong.push(`step ${n}: ${k} = ${String(got)}, expected ~${v}`)
    }
  }
  return wrong
}

/**
 * What the XML reader loses without a warning, measured against our own document so the verdict
 * says WHERE the program changed rather than only that its replay went wrong. Two shapes, both legal
 * TC6 and both first seen here: a starting value given as an `arrayValue` or
 * `structValue` (the reader takes only `simpleValue`), and a `pouInstance` placed directly on the
 * resource, which is how TC6 spells an instance with no task (the reader takes only instances
 * nested in a task). And a block's METHODs: TC6 has no element for
 * them, so they travel in `<addData>`, TC6's extension point, and the reader reads no `addData`
 * at all. A block whose code is all in its methods then also arrives with an empty body, which is
 * only reported when OUR body was not empty, so the verdict names the member that was lost.
 */
function xmlSilences(ours, xml, data) {
  const problems = []
  const initials = []
  const taskless = []
  const members = new Map() // pou -> ['METHOD Area', ...]
  const emptyInExport = new Set()
  const walk = (node, pou, parent) => {
    const here = node.name === 'pou' ? node.attrs.name : pou
    if (node.name === 'pou') {
      const st = node.children.find((k) => k.name === 'body')?.children.find((k) => k.name === 'ST')
      const p = st?.children.find((k) => k.name === 'p') // parseXml drops the xhtml: prefix
      if (p && p.text.trim() === '') emptyInExport.add(String(here).toUpperCase())
    }
    if (node.name === 'data' && /\/(method|property)$/.test(node.attrs.name ?? '')) {
      // ours is a `<method>`; a file written elsewhere may hold `<Method>` / `<Property>`
      for (const m of node.children.filter((k) => /^(method|property)$/i.test(k.name))) {
        members.set(here, [...(members.get(here) ?? []), `${m.name.toUpperCase()} ${m.attrs.name}`])
      }
    }
    if (node.name === 'variable') {
      const init = node.children.find((k) => k.name === 'initialValue')
      const shape = init?.children.find((k) => k.name === 'arrayValue' || k.name === 'structValue')
      if (shape) initials.push({ pou: here, name: node.attrs.name, shape: shape.name })
    }
    if (node.name === 'pouInstance' && parent?.name === 'resource') taskless.push(node.attrs.name)
    for (const k of node.children) walk(k, here, node)
  }
  walk(ours.parseXml(xml), undefined, undefined)
  const same = (a, b) => String(a).toUpperCase() === String(b).toUpperCase()
  for (const { pou, name, shape } of initials) {
    const vars = pou === undefined ? data.configurations?.resource?.globalVariables : data.pous.find((p) => same(p.name, pou))?.interface?.variables
    const v = (vars ?? []).find((x) => same(x.name, name))
    if (v && (v.initialValue === null || v.initialValue === undefined || v.initialValue === '')) {
      problems.push(`variable "${pou ? `${pou}.` : ''}${name}" lost its ${shape === 'arrayValue' ? 'array' : 'structured'} starting value, without a warning`)
    }
  }
  const instances = data.configurations?.resource?.instances ?? []
  for (const name of taskless) {
    if (!instances.some((i) => same(i.name, name))) problems.push(`PROGRAM instance "${name}", which has no task, was dropped without a warning`)
  }
  for (const [pou, list] of members) {
    const p = data.pous.find((x) => same(x.name, pou))
    if (p && !(p.methods?.length > 0 || p.properties?.length > 0)) problems.push(`POU "${pou}" lost its ${list.join(', ')}, without a warning`)
  }
  // a POU whose body arrived empty, where ours was not
  for (const pou of data.pous) {
    if (pou.body?.language === 'st' && String(pou.body.value ?? '').trim() === '' && !emptyInExport.has(String(pou.name).toUpperCase())) {
      problems.push(`POU "${pou.name}" was read with an empty body, without a warning`)
    }
  }
  return problems
}

function runDoor(door, ours, editor, c, exported, outDir) {
  let data
  const loadProblems = []
  let declared = []
  if (door === 'xml') {
    // our exporter refusing a case is the TC6 job's failure to report, not this one's
    if (exported.xmlError) return { stage: 'skipped', detail: `our PLCopen exporter refused it: ${exported.xmlError}` }
    try {
      const parsed = editor.parsePlcopenXml(exported.xml)
      data = editor.buildProjectResponseFromPlcopenParse(parsed, '/oracle', c.name).projectData
      loadProblems.push(...parsed.warnings)
    } catch (e) {
      return { stage: 'load', detail: `the PLCopen reader threw: ${firstLine(e)}` }
    }
    loadProblems.push(...xmlSilences(ours, exported.xml, data))
  } else {
    const folder = projectFolder(ours, editor, exported.text)
    for (const f of [...folder.pouFiles, ...folder.dataTypeFiles]) {
      mkdirSync(dirname(join(outDir, 'project', f.relativePath)), { recursive: true })
      writeFileSync(join(outDir, 'project', f.relativePath), f.content, 'utf8')
    }
    writeFileSync(join(outDir, 'project', 'project.json'), folder.projectJson, 'utf8')
    try {
      const parsed = editor.parseProjectFiles('/oracle', folder.projectJson, '', '', folder.pouFiles, [], [], '', folder.dataTypeFiles)
      loadProblems.push(...folder.loadErrors, ...(parsed.warnings ?? []), ...(parsed.fatalErrors ?? []))
      data = parsed.projectData
    } catch (e) {
      return { stage: 'load', detail: `the project loader threw: ${firstLine(e)}` }
    }
    declared = folder.pouFiles
  }
  // The silent case: a POU whose text declares variables and whose loaded form has none, with no
  // warning. It is caught downstream as well, but this says WHERE it happened.
  for (const pou of data.pous) {
    const file = declared.find((f) => f.relativePath.endsWith(`/${pou.name}.st`))
    if (file && /^\s*VAR/im.test(file.content) && (pou.interface?.variables ?? []).length === 0 && !pou.variablesText) {
      loadProblems.push(`POU "${pou.name}" declares variables and was loaded with none, without a warning`)
    }
  }
  if (loadProblems.length > 0) return { stage: 'load', detail: loadProblems.join('\n') }

  let result
  try {
    result = compileChain(editor, data)
  } catch (e) {
    return { stage: 'transpile', detail: `threw: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (result.stage) return result
  writeFileSync(join(outDir, `${door}.program.st`), result.programSt, 'utf8')
  if (!result.built) {
    return exported.baselineBuilds
      ? { stage: 'compile', detail: `STruC++ builds our export but not the editor's regeneration of it: ${result.compileErrors.join('; ')}` }
      : { stage: 'compiler-gap', detail: result.compileErrors.join('; ') }
  }

  let imported
  try {
    imported = ours.importIecText(result.programSt)
  } catch (e) {
    return { stage: 'meaning', detail: `this engine's importer refused the regenerated program: ${e instanceof Error ? e.message : String(e)}` }
  }
  try {
    const wrong = replay(ours, imported.source, c)
    if (wrong.length > 0) return { stage: 'meaning', detail: [...wrong, ...imported.notes.map((n) => `import note: ${n}`)].join('\n') }
  } catch (e) {
    return { stage: 'meaning', detail: `the regenerated program does not run here: ${e instanceof Error ? e.message : String(e)}${imported.notes.length ? `\nimport notes: ${imported.notes.join('; ')}` : ''}` }
  }
  return { stage: 'ok' }
}

// ---- main ----

async function main() {
  console.log(`OpenPLC editor oracle - ${EDITOR.repo}@${EDITOR.sha.slice(0, 8)}`)
  mkdirSync(WORK, { recursive: true })
  const fetched = await ensureEditorSources()
  const { strucppVersion, specs } = await ensureDeps()
  console.log(`  editor: ${fetched} source files (+${Object.keys(STUBS).length} stubs)`)
  console.log(`  STruC++ ${strucppVersion}; ${specs.join(', ')}`)

  const [ours, editor] = [await loadOurs(), await loadEditor()]
  const cases = ours.CONFORMANCE_CASES.filter((c) => !c.rejects && !c.oracle?.skip && (!caseFilter || c.name.toLowerCase().includes(caseFilter)))
  console.log(`  corpus: ${ours.CONFORMANCE_CASES.length} cases - ${cases.length} replayed through ${DOORS.join(' + ')}\n`)

  const casesDir = join(WORK, 'cases')
  rmSync(casesDir, { recursive: true, force: true })
  const tally = Object.fromEntries(DOORS.map((d) => [d, {}]))
  const failures = []
  const gaps = []
  const knownSeen = new Map()

  for (const c of cases) {
    const outDir = join(casesDir, slug(c.name))
    mkdirSync(outDir, { recursive: true })
    const text = ours.renderIecText(c.src, { banner: false })
    writeFileSync(join(outDir, 'export.st'), text, 'utf8')
    const exported = { text }
    try {
      exported.xml = ours.toPlcopenXml(c.src, { projectName: c.name, timestamp: '2026-01-01T00:00:00' })
      writeFileSync(join(outDir, 'export.xml'), exported.xml, 'utf8')
    } catch (e) {
      exported.xmlError = e instanceof Error ? e.message : String(e)
    }
    exported.baselineBuilds = baselineBuild(editor, text)

    // The harness proves itself on every case before it judges the editor: our export, read back by
    // our importer, has to replay to the goldens. If it does not, a 'meaning' verdict below would be
    // about this script, not about OpenPLC.
    const self = replay(ours, ours.importIecText(text).source, c)
    if (self.length > 0) throw new HarnessError(`${c.name}: our own export does not replay to the goldens:\n  ${self.join('\n  ')}`)

    const marks = []
    for (const door of DOORS) {
      let v
      try {
        v = runDoor(door, ours, editor, c, exported, outDir)
      } catch (e) {
        if (e instanceof HarnessError) throw e
        v = { stage: 'threw', detail: e instanceof Error ? (e.stack ?? e.message) : String(e) }
      }
      writeFileSync(join(outDir, `${door}.verdict.txt`), `${v.stage}\n${v.detail ?? ''}\n`, 'utf8')
      const settled = v.stage === 'ok' || v.stage === 'skipped' || v.stage === 'compiler-gap'
      // known only if every problem line is explained, so nothing new can hide behind a known cause
      const lines = String(v.detail ?? '').split('\n').filter(Boolean)
      const covering = lines.map((line) => KNOWN.find((k) => k.door === door && k.stage === v.stage && k.match.test(line)))
      const known = !settled && lines.length > 0 && covering.every(Boolean) ? [...new Set(covering)] : null
      for (const k of known ?? []) knownSeen.set(k.id, (knownSeen.get(k.id) ?? 0) + 1)
      const label = settled ? (v.stage === 'compiler-gap' ? 'gap' : v.stage) : known ? 'known' : v.stage.toUpperCase()
      tally[door][label] = (tally[door][label] ?? 0) + 1
      marks.push(`${door}:${label}`)
      if (v.stage === 'compiler-gap') gaps.push({ name: c.name, door, detail: v.detail })
      else if (!settled && !known) {
        const unexplained = lines.filter((_, i) => !covering[i])
        failures.push({ name: c.name, door, stage: v.stage, detail: (unexplained.length > 0 ? unexplained : lines).join('\n') })
      }
    }
    console.log(`  ${marks.map((m) => m.padEnd(18)).join('')}${c.name}`)
  }

  console.log('')
  for (const door of DOORS) {
    console.log(`  ${door.padEnd(6)} ${Object.entries(tally[door]).map(([k, n]) => `${n} ${k}`).join(', ')}`)
  }
  if (gaps.length > 0) {
    console.log(`\n  ${gaps.length} compiler gap(s) - STruC++ ${strucppVersion} refuses our export itself, so the editor is not the cause:`)
    for (const g of gaps) console.log(`    [${g.door}] ${g.name}\n        ${String(g.detail).slice(0, 300)}`)
  }
  for (const k of KNOWN.filter((x) => knownSeen.has(x.id))) {
    console.log(`\n  known: ${k.id} (${k.door}, ${k.stage}) - ${knownSeen.get(k.id)} case(s)\n    ${k.why}`)
  }
  const unseen = KNOWN.filter((k) => !knownSeen.has(k.id) && (!doorFilter || k.door === doorFilter))
  if (unseen.length > 0 && !caseFilter) {
    console.log('\n  known entries no longer observed - the editor or the export changed, retire these:')
    for (const k of unseen) console.log(`    ${k.id}`)
  }
  console.log(`\n  artifacts in ${casesDir}`)

  if (failures.length > 0) {
    console.log(`\n${failures.length} failure(s):`)
    for (const f of failures) console.log(`  - [${f.door}] ${f.stage}: ${f.name}\n      ${String(f.detail).split('\n').join('\n      ')}`)
    return 1
  }
  const knownCount = DOORS.reduce((n, d) => n + (tally[d].known ?? 0), 0)
  console.log(
    knownCount > 0
      ? `\nno unexplained disagreements; ${knownCount} verdict(s) stop at a known cause, listed above.`
      : '\nOpenPLC\'s editor reads every exported program and builds one that behaves the same.',
  )
  return 0
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof HarnessError ? `\nharness: ${e.message}` : e)
    process.exit(2)
  },
)
