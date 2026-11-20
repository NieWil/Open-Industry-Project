// Test for adsIo.cjs's symbol table walk, which the tag picker lists from a TwinCAT runtime. Runs with plain Node (no
// Electron, no TwinCAT): `node apps/desktop/adsIo.test.cjs`. The records are built by hand in AdsSymbolEntry's layout
// (TcAdsDef.h), so nothing here needs a PLC; the ADS calls themselves are tested against a runtime by hand.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { AdsLink, parseSymbolTable } = require('./adsIo.cjs')

/** One AdsSymbolEntry: the six u32 header fields, the three u16 lengths, then name, type and comment, each zero-ended. */
function entry(name, typeName, adsType, size, comment = '') {
  const len = 30 + name.length + 1 + typeName.length + 1 + comment.length + 1
  const b = Buffer.alloc(len)
  b.writeUInt32LE(len, 0)
  b.writeUInt32LE(0x4040, 4)
  b.writeUInt32LE(0, 8)
  b.writeUInt32LE(size, 12)
  b.writeUInt32LE(adsType, 16)
  b.writeUInt32LE(0, 20)
  b.writeUInt16LE(name.length, 24)
  b.writeUInt16LE(typeName.length, 26)
  b.writeUInt16LE(comment.length, 28)
  b.write(name, 30, 'latin1')
  b.write(typeName, 30 + name.length + 1, 'latin1')
  b.write(comment, 30 + name.length + 1 + typeName.length + 1, 'latin1')
  return b
}

test('lists every record with its name, type and size', () => {
  const table = Buffer.concat([entry('MAIN.Extend', 'BOOL', 33, 1), entry('MAIN.tCycle', 'TON', 65, 32, 'cycle timer'), entry('GVL.Speed', 'REAL', 4, 4)])
  assert.deepEqual(parseSymbolTable(table), [
    { name: 'MAIN.Extend', typeName: 'BOOL', adsType: 33, size: 1 },
    { name: 'MAIN.tCycle', typeName: 'TON', adsType: 65, size: 32 },
    { name: 'GVL.Speed', typeName: 'REAL', adsType: 4, size: 4 },
  ])
})

test('stops at a record that runs past the table, keeping the ones before it', () => {
  const good = entry('MAIN.Run', 'BOOL', 33, 1)
  const cut = entry('MAIN.Eye', 'BOOL', 33, 1).subarray(0, 20)
  assert.deepEqual(
    parseSymbolTable(Buffer.concat([good, cut])).map((s) => s.name),
    ['MAIN.Run'],
  )
})

test('an empty table lists nothing', () => {
  assert.deepEqual(parseSymbolTable(Buffer.alloc(0)), [])
})

test('a link that was never opened says so rather than listing', async () => {
  const r = await new AdsLink().listSymbols()
  assert.equal(typeof r.error, 'string')
  assert.notEqual(r.error, '')
})

test("the PLC connections window's link number is past every controller's, and only a listing protocol takes it", () => {
  const { BROWSE_LINK, MAX_LINKS, linkNo, listingLinkNo } = require('./linkKeys.cjs')
  assert.equal(BROWSE_LINK, MAX_LINKS)
  assert.equal(linkNo({ link: MAX_LINKS - 1 }), MAX_LINKS - 1)
  assert.equal(linkNo({ link: BROWSE_LINK }), null)
  assert.equal(listingLinkNo({ link: BROWSE_LINK }), BROWSE_LINK)
  assert.equal(listingLinkNo({ link: BROWSE_LINK + 1 }), null)
})
