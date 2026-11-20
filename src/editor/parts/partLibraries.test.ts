import { describe, expect, it } from 'vitest'
import { partToOippartBytes } from '../../core/parts/partArchive'
import type { LibraryVersion } from '../../core/parts/partLibrary'
import { partFingerprint } from '../../core/parts/partOrigin'
import { sha256HexOfBytes } from '../../core/sha256'
import { buildPackage } from '../../sim/buildPackage'
import { downloadVersion, libraryUrls, readLibrary } from './partLibraries'

const INDEX_URL = 'https://parts.example/oip.test/index.json'

const PART = buildPackage(
  { id: 'oip.block', name: 'Block', geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0] }], joints: [] } },
  'definePart({ step() {} })',
)

/** A fetch that serves `files` by absolute URL, and 404 for anything else. */
function server(files: Record<string, Uint8Array | object>): (url: string) => Promise<Response> {
  return async (url) => {
    const body = files[url]
    if (body === undefined) return new Response('', { status: 404 })
    return body instanceof Uint8Array ? new Response(new Blob([body as Uint8Array<ArrayBuffer>])) : new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  }
}

async function listed(part = PART): Promise<{ bytes: Uint8Array; version: LibraryVersion }> {
  const bytes = await partToOippartBytes(part)
  return { bytes, version: { file: 'oip.block/a.oippart', sha256: sha256HexOfBytes(bytes), fingerprint: partFingerprint(part), sdk: 1, published: '2026-10-17' } }
}

describe('libraryUrls', () => {
  it('reads ?library= links for the session, keeping only http(s)', () => {
    expect(libraryUrls(`?library=${encodeURIComponent(INDEX_URL)}&library=javascript:alert(1)`)).toEqual([INDEX_URL])
  })
})

describe('readLibrary', () => {
  it('reads a valid index, and as first-party only from the project host', async () => {
    const index = { format: 1, id: 'oip.test', name: 'Test', licence: { code: 'MIT', assets: 'CC-BY-4.0' }, parts: [] }
    const elsewhere = await readLibrary(INDEX_URL, server({ [INDEX_URL]: index }))
    expect(elsewhere.index?.id).toBe('oip.test')
    expect(elsewhere.firstParty).toBe(false)
    const official = 'https://parts.openindustryproject.org/oip.test/index.json'
    expect((await readLibrary(official, server({ [official]: index }))).firstParty).toBe(true)
  })

  it('says why a library could not be read, never throws', async () => {
    expect((await readLibrary(INDEX_URL, server({}))).error).toMatch(/404/)
    expect((await readLibrary(INDEX_URL, server({ [INDEX_URL]: { format: 9 } }))).error).toMatch(/newer version of the app/)
    expect((await readLibrary(INDEX_URL, () => Promise.reject(new Error('blocked by CORS')))).error).toMatch(/CORS/)
  })
})

describe('downloadVersion', () => {
  it('builds the listed part from its file', async () => {
    const { bytes, version } = await listed()
    const r = await downloadVersion(INDEX_URL, 'oip.block', version, server({ 'https://parts.example/oip.test/oip.block/a.oippart': bytes }))
    expect('pkg' in r && partFingerprint(r.pkg)).toBe(partFingerprint(PART))
  })

  it('refuses a file that is not the one listed, and tries again on the next ask', async () => {
    // a version of its own: downloads are kept by the file's hash, and the test above has this part's
    const { bytes, version } = await listed(buildPackage({ ...PART, id: 'oip.block' }, 'definePart({ step() { /* v2 */ } })'))
    const other = { ...version, file: 'oip.block/b.oippart' }
    const url = 'https://parts.example/oip.test/oip.block/b.oippart'
    const tampered = new Uint8Array(bytes)
    tampered[tampered.length - 1]! ^= 1
    const first = await downloadVersion(INDEX_URL, 'oip.block', other, server({ [url]: tampered }))
    expect('error' in first && first.error).toMatch(/hash differs|not a valid part file/)
    const second = await downloadVersion(INDEX_URL, 'oip.block', other, server({ [url]: bytes }))
    expect('pkg' in second).toBe(true)
  })
})
