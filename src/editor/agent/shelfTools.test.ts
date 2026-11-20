import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { manifestOfPackage } from '../../core/parts/partPackage'
import type { PartPackage } from '../../core/parts/partPackage'
import { clearPackages } from '../../core/parts/partRegistry'
import { buildPackage } from '../../sim/buildPackage'
import type { PackageManifest } from '../../sim/buildPackage'
import { EditorStore } from '../store/store'
import { callAgentTool, type AgentToolContext } from './tools'

function fakeStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    },
  } as Storage
}

function transfer(name = 'Transfer'): PartPackage {
  return buildPackage(
    { id: 'acme.transfer', name, geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0] }], joints: [] } } as PackageManifest,
    'definePart({ step() {} })',
  )
}

/** a shelf folder in memory, served the way the desktop shell's window.oipShelf serves one */
function fakeShelf(parts: PartPackage[]) {
  const folders = new Map(parts.map((p) => [p.id, { manifestJson: JSON.stringify(manifestOfPackage(p)), behaviorSource: p.behavior }]))
  let writes = 0
  const api = {
    list: async () => ({ root: '/shelf', parts: [...folders].map(([id, f]) => ({ dir: `/shelf/${id}`, id, name: id, ...f })), problems: [] }),
    signature: async () => `/shelf|${writes}`,
    write: async (id: string, manifestJson: string, behaviorSource: string) => {
      folders.set(id, { manifestJson, behaviorSource })
      writes++
      return ''
    },
    pickFolder: async () => null,
    reveal: async () => '',
  }
  vi.stubGlobal('oipShelf', api)
  return folders
}

/** a tool's answer, failing the test if the tool refused */
async function ok(c: AgentToolContext, name: string, args: unknown = {}): Promise<unknown> {
  const r = await callAgentTool(c, name, args)
  if (!r.ok) throw new Error(`${name} refused: ${r.error}`)
  return r.value
}

/** why a tool refused, failing the test if it did not */
async function refused(c: AgentToolContext, name: string, args: unknown = {}): Promise<string> {
  const r = await callAgentTool(c, name, args)
  if (r.ok) throw new Error(`${name} did not refuse`)
  return r.error
}

function ctx(): AgentToolContext {
  return { store: new EditorStore(), controller: null }
}

beforeEach(() => vi.stubGlobal('localStorage', fakeStorage()))
afterEach(() => {
  vi.unstubAllGlobals()
  clearPackages()
})

describe('the parts shelf, for an agent', () => {
  it('lists what the shelf holds with its status here, and takes a part into the project', async () => {
    fakeShelf([transfer()])
    const c = ctx()
    const listed = (await ok(c, 'list_shelf_parts')) as { parts: { id: string; status: string; shelfText: { name: string } }[] }
    expect(listed.parts).toEqual([{ id: 'acme.transfer', status: 'notInProject', shelfText: { name: 'Transfer' } }])
    expect(await ok(c, 'install_shelf_part', { id: 'acme.transfer' })).toMatchObject({ status: 'upToDate', was: 'notInProject' })
    expect(c.store.getState().userPackages.find((p) => p.id === 'acme.transfer')?.origin?.shelf).toBeDefined()
  })

  it("replaces the project's copy only when asked", async () => {
    const folders = fakeShelf([transfer()])
    const c = ctx()
    await ok(c, 'install_shelf_part', { id: 'acme.transfer' })
    const newer = transfer('Transfer v2')
    folders.set(newer.id, { manifestJson: JSON.stringify(manifestOfPackage(newer)), behaviorSource: newer.behavior })
    expect(await refused(c, 'install_shelf_part', { id: 'acme.transfer' })).toMatch(/update: true/)
    await ok(c, 'install_shelf_part', { id: 'acme.transfer', update: true })
    expect(c.store.getState().userPackages.find((p) => p.id === 'acme.transfer')?.name).toBe('Transfer v2')
  })

  it("puts the project's version on the shelf, and over another version only with replace", async () => {
    const folders = fakeShelf([])
    const c = ctx()
    c.store.addUserPackage(transfer())
    expect(await ok(c, 'put_on_shelf', { id: 'acme.transfer' })).toMatchObject({ replaced: false })
    expect(JSON.parse(folders.get('acme.transfer')!.manifestJson).name).toBe('Transfer')
    expect(await ok(c, 'put_on_shelf', { id: 'acme.transfer' })).toMatchObject({ note: expect.stringMatching(/already on the shelf/) })
    // an edit here keeps the record of the shelf version it came from, as every in-app edit does
    const mine = c.store.getState().userPackages.find((p) => p.id === 'acme.transfer')!
    c.store.addUserPackage({ ...mine, name: 'Transfer, edited here' })
    const other = transfer('Transfer, from a teammate')
    folders.set(other.id, { manifestJson: JSON.stringify(manifestOfPackage(other)), behaviorSource: other.behavior })
    expect(await refused(c, 'put_on_shelf', { id: 'acme.transfer' })).toMatch(/replace: true/)
    expect(await ok(c, 'put_on_shelf', { id: 'acme.transfer', replace: true })).toMatchObject({ replaced: true })
    expect(JSON.parse(folders.get('acme.transfer')!.manifestJson).name).toBe('Transfer, edited here')
  })
})
