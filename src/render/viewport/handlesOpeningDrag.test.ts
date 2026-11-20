import { beforeEach, describe, expect, it } from 'vitest'
import { PerspectiveCamera, Ray, Vector3 } from 'three'
import { clearPackages, registerPackage } from '../../core/parts/partRegistry'
import type { PartPackage } from '../../core/parts/partPackage'
import type { SdkPart } from '../../core/types'
import type { GuardOpeningHandle, ScreenProjector } from '../api'
import { examplePart, type RigGeo } from '../parts/examplePart'
import { ResizeHandles } from './handles'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'

// The guard-openings gizmo (G) reads the pointer off each guard wall, the line its dots sit on. Grabbing a dot
// must read back that dot's own row value from any viewpoint. On an inclined straight bed, a drag computed on a
// level line while the dots follow the slope snaps an end dot grabbed at 2.9 m on a 30-degree bed to 2.71 m. On
// a bent belt, a drag computed level at the part's base while the dots climb the incline makes a grab jump by up
// to 0.8 m depending on the camera.

const { geometry } = examplePart<RigGeo>('oip.roller-conveyor')
const rollerPkg = {
  format: PACKAGE_FORMAT,
  id: 'test.roller',
  name: 'Roller',
  conveyor: { bed: 'straight', surface: 'roller' },
  params: {
    length: { type: 'number', default: 4, handle: { kind: 'face', axis: 'x' } },
    width: { type: 'number', default: 1, handle: { kind: 'face', axis: 'z' } },
    tiltDeg: { type: 'number', default: 0 },
    guardOpenings: { type: 'numberList', arity: 3, default: [] },
  },
  behavior: 'definePart({ step(){} })',
  geometry,
} as unknown as PartPackage

// the belt's path handle is what makes a part belt-like (a path bed, conveyorBeds.ts); the shipped belt declares it so
const belt0 = examplePart('oip.belt-conveyor')
const beltPkg = {
  format: PACKAGE_FORMAT,
  id: 'test.belt',
  name: 'Belt',
  conveyor: { bed: 'path', surface: 'belt' },
  params: {
    segments: { type: 'numberList', arity: 2, default: [[4, 0]], handle: { kind: 'path', lengthCol: 0, tiltCol: 1 } },
    width: { type: 'number', default: 1 },
    height: { type: 'number', default: 0.2 },
    guardOpenings: { type: 'numberList', arity: 3, default: [] },
  },
  behavior: belt0.behavior,
  geometry: belt0.geometry,
} as unknown as PartPackage

const roller = (tiltDeg: number): SdkPart => ({
  id: 'r',
  type: 'part',
  packageId: 'test.roller',
  position: [2, 1, 3],
  rotationY: 0.4,
  params: { length: 3, width: 1, tiltDeg, guardOpenings: [[1, 2.9, 1]] },
})

const belt = (segments: number[][]): SdkPart =>
  ({
    id: 'b',
    type: 'part',
    packageId: 'test.belt',
    position: [2, 1, 3],
    rotationY: 0.4,
    params: { segments, width: 1, height: 0.2, guardOpenings: [[1, 4, 1]] },
  }) as unknown as SdkPart

type Cube = { handle: GuardOpeningHandle | null; group: { position: Vector3; visible: boolean } }

/** a camera at `eye` looking at `at`, as a 1000 px square viewport */
function screenAt(eye: Vector3, at: Vector3): { cam: PerspectiveCamera; proj: (px: number, py: number) => ScreenProjector } {
  const cam = new PerspectiveCamera(50, 1, 0.05, 500)
  cam.position.copy(eye)
  cam.lookAt(at)
  cam.updateMatrixWorld(true)
  const project = (p: { x: number; y: number; z: number }) => {
    const v = new Vector3(p.x, p.y, p.z).project(cam)
    return v.z < -1 || v.z > 1 ? null : { x: ((v.x + 1) / 2) * 1000, y: ((1 - v.y) / 2) * 1000 }
  }
  return { cam, proj: (x, y) => ({ project, x, y }) }
}

function handlesFor(part: SdkPart): { h: ResizeHandles; cubes: Cube[] } {
  const h = new ResizeHandles()
  h.setSideGuardMode(true)
  h.setPart(part)
  return { h, cubes: (h as unknown as { openingCubes: Cube[] }).openingCubes }
}

/** grab the dot for `edge` of opening 0 on the right wall with the pointer exactly on it, seen from `eye` */
function grab(part: SdkPart, edge: 'start' | 'end', eye: Vector3): number | null {
  const { h, cubes } = handlesFor(part)
  const cube = cubes.find((c) => c.group.visible && c.handle?.guard === 'right' && c.handle.opening === 0 && c.handle.edge === edge)
  if (!cube) throw new Error('no dot for opening 0')
  const dot = cube.group.position.clone()
  const { proj } = screenAt(eye, dot)
  const px = proj(0, 0).project(dot)!
  h.beginDrag(cube.handle!)
  return h.dragExtent(new Ray(eye, dot.clone().sub(eye).normalize()), proj(px.x, px.y))
}

const EYES = [new Vector3(4, 6, 9), new Vector3(-3, 2, -1), new Vector3(8, 3, 3), new Vector3(-4, 5, 0)]

beforeEach(() => {
  clearPackages()
  registerPackage(rollerPkg)
  registerPackage(beltPkg)
})

describe('guard opening drag reads back the grabbed dot', () => {
  it('the incline param is live on the roller fixture (else the tilt cases are vacuous)', () => {
    expect(geometry.inclineParam).toBe('tiltDeg')
  })

  for (const tilt of [0, 30, -20]) {
    it(`on an inclined straight bed (tilt ${tilt} deg), from any viewpoint`, () => {
      for (const eye of EYES) {
        expect(grab(roller(tilt), 'end', eye)).toBeCloseTo(2.9, 4)
        expect(grab(roller(tilt), 'start', eye)).toBeCloseTo(1, 4)
      }
    })
  }

  for (const [name, segs] of [['flat', [[5, 0]]], ['bent', [[1, 0], [3, 25], [1, 0]]]] as const) {
    it(`on a ${name} belt, from any viewpoint`, () => {
      for (const eye of EYES) {
        expect(grab(belt(segs as unknown as number[][]), 'end', eye)).toBeCloseTo(4, 3)
        expect(grab(belt(segs as unknown as number[][]), 'start', eye)).toBeCloseTo(1, 3)
      }
    })
  }
})

describe('pickWall', () => {
  it('finds the wall and row value under the pointer, and nothing off the guard', () => {
    const { h, cubes } = handlesFor(roller(0))
    const dot = cubes.find((c) => c.group.visible && c.handle?.guard === 'right' && c.handle.edge === 'end')!.group.position.clone()
    const eye = new Vector3(4, 6, 9)
    const { proj } = screenAt(eye, dot)
    const px = proj(0, 0).project(dot)!
    const hit = h.pickWall(new Ray(eye, dot.clone().sub(eye).normalize()), proj(px.x, px.y), 14)
    expect(hit?.guard).toBe('right')
    expect(hit?.s).toBeCloseTo(2.9, 4)
    // 200 px away is not on the guard
    const far = new Ray(eye, dot.clone().add(new Vector3(0, 3, 0)).sub(eye).normalize())
    expect(h.pickWall(far, proj(px.x, px.y - 200), 14)).toBeNull()
  })

  it('a wall whose guard is switched off is not a wall: no pick, no dots', () => {
    const part = roller(0)
    const { h, cubes } = handlesFor({ ...part, params: { ...part.params, rightGuard: false } } as SdkPart)
    expect(cubes.filter((c) => c.group.visible)).toHaveLength(0) // the one opening was on the right wall
    const walls = (h as unknown as { walls: Record<'left' | 'right', { p: Vector3[] }> }).walls
    expect(walls.right.p).toHaveLength(0)
    expect(walls.left.p.length).toBeGreaterThan(1)
  })

  it('a gap a neighbour already cut is not solid guard: no pick there, unless an authored opening overlaps it', () => {
    const part = { ...roller(0), params: { ...roller(0).params, guardOpenings: [] } } as SdkPart
    const { h } = handlesFor(part)
    const walls = (h as unknown as { walls: Record<'left' | 'right', { p: Vector3[] }> }).walls
    // aim at the right wall's midpoint (s = 1.5 on the 3 m bed)
    const at = walls.right.p[0]!.clone().lerp(walls.right.p[1]!, 0.5)
    const eye = new Vector3(4, 6, 9)
    const { proj } = screenAt(eye, at)
    const px = proj(0, 0).project(at)!
    const pick = () => h.pickWall(new Ray(eye, at.clone().sub(eye).normalize()), proj(px.x, px.y), 14)
    expect(pick()?.s).toBeCloseTo(1.5, 4)
    h.setJunctionOpenings({ left: [], right: [[1, 2]] })
    expect(pick()).toBeNull()
    const authored = handlesFor({ ...part, params: { ...part.params, guardOpenings: [[1.2, 1.8, 1]] } } as SdkPart).h
    authored.setJunctionOpenings({ left: [], right: [[1, 2]] })
    expect(authored.pickWall(new Ray(eye, at.clone().sub(eye).normalize()), proj(px.x, px.y), 14)?.s).toBeCloseTo(1.5, 4)
  })

  it('hovering a guard does not wipe the hover colour of the dot under the pointer', () => {
    const { h, cubes } = handlesFor(roller(0))
    const cube = cubes.find((c) => c.group.visible)! as Cube & { sprite: { material: unknown } }
    h.setHighlight(cube.handle)
    const hot = cube.sprite.material
    h.setWallHover(null) // the controller calls this on every pointer move, right after setHighlight
    expect(cube.sprite.material).toBe(hot)
    h.setSelectedOpening(null)
    expect(cube.sprite.material).toBe(hot)
  })

  it('shows no dots for the guard ends any more: only opening edges are dots', () => {
    const { cubes } = handlesFor(roller(0))
    const visible = cubes.filter((c) => c.group.visible)
    expect(visible).toHaveLength(2) // one opening on the right wall: its two edges
    expect(visible.every((c) => c.handle!.opening === 0)).toBe(true)
  })
})
