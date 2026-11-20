import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { bytesToBase64 } from '../core/parts/partAssets'
import { PACKAGE_FORMAT } from '../core/parts/partPackage'
import type { PartPackage } from '../core/parts/partPackage'
import { sha256HexOfBytes } from '../core/sha256'
import { assetBaseFor, configureRoomAssets, onRoomAssetsArrived, resetRoomAssetsForTest } from './roomAssets'
import { packagesMap, readPackages, writePackage } from './schema'

const glb = new Uint8Array(3000).map((_, i) => (i * 7) & 255)
const SHA = sha256HexOfBytes(glb)
const pkg: PartPackage = {
  format: PACKAGE_FORMAT,
  id: 'acme.modelled',
  name: 'Modelled',
  params: {},
  behavior: 'definePart(() => ({}))',
  geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, 0, 0] }], joints: [] },
  assets: [
    { id: 'body', mime: 'model/gltf-binary', data: bytesToBase64(glb) },
    { id: 'shipped', mime: 'model/gltf-binary', url: '/models/Box.glb' },
  ],
}
const LINK = { base: 'https://collab.test', room: `r-${'1'.repeat(64)}`, token: 'e-secret' }

/** The server's asset store, in memory: what fetch sees. */
let server: Map<string, Uint8Array>
/** false: a collab server from before the asset store (no route, no CORS header) */
let hasStore: boolean
let puts: { url: string; headers: Record<string, string> }[]

beforeEach(() => {
  resetRoomAssetsForTest()
  server = new Map()
  puts = []
  hasStore = true
  vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: Uint8Array; headers?: Record<string, string> }) => {
    const sha = url.split('/').pop()!
    const method = init?.method ?? 'GET'
    if (method === 'PUT') {
      puts.push({ url, headers: init!.headers! })
      server.set(sha, init!.body!)
      return new Response(null, { status: 201 })
    }
    const cors = { 'access-control-allow-origin': '*', 'x-oip-asset-store': '1' }
    if (!hasStore) return new Response(null, { status: 404 })
    const bytes = server.get(sha)
    if (!bytes) return new Response(null, { status: 404, headers: cors })
    return new Response(method === 'HEAD' ? null : (bytes as Uint8Array<ArrayBuffer>), { status: 200, headers: cors })
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  resetRoomAssetsForTest()
})

const blobOf = (doc: Y.Doc): string => packagesMap(doc).get(pkg.id)!.get('blob') as string
const arrived = (): Promise<void> => new Promise((r) => onRoomAssetsArrived(() => r()))
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('a room keeps embedded part assets by hash (roomAssets.ts)', () => {
  it('maps the collab WebSocket address to its http origin', () => {
    expect(assetBaseFor('wss://collab.openindustryproject.org')).toBe('https://collab.openindustryproject.org')
    expect(assetBaseFor('ws://localhost:1234/')).toBe('http://localhost:1234')
  })

  it('unconfigured (no room store), a package travels embedded as it always did', () => {
    const doc = new Y.Doc()
    writePackage(packagesMap(doc), pkg)
    expect(blobOf(doc)).toContain(bytesToBase64(glb))
    expect(readPackages(doc)).toEqual([pkg])
  })

  it('an editor writes the hash, not the bytes, and uploads the bytes once with its room proof', async () => {
    configureRoomAssets(LINK)
    await settle()
    const doc = new Y.Doc()
    writePackage(packagesMap(doc), pkg)
    expect(blobOf(doc)).not.toContain(bytesToBase64(glb))
    expect(JSON.parse(blobOf(doc)).assets).toEqual([
      { id: 'body', mime: 'model/gltf-binary', room: SHA },
      { id: 'shipped', mime: 'model/gltf-binary', url: '/models/Box.glb' },
    ])
    await settle()
    await settle()
    expect(puts).toHaveLength(1)
    expect(puts[0]!.url).toBe(`https://collab.test/assets/${SHA}`)
    expect(puts[0]!.headers).toMatchObject({ authorization: 'Bearer e-secret', 'x-oip-room': LINK.room })
    expect(server.get(SHA)).toEqual(glb)
    // the writer has the bytes, so it reads its own package back whole at once
    expect(readPackages(doc)).toEqual([pkg])
  })

  it('a peer leaves the package out until the bytes arrive, then reads it back exactly as it was written', async () => {
    configureRoomAssets(LINK)
    await settle()
    const doc = new Y.Doc()
    writePackage(packagesMap(doc), pkg)
    await settle()
    await settle()
    // another client: nothing cached, a view link
    resetRoomAssetsForTest()
    configureRoomAssets({ ...LINK, token: null })
    const landed = arrived()
    expect(readPackages(doc)).toEqual([])
    await landed
    expect(readPackages(doc)).toEqual([pkg])
  })

  it('an editor keeps embedding when the server has no asset store yet (a web deploy ahead of the server)', async () => {
    hasStore = false
    configureRoomAssets(LINK)
    await settle()
    const doc = new Y.Doc()
    writePackage(packagesMap(doc), pkg)
    expect(blobOf(doc)).toContain(bytesToBase64(glb))
    await settle()
    expect(puts).toHaveLength(0)
  })

  it('a viewer never converts or uploads: it has nothing to write', async () => {
    configureRoomAssets({ ...LINK, token: null })
    const doc = new Y.Doc()
    writePackage(packagesMap(doc), pkg)
    expect(blobOf(doc)).toContain(bytesToBase64(glb))
    await settle()
    expect(puts).toHaveLength(0)
  })
})
