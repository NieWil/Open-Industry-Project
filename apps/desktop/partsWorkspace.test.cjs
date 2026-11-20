// Smoke test for partsWorkspace.cjs - the testable core of the desktop authoring loop. Runs with plain
// Node (no Electron), so: `node apps/desktop/partsWorkspace.test.cjs`. Verifies the repo's parts folder
// (examples/parts) scans without problems and that malformed folders are reported, not thrown.

const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { listWorkspace, readPartFolder } = require('./partsWorkspace.cjs')

const repoRoot = join(__dirname, '..', '..')
const examples = join(repoRoot, 'examples', 'parts')

// 1. The repo's parts folder scans without problems: its first-party folders (rig.json + behavior.ts)
//    are not workspace parts, so they are skipped, not reported.
{
  const { parts, problems } = listWorkspace(examples)
  assert.equal(problems.length, 0, `unexpected problems: ${JSON.stringify(problems)}`)
  console.log(`✓ scanned examples/parts: ${parts.length} workspace part(s)`)
}

// 2. A malformed part folder is reported in `problems`, and a sibling good part still loads.
{
  const tmp = mkdtempSync(join(tmpdir(), 'oip-parts-'))
  try {
    // good part
    const good = join(tmp, 'good')
    mkdirSync(good)
    writeFileSync(join(good, 'manifest.json'), JSON.stringify({ id: 'x.good', name: 'Good' }))
    writeFileSync(join(good, 'behavior.js'), 'definePart({ step() {} })')
    // bad part: manifest present (so it's treated as a part) but no behavior.js
    const bad = join(tmp, 'bad')
    mkdirSync(bad)
    writeFileSync(join(bad, 'manifest.json'), JSON.stringify({ id: 'x.bad', name: 'Bad' }))
    // not-a-part: no manifest → silently skipped
    mkdirSync(join(tmp, 'notapart'))
    // a loose file beside the parts (an author's jsconfig.json) is not a part folder either
    writeFileSync(join(tmp, 'jsconfig.json'), '{}')

    const { parts, problems } = listWorkspace(tmp)
    assert.deepEqual(parts.map((p) => p.id), ['x.good'], 'only the good part should load')
    assert.equal(parts[0].name, 'Good')
    assert.match(parts[0].behaviorSource, /definePart\(/, 'behavior source should be read raw')
    assert.equal(JSON.parse(parts[0].manifestJson).id, 'x.good', 'manifest should round-trip as JSON')
    assert.equal(problems.length, 1, 'the bad part should be reported')
    assert.match(problems[0].message, /behavior\.js/, 'problem should name the missing file')

    // 3. readPartFolder throws a clear message for a manifest without an id.
    const noId = join(tmp, 'noid')
    mkdirSync(noId)
    writeFileSync(join(noId, 'manifest.json'), '{}')
    writeFileSync(join(noId, 'behavior.js'), 'definePart({ step() {} })')
    assert.throws(() => readPartFolder(noId), /missing a string "id"/)
    console.log('✓ malformed folders reported, not thrown; good siblings still load')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// 4. A part whose manifest names asset files (src/core/parts/partAssets.ts) is handed on with them joined back into base64
//    `data`; a missing or altered file fails that part, naming the file.
{
  const { createHash } = require('node:crypto')
  const tmp = mkdtempSync(join(tmpdir(), 'oip-ws-assets-'))
  try {
    const bytes = Buffer.from([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 255, 0, 128])
    const file = `assets/${createHash('sha256').update(bytes).digest('hex')}.glb`
    const dir = join(tmp, 'modelled')
    mkdirSync(join(dir, 'assets'), { recursive: true })
    writeFileSync(join(dir, ...file.split('/')), bytes)
    const manifest = { id: 'x.modelled', assets: [{ id: 'body', mime: 'model/gltf-binary', file }, { id: 'shipped', mime: 'model/gltf-binary', url: '/models/Box.glb' }] }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
    writeFileSync(join(dir, 'behavior.js'), 'definePart({ step() {} })')
    assert.deepEqual(JSON.parse(readPartFolder(dir).manifestJson).assets, [
      { id: 'body', mime: 'model/gltf-binary', data: bytes.toString('base64') },
      { id: 'shipped', mime: 'model/gltf-binary', url: '/models/Box.glb' },
    ])
    writeFileSync(join(dir, ...file.split('/')), Buffer.from([1]))
    assert.throws(() => readPartFolder(dir), /does not match its contents/)
    rmSync(join(dir, ...file.split('/')))
    assert.throws(() => readPartFolder(dir), /not found in the part folder/)
    console.log('✓ asset files joined back into the manifest; a missing or altered one fails the part')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

console.log('\nALL PASS - partsWorkspace.cjs')
