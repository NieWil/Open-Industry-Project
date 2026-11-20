// partsShelf.cjs under plain Node: `node apps/desktop/partsShelf.test.cjs`.

const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { folderNameForId, listShelf, readChosenShelf, shelfSignature, writeChosenShelf, writeShelfPart } = require('./partsShelf.cjs')

const manifest = (id, name = 'Part') => JSON.stringify({ id, name, geometry: { kind: 'rig', links: [], joints: [] } })
const tmp = mkdtempSync(join(tmpdir(), 'oip-shelf-'))
try {
  const root = join(tmp, 'Parts Shelf')

  // 1. a shelf nobody has put anything on yet is empty, not an error
  {
    const listed = listShelf(root)
    assert.deepEqual([listed.parts.length, listed.problems.length], [0, 0])
    console.log('✓ a missing shelf lists empty')
  }

  // 2. putting a part on it makes the folder, named for the id, and it lists back
  {
    assert.equal(writeShelfPart(root, 'acme.transfer', manifest('acme.transfer', 'Transfer'), 'definePart({})'), '')
    const listed = listShelf(root)
    assert.deepEqual(listed.parts.map((p) => [p.id, p.name]), [['acme.transfer', 'Transfer']])
    assert.equal(listed.parts[0].dir, join(root, 'acme.transfer'))
    console.log('✓ a new part gets a folder named for its id')
  }

  // 3. putting it on again overwrites in place: one folder per id, a hand-named folder keeps its name
  {
    const hand = join(root, 'Our merge')
    mkdirSync(hand)
    writeFileSync(join(hand, 'manifest.json'), manifest('acme.merge', 'Merge'))
    writeFileSync(join(hand, 'behavior.js'), 'definePart({})')
    assert.equal(writeShelfPart(root, 'acme.merge', manifest('acme.merge', 'Merge v2'), 'definePart({ v: 2 })'), '')
    assert.equal(JSON.parse(readFileSync(join(hand, 'manifest.json'), 'utf8')).name, 'Merge v2')
    assert.equal(readFileSync(join(hand, 'behavior.js'), 'utf8'), 'definePart({ v: 2 })')
    assert.equal(readdirSync(root).filter((n) => !n.startsWith('.')).length, 2)
    assert.ok(!readdirSync(hand).some((n) => n.includes('.tmp-')), 'no temp file left behind')
    console.log('✓ a part already on the shelf is replaced in its own folder')
  }

  // 4. an id cannot climb out of the shelf, and a name collision is numbered past
  {
    assert.equal(folderNameForId('../../evil'), 'evil')
    assert.equal(folderNameForId('a/b\\c'), 'a-b-c')
    assert.equal(folderNameForId('...'), 'part')
    mkdirSync(join(root, 'acme.other'))
    writeFileSync(join(root, 'acme.other', 'notes.txt'), 'not a part')
    assert.equal(writeShelfPart(root, 'acme.other', manifest('acme.other'), 'definePart({})'), '')
    assert.ok(listShelf(root).parts.some((p) => p.id === 'acme.other' && p.dir === join(root, 'acme.other-2')))
    console.log('✓ folder names are safe and never clobber another folder')
  }

  // 5. a manifest that does not name the id it is filed under is refused
  {
    assert.notEqual(writeShelfPart(root, 'acme.x', manifest('acme.y'), 'definePart({})'), '')
    assert.notEqual(writeShelfPart(root, 'acme.x', '{nope', 'definePart({})'), '')
    console.log('✓ a mismatched or broken manifest is refused')
  }

  // 5b. embedded assets go on the shelf as hash-named files (src/core/parts/partAssets.ts), read back as the same base64;
  //     a new version replaces the files the old one named
  {
    const { createHash } = require('node:crypto')
    const glb = Buffer.from([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 255, 0, 128])
    const withAsset = (bytes) =>
      JSON.stringify({ id: 'acme.modelled', name: 'Modelled', geometry: { kind: 'rig', links: [], joints: [] }, assets: [{ id: 'body', mime: 'model/gltf-binary', data: bytes.toString('base64') }] })
    assert.equal(writeShelfPart(root, 'acme.modelled', withAsset(glb), 'definePart({})'), '')
    const part = listShelf(root).parts.find((p) => p.id === 'acme.modelled')
    const name = `${createHash('sha256').update(glb).digest('hex')}.glb`
    assert.deepEqual(readdirSync(join(part.dir, 'assets')), [name])
    assert.equal(JSON.parse(readFileSync(join(part.dir, 'manifest.json'), 'utf8')).assets[0].file, `assets/${name}`)
    assert.equal(JSON.parse(part.manifestJson).assets[0].data, glb.toString('base64'))
    const next = Buffer.from([1, 2, 3])
    assert.equal(writeShelfPart(root, 'acme.modelled', withAsset(next), 'definePart({})'), '')
    assert.deepEqual(readdirSync(join(part.dir, 'assets')), [`${createHash('sha256').update(next).digest('hex')}.glb`])
    console.log('✓ assets go on the shelf as hash-named files, one version at a time')
  }

  // 5c. the card image goes beside the part and comes back as a data URL; a version written without one drops it
  {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const url = `data:image/png;base64,${png.toString('base64')}`
    assert.equal(writeShelfPart(root, 'acme.pictured', manifest('acme.pictured'), 'definePart({})', url), '')
    assert.equal(listShelf(root).parts.find((p) => p.id === 'acme.pictured').thumbnail, url)
    assert.equal(writeShelfPart(root, 'acme.pictured', manifest('acme.pictured'), 'definePart({})', 'data:text/html,<b>'), '')
    assert.equal(listShelf(root).parts.find((p) => p.id === 'acme.pictured').thumbnail, undefined)
    console.log('✓ the card image goes on the shelf with its part, and only a PNG is written')
  }

  // 5d. the signature moves when a part's files change, and not otherwise
  {
    const before = shelfSignature(root)
    assert.equal(shelfSignature(root), before)
    assert.equal(writeShelfPart(root, 'acme.signed', manifest('acme.signed'), 'definePart({})'), '')
    assert.notEqual(shelfSignature(root), before)
    console.log('✓ the signature tells a changed shelf from an unchanged one without reading it')
  }

  // 6. the chosen shelf folder round-trips through its settings file
  {
    const settings = join(tmp, 'parts-shelf.json')
    assert.equal(readChosenShelf(settings), null)
    writeChosenShelf(settings, 'D:\\Team\\Shelf')
    assert.equal(readChosenShelf(settings), 'D:\\Team\\Shelf')
    console.log('✓ the chosen shelf folder is remembered')
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
console.log('partsShelf: all checks passed')
