import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import noUnhandledThen from './eslint-rules/no-unhandled-then.js'

// The GPL boundary. OpenPLC's editor and STruC++ (scripts/lib/openplc-editor.mjs) are GPL-3.0; this tree
// is MIT. They are used only as a dev-time oracle: fetched at a pinned SHA into a gitignored work dir, run
// from scripts/, never shipped. That keeps the licences apart (THIRD_PARTY_NOTICES.md). Importing them from
// the product would make the shipped app a combined work and put this whole codebase under GPL. Nothing in
// the offending file would look wrong, so lint enforces the ban.
const gplOracleBan = {
  group: ['**/scripts/**', '**/.oracle-openplc/**', 'strucpp', 'strucpp/*'],
  message:
    "GPL boundary: the OpenPLC editor and STruC++ are a dev-time oracle run from scripts/, never part of the shipped app (this tree is MIT - see THIRD_PARTY_NOTICES.md)",
}

const ban = (patterns, message) => ({
  'no-restricted-imports': ['error', { patterns: [{ group: patterns, message }, gplOracleBan] }],
})

// render layer bans, shared by the layer block and the examplePart block below (flat-config rule
// entries replace per rule key, so a later no-restricted-imports must restate these to keep them)
const renderBans = ['react', 'react-dom', 'react-dom/*', 'jolt-physics', 'jolt-physics/*', '**/sim/**', '**/editor/**']
const renderMessage = 'render may only depend on core and three'
// Part hot-reload invariants: examples/parts/** data enters the app
// through exactly two modules: editor/parts/bundledPackageData (whose only importer is the
// hot-accepting bundledExamples.ts) and render/parts/examplePart (a parity-test fixture). Any other
// importer becomes an un-accepting HMR boundary, which silently turns every part edit into a full page
// reload (demoScenes did this once).
const bundledDataBan = {
  regex: '(^|/)bundledPackageData$',
  message:
    'import via bundledExamples (the HMR-accepting boundary), never bundledPackageData directly — a direct import silently breaks part hot-reload (see bundledExamples.ts)',
}
const examplePartBan = {
  regex: '(^|/)examplePart$',
  message:
    'examplePart is the test-only committed-part fixture loader — importing it from app code puts examples/ edits in the live render graph and breaks part hot-reload (full page reloads)',
}

// The ST/PLC program is one document, owned by the editor store (`state.stProgram` + `stScanMs`).
// stProgram.ts holds only its localStorage half (the solo persistence seam). Reading that half from
// anywhere else brings back the bug this boundary prevents: when the attach path, the scene exporter, the
// room seeder and the project autosave each read a different copy of "the current program", a room could be
// seeded with a layout and no logic, and a scene exported from a room shipped someone's pre-room buffer.
// Read the store; write through it.
// The concrete engine classes have one composition site each. RenderView and SimWorld keep their area state in
// owned objects with narrow dependencies (view*.ts, sim/*.ts), and some members stay public only so those areas
// and the test hooks can reach them. Editor code talks to the view through IRenderView, which App.tsx builds, and
// to the sim through the worker; importing the class anywhere else would reach past that surface.
const renderViewBan = {
  group: ['**/render/viewport/view'],
  message: 'RenderView is built only in App.tsx; elsewhere use the IRenderView interface it is handed as (render/api.ts)',
}
const simWorldBan = {
  group: ['**/sim/world'],
  message: 'SimWorld runs in the sim worker; editor code reaches it through the worker (or, for project tests, projectTestRunner.ts)',
}

const stProgramSeamBan = {
  group: ['**/stProgram'],
  importNames: ['readStProgram', 'saveStProgram', 'readStScanMs', 'saveStScanMs'],
  message:
    "the ST program lives in store state: read store.getState().stProgram / .stScanMs, and write via store.loadStProgram / setStProgram / setStScanMs. stProgram.ts's localStorage half is the store's own persistence seam (see EditorState.stProgram).",
}

const rotateXZRedefinition = {
  selector: ":matches(FunctionDeclaration, VariableDeclarator)[id.name=/^(rotateXZ|rotXZ|yawAboutPivot)$/]",
  message: 'Import rotateXZ / yawAboutPivot from core/transforms — do not redefine the planar rotation convention.',
}

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { ignores: ['dist/**', '.types/**', 'node_modules/**', '**/*.d.ts'] },
  {
    // A part script kept as a test fixture (src/sim/fixtures/<part>/behavior.js) runs in the part sandbox, which hands
    // it `definePart` as its one global (core/parts/partScript.ts). Linted as a script, with that global declared.
    files: ['src/**/fixtures/**/behavior.js'],
    languageOptions: { sourceType: 'script', globals: { definePart: 'readonly' } },
  },
  {
    // A discarded `.then(...)` / `void p.then(...)` with no rejection handler loses the error and blocks whatever
    // waited on the chain (eslint-rules/no-unhandled-then.js).
    files: ['src/**/*.{ts,tsx}'],
    plugins: { oip: { rules: { 'no-unhandled-then': noUnhandledThen } } },
    rules: { 'oip/no-unhandled-then': 'error' },
  },
  {
    // The two classic hook rules only. The plugin's React Compiler rules are left off.
    files: ['src/editor/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'warn' },
  },
  {
    // Honor the `_`-prefix convention for intentionally-unused bindings (stub callbacks,
    // ignored event args, swallowed catch vars) so they don't read as dead code.
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // A source file past 1,500 lines is hard to find code in, for a person or an agent reading it in chunks, and
    // parallel sessions editing different areas of it collide. Split it by area (checker.ts and partPackage.ts are
    // the pattern) rather than raising the limit. A warning, so it never blocks a change.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    rules: { 'max-lines': ['warn', { max: 1500 }] },
  },
  // Files already over the limit. Each may not grow past its own ceiling: its size when the limit came in, plus
  // headroom. Shrink a ceiling when a split shrinks the file, and delete the entry once it is under 1,500.
  ...Object.entries({
    'src/editor/store/store.ts': 2300,
    'src/render/viewport/view.ts': 2500,
    'src/editor/components/plc/LadderView.tsx': 1800,
    'src/editor/controller.ts': 2000,
    'src/core/parts/partApi.ts': 1705,
    'src/editor/App.tsx': 1700,
    'src/sim/world.ts': 1700,
  }).map(([file, max]) => ({ files: [file], rules: { 'max-lines': ['warn', { max }] } })),
  {
    // Data, not logic: conformance cases and demo scenes grow by adding entries, and nobody reads them end to end.
    files: ['src/plc/conformanceCases.ts', 'src/editor/demo/demoScenes.ts'],
    rules: { 'max-lines': 'off' },
  },
  {
    // The world-space planar rotation convention lives once, in core/transforms.ts
    // (rotateXZ / yawAboutPivot). Private copies would let the sign conventions silently diverge
    // (partGeometry, prefabInstance and snapFeatures each once held one, as `rotateXZ` or `rotXZ`).
    // Re-declaring the helper under any of those names, including the `rotXZ` alias, is a lint error:
    // import the canonical one instead. (Scoped out: the seam itself.)
    ignores: ['src/core/transforms.ts'],
    rules: {
      'no-restricted-syntax': ['error', rotateXZRedefinition],
    },
  },
  {
    // The hot-reload invariants for everything outside the layer-banned dirs (editor + unlayered files).
    // core/sim/render/plc already ban bundledPackageData through their '**/editor/**' bans; render's
    // examplePart enforcement is its own block below.
    files: ['src/**'],
    ignores: ['src/editor/parts/bundledExamples.ts', 'src/editor/parts/bundledPackageData.test.ts', 'src/editor/agentGuideConventions.test.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [bundledDataBan, examplePartBan, gplOracleBan] }],
    },
  },
  {
    // The program-document boundary (see stProgramSeamBan). Exempt: the store (which owns the
    // document and is the persistence seam), projectFile's one-time legacy-key migration, and the
    // module itself. Restates the hot-reload bans, because a later no-restricted-imports replaces the
    // earlier entry for the files it matches.
    files: ['src/**'],
    ignores: [
      'src/editor/store/store.ts',
      'src/editor/project/projectFile.ts',
      'src/editor/program/stProgram.ts',
      'src/editor/program/stProgram.test.ts',
      'src/editor/parts/bundledExamples.ts',
      'src/editor/parts/bundledPackageData.test.ts',
      // vitest-only, like the line above: a test file is never in the dev module graph, so it cannot
      // become the un-accepting HMR boundary this ban exists to prevent.
      'src/editor/agentGuideConventions.test.ts',
    ],
    rules: {
      'no-restricted-imports': ['error', { patterns: [bundledDataBan, examplePartBan, stProgramSeamBan, gplOracleBan] }],
    },
  },
  {
    // The engine-class boundary (see renderViewBan / simWorldBan), for the editor. Restates the block above, and
    // keeps its exemptions out of this one so they keep exactly the rules they had.
    files: ['src/editor/**'],
    ignores: [
      'src/editor/store/store.ts',
      'src/editor/project/projectFile.ts',
      'src/editor/program/stProgram.ts',
      'src/editor/program/stProgram.test.ts',
      'src/editor/parts/bundledExamples.ts',
      'src/editor/parts/bundledPackageData.test.ts',
      'src/editor/agentGuideConventions.test.ts',
      'src/editor/App.tsx',
      'src/editor/project/projectTestRunner.ts',
      'src/editor/project/projectTestsRun.ts',
    ],
    rules: {
      'no-restricted-imports': ['error', { patterns: [bundledDataBan, examplePartBan, stProgramSeamBan, gplOracleBan, renderViewBan, simWorldBan] }],
    },
  },
  {
    // App.tsx is RenderView's composition site.
    files: ['src/editor/App.tsx'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [bundledDataBan, examplePartBan, stProgramSeamBan, gplOracleBan, simWorldBan] }],
    },
  },
  {
    // The project-test runner drives a SimWorld in-process, headless, by design.
    files: ['src/editor/project/projectTestRunner.ts', 'src/editor/project/projectTestsRun.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [bundledDataBan, examplePartBan, stProgramSeamBan, gplOracleBan, renderViewBan] }],
    },
  },
  {
    files: ['src/core/**'],
    rules: ban(
      ['three', 'three/*', 'react', 'react-dom', 'react-dom/*', 'jolt-physics', 'jolt-physics/*', '**/sim/**', '**/render/**', '**/editor/**'],
      'core is headless: no DOM, Three, React, Jolt, or downstream package imports',
    ),
  },
  {
    files: ['src/sim/**'],
    rules: ban(
      ['three', 'three/*', 'react', 'react-dom', 'react-dom/*', '**/render/**', '**/editor/**'],
      'sim may only depend on core, jolt-physics, and plc (the in-worker scan host)',
    ),
  },
  {
    files: ['src/render/**'],
    rules: ban(renderBans, renderMessage),
  },
  {
    // Non-test render files also may not import the examplePart fixture (see examplePartBan above).
    // Restates the render layer bans: this block overrides the previous one for the files it matches.
    files: ['src/render/**'],
    ignores: ['src/render/**/*.test.ts', 'src/render/parts/examplePart.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: renderBans, message: renderMessage }, examplePartBan, gplOracleBan] }],
    },
  },
  {
    // plc is the portable Structured-Text engine. Like core, it must stay headless so it
    // can run inside a real PLC runtime / native host, so it depends on core only.
    files: ['src/plc/**'],
    rules: ban(
      [
        'three', 'three/*', 'react', 'react-dom', 'react-dom/*', 'jolt-physics', 'jolt-physics/*',
        '**/sim/**', '**/render/**', '**/editor/**', '**/collab/**',
      ],
      'plc is a portable ST engine: depend only on core (no DOM, Three, React, Jolt, or other layers)',
    ),
  },
  {
    // Non-test plc files also may not import a GPL oracle (gplOracleBan). Restates the plc layer bans (a later
    // no-restricted-imports replaces the earlier one for the files it matches).
    files: ['src/plc/**'],
    ignores: ['src/plc/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['three', 'three/*', 'react', 'react-dom', 'react-dom/*', 'jolt-physics', 'jolt-physics/*', '**/sim/**', '**/render/**', '**/editor/**', '**/collab/**'],
              message: 'plc is a portable ST engine: depend only on core (no DOM, Three, React, Jolt, or other layers)',
            },
            gplOracleBan,
          ],
        },
      ],
    },
  },
  {
    // ...and the same for the sim. Restates the sim layer bans.
    files: ['src/sim/**'],
    ignores: ['src/sim/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['three', 'three/*', 'react', 'react-dom', 'react-dom/*', '**/render/**', '**/editor/**'], message: 'sim may only depend on core, jolt-physics, and plc (the in-worker scan host)' },
            gplOracleBan,
          ],
        },
      ],
    },
  },
  {
    // A cargo body's pose is set only through CargoRegistry.placeBody: a write there can make the frame's pose
    // snapshot stale before the next step reads it, and a raw write elsewhere would leave that step reading old
    // poses. The ban can't tell a cargo body from another; today only cargo bodies have their pose set (rig and pilot
    // bodies move by MoveKinematic). Restates the rotateXZ ban, because a later no-restricted-syntax replaces it.
    files: ['src/sim/**'],
    ignores: ['src/sim/**/*.test.ts', 'src/sim/cargoRegistry.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        rotateXZRedefinition,
        {
          selector: "CallExpression[callee.property.name=/^Set(Position|Rotation|PositionAndRotation)$/]",
          message: "Set a cargo body's pose through CargoRegistry.placeBody, so the next step's pose snapshot sees the move.",
        },
      ],
    },
  },
  {
    // collab = Yjs live editing. It drives the editor store, so it sits above editor
    // (collab → editor → render/sim → core) and may use its yjs/codemirror stack. It
    // is still banned from three/Jolt and the sim/render/interop/plc internals.
    files: ['src/collab/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['three', 'three/*', 'jolt-physics', 'jolt-physics/*', '**/sim/**', '**/render/**', '**/plc/**'],
              message: 'collab may only depend on core, editor, and its yjs/codemirror stack',
            },
            gplOracleBan,
            // collab may import the editor, so it needs the program-document boundary restated: the
            // room's Y.Text is a replica of store state, not a second store of record (see session.ts)
            stProgramSeamBan,
          ],
        },
      ],
    },
  },
)
