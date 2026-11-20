import { describe, expect, it } from 'vitest'
import { PACKAGE_FORMAT, rigLampNames } from '../../core/parts/partPackage'
import { validatePartPackage } from '../../core/parts/partValidate'
import { evalPartGeometry, geometryLampNames } from '../../core/geometry/geometryEval'
import type { MeshPart } from '../../core/parts/partApi'
import { examplePart, type RigGeo } from './examplePart'
import { instantiatePartScript } from '../../core/parts/partScript'
const { assets: PUSH_BUTTON_SDK_ASSETS, behavior: PUSH_BUTTON_SDK_BEHAVIOR, materials: PUSH_BUTTON_SDK_MATERIALS, geometry: PUSH_BUTTON_SDK_RIG } = examplePart<RigGeo>('oip.push-button')

// The Push Button as a custom part (examples/parts/push-button), drawn by geometry(): it exercises C-interaction
// (ctx.used → pressed) + C-emissive on a code-built cap (a MeshPart.lamp, lit by ctx.lamps) + a depressing cap
// (ctx.setSubPose on the `cap` link) + a face label + a PLC tag. The interactive-flag bake is covered by
// validatePart.test; here we pin the rig shape + the lit/depressing-cap + label wiring, and the size: real gear's
// (a ~90 mm station box, a 40 mm E-stop head), and other things are placed against it (the face label clears the
// legend plate; the demo seats the back plate on a rail wall).

const geo = PUSH_BUTTON_SDK_RIG
const cap = geo.links.find((l) => l.name === 'cap')!
const parts = (): MeshPart[] => evalPartGeometry(PUSH_BUTTON_SDK_BEHAVIOR, {}) ?? []
const zRange = (ps: MeshPart[]): [number, number] => {
  const zs = ps.flatMap((p) => p.desc.positions.filter((_, i) => i % 3 === 2))
  return [Math.min(...zs), Math.max(...zs)]
}
const label = geo.links.find((l) => l.name === 'label')!

describe('Push Button custom-part rig - parity with the built-in', () => {
  it('is a structurally valid package (the split GLB + cap material, a behavior declaring the lamp)', () => {
    expect(
      validatePartPackage({
        format: PACKAGE_FORMAT,
        id: 'oip.push-button',
        name: 'Push Button',
        params: {},
        behavior: "definePart({ interactive:true, lamps:['cap'], step(){} })",
        geometry: geo,
        assets: PUSH_BUTTON_SDK_ASSETS,
        materials: PUSH_BUTTON_SDK_MATERIALS,
      }),
    ).toEqual([])
  })

  it('is drawn in code: the housing on the root, the cap alone on the link the press moves', () => {
    expect(PUSH_BUTTON_SDK_ASSETS).toEqual([]) // no model file
    expect(cap.shape.kind).toBe('frame') // geometry() dresses it
    const ps = parts()
    const onCap = ps.filter((p) => p.link === 'cap')
    expect(onCap).toHaveLength(1) // depressing the cap moves nothing else
    expect(ps.filter((p) => p.link === undefined).map((p) => p.material).sort()).toEqual(['bolt', 'dark', 'gray', 'light'])
  })

  it('the cap is the lamp: a lit colour, tinted by the button colour param, counted as a rig lamp', () => {
    const capPart = parts().find((p) => p.link === 'cap')!
    expect(capPart.lamps?.map((l) => l.name)).toEqual(['cap'])
    expect(capPart.lamps?.[0]?.emissive).toBeTruthy()
    expect(capPart.colorParam).toBe('buttonColor') // sets both the unlit cap and the glow
    expect(capPart.material).toBe('cap')
    // the typo guards (validatePart at load, world at run time) accept ctx.lamps.cap only if this holds
    expect(rigLampNames(geo, geometryLampNames(PUSH_BUTTON_SDK_BEHAVIOR)).has('cap')).toBe(true)
  })

  it('is drawn at real size, which the label and the demo are placed against', () => {
    const ps = parts()
    const ys = ps.flatMap((p) => p.desc.positions.filter((_, i) => i % 3 === 1))
    expect(Math.min(...ys)).toBeCloseTo(0, 3)
    expect(Math.max(...ys)).toBeCloseTo(0.09, 3) // a 90 mm box
    const [back, front] = zRange(ps)
    expect(back).toBeCloseTo(-0.0317, 3) // the tabs' back plate; the demo seats this on a rail wall
    expect(front).toBeCloseTo(0.0317, 3) // the cap face
    // the legend plate's face, which the caption must stand clear of
    const legend = zRange(ps.filter((p) => p.material === 'light'))
    expect(legend[1]).toBeCloseTo(0.0183, 3)
    expect(legend[1]).toBeLessThan(label.offset![2] - 0.001)
  })

  it('has a face label driven by an Inspector-editable text param', () => {
    expect(label.shape.kind).toBe('label')
    const lab = label.shape as Extract<typeof label.shape, { kind: 'label' }>
    expect(lab.textParam).toBe('text')
  })

  it('the behavior is interactive and drives the depress + lamp + tag from a use', () => {
    expect(PUSH_BUTTON_SDK_BEHAVIOR).toContain('interactive: true')
    expect(PUSH_BUTTON_SDK_BEHAVIOR).toContain('ctx.used()')
    expect(PUSH_BUTTON_SDK_BEHAVIOR).toContain('ctx.lamps.cap')
    expect(PUSH_BUTTON_SDK_BEHAVIOR).toContain("ctx.setSubPose('cap'") // the cap depresses
    expect(PUSH_BUTTON_SDK_BEHAVIOR).toContain('writeTag')
  })

  // The emergency-stop head: a mushroom that latches in when struck and is released by a twist. People recognise
  // the device by the twist, so it is pinned here as motion, not just as a flag: the head turns while it
  // is still in, springs out only once turned, and turns about its own axis. The cap link pivots at the part's
  // origin, 0.045 m below that axis, so a turn without its offset would swing the head round the housing's foot.
  describe('emergency stop', () => {
    type Pose = { position?: [number, number, number]; rotation?: [number, number, number] }
    const run = () => {
      const { def, error } = instantiatePartScript(PUSH_BUTTON_SDK_BEHAVIOR)
      expect(error).toBe('')
      let use = false
      const out: { pose: Pose; tag: boolean | undefined } = { pose: {}, tag: undefined }
      const ctx = {
        dt: 1 / 60,
        params: { emergencyStop: true, momentary: true, normallyClosed: false, tag: 'EStop', lampSource: 'off', lampTag: '' },
        lamps: {} as Record<string, boolean>,
        used: () => use,
        readTag: () => false,
        tagDriven: () => false,
        writeTag: (_t: string, v: boolean) => { out.tag = v },
        setSubPose: (_l: string, p: Pose) => { out.pose = p },
      }
      const tick = (used = false) => {
        use = used
        def!.step!(ctx as never)
        use = false
        return { ...out }
      }
      return tick
    }

    it('draws a mushroom head, centred on the axis the twist turns it about', () => {
      const head = evalPartGeometry(PUSH_BUTTON_SDK_BEHAVIOR, { emergencyStop: true })!.find((p) => p.link === 'cap' && p.material === 'cap')!
      const pos = head.desc.positions
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
      for (let i = 0; i < pos.length; i += 3) {
        x0 = Math.min(x0, pos[i]!); x1 = Math.max(x1, pos[i]!)
        y0 = Math.min(y0, pos[i + 1]!); y1 = Math.max(y1, pos[i + 1]!)
      }
      expect((x0 + x1) / 2).toBeCloseTo(0, 4)
      expect((y0 + y1) / 2).toBeCloseTo(0.045, 4) // HEAD_AXIS_Y
      expect(x1 - x0).toBeCloseTo(0.04, 3) // a standard 40 mm head, wider than the plain cap's 0.0285: a mushroom
      expect(head.colorParam).toBeUndefined() // red whatever Button color says
    })

    it('latches in when struck, turns while still in, then springs out and turns back', () => {
      const tick = run()
      expect(tick().tag).toBe(true) // released: the normally-closed contact is made
      const struck = tick(true)
      expect(struck.tag).toBe(false) // the contact opens on the strike itself...
      expect(struck.pose.position![2]).toBeLessThan(0)
      expect(struck.pose.position![2]).toBeGreaterThan(-0.007) // ...while the head is drawn going in, not jumped
      let held = struck
      for (let i = 0; i < 120; i++) { held = tick(); expect(held.tag).toBe(false) } // latched: it stays in on its own
      // far enough in to see it come back out (8 mm on a 0.1 m head could not be seen retracting)
      expect(held.pose.position![2]).toBeCloseTo(-0.007, 6)

      let turned = 0, twistTicks = 0, s = tick(true)
      while (s.tag === false) {
        twistTicks++
        const turn = s.pose.rotation?.[2] ?? 0
        expect(turn).toBeLessThanOrEqual(0) // clockwise seen from the front, the way the face arrow points
        turned = Math.min(turned, turn)
        expect(s.pose.position![2]).toBeLessThan(0) // still in while it turns
        // the head's own axis (0, 0.045) stays put: R(turn) * axis + offset = axis
        const [px, py] = s.pose.position!
        expect(-0.045 * Math.sin(turn) + px).toBeCloseTo(0, 9)
        expect(0.045 * Math.cos(turn) + py).toBeCloseTo(0.045, 9)
        s = tick()
        expect(twistTicks).toBeLessThan(120)
      }
      expect(turned).toBeLessThan(-0.5) // it really turned, ~43 degrees, before the contact made
      // ...and promptly: the head is out within 0.6 s of the Use (0.8 s read as sluggish in the running sim)
      expect(twistTicks / 60).toBeLessThanOrEqual(0.6)
      // out: the head comes the whole way back out, as a motion, within a tenth of a second or so
      const outDepths: number[] = []
      for (let i = 0; i < 9; i++) { outDepths.push(s.pose.position![2]); s = tick() }
      expect(outDepths.some((d) => d < -0.001 && d > -0.006)).toBe(true) // a frame part-way out
      expect(s.pose.position![2]).toBe(0)
      for (let i = 0; i < 30; i++) s = tick()
      expect(s.pose.rotation).toBeUndefined() // and back at rest
      expect(s.tag).toBe(true)
    })

    it('set to start struck, it opens its contact from the first tick of a run', () => {
      const { def } = instantiatePartScript(PUSH_BUTTON_SDK_BEHAVIOR)
      let tag: boolean | undefined
      const ctx = {
        dt: 1 / 60,
        params: { emergencyStop: true, startStruck: true, momentary: true, normallyClosed: false, tag: 'EStop', lampSource: 'off', lampTag: '' },
        lamps: {} as Record<string, boolean>,
        used: () => false,
        readTag: () => false,
        tagDriven: () => false,
        writeTag: (_t: string, v: boolean) => { tag = v },
        setSubPose: () => {},
      }
      def!.init!(ctx as never)
      def!.step!(ctx as never)
      expect(tag).toBe(false) // struck: the normally-closed contact is open, so the line cannot start
    })

    it('ignores the momentary and normally-closed switches it overrides', () => {
      const tick = run() // the run sets momentary on and normallyClosed off, the settings an E-stop may not have
      expect(tick().tag).toBe(true) // normally closed regardless
      tick(true)
      for (let i = 0; i < 60; i++) expect(tick().tag).toBe(false) // latched, not a 0.3 s pulse
    })
  })
})
