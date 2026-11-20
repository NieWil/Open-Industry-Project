import { describe, expect, it } from 'vitest'
import type { PackageManifest } from './buildPackage'
import { validatePart } from './validatePart'
import { undeclaredParamReads } from '../core/parts/partAuthoringChecks'
import { partFingerprint, storedPackageHash } from '../core/parts/partOrigin'
import { manifestOfPackage } from '../core/parts/partPackage'
import { newerSdkLevel, PART_SDK_LEVEL } from '../core/parts/partSdk'

const deck: PackageManifest = { id: 'acme.deck', name: 'Deck', geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [6, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 6, width: 1, top: 0.05, bottom: -0.1 } } }

const GOOD = `definePart({
  params: { speed: { type: 'number', default: 0.6 } },
  step(ctx) { ctx.setSurfaceVelocity({ x: ctx.forward.x * ctx.params.speed, y: 0, z: 0 }) },
})`

const rig: PackageManifest = {
  id: 'acme.arm',
  name: 'Arm',
  geometry: {
    kind: 'rig',
    links: [{ name: 'arm', shape: { kind: 'box', size: [1, 1, 1] }, offset: [0, 0, 0] }],
    joints: [{ name: 'shoulder', link: 'arm', type: 'revolute', axis: [0, 1, 0], min: -1, max: 1 }],
  },
}

const kinds = (m: PackageManifest, src: string): string[] => validatePart(m, src).diagnostics.map((d) => d.kind)

describe('snap: declared in the manifest (package format 4)', () => {
  const flush = { flush: true } as const
  // l / w: the params a tile snap names
  const script = (snap?: string) => `definePart({ params: { l: { type: 'number', default: 1 }, w: { type: 'number', default: 1 } }, ${snap ? `snap: ${snap}, ` : ''}step(){} })`

  it("takes the manifest's snap", () => {
    const r = validatePart({ ...rig, snap: flush }, script())
    expect(r.ok).toBe(true)
    expect(r.package?.snap).toEqual(flush)
  })

  it('still reads a snap declared in definePart when the manifest has none (behavior code written before format 4), in the current spelling', () => {
    const r = validatePart(rig, script("{ edges: { group: 'g', lengthParam: 'l', widthParam: 'w' } }"))
    expect(r.package?.snap).toEqual({ tile: { group: 'g', lengthParam: 'l', widthParam: 'w' } })
  })

  it('accepts the same snap in both places (a stored part whose code predates the move) and refuses two different ones', () => {
    expect(validatePart({ ...rig, snap: flush }, script('{ flush: true }')).ok).toBe(true)
    const r = validatePart({ ...rig, snap: flush }, script("{ tile: { group: 'g', lengthParam: 'l', widthParam: 'w' } }"))
    expect(r.ok).toBe(false)
    expect(r.diagnostics.map((d) => d.message).join(' ')).toMatch(/belongs in the manifest/)
  })
})

describe('a param the script reads but the part does not declare', () => {
  const speed = { type: 'number', default: 1 } as const

  it('is refused at its line, with the near name when there is one', () => {
    const r = validatePart(deck, "definePart({\n  params: { speed: { type: 'number', default: 1 } },\n  step(ctx) { const v = ctx.params.sped },\n})")
    expect(r.ok).toBe(false)
    const d = r.diagnostics.find((x) => x.message.startsWith('ctx.params.sped'))
    expect(d).toMatchObject({ kind: 'package', line: 3, column: 36 })
    expect(d?.message).toMatch(/did you mean "speed"/)
  })

  it('lists the params when no name is close, and says so when there are none', () => {
    expect(undeclaredParamReads('ctx.params.height', { speed })).toEqual([{ name: 'height', line: 1, column: 12 }])
    const r = validatePart(deck, 'definePart({ step(ctx) { ctx.params.height } })')
    expect(r.diagnostics.map((d) => d.message)).toContain('ctx.params.height is not a param of this part, so it reads undefined (it declares none)')
  })

  it('sees ?. and a bracketed literal, and not a comment, a string or another object\'s params', () => {
    const src = [
      'ctx.params?.alpha',
      "ctx.params['beta']",
      '// ctx.params.gamma',
      "const s = 'ctx.params.delta'",
      'other.params.epsilon',
      'ctx.params[key]',
    ].join('\n')
    expect(undeclaredParamReads(src, {}).map((r) => r.name)).toEqual(['alpha', 'beta'])
  })

  it('a declared name inherited from Object.prototype is not a pass (toString is not a param)', () => {
    expect(undeclaredParamReads('ctx.params.toString', {}).map((r) => r.name)).toEqual(['toString'])
  })
})

describe('validatePart', () => {
  it('returns ok + the built package for a clean part', () => {
    const res = validatePart(deck, GOOD)
    expect(res.ok).toBe(true)
    expect(res.diagnostics).toEqual([])
    expect(res.package?.params).toHaveProperty('speed')
  })

  it('reports a determinism violation with kind + line, and never throws', () => {
    const res = validatePart(deck, `definePart({\n  step(ctx) { ctx.setSurfaceVelocity({ x: Math.random(), y: 0, z: 0 }) },\n})`)
    expect(res.ok).toBe(false)
    expect(res.package).toBeUndefined()
    const det = res.diagnostics.find((d) => d.kind === 'determinism')
    expect(det?.message).toMatch(/Math\.random/)
    expect(det?.line).toBe(2)
  })

  it('does not double-report a determinism failure as a load error', () => {
    const res = validatePart(deck, `definePart({ step(){ Date.now() } })`)
    expect(kinds(deck, `definePart({ step(){ Date.now() } })`)).toEqual(['determinism'])
    expect(res.diagnostics.every((d) => d.kind !== 'load')).toBe(true)
  })

  it('reports a load failure when the script never calls definePart', () => {
    const res = validatePart(deck, 'const x = 1')
    expect(res.ok).toBe(false)
    expect(res.diagnostics).toHaveLength(1)
    expect(res.diagnostics[0]).toMatchObject({ kind: 'load' })
    expect(res.diagnostics[0]!.message).toMatch(/definePart/)
  })

  it('bakes useParam when it names a boolean param on an interactive part, and reports it', () => {
    const res = validatePart(deck, `definePart({
      interactive: true,
      useParam: 'active',
      params: { active: { type: 'boolean', default: false } },
      step(ctx) { ctx.report('active', ctx.params.active !== ctx.used()) },
    })`)
    expect(res.ok).toBe(true)
    expect(res.package?.interactive).toBe(true)
    expect(res.package?.useParam).toBe('active')
  })

  // The param is only where the hand state starts: Use never writes it, so the state the device is actually in
  // (after hand presses, or under a program) exists only inside step(). The same contract as setpointFor.
  it('rejects a useParam with no matching ctx.report', () => {
    const res = validatePart(deck, `definePart({
      interactive: true,
      useParam: 'active',
      params: { active: { type: 'boolean', default: false } },
      step(ctx) { if (ctx.used()) {} },
    })`)
    expect(res.ok).toBe(false)
    expect(res.package).toBeUndefined()
    expect(res.diagnostics.some((d) => d.kind === 'package' && /useParam: names "active".*ctx\.report\('active'/.test(d.message))).toBe(true)
  })

  it('rejects useParam without interactive: true', () => {
    const res = validatePart(deck, `definePart({
      useParam: 'active',
      params: { active: { type: 'boolean', default: false } },
      step() {},
    })`)
    expect(res.ok).toBe(false)
    expect(res.diagnostics).toContainEqual({ kind: 'package', message: 'useParam: requires interactive: true' })
  })

  it('rejects useParam that does not name a boolean param', () => {
    const res = validatePart(deck, `definePart({
      interactive: true,
      useParam: 'speed',
      params: { speed: { type: 'number', default: 1 } },
      step() {},
    })`)
    expect(res.ok).toBe(false)
    expect(res.diagnostics.some((d) => d.kind === 'package' && /useParam: must name a boolean param/.test(d.message))).toBe(true)
  })

  // setpointFor is the link the Inspector trusts blindly to swap the live commanded value into a field, so a
  // typo has to fail the build rather than leave a dead readout that silently keeps showing the authored value.
  it('bakes a setpointFor tag that names a number param and reports it', () => {
    const res = validatePart(deck, `definePart({
      params: {
        speed: { type: 'number', default: 1 },
        speedTag: { type: 'tag', dir: 'in', stType: 'REAL', setpointFor: 'speed', default: '' },
      },
      step(ctx) { ctx.report('speed', ctx.params.speed) },
    })`)
    expect(res.ok).toBe(true)
    expect(res.package?.params.speedTag).toMatchObject({ setpointFor: 'speed' })
  })

  // setpointFor promises the Inspector that a tag replaces a param; ctx.report is what makes the number
  // behind that promise the one step() actually computed. Declaring without reporting leaves the readout on
  // the host's re-derivation of the comms convention, which is exactly the drift this pair exists to prevent.
  it('rejects a setpointFor with no matching ctx.report', () => {
    const res = validatePart(deck, `definePart({
      params: {
        speed: { type: 'number', default: 1 },
        speedTag: { type: 'tag', dir: 'in', stType: 'REAL', setpointFor: 'speed', default: '' },
      },
      step(ctx) { ctx.report('other', 1) },
    })`)
    expect(res.ok).toBe(false)
    expect(res.diagnostics.some((d) => /must also call ctx\.report\('speed'/.test(d.message))).toBe(true)
  })

  // an undeclared tag param is invisible to the wiring check, so an authored one is refused, naming both fields
  it('rejects a tag param that declares no dir or stType', () => {
    const res = validatePart(deck, `definePart({ params: { runTag: { type: 'tag', default: '' } }, step(ctx) {} })`)
    expect(res.ok).toBe(false)
    expect(res.diagnostics.map((d) => d.message).filter((m) => /params\.runTag\.(dir|stType)/.test(m))).toHaveLength(2)
  })

  it('rejects a setpointFor naming a missing or non-number param', () => {
    const missing = validatePart(deck, `definePart({
      params: { speed: { type: 'number', default: 1 }, speedTag: { type: 'tag', dir: 'in', stType: 'REAL', setpointFor: 'sped', default: '' } },
      step(ctx) { ctx.report('sped', 1) },
    })`)
    expect(missing.ok).toBe(false)
    expect(missing.diagnostics.some((d) => /params\.speedTag\.setpointFor: must name a number param/.test(d.message))).toBe(true)

    const wrongKind = validatePart(deck, `definePart({
      params: { run: { type: 'boolean', default: false }, speedTag: { type: 'tag', dir: 'in', stType: 'REAL', setpointFor: 'run', default: '' } },
      step(ctx) { ctx.report('run', true) },
    })`)
    expect(wrongKind.ok).toBe(false)
    expect(wrongKind.diagnostics.some((d) => /params\.speedTag\.setpointFor: must name a number param/.test(d.message))).toBe(true)
  })

  it('rejects setpointFor on a param that is not a tag', () => {
    const res = validatePart(deck, `definePart({
      params: { speed: { type: 'number', default: 1 }, note: { type: 'string', setpointFor: 'speed', default: '' } },
      step() {},
    })`)
    expect(res.ok).toBe(false)
    expect(res.diagnostics).toContainEqual({
      kind: 'package',
      message: 'params.note.setpointFor: setpointFor is only valid on a tag param',
    })
  })

  it('reports a declared joint that is not in the rig geometry', () => {
    const res = validatePart(rig, 'definePart({ joints: ["sholder"], step(){} })') // typo
    expect(res.ok).toBe(false)
    expect(res.diagnostics).toEqual([{ kind: 'rig', message: 'declared joint "sholder" is not a rig joint' }])
  })

  it('accepts correct rig declarations (gripper = a link name)', () => {
    expect(validatePart(rig, 'definePart({ joints: ["shoulder"], grippers: ["arm"], step(){} })').ok).toBe(true)
  })

  it('reports a declared lamp that is no link\'s `lamps` entry and no drawn submesh\'s `lamps` entry', () => {
    expect(validatePart(rig, 'definePart({ lamps: ["beacon"], step(){} })').diagnostics).toEqual([
      { kind: 'rig', message: 'declared lamp "beacon" is not a rig lamp (an entry of a link\'s `lamps`, named or taking the link\'s name, or of a drawn submesh\'s `lamps`)' },
    ])
    // 'arm' is a real link but has no emissive colour → still rejected
    expect(validatePart(rig, 'definePart({ lamps: ["arm"], step(){} })').ok).toBe(false)
  })

  it('accepts a lamp named by a mesh link\'s `lamps` entry (a panel with several lens materials)', () => {
    // The multi-lamp form names each lamp itself, not its link: the Diverter's two lenses are primitives of
    // one mesh, so they can't each be a link. The typo guard has to know both forms or it rejects the good one.
    const panel: PackageManifest = {
      id: 'oip.panel',
      name: 'Panel',
      geometry: {
        kind: 'rig',
        links: [{
          name: 'housing',
          shape: { kind: 'mesh', asset: 'glb', materials: { LensA: 'lensA', LensB: 'lensB' } },
          lamps: [{ material: 'LensA', name: 'red', emissive: [1, 0, 0] }, { material: 'LensB', name: 'green', emissive: [0, 1, 0] }],
          offset: [0, 0, 0],
        }],
        joints: [],
      },
      assets: [{ id: 'glb', mime: 'model/gltf-binary', data: 'AAAA' }],
      materials: [{ id: 'lensA', color: [0.2, 0, 0] }, { id: 'lensB', color: [0, 0.2, 0] }],
    }
    expect(validatePart(panel, 'definePart({ lamps: ["red", "green"], step(ctx){ ctx.lamps.red = true } })').diagnostics).toEqual([])
    // and a typo in one of them is still caught
    expect(validatePart(panel, 'definePart({ lamps: ["red", "grene"], step(){} })').ok).toBe(false)
  })

  it('bakes interactive into the package when the behavior declares it (C-interaction)', () => {
    expect(validatePart(deck, 'definePart({ interactive: true, step(){} })').package?.interactive).toBe(true)
    expect(validatePart(deck, GOOD).package?.interactive).toBeUndefined() // not set when not declared
  })

  it('accepts a declared lamp on a link that carries a lamp', () => {
    const lit: PackageManifest = {
      id: 'acme.lit',
      name: 'Lit',
      geometry: { kind: 'rig', links: [{ name: 'red', shape: { kind: 'cylinder', radius: 0.1, height: 0.1 }, offset: [0, 0, 0], lamps: [{ emissive: [1, 0, 0] }] }], joints: [] },
    }
    expect(validatePart(lit, 'definePart({ lamps: ["red"], step(){} })').ok).toBe(true)
  })

  // geometry() output, checked at default params: only the script's result can show these
  const drawing = (part: string): string => `definePart({ geometry(g) { return [${part}] }, step() {} })`
  const fn: PackageManifest = { id: 'acme.fn', name: 'Fn', geometry: { kind: 'drawn', bounds: { length: 1, width: 1, top: 1 } }, materials: [{ id: 'paint', color: [1, 0, 0] }] }
  it('reports a geometry() submesh naming a material the manifest does not declare', () => {
    const r = validatePart(fn, drawing("{ desc: g.box([1, 1, 1], [0, 0, 0]), material: 'band' }"))
    expect(r.ok).toBe(false)
    expect(r.diagnostics[0]!.message).toMatch(/names material "band"/)
    expect(validatePart(fn, drawing("{ desc: g.box([1, 1, 1], [0, 0, 0]), material: 'paint' }")).ok).toBe(true)
  })

  it('reports a spinning instanced bank whose axis is not local Z (the only axis a bank turns about)', () => {
    const bank = (axis: string): string => drawing(`{ desc: g.box([1, 1, 1], [0, 0, 0]), finish: 'roller', instances: [{ position: [0, 0, 0] }], spin: { axis: ${axis}, radius: 0.02, speed: 'rpm' } }`)
    expect(validatePart(fn, bank('[1, 0, 0]')).diagnostics[0]!.message).toMatch(/spin\.axis must be \[0, 0, 1\] or \[0, 0, -1\]/)
    expect(validatePart(fn, bank('[0, 0, -1]')).ok).toBe(true)
    expect(validatePart(fn, bank('[0, 0, 2]')).ok).toBe(true) // any length along Z
    // a plain (non-instanced) submesh turns about any axis
    expect(validatePart(fn, drawing("{ desc: g.box([1, 1, 1], [0, 0, 0]), spin: { axis: [1, 0, 0], radius: 0.02, speed: 'rpm' } }")).ok).toBe(true)
  })

  it('collects all problems at once (determinism + rig) instead of stopping at the first', () => {
    // determinism stops the load, so rig decls can't be read in the same pass - but multiple determinism
    // violations are all reported together
    const res = validatePart(deck, `definePart({ step(){ Date.now(); fetch('/x') } })`)
    expect(res.diagnostics.map((d) => d.message).join(' ')).toMatch(/Date/)
    expect(res.diagnostics.map((d) => d.message).join(' ')).toMatch(/fetch/)
  })
})

describe('where a project copy came from (package format 6: origin)', () => {
  it('a part folder written before format 6 (basedOn / fromShelf, no format number) still builds with its record', () => {
    const old = { ...deck, basedOn: 'a1', fromShelf: 's1' } as unknown as PackageManifest
    const r = validatePart(old, GOOD)
    expect(r.package?.origin).toEqual({ app: 'a1', shelf: 's1' })
    expect(r.package).not.toHaveProperty('basedOn')
  })
})

describe('the Part SDK level stamp (core/parts/partSdk.ts)', () => {
  it("stamps a new part with this build's level and its fingerprint", () => {
    const pkg = validatePart(deck, GOOD).package!
    expect(pkg.sdk).toEqual({ level: PART_SDK_LEVEL, of: partFingerprint(pkg) })
  })

  it('keeps a stamp from a newer build while the part is unchanged, so loading it keeps its level', () => {
    const made = validatePart(deck, GOOD).package!
    const fromNewer = { ...made, sdk: { level: PART_SDK_LEVEL + 3, of: made.sdk!.of } }
    const reloaded = validatePart(manifestOfPackage(fromNewer), fromNewer.behavior).package!
    expect(reloaded.sdk?.level).toBe(PART_SDK_LEVEL + 3)
    expect(newerSdkLevel(reloaded)).toBe(PART_SDK_LEVEL + 3)
  })

  it("takes this build's level once the part has changed since its stamp", () => {
    const made = validatePart(deck, GOOD).package!
    const manifest = { ...manifestOfPackage(made), sdk: { level: PART_SDK_LEVEL + 3, of: made.sdk!.of }, name: 'Renamed deck' }
    const edited = validatePart(manifest, made.behavior).package!
    expect(edited.sdk?.level).toBe(PART_SDK_LEVEL)
    expect(newerSdkLevel(edited)).toBeUndefined()
  })

  it('leaves the fingerprint alone, so stamping never reads as an update or an edit', () => {
    const made = validatePart(deck, GOOD).package!
    const { sdk: _sdk, ...unstamped } = made
    expect(partFingerprint(unstamped)).toBe(partFingerprint(made))
    expect(storedPackageHash(unstamped)).toBe(storedPackageHash(made))
  })
})

describe('geometry(): a spinning instanced bank', () => {
  const bank = (look: string): string =>
    `definePart({ params: { speed: { type: 'number', default: 1 } }, geometry(g) { return [{ desc: g.box([1, 1, 1], [0, 0, 0]), ${look}, instances: [{ position: [0, 0, 0] }, { position: [1, 0, 0] }], spin: { axis: [0, 0, 1], radius: 0.1, speed: 'speed' } }] }, step() {} })`
  const messages = (m: PackageManifest, src: string): string[] => validatePart(m, src).diagnostics.map((d) => d.message)

  it('says a bank whose material has no grain to turn holds still, and how to turn its teeth instead', () => {
    expect(messages(rig, bank("finish: 'bolt'"))).toEqual([expect.stringContaining('finish "bolt" has no grain to turn, so it holds still')])
    const plain = { ...rig, materials: [{ id: 'steel', color: [0.5, 0.5, 0.5] as [number, number, number] }] }
    expect(messages(plain, bank("material: 'steel'"))).toEqual([expect.stringContaining('draw each one as its own submesh, which turns its mesh')])
  })

  it("is quiet for a roller finish or an object-space triplanar material, whose grain turns", () => {
    expect(messages(rig, bank("finish: 'roller'"))).toEqual([])
    const grained = { ...rig, assets: [{ id: 'tex', mime: 'image/webp', url: '/textures/x.webp' }], materials: [{ id: 'arm', albedo: 'tex', triplanar: { space: 'object' as const, scale: 2 } }] }
    expect(messages(grained, bank("material: 'arm'"))).toEqual([])
  })
})
