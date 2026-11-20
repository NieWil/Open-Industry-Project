// Scaffold discoverable extras into an existing project FOLDER (docs/project-tests.md). This is a
// deliberate GENERATIVE act - kept OUT of the export/spill path (core/project/projectFolder.ts), which must
// stay a faithful, byte-reproducible mirror of project data. Export mirrors; scaffolding generates.
//
//   npm run scaffold-project -- <project-folder>
//
// Writes a starter test (pre-filled with the project's real tag names, pulled from its ST
// program) + a tests/README so the test harness is discoverable instead of hidden. Idempotent: an
// existing file is never overwritten - you keep your edits, and re-running only fills gaps.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const target = process.argv[2]
if (!target) {
  console.error('usage: npm run scaffold-project -- <project-folder>')
  process.exit(2)
}
const root = resolve(target)
const manifestPath = join(root, 'project.json')
if (!existsSync(manifestPath)) {
  console.error(`✗ ${target} is not a project folder (no project.json)`)
  process.exit(2)
}

// --- read the project + its program's ST tags (a hint for the starter test) ----------------------

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch {
  console.error('✗ project.json is not valid JSON')
  process.exit(2)
}
// A project names its scene and program on the manifest itself (format 4 on). A folder from before then lists
// scenes: its active one is the one the app keeps when it converts it, so that program is the hint here.
const listed = Array.isArray(manifest.scenes) ? manifest.scenes : null
const active = listed ? (listed[typeof manifest.activeScene === 'number' ? manifest.activeScene : 0] ?? listed[0]) : manifest

/** Pull identifiers declared in a `VAR_INPUT` / `VAR_OUTPUT` block - a best-effort hint, not a parse. */
function extractVars(src, keyword) {
  const withoutComments = src.replace(/\(\*[\s\S]*?\*\)/g, '')
  const block = withoutComments.match(new RegExp(`${keyword}([\\s\\S]*?)END_VAR`, 'i'))
  if (!block) return []
  const names = []
  for (const decl of block[1].split(/[;\n]/)) {
    const m = decl.match(/^\s*([A-Za-z_]\w*)\s*:/)
    if (m) names.push(m[1])
  }
  return names
}

let inputTags = []
let outputTags = []
// the program's files: format 7 lists one per POU (`program`), formats 4-6 name one (`stProgram`)
const programRefs = !active ? [] : Array.isArray(active.program) ? active.program : typeof active.stProgram === 'string' ? [active.stProgram] : []
if (programRefs.length > 0) {
  try {
    const src = programRefs.map((ref) => readFileSync(join(root, ...String(ref).split('/')), 'utf8')).join('\n\n')
    inputTags = extractVars(src, 'VAR_INPUT')
    outputTags = extractVars(src, 'VAR_OUTPUT')
  } catch {
    /* no readable program - fall back to a placeholder test */
  }
}

// --- compose the starter test ---------------------------------------------------------------------

const duration = 5
const inputs = inputTags.length > 0 ? [{ at: 0.5, tag: inputTags[0], value: true }] : []
// Prefer asserting on an output coil the program drives; else confirm the injected stimulus took;
// else a clearly-labelled placeholder the author replaces.
const checks =
  outputTags.length > 0
    ? [{ eventually: true, within: duration, tag: outputTags[0], equals: true }]
    : inputTags.length > 0
      ? [{ eventually: true, tag: inputTags[0], equals: true }]
      : [{ at: 1, tag: 'REPLACE_WITH_A_REAL_TAG', equals: false }]

const starterTest = {
  name: 'EXAMPLE - replace the checks with your acceptance criteria',
  duration,
  ...(inputs.length > 0 ? { inputs } : {}),
  checks,
}

const README = `# Tests - regression tests for this project's control logic

Each \`*.test.json\` here runs the project's scene headless for a few simulated seconds and asserts on tag
values, so a change to the PLC program or the parts is caught automatically. Run them with:

    npm run test-project -- ${target}

## Spec fields

- **duration** - simulated seconds to run (a fraction of a second of wall-clock).
- **inputs** - stimuli you inject: \`{ "at": <t>, "tag": "<name>", "value": true|number }\`. A value
  sticks until you set it again (that's how a momentary button press works).
- **checks** - assertions. Each has ONE source, ONE temporal mode and ONE predicate:
  - source: \`"tag": "<name>"\` (what the program says) or \`"probe": {…}\` (what physically happened).
  - temporal: \`"at": t\` (sample once), \`"always": true\` (must hold), \`"eventually": true\` (must hold
    at some point); \`always\` / \`eventually\` take an optional window \`"from": t1, "until": t2\`.
  - predicate: \`"equals"\` / \`"notEquals"\` (bool/int), \`"min"\`/\`"max"\` (numbers), \`"near"\` + \`"tolerance"\`
    (reals), against a value or another tag / probe: \`"equals": { "tag": "SinkCount" }\`.

## Asserting on the world, not just the tags

A tag check only asks the program about itself - it can pass while boxes pile up or fall off. A
**probe** reads a number out of the simulation instead, and takes the same temporal modes and
predicates:

    // 10 boxes reached the discharge zone within 25 s
    { "eventually": true, "within": 25, "min": 10,
      "probe": { "count": { "zone": { "min": [2, 0, -1], "max": [6, 2, 1] } } } }

    // this pallet never left the line
    { "always": true, "equals": 1, "probe": { "count": { "part": "pallet-1" } } }

    // the AGV stopped within 20 cm of the dock
    { "at": 30, "near": 12.5, "tolerance": 0.2,
      "probe": { "pose": { "part": "agv-1", "axis": "x" } } }

    // no red box ever went down lane 2: cumulative, so it does not care WHEN boxes arrive
    { "always": true, "max": 0,
      "probe": { "passed": { "zone": { "min": [5.5, 0.8, -1.2], "max": [6.5, 1.5, -1] }, "color": "red" } } }

\`count\` filters (\`zone\`, \`part\`, \`kind\`, \`color\`: red/green/blue/yellow or "#rrggbb") are all optional and AND
together; \`passed\` takes the same filters and needs a \`zone\`; \`pose\` axes are \`x\`/\`y\`/\`z\`/\`yaw\`. Part ids
are the ids in \`scene.json\`. \`npm run test-project -- <folder> --cargo 5,10\` lists where every box is at those times.

## Tag names

Assert on the tags your program and parts use:
${inputTags.length || outputTags.length ? `- from this project's ST program: **${[...inputTags, ...outputTags].join('**, **') || '(none)'}**` : '- your ST program\'s `VAR_INPUT` / `VAR_OUTPUT` names'}
- any tag a part writes via \`ctx.writeTag('Name', …)\` in its \`behavior.js\`.

A check whose tag never appears fails with "never appeared", so a typo surfaces immediately.
`

// --- write (never clobber) ------------------------------------------------------------------------

const outputs = [
  { path: join(root, 'tests', 'example.test.json'), contents: JSON.stringify(starterTest, null, 2) + '\n' },
  { path: join(root, 'tests', 'README.md'), contents: README },
]

let wrote = 0
for (const { path, contents } of outputs) {
  if (existsSync(path)) {
    console.log(`  skip (exists) ${path.replace(root, '.')}`)
    continue
  }
  mkdirSync(join(root, 'tests'), { recursive: true })
  writeFileSync(path, contents)
  console.log(`  create        ${path.replace(root, '.')}`)
  wrote++
}

console.log(wrote > 0 ? `\n✓ scaffolded ${wrote} file(s) into ${target}` : `\n✓ nothing to add - ${target} already has these`)
// A GitHub Action that runs validate-project + test-project on every push is the natural next
// scaffold, but it needs the OIP CLI to be installable in a standalone repo (npm publish, still
// pending) - so it's deferred rather than scaffolded as a workflow that can't run yet.
