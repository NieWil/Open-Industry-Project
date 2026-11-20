import { describe, expect, it } from 'vitest'
import {
  advanceBaseline,
  agreedBaseline,
  diskAfter,
  hashText,
  planFolderSync,
  layoutBaseline,
  resolveConflicts,
  sceneUntouched,
  writeOpsFor,
} from './folderSync'
import type { FolderBaseline } from './folderSync'
import { hashBytes, hashContents } from '../hash'
import { AGENT_GUIDE } from './projectFolder'
import type { ProjectFolderFile } from './projectFolder'

const files = (o: Record<string, string>): ProjectFolderFile[] => Object.entries(o).map(([path, contents]) => ({ path, contents }))

/** Both sides agreed on `o` - the state right after a folder is opened or saved. */
const agreedOn = (o: Record<string, string>): FolderBaseline => agreedBaseline(files(o), files(o))

const START = { 'project.json': '{"a":1}', 'scenes/s1.scene.json': 'scene one', 'scenes/s1.st': 'PROGRAM A' }

describe('the content hash', () => {
  // The Electron shell carries a copy (apps/desktop/projectFolderIo.cjs) and checks writes against it,
  // so these vectors are pinned in both test suites. Changing one without the other breaks every write.
  it('matches the vectors the shell is pinned to', () => {
    expect(hashText('')).toBe('0:wvjl67o803')
    expect(hashText('a')).toBe('1:262p94epp1d')
    expect(hashText('PROGRAM Main\nEND_PROGRAM\n')).toBe('25:qs8r3nb1as')
    expect(hashText('{\n  "name": "Linie – Nord ✓"\n}\n')).toBe('31:1giy78exjsy')
  })

  it('hashes an asset file by its bytes, to vectors of its own that never equal a text hash', () => {
    expect(hashBytes(new Uint8Array([]))).toBe('b0:wvjl67o803')
    expect(hashBytes(new Uint8Array([97]))).toBe('b1:262p94epp1d')
    expect(hashBytes(new Uint8Array([0, 255, 128, 1]))).toBe('b4:19uptk7pfoz')
    expect(hashContents(new Uint8Array([97]))).not.toBe(hashContents('a'))
  })
})

describe('a binary file (a part asset, core/parts/partAssets.ts)', () => {
  const ASSET = `parts/p/assets/${'a'.repeat(64)}.glb`
  const withAsset = (bytes: Uint8Array): ProjectFolderFile[] => [...files(START), { path: ASSET, contents: bytes }]

  it('is compared by its bytes: equal bytes are agreed, a changed byte is an edit carried the right way', () => {
    const before = withAsset(new Uint8Array([1, 2, 3]))
    const base = agreedBaseline(before, before)
    expect(planFolderSync(base, withAsset(new Uint8Array([1, 2, 3])), before)).toEqual({ write: [], remove: [], take: [], conflicts: [] })
    const mine = withAsset(new Uint8Array([1, 2, 4]))
    const plan = planFolderSync(base, mine, before)
    expect(plan.write).toEqual([{ path: ASSET, contents: new Uint8Array([1, 2, 4]) }])
    expect(writeOpsFor(plan, base)).toEqual([{ path: ASSET, contents: new Uint8Array([1, 2, 4]), expect: hashBytes(new Uint8Array([1, 2, 3])) }])
    expect(planFolderSync(base, before, mine).take).toEqual([ASSET])
  })

  it('that the app stops writing (a part replaced its model) is removed', () => {
    const before = withAsset(new Uint8Array([1]))
    expect(planFolderSync(agreedBaseline(before, before), files(START), before).remove).toEqual([ASSET])
  })
})

describe('planning a round', () => {
  it('does nothing when neither side moved', () => {
    const plan = planFolderSync(agreedOn(START), files(START), files(START))
    expect(plan).toEqual({ write: [], remove: [], take: [], conflicts: [] })
  })

  it('writes an edit made in the app', () => {
    const mine = { ...START, 'scenes/s1.st': 'PROGRAM B' }
    const plan = planFolderSync(agreedOn(START), files(mine), files(START))
    expect(plan.write).toEqual([{ path: 'scenes/s1.st', contents: 'PROGRAM B' }])
    expect(plan.take).toEqual([])
  })

  it('loads an edit made on disk', () => {
    const theirs = { ...START, 'scenes/s1.st': 'PROGRAM C' }
    const plan = planFolderSync(agreedOn(START), files(START), files(theirs))
    expect(plan.take).toEqual(['scenes/s1.st'])
    expect(plan.write).toEqual([])
  })

  it('carries both directions at once when they touch different files', () => {
    const mine = { ...START, 'scenes/s1.st': 'PROGRAM B' }
    const theirs = { ...START, 'scenes/s1.scene.json': 'scene edited by an agent' }
    const plan = planFolderSync(agreedOn(START), files(mine), files(theirs))
    expect(plan.write.map((f) => f.path)).toEqual(['scenes/s1.st'])
    expect(plan.take).toEqual(['scenes/s1.scene.json'])
    expect(plan.conflicts).toEqual([])
  })

  it('calls the same file changed differently on both sides a conflict', () => {
    const plan = planFolderSync(
      agreedOn(START),
      files({ ...START, 'scenes/s1.st': 'PROGRAM B' }),
      files({ ...START, 'scenes/s1.st': 'PROGRAM C' }),
    )
    expect(plan.conflicts).toEqual(['scenes/s1.st'])
  })

  it('does not call it a conflict when both sides made the same change', () => {
    const same = { ...START, 'scenes/s1.st': 'PROGRAM B' }
    const plan = planFolderSync(agreedOn(START), files(same), files(same))
    expect(plan).toEqual({ write: [], remove: [], take: [], conflicts: [] })
  })

  // The reason there are two baselines. An agent's JSON is not the app's JSON, and the store fills in
  // defaults a folder may omit - so the app's rendering of an untouched file differs from the file.
  it('leaves a file alone when the two sides only render it differently', () => {
    const disk = { ...START, 'project.json': '{ "a": 1 }' } // the agent's formatting
    const baseline = agreedBaseline(files(START), files(disk))
    const plan = planFolderSync(baseline, files(START), files(disk))
    expect(plan).toEqual({ write: [], remove: [], take: [], conflicts: [] })
  })

  it('writes that file once the app really edits it', () => {
    const disk = { ...START, 'project.json': '{ "a": 1 }' }
    const baseline = agreedBaseline(files(START), files(disk))
    const plan = planFolderSync(baseline, files({ ...START, 'project.json': '{"a":2}' }), files(disk))
    expect(plan.write).toEqual([{ path: 'project.json', contents: '{"a":2}' }])
  })

  it('removes a file the app stopped producing, when the disk still holds it unchanged', () => {
    const extra = { ...START, 'scenes/s2.scene.json': 'scene two' }
    const plan = planFolderSync(agreedOn(extra), files(START), files(extra))
    expect(plan.remove).toEqual(['scenes/s2.scene.json'])
  })

  it('will not remove a file someone edited after the app stopped producing it', () => {
    const extra = { ...START, 'scenes/s2.scene.json': 'scene two' }
    const plan = planFolderSync(agreedOn(extra), files(START), files({ ...extra, 'scenes/s2.scene.json': 'edited' }))
    expect(plan.remove).toEqual([])
    expect(plan.conflicts).toEqual(['scenes/s2.scene.json'])
  })

  it('loads a file that appeared on disk, and a deletion made there', () => {
    const plan = planFolderSync(
      agreedOn(START),
      files(START),
      files({ 'project.json': START['project.json'], 'scenes/s1.scene.json': START['scenes/s1.scene.json'], 'tests/new.test.json': '{}' }),
    )
    expect(plan.take).toEqual(['scenes/s1.st', 'tests/new.test.json'])
  })

  it('never carries the generated agent guide either way', () => {
    const plan = planFolderSync(agreedOn(START), files({ ...START, [AGENT_GUIDE]: 'mine' }), files({ ...START, [AGENT_GUIDE]: 'theirs' }))
    expect(plan).toEqual({ write: [], remove: [], take: [], conflicts: [] })
  })
})

describe("a part's build sources (a part.js, a parts/_shared/ module)", () => {
  // The app writes only a part folder's manifest.json, behavior.js and asset files. An author's part.js, and the shared
  // modules it imports, are built into those by `npm run build-parts`; the app never produces or reads them.
  const PART = { ...START, 'parts/belt/manifest.json': '{"id":"acme.belt"}', 'parts/belt/behavior.js': 'definePart({})' }
  const SOURCES = { 'parts/belt/part.js': 'definePart({ rig() {} })', 'parts/_shared/legs.js': 'export function legs() {}' }

  it('are never written, taken or removed', () => {
    const disk = { ...PART, ...SOURCES }
    const base = agreedBaseline(files(PART), files(disk))
    expect(Object.keys(base.disk).filter((p) => p in SOURCES)).toEqual([])
    // an edit to a source on disk is not a load (it would reload the project for nothing)
    const edited = { ...disk, 'parts/belt/part.js': 'definePart({ rig() { return 1 } })', 'parts/_shared/new.js': 'export const A = 1' }
    expect(planFolderSync(base, files(PART), files(edited))).toEqual({ write: [], remove: [], take: [], conflicts: [] })
    // the app editing the part writes its two files and nothing else
    const mine = { ...PART, 'parts/belt/behavior.js': 'definePart({ params: {} })' }
    expect(planFolderSync(base, files(mine), files(disk))).toEqual({
      write: [{ path: 'parts/belt/behavior.js', contents: 'definePart({ params: {} })' }],
      remove: [],
      take: [],
      conflicts: [],
    })
  })

  it('stay when the app removes the part from the project', () => {
    const disk = { ...PART, ...SOURCES }
    const plan = planFolderSync(agreedBaseline(files(PART), files(disk)), files(START), files(disk))
    expect(plan.remove).toEqual(['parts/belt/behavior.js', 'parts/belt/manifest.json'])
    expect(diskAfter(files(disk), plan).map((f) => f.path).filter((p) => p in SOURCES).sort()).toEqual(Object.keys(SOURCES).sort())
  })
})

describe('carrying out a plan', () => {
  it('guards each write with what the disk held when the two last agreed', () => {
    const baseline = agreedOn(START)
    const plan = planFolderSync(
      baseline,
      files({ 'project.json': '{"a":2}', 'scenes/s1.scene.json': 'scene one', 'scenes/new.st': 'X' }),
      files(START),
    )
    const ops = writeOpsFor(plan, baseline)
    expect(ops).toEqual([
      { path: 'project.json', contents: '{"a":2}', expect: hashText('{"a":1}') },
      { path: 'scenes/new.st', contents: 'X', expect: null },
      { path: 'scenes/s1.st', expect: hashText('PROGRAM A') },
    ])
  })

  it('predicts the folder once the writes land, skipping the ones the guard refused', () => {
    const plan = planFolderSync(agreedOn(START), files({ ...START, 'scenes/s1.st': 'PROGRAM B', 'project.json': '{"a":2}' }), files(START))
    const after = diskAfter(files(START), plan, ['project.json'])
    expect(Object.fromEntries(after.map((f) => [f.path, f.contents]))).toEqual({ ...START, 'scenes/s1.st': 'PROGRAM B' })
  })

  it('keeps the old baseline for a write the guard refused, so the next round sees both changes', () => {
    const baseline = agreedOn(START)
    const mine = { ...START, 'scenes/s1.st': 'PROGRAM B' }
    const next = advanceBaseline(baseline, files(mine), files(START), ['scenes/s1.st'])
    // the agent had written its own version in between
    const plan = planFolderSync(next, files(mine), files({ ...START, 'scenes/s1.st': 'PROGRAM C' }))
    expect(plan.conflicts).toEqual(['scenes/s1.st'])
  })
})

describe('settling a conflict', () => {
  const mine = { ...START, 'scenes/s1.st': 'PROGRAM B' }
  const theirs = { ...START, 'scenes/s1.st': 'PROGRAM C' }

  it('"load from disk" turns the conflict into a load', () => {
    const settled = resolveConflicts(agreedOn(START), ['scenes/s1.st'], 'disk', files(mine), files(theirs))
    const plan = planFolderSync(settled, files(mine), files(theirs))
    expect(plan.take).toEqual(['scenes/s1.st'])
    expect(plan.conflicts).toEqual([])
  })

  it('"keep mine" turns it into a write, guarded against the disk version the user just saw', () => {
    const settled = resolveConflicts(agreedOn(START), ['scenes/s1.st'], 'mine', files(mine), files(theirs))
    const plan = planFolderSync(settled, files(mine), files(theirs))
    expect(plan.write).toEqual([{ path: 'scenes/s1.st', contents: 'PROGRAM B' }])
    expect(writeOpsFor(plan, settled)[0]!.expect).toBe(hashText('PROGRAM C'))
  })
})

describe('whether a load disturbs the scene on screen', () => {
  const manifest = (over: Record<string, unknown> = {}, packages: string[] = []): string =>
    JSON.stringify({ name: 'P', scene: 'scene.json', stProgram: 'program.st', stScanMs: 10, packages, ...over })

  it('is untouched by a change to a file that is not the scene, its program or a part', () => {
    expect(sceneUntouched(['tests/t.test.json'], manifest(), manifest())).toBe(true)
    expect(sceneUntouched(['assemblies/a.assembly.json'], manifest(), manifest())).toBe(true)
  })

  it('is touched by a change to its scene or program file', () => {
    expect(sceneUntouched(['scene.json'], manifest(), manifest())).toBe(false)
    expect(sceneUntouched(['program.st'], manifest(), manifest())).toBe(false)
    expect(sceneUntouched(['plc/Latch.st'], manifest(), manifest())).toBe(false)
  })

  it('is touched when the program files are listed differently', () => {
    const listing = (program: string[]): string => manifest({ stProgram: undefined, program })
    expect(sceneUntouched(['project.json'], listing(['plc/A.st', 'plc/B.st']), listing(['plc/B.st', 'plc/A.st']))).toBe(false)
    expect(sceneUntouched(['project.json'], listing(['plc/A.st']), listing(['plc/A.st']))).toBe(true)
  })

  it('is touched by any part folder, because its parts resolve against the library', () => {
    expect(sceneUntouched(['parts/p/behavior.js'], manifest(), manifest())).toBe(false)
  })

  it('is untouched by a rename in the manifest, and touched by a new scan time', () => {
    expect(sceneUntouched(['project.json'], manifest(), manifest({ name: 'Renamed' }))).toBe(true)
    expect(sceneUntouched(['project.json'], manifest(), manifest({ stScanMs: 20 }))).toBe(false)
  })

  it('is touched by a new program dialect, which changes whether its program may run at all', () => {
    expect(sceneUntouched(['project.json'], manifest(), manifest({ stDialect: 'other' }))).toBe(false)
    expect(sceneUntouched(['project.json'], manifest({ stDialect: 'other' }), manifest({ stDialect: 'other', name: 'Renamed' }))).toBe(true)
  })

  it('is touched by a new step rate or controller table', () => {
    expect(sceneUntouched(['project.json'], manifest(), manifest({ simHz: 240 }))).toBe(false)
    expect(sceneUntouched(['project.json'], manifest(), manifest({ controller: { tasks: [], programs: [] } }))).toBe(false)
  })

  it('is touched when the library list changes, when the scene file moves, or when the manifest names no scene', () => {
    expect(sceneUntouched(['project.json'], manifest(), manifest({}, ['parts/p']))).toBe(false)
    expect(sceneUntouched(['project.json'], manifest(), manifest({ scene: 'other.json' }))).toBe(false)
    // an older manifest (a scene list, no `scene`) or an unreadable one: reload rather than guess
    expect(sceneUntouched(['tests/t.test.json'], manifest(), JSON.stringify({ scenes: [{ id: 'a', scene: 'scenes/a.scene.json' }] }))).toBe(false)
    expect(sceneUntouched(['project.json'], 'not json', manifest())).toBe(false)
    expect(sceneUntouched(['tests/t.test.json'], manifest(), undefined)).toBe(false)
  })
})

describe('rewriting the program layout (format 7)', () => {
  const manifest = (m: Record<string, unknown>): string => JSON.stringify({ name: 'P', scene: 'scene.json', ...m })
  const mine = files({
    'project.json': manifest({ program: ['plc/Latch.st', 'plc/program.st'] }),
    'scene.json': '{"parts":[]}',
    'plc/Latch.st': 'FUNCTION_BLOCK Latch\nEND_FUNCTION_BLOCK\n',
    'plc/program.st': 'Run := TRUE;\n',
  })

  it('is not needed when the folder names the files the app writes', () => {
    expect(layoutBaseline(agreedBaseline(mine, mine), mine, mine)).toBeNull()
  })

  it('writes the app files and manifest over a one-file program.st, removes it, and leaves the rest alone', () => {
    const theirs = files({
      'project.json': manifest({ version: 6, stProgram: 'program.st' }),
      // formatted by someone else: a rendering difference, which stays
      'scene.json': '{ "parts": [] }',
      'program.st': 'FUNCTION_BLOCK Latch\nEND_FUNCTION_BLOCK\n\nRun := TRUE;\n',
    })
    const baseline = layoutBaseline(agreedBaseline(mine, theirs), mine, theirs)!
    const plan = planFolderSync(baseline, mine, theirs)
    expect(plan.write.map((f) => f.path).sort()).toEqual(['plc/Latch.st', 'plc/program.st', 'project.json'])
    expect(plan.remove).toEqual(['program.st'])
    expect(plan.take).toEqual([])
    expect(plan.conflicts).toEqual([])
    // every write is guarded on what the folder held
    const ops = writeOpsFor(plan, baseline)
    expect(ops.find((o) => o.path === 'program.st')!.expect).toBe(hashText(theirs.find((f) => f.path === 'program.st')!.contents as string))
    expect(ops.find((o) => o.path === 'plc/Latch.st')!.expect).toBeNull()
  })

  it('splits POUs an agent wrote into one file of the current format', () => {
    const theirs = files({
      'project.json': manifest({ program: ['plc/program.st'] }),
      'scene.json': '{"parts":[]}',
      'plc/program.st': 'FUNCTION_BLOCK Latch\nEND_FUNCTION_BLOCK\n\nRun := TRUE;\n',
    })
    const plan = planFolderSync(layoutBaseline(agreedBaseline(mine, theirs), mine, theirs)!, mine, theirs)
    expect(plan.write.map((f) => f.path).sort()).toEqual(['plc/Latch.st', 'plc/program.st', 'project.json'])
    expect(plan.remove).toEqual([])
  })

  it('waits while the folder is changing those files, so its change is loaded first', () => {
    const before = files({ 'project.json': manifest({ program: ['plc/Latch.st', 'plc/program.st'] }), 'plc/Latch.st': 'x', 'plc/program.st': 'y' })
    const theirs = files({ 'project.json': manifest({ program: ['plc/program.st'] }), 'plc/program.st': 'x\n\ny' })
    expect(layoutBaseline(agreedBaseline(before, before), mine, theirs)).toBeNull()
  })
})

describe('rewriting the test layout', () => {
  const manifest = (tests: string[]): string => JSON.stringify({ name: 'P', scene: 'scene.json', program: ['plc/program.st'], tests })
  const spec = '{"name":"Sort by colour","duration":10,"checks":[]}'
  const mine = files({
    'project.json': manifest(['tests/Sort_by_colour.test.json']),
    'scene.json': '{"parts":[]}',
    'plc/program.st': 'Run := TRUE;\n',
    'tests/Sort_by_colour.test.json': spec,
  })

  it('relays a test file not named from its test: writes the app file and the manifest, removes the old one, leaves the program', () => {
    const theirs = files({
      'project.json': manifest(['tests/sort.test.json']),
      'scene.json': '{"parts":[]}',
      // formatted by someone else: a rendering difference, which stays
      'plc/program.st': 'Run := TRUE;',
      'tests/sort.test.json': '{ "name": "Sort by colour", "duration": 10, "checks": [] }',
    })
    const baseline = layoutBaseline(agreedBaseline(mine, theirs), mine, theirs)!
    const plan = planFolderSync(baseline, mine, theirs)
    expect(plan.write.map((f) => f.path).sort()).toEqual(['project.json', 'tests/Sort_by_colour.test.json'])
    expect(plan.remove).toEqual(['tests/sort.test.json'])
    expect(plan.take).toEqual([])
    expect(plan.conflicts).toEqual([])
  })

  it('finishes the relay after an app edit already wrote the new file, which is how the bug left a folder', () => {
    // the app wrote its file; the manifest still names the old one, which keeps the stale spec
    const theirs = files({
      'project.json': manifest(['tests/sort.test.json']),
      'scene.json': '{"parts":[]}',
      'plc/program.st': 'Run := TRUE;\n',
      'tests/sort.test.json': '{"name":"Sort by colour","duration":5,"checks":[]}',
      'tests/Sort_by_colour.test.json': spec,
    })
    const plan = planFolderSync(layoutBaseline(agreedBaseline(mine, theirs), mine, theirs)!, mine, theirs)
    expect(plan.write.map((f) => f.path)).toEqual(['project.json'])
    expect(plan.remove).toEqual(['tests/sort.test.json'])
  })

  it('is not needed when the folder names the test files the app writes', () => {
    expect(layoutBaseline(agreedBaseline(mine, mine), mine, mine)).toBeNull()
  })
})
