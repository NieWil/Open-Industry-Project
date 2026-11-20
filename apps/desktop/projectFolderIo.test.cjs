// Smoke test for projectFolderIo.cjs - the fs half of Open/Save Project Folder. Runs with plain Node
// (no Electron): `node apps/desktop/projectFolderIo.test.cjs`. The format (manifest refs, validation)
// is tested in src/core/project/projectFolder.test.ts; here only the disk round-trip and path safety.

const assert = require('node:assert/strict')
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { applyFolderWrites, folderSignature, hashBytes, hashText, hasProjectManifest, readProjectFolder, writeProjectFolder } = require('./projectFolderIo.cjs')

// 1. write → read round-trips the file set with POSIX-relative paths, creating subfolders.
{
  const tmp = mkdtempSync(join(tmpdir(), 'oip-project-'))
  try {
    const files = [
      { path: 'project.json', contents: '{"version":2,"name":"P","activeScene":0,"scenes":[]}\n' },
      { path: 'scenes/line-1.scene.json', contents: '{"version":3,"parts":[]}\n' },
      { path: 'scenes/line-1.st', contents: 'PROGRAM Main\nEND_PROGRAM\n' },
      { path: 'parts/acme.widget/manifest.json', contents: '{"id":"acme.widget"}\n' },
      { path: 'parts/acme.widget/behavior.js', contents: 'definePart({ step() {} })\n' },
    ]
    assert.equal(writeProjectFolder(tmp, files), '')
    const back = readProjectFolder(tmp)
    assert.deepEqual(
      back.map((f) => f.path).sort(),
      files.map((f) => f.path).sort(),
    )
    assert.equal(back.find((f) => f.path === 'scenes/line-1.st').contents, 'PROGRAM Main\nEND_PROGRAM\n')
    console.log(`✓ write → read round-trips ${files.length} files`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// 1b. the program's files (format 7): one per POU under plc/, ladder ones as .ld - both read, in a folder of their own
{
  const tmp = mkdtempSync(join(tmpdir(), 'oip-project-'))
  try {
    const files = [
      { path: 'project.json', contents: '{"version":7,"name":"P","scene":"scene.json","program":["plc/Truck.st","plc/Cell.ld"]}\n' },
      { path: 'scene.json', contents: '{"version":3,"parts":[]}\n' },
      { path: 'plc/Truck.st', contents: 'FUNCTION_BLOCK Truck\nEND_FUNCTION_BLOCK\n' },
      { path: 'plc/Cell.ld', contents: 'PROGRAM Cell\nLADDER\n  |A| (B);\nEND_LADDER\nEND_PROGRAM\n' },
    ]
    assert.equal(writeProjectFolder(tmp, files), '')
    assert.deepEqual(readProjectFolder(tmp).map((f) => f.path).sort(), files.map((f) => f.path).sort())
    console.log('✓ the program files under plc/, .st and .ld, are read')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// 2. reading skips binaries/unknown extensions and tolerates a folder with no manifest (the codec,
//    not the walker, reports "not a project folder").
{
  const tmp = mkdtempSync(join(tmpdir(), 'oip-project-'))
  try {
    mkdirSync(join(tmp, 'scenes'))
    writeFileSync(join(tmp, 'scenes', 'a.scene.json'), '{}')
    writeFileSync(join(tmp, 'scenes', 'shot.png'), 'not-really-a-png')
    writeFileSync(join(tmp, 'README.md'), '# notes') // root non-manifest files aren't walked at all
    const back = readProjectFolder(tmp)
    assert.deepEqual(back.map((f) => f.path), ['scenes/a.scene.json'])
    console.log('✓ walk filters extensions and survives a manifest-less folder')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// 3. path safety: a malformed/malicious payload can't write outside the chosen root.
{
  const tmp = mkdtempSync(join(tmpdir(), 'oip-project-'))
  try {
    for (const path of ['../evil.txt', '/abs.txt', 'C:/evil.txt', 'a\\b.txt', '']) {
      const err = writeProjectFolder(tmp, [{ path, contents: 'x' }])
      assert.notEqual(err, '', `expected rejection for ${JSON.stringify(path)}`)
    }
    assert.ok(!existsSync(join(tmp, '..', 'evil.txt')))
    assert.equal(writeProjectFolder(tmp, []), 'nothing to write')
    console.log('✓ escaping paths rejected')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// 4. saving over an existing folder overwrites what it writes and leaves other files alone.
{
  const tmp = mkdtempSync(join(tmpdir(), 'oip-project-'))
  try {
    writeProjectFolder(tmp, [
      { path: 'project.json', contents: 'old' },
      { path: 'scenes/stale.scene.json', contents: 'stale' },
    ])
    writeProjectFolder(tmp, [{ path: 'project.json', contents: 'new' }])
    assert.equal(readFileSync(join(tmp, 'project.json'), 'utf8'), 'new')
    assert.equal(readFileSync(join(tmp, 'scenes', 'stale.scene.json'), 'utf8'), 'stale')
    console.log('✓ re-save overwrites its files, preserves the rest')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// 5. the content hash is the same function as src/core/project/folderSync.ts hashText, pinned to the same
//    vectors there. If these ever disagree, every guarded write reads as "someone changed this file".
{
  assert.equal(hashText(''), '0:wvjl67o803')
  assert.equal(hashText('a'), '1:262p94epp1d')
  assert.equal(hashText('PROGRAM Main\nEND_PROGRAM\n'), '25:qs8r3nb1as')
  assert.equal(hashText('{\n  "name": "Linie – Nord ✓"\n}\n'), '31:1giy78exjsy')
  console.log('✓ hashText matches the renderer vectors')
  // and the byte hash, src/core/hash.ts hashBytes (folderSync.test.ts pins the same vectors)
  assert.equal(hashBytes(new Uint8Array([])), 'b0:wvjl67o803')
  assert.equal(hashBytes(new Uint8Array([97])), 'b1:262p94epp1d')
  assert.equal(hashBytes(new Uint8Array([0, 255, 128, 1])), 'b4:19uptk7pfoz')
  console.log('✓ hashBytes matches the renderer vectors')
}

// 5b. a part's asset file (src/core/parts/partAssets.ts) is read and written as bytes, and guarded by its byte hash; a
//     binary file anywhere else is still skipped
{
  const tmp = mkdtempSync(join(tmpdir(), 'oip-project-'))
  try {
    const name = 'a'.repeat(64) + '.glb'
    const asset = `parts/p/assets/${name}`
    const bytes = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0, 255, 128])
    assert.equal(writeProjectFolder(tmp, [{ path: 'project.json', contents: '{}' }, { path: asset, contents: bytes }]), '')
    writeFileSync(join(tmp, 'parts', 'p', 'shot.png'), 'not read')
    const read = readProjectFolder(tmp)
    const got = read.find((f) => f.path === asset)
    assert.ok(got && got.contents instanceof Uint8Array, 'asset read as bytes')
    assert.deepEqual([...got.contents], [...bytes])
    assert.equal(read.some((f) => f.path.endsWith('shot.png')), false)
    const next = new Uint8Array([1, 2, 3])
    assert.deepEqual(applyFolderWrites(tmp, [{ path: asset, contents: next, expect: hashBytes(bytes) }]), { moved: [], failed: [], error: null })
    assert.deepEqual([...readFileSync(join(tmp, ...asset.split('/')))], [1, 2, 3])
    assert.deepEqual(applyFolderWrites(tmp, [{ path: asset, contents: bytes, expect: hashBytes(bytes) }]).moved, [asset])
    console.log('✓ asset files move as bytes, guarded by their byte hash')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// 6. tests/ is part of a project folder: a manifest that references a test must be able to read it.
{
  const tmp = mkdtempSync(join(tmpdir(), 'oip-project-'))
  try {
    writeProjectFolder(tmp, [
      { path: 'project.json', contents: '{}' },
      { path: 'tests/stops-at-sensor.test.json', contents: '{"name":"x"}' },
    ])
    assert.deepEqual(readProjectFolder(tmp).map((f) => f.path).sort(), ['project.json', 'tests/stops-at-sensor.test.json'])
    console.log('✓ tests/ is read')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// 7. a folder that is gone is an error, not an empty project; the fingerprint says the same.
{
  const gone = join(tmpdir(), `oip-gone-${Date.now()}`)
  assert.throws(() => readProjectFolder(gone))
  assert.throws(() => folderSignature(gone))
  console.log('✓ a missing folder throws')
}

// 8. the fingerprint moves when a project file does, and ignores what is not a project file.
{
  const tmp = mkdtempSync(join(tmpdir(), 'oip-project-'))
  try {
    writeProjectFolder(tmp, [
      { path: 'project.json', contents: '{}' },
      { path: 'scenes/a.st', contents: 'A' },
    ])
    const before = folderSignature(tmp)
    assert.equal(folderSignature(tmp), before)
    writeFileSync(join(tmp, 'NOTES.md'), 'root notes are not part of the project')
    writeFileSync(join(tmp, 'scenes', 'shot.png'), 'binary')
    assert.equal(folderSignature(tmp), before)
    writeFileSync(join(tmp, 'scenes', 'a.st'), 'A changed')
    assert.notEqual(folderSignature(tmp), before)
    console.log('✓ the fingerprint follows project files only')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// 9. guarded writes: a write happens only when the file still holds what the renderer last saw.
{
  const tmp = mkdtempSync(join(tmpdir(), 'oip-project-'))
  try {
    writeProjectFolder(tmp, [{ path: 'scenes/a.st', contents: 'A' }])
    // the file matches -> replaced
    let r = applyFolderWrites(tmp, [{ path: 'scenes/a.st', contents: 'B', expect: hashText('A') }])
    assert.deepEqual(r, { moved: [], failed: [], error: null })
    assert.equal(readFileSync(join(tmp, 'scenes', 'a.st'), 'utf8'), 'B')
    // someone changed it since -> skipped and reported, never overwritten
    r = applyFolderWrites(tmp, [{ path: 'scenes/a.st', contents: 'C', expect: hashText('A') }])
    assert.deepEqual(r.moved, ['scenes/a.st'])
    assert.equal(readFileSync(join(tmp, 'scenes', 'a.st'), 'utf8'), 'B')
    // a new file must not exist yet
    r = applyFolderWrites(tmp, [{ path: 'scenes/b.st', contents: 'new', expect: null }])
    assert.deepEqual(r.moved, [])
    r = applyFolderWrites(tmp, [{ path: 'scenes/b.st', contents: 'again', expect: null }])
    assert.deepEqual(r.moved, ['scenes/b.st'])
    // '*' writes regardless
    r = applyFolderWrites(tmp, [{ path: 'scenes/b.st', contents: 'forced', expect: '*' }])
    assert.equal(readFileSync(join(tmp, 'scenes', 'b.st'), 'utf8'), 'forced')
    // no temp file is left behind
    assert.ok(!existsSync(join(tmp, 'scenes', 'b.st.oip-tmp')))
    console.log('✓ guarded writes land only on the file the renderer last saw')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// 10. guarded deletes, and an emptied part folder goes with its files.
{
  const tmp = mkdtempSync(join(tmpdir(), 'oip-project-'))
  try {
    writeProjectFolder(tmp, [
      { path: 'parts/p/manifest.json', contents: 'M' },
      { path: 'parts/p/behavior.js', contents: 'B' },
    ])
    let r = applyFolderWrites(tmp, [{ path: 'parts/p/manifest.json', expect: hashText('stale') }])
    assert.deepEqual(r.moved, ['parts/p/manifest.json'])
    assert.ok(existsSync(join(tmp, 'parts', 'p', 'manifest.json')))
    r = applyFolderWrites(tmp, [
      { path: 'parts/p/manifest.json', expect: hashText('M') },
      { path: 'parts/p/behavior.js', expect: hashText('B') },
    ])
    assert.deepEqual(r, { moved: [], failed: [], error: null })
    assert.ok(!existsSync(join(tmp, 'parts', 'p')), 'the emptied part folder is removed')
    assert.ok(existsSync(join(tmp, 'parts')), 'the format folder itself stays')
    console.log('✓ guarded deletes, and an emptied part folder is pruned')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// 10b. a part folder that also holds the author's part.js (and a parts/_shared/ module beside it) keeps them: deleting
// the part's two files leaves the folder, and the walk reads the sources so the sync can see them and leave them alone.
{
  const tmp = mkdtempSync(join(tmpdir(), 'oip-project-'))
  try {
    writeProjectFolder(tmp, [
      { path: 'parts/p/manifest.json', contents: 'M' },
      { path: 'parts/p/behavior.js', contents: 'B' },
      { path: 'parts/p/part.js', contents: 'S' },
      { path: 'parts/_shared/legs.js', contents: 'L' },
    ])
    const r = applyFolderWrites(tmp, [
      { path: 'parts/p/manifest.json', expect: hashText('M') },
      { path: 'parts/p/behavior.js', expect: hashText('B') },
    ])
    assert.deepEqual(r, { moved: [], failed: [], error: null })
    assert.equal(readFileSync(join(tmp, 'parts', 'p', 'part.js'), 'utf8'), 'S')
    assert.equal(readFileSync(join(tmp, 'parts', '_shared', 'legs.js'), 'utf8'), 'L')
    assert.deepEqual(readProjectFolder(tmp).map((f) => f.path).sort(), ['parts/_shared/legs.js', 'parts/p/part.js'])
    console.log("✓ deleting a part's files keeps its part.js and the shared modules")
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// 11. a bad path fails that op alone; the rest of the batch is still written.
{
  const tmp = mkdtempSync(join(tmpdir(), 'oip-project-'))
  try {
    const r = applyFolderWrites(tmp, [
      { path: '../evil.txt', contents: 'x', expect: '*' },
      { path: 'scenes/ok.st', contents: 'ok', expect: null },
    ])
    assert.deepEqual(r.failed, ['../evil.txt'])
    assert.ok(r.error)
    assert.equal(readFileSync(join(tmp, 'scenes', 'ok.st'), 'utf8'), 'ok')
    assert.equal(hasProjectManifest(tmp), false)
    writeProjectFolder(tmp, [{ path: 'project.json', contents: '{}' }])
    assert.equal(hasProjectManifest(tmp), true)
    console.log('✓ one bad op does not hold back the batch')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

console.log('projectFolderIo: all good')
