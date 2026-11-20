import { describe, expect, it } from 'vitest'
import { PerspectiveCamera, Quaternion, Ray, Raycaster, Vector3 } from 'three'
import { TransformGizmo } from './gizmo'

/** a downward ray whose XZ-plane intersection is (x, 0, z) - the gizmo math works off that point */
function downRay(x: number, z: number): Ray {
  return new Ray(new Vector3(x, 5, z), new Vector3(0, -1, 0))
}

/** a ray along -Z whose z=0 (XY-plane) intersection is (x, y, 0) */
function zRay(x: number, y: number): Ray {
  return new Ray(new Vector3(x, y, 5), new Vector3(0, 0, -1))
}

/** a ray along -X whose x=0 (YZ-plane) intersection is (0, y, z) */
function xRay(y: number, z: number): Ray {
  return new Ray(new Vector3(5, y, z), new Vector3(-1, 0, 0))
}

/** a camera looking along -Z, so the view (free-translate) plane is z=0 */
const CAM_FWD_Z = new Vector3(0, 0, -1)

/** a perspective ray from a fixed camera position toward a world target (rings read this) */
function rayFrom(cam: [number, number, number], target: [number, number, number]): Ray {
  const o = new Vector3(...cam)
  return new Ray(o, new Vector3(...target).sub(o).normalize())
}

describe('TransformGizmo grid snap', () => {
  it('quantizes axis translation to the snap step', () => {
    const g = new TransformGizmo()
    g.setState({ center: [0, 0, 0], rotationY: 0, mode: 'move', space: 'global' })
    g.beginDrag('x', downRay(0, 0))
    // unsnapped: the raw distance travelled along +X passes straight through
    expect(g.dragDelta(downRay(2.3, 0))?.translation?.[0]).toBeCloseTo(2.3, 5)
    // snapped to a 1 m grid: 2.3 -> 2
    const snapped = g.dragDelta(downRay(2.3, 0), { translate: 1, rotate: null })?.translation
    expect(snapped?.[0]).toBeCloseTo(2, 5)
    expect(snapped?.[2]).toBeCloseTo(0, 5)
    g.dispose()
  })

  it('quantizes rotation to the snap step', () => {
    const g = new TransformGizmo()
    g.setState({ center: [0, 0, 0], rotationY: 0, mode: 'rotate', space: 'global' })
    g.beginDrag('rotY', downRay(1, 0)) // start azimuth 0
    // ~0.35 rad turn snapped to 15 deg (0.2618 rad) steps -> nearest is one step
    const d = g.dragDelta(downRay(Math.cos(0.35), -Math.sin(0.35)), { translate: null, rotate: Math.PI / 12 })
    expect(d?.rotationDelta).toBeCloseTo(Math.PI / 12, 5)
    g.dispose()
  })

  it('moves along world axes in global space and the part axes in local space', () => {
    const local = new TransformGizmo()
    local.setState({ center: [0, 0, 0], rotationY: Math.PI / 2, mode: 'move', space: 'local' })
    local.beginDrag('x', downRay(0, 0))
    // local +X of a 90 deg-yawed part points along world -Z, so a +X drag slides in Z
    const lt = local.dragDelta(downRay(0, -2))?.translation
    expect(lt?.[0]).toBeCloseTo(0, 5)
    expect(lt?.[2]).toBeCloseTo(-2, 5)
    local.dispose()

    const global = new TransformGizmo()
    global.setState({ center: [0, 0, 0], rotationY: Math.PI / 2, mode: 'move', space: 'global' })
    global.beginDrag('x', downRay(0, 0))
    // global ignores the yaw: +X stays world +X
    const gt = global.dragDelta(downRay(2, 0))?.translation
    expect(gt?.[0]).toBeCloseTo(2, 5)
    expect(gt?.[2]).toBeCloseTo(0, 5)
    global.dispose()
  })
})

describe('TransformGizmo planes + view drag', () => {
  it('xy/yz plane pads ride their plane (the third axis stays put)', () => {
    const g = new TransformGizmo()
    g.setState({ center: [0, 0, 0], rotationY: 0, mode: 'move', space: 'global' })

    g.beginDrag('xy', zRay(0, 0))
    const xy = g.dragDelta(zRay(2, 3))?.translation
    expect(xy?.[0]).toBeCloseTo(2, 5)
    expect(xy?.[1]).toBeCloseTo(3, 5)
    expect(xy?.[2]).toBeCloseTo(0, 5)

    g.beginDrag('yz', xRay(0, 0))
    const yz = g.dragDelta(xRay(3, 2))?.translation
    expect(yz?.[0]).toBeCloseTo(0, 5)
    expect(yz?.[1]).toBeCloseTo(3, 5)
    expect(yz?.[2]).toBeCloseTo(2, 5)
    g.dispose()
  })

  it('a view (body) drag moves freely on the camera-facing plane', () => {
    const g = new TransformGizmo()
    g.setState({ center: [0, 0, 0], rotationY: 0, mode: 'move', space: 'global' })
    g.beginDrag('view', zRay(0, 0), CAM_FWD_Z)
    const t = g.dragDelta(zRay(2, 1))?.translation
    expect(t?.[0]).toBeCloseTo(2, 5)
    expect(t?.[1]).toBeCloseTo(1, 5)
    expect(t?.[2]).toBeCloseTo(0, 5)
    g.dispose()
  })
})

describe('TransformGizmo keyboard constraint', () => {
  it('X locks a view drag to the X axis; pressing X again twice releases it', () => {
    const g = new TransformGizmo()
    g.setState({ center: [0, 0, 0], rotationY: 0, mode: 'move', space: 'global' })
    g.beginDrag('view', zRay(0, 0), CAM_FWD_Z)

    // press X -> global X axis: the Y component is masked away
    g.constrain('x')
    const locked = g.dragDelta(zRay(2, 1))?.translation
    expect(locked?.[0]).toBeCloseTo(2, 5)
    expect(locked?.[1]).toBeCloseTo(0, 5)

    // press X again (local, same axis at yaw 0) -> still X only
    g.constrain('x')
    expect(g.dragDelta(zRay(2, 1))?.translation?.[1]).toBeCloseTo(0, 5)

    // third press releases back to the free view plane: Y returns
    g.constrain('x')
    expect(g.dragDelta(zRay(2, 1))?.translation?.[1]).toBeCloseTo(1, 5)
    g.dispose()
  })
})

describe('TransformGizmo 3-DOF rotation', () => {
  it('the Z ring viewed face-on rotates about world Z by the swept angle', () => {
    const g = new TransformGizmo()
    g.setState({ center: [0, 0, 0], rotationY: 0, mode: 'rotate', space: 'global' })
    // camera on +Z looking at the origin: the Z ring (XY plane) is face-on
    g.beginDrag('rotZ', rayFrom([0, 0, 5], [1, 0, 0]), CAM_FWD_Z)
    const d = g.dragDelta(rayFrom([0, 0, 5], [Math.cos(0.4), Math.sin(0.4), 0]))
    expect(d?.rotationAxis?.[2]).toBeCloseTo(1, 5)
    expect(d?.rotationAxis?.[0]).toBeCloseTo(0, 5)
    expect(d?.rotationDelta).toBeCloseTo(0.4, 5)
    g.dispose()
  })

  it('the X ring viewed face-on rotates about world X by the swept angle', () => {
    const g = new TransformGizmo()
    g.setState({ center: [0, 0, 0], rotationY: 0, mode: 'rotate', space: 'global' })
    // camera on +X looking at the origin: the X ring (YZ plane) is face-on
    g.beginDrag('rotX', rayFrom([5, 0, 0], [0, 1, 0]), new Vector3(-1, 0, 0))
    const d = g.dragDelta(rayFrom([5, 0, 0], [0, Math.cos(0.3), Math.sin(0.3)]))
    expect(d?.rotationAxis?.[0]).toBeCloseTo(1, 5)
    expect(d?.rotationAxis?.[1]).toBeCloseTo(0, 5)
    expect(d?.rotationDelta).toBeCloseTo(0.3, 5)
    g.dispose()
  })

  it('an edge-on ring falls back to a linear drag (one gizmo-radius = 90deg)', () => {
    const g = new TransformGizmo()
    g.setState({ center: [0, 0, 0], rotationY: 0, mode: 'rotate', space: 'global' })
    // camera on +Z, but grabbing the X ring: its axis lies in the screen plane (edge-on),
    // so the angular reading is replaced by a linear drag along (camNormal x axisX) = -Y.
    // unit scale + unit radius -> dragging the cursor +0.5 in world Y = -PI/4.
    g.beginDrag('rotX', rayFrom([0, 0, 5], [0, 0.3, 0]), CAM_FWD_Z)
    const d = g.dragDelta(rayFrom([0, 0, 5], [0, 0.8, 0]))
    expect(d?.rotationAxis?.[0]).toBeCloseTo(1, 5)
    expect(d?.rotationDelta).toBeCloseTo(-Math.PI / 4, 5)
    g.dispose()
  })

  it('builds the rotation feedback (circle + arc + cursor line) without error', () => {
    const g = new TransformGizmo()
    g.setState({ center: [0, 0, 0], rotationY: 0, mode: 'rotate', space: 'global' })
    g.beginDrag('rotZ', rayFrom([0, 0, 5], [1, 0, 0]), CAM_FWD_Z)
    g.dragDelta(rayFrom([0, 0, 5], [Math.cos(0.5), Math.sin(0.5), 0]))
    expect(() => g.setRotationFeedback(0.5)).not.toThrow()
    expect(() => g.setRotationFeedback(-3 * Math.PI)).not.toThrow() // clamps past a full turn
    expect(() => g.setRotationFeedback(null)).not.toThrow()
    g.dispose()
  })

  it('in local space the X ring rotates about the part local X (yawed 90deg -> world -Z)', () => {
    const g = new TransformGizmo()
    g.setState({ center: [0, 0, 0], rotationY: Math.PI / 2, mode: 'rotate', space: 'local' })
    // the part's local X (yawed 90deg) points along world -Z, so view it face-on from +Z
    g.beginDrag('rotX', rayFrom([0, 0, 5], [1, 0, 0]), CAM_FWD_Z)
    const d = g.dragDelta(rayFrom([0, 0, 5], [Math.cos(0.3), Math.sin(0.3), 0]))
    expect(d?.rotationAxis?.[0]).toBeCloseTo(0, 5)
    expect(d?.rotationAxis?.[1]).toBeCloseTo(0, 5)
    expect(Math.abs(d?.rotationAxis?.[2] ?? 0)).toBeCloseTo(1, 5)
    g.dispose()
  })

  it('keyboard X re-picks the rotation axis mid-drag (global -> local -> view)', () => {
    const g = new TransformGizmo()
    const camNormal = new Vector3(0, -1, 0) // looking straight down
    // part yawed 90deg so its local X points along world -Z
    g.setState({ center: [0, 0, 0], rotationY: Math.PI / 2, mode: 'rotate', space: 'global' })
    g.beginDrag('rotZ', rayFrom([0, 5, 0], [0.3, 0, 0.3]), camNormal)

    // press X -> global world X
    g.constrain('x')
    const globalX = g.dragDelta(rayFrom([0, 5, 0], [0.3, 0, 0.3]))?.rotationAxis
    expect(globalX?.[0]).toBeCloseTo(1, 5)
    expect(globalX?.[1]).toBeCloseTo(0, 5)
    expect(globalX?.[2]).toBeCloseTo(0, 5)

    // press X again -> local X (yawed 90deg about Y -> world -Z)
    g.constrain('x')
    const localX = g.dragDelta(rayFrom([0, 5, 0], [0.3, 0, 0.3]))?.rotationAxis
    expect(localX?.[0]).toBeCloseTo(0, 5)
    expect(Math.abs(localX?.[2] ?? 0)).toBeCloseTo(1, 5)

    // press X a third time -> view axis (camera normal)
    g.constrain('x')
    expect(g.dragDelta(rayFrom([0, 5, 0], [0.3, 0, 0.3]))?.rotationAxis?.[1]).toBeCloseTo(-1, 5)
    g.dispose()
  })

  it('a plane lock (yz/xz/xy) is ignored for a rotation ring (rotate has no plane constraint)', () => {
    const g = new TransformGizmo()
    g.setState({ center: [0, 0, 0], rotationY: 0, mode: 'rotate', space: 'global' })
    g.beginDrag('rotZ', rayFrom([0, 0, 5], [1, 0, 0]), CAM_FWD_Z)
    g.constrain('xy') // plane target -> no-op for a ring; the Z axis stays
    expect(g.dragDelta(rayFrom([0, 0, 5], [1, 0, 0]))?.rotationAxis?.[2]).toBeCloseTo(1, 5)
    g.dispose()
  })
})

describe('TransformGizmo trackball', () => {
  // camera looking along -Z: screen right = world +X, screen up = world +Y
  const grab = { x: 100, y: 100 }

  it('a horizontal drag rotates about the camera up axis (world +Y)', () => {
    const g = new TransformGizmo()
    g.setState({ center: [0, 0, 0], rotationY: 0, mode: 'rotate', space: 'global' })
    g.beginDrag('rotTrackball', zRay(0, 0), CAM_FWD_Z, grab)
    const d = g.dragDelta(zRay(0, 0), null, { x: 200, y: 100 }) // dx = +100 px
    expect(d?.rotationAxis?.[0]).toBeCloseTo(0, 5)
    expect(d?.rotationAxis?.[1]).toBeCloseTo(1, 5)
    expect(d?.rotationAxis?.[2]).toBeCloseTo(0, 5)
    expect(d?.rotationDelta).toBeCloseTo(100 * 0.005, 5) // sensitivity * pixels
    g.dispose()
  })

  it('a vertical drag rotates about the camera right axis (world +X)', () => {
    const g = new TransformGizmo()
    g.setState({ center: [0, 0, 0], rotationY: 0, mode: 'rotate', space: 'global' })
    g.beginDrag('rotTrackball', zRay(0, 0), CAM_FWD_Z, grab)
    const d = g.dragDelta(zRay(0, 0), null, { x: 100, y: 220 }) // dy = +120 px
    expect(d?.rotationAxis?.[0]).toBeCloseTo(1, 5)
    expect(d?.rotationAxis?.[1]).toBeCloseTo(0, 5)
    expect(d?.rotationAxis?.[2]).toBeCloseTo(0, 5)
    expect(d?.rotationDelta).toBeCloseTo(120 * 0.005, 5)
    g.dispose()
  })

  it('combines axes for a diagonal drag and snaps the angle', () => {
    const g = new TransformGizmo()
    g.setState({ center: [0, 0, 0], rotationY: 0, mode: 'rotate', space: 'global' })
    g.beginDrag('rotTrackball', zRay(0, 0), CAM_FWD_Z, grab)
    // equal dx/dy -> axis bisects up (Y) and right (X)
    const d = g.dragDelta(zRay(0, 0), { translate: null, rotate: Math.PI / 12 }, { x: 160, y: 160 })
    expect(d?.rotationAxis?.[0]).toBeCloseTo(Math.SQRT1_2, 5)
    expect(d?.rotationAxis?.[1]).toBeCloseTo(Math.SQRT1_2, 5)
    // raw angle = |(60,60)|*0.005 = 0.4243 rad -> snapped to nearest 15deg step (2 steps)
    expect(d?.rotationDelta).toBeCloseTo(Math.PI / 6, 5)
    g.dispose()
  })

  it('reports no rotation before the pointer moves', () => {
    const g = new TransformGizmo()
    g.setState({ center: [0, 0, 0], rotationY: 0, mode: 'rotate', space: 'global' })
    g.beginDrag('rotTrackball', zRay(0, 0), CAM_FWD_Z, grab)
    expect(g.dragDelta(zRay(0, 0), null, grab)?.rotationDelta).toBe(0)
    g.dispose()
  })

  it('the interior is only pickable while the toggle is on', () => {
    const g = new TransformGizmo()
    // a diagonal ray through the center hits the interior sphere but misses every ring
    const rc = new Raycaster(new Vector3(5, 5, 5), new Vector3(-1, -1, -1).normalize())
    g.setState({ center: [0, 0, 0], rotationY: 0, mode: 'rotate', space: 'global', trackball: false })
    expect(g.pick(rc)).toBeNull()
    g.setState({ center: [0, 0, 0], rotationY: 0, mode: 'rotate', space: 'global', trackball: true })
    expect(g.pick(rc)).toBe('rotTrackball')
    g.dispose()
  })
})

describe('TransformGizmo half-ring pick', () => {
  // gizmo yawed 20deg in local space so the X ring (YZ plane) reads obliquely (not
  // edge-on, not face-on): its away half projects across the gizmo interior but is
  // draw-discarded by the halfRing shader. The pick must reject that unseen half too,
  // otherwise it takes the hover/grab and hides the interior trackball ball. At 20deg the
  // X ring's screen ellipse is thin (x half = sin20), so the other rings don't reach
  // these (+-0.242, -0.707) screen points, isolating the two halves of the X ring.
  const state = {
    center: [0, 0, 0] as [number, number, number],
    rotationY: Math.PI / 9, // 20deg
    rotationX: 0,
    rotationZ: 0,
    mode: 'rotate' as const,
    space: 'local' as const,
    trackball: true,
  }
  // a -Z raycaster whose XY-plane (screen) intersection is (x, y)
  const rc = (x: number, y: number) => new Raycaster(new Vector3(x, y, 5), new Vector3(0, 0, -1))

  it('does not grab the invisible (away) half of a tilted ring', () => {
    const g = new TransformGizmo()
    g.setState(state)
    // the X ring's away-half centerline projects here but is drawn-discarded, so the
    // pick falls through to the interior trackball instead of grabbing the unseen ring
    expect(g.pick(rc(-0.242, -0.707))).toBe('rotTrackball')
    g.dispose()
  })

  it('still grabs the visible (near) half at the mirror point', () => {
    const g = new TransformGizmo()
    g.setState(state)
    // the X ring's near (camera-facing) half is drawn at the mirror screen point
    expect(g.pick(rc(0.242, -0.707))).toBe('rotX')
    g.dispose()
  })
})

describe('TransformGizmo frame + locks (a rig node: handles in its parent frame, owned axes left out)', () => {
  const down = (x: number, z: number) => new Raycaster(new Vector3(x, 5, z), new Vector3(0, -1, 0))

  it('a frame orients the local axes whole, not by yaw alone', () => {
    // a parent pitched +90 deg about X: its local +Y points along world +Z
    const s = Math.SQRT1_2
    const g = new TransformGizmo()
    g.setState({ center: [0, 0, 0], rotationY: 0, mode: 'move', space: 'local', frame: [s, 0, 0, s] })
    g.beginDrag('y', downRay(0, 0))
    const t = g.dragDelta(downRay(0, 2))?.translation
    expect(t?.[0]).toBeCloseTo(0, 5)
    expect(t?.[1]).toBeCloseTo(0, 5)
    expect(t?.[2]).toBeCloseTo(2, 5) // along the frame's Y = world +Z
    g.dispose()
  })

  it('a locked move axis has no arrow to grab', () => {
    const g = new TransformGizmo()
    g.setState({ center: [0, 0, 0], rotationY: 0, mode: 'move', space: 'global' })
    expect(g.pick(down(0.8, 0))).toBe('x') // the X arrow is there...
    g.setState({ center: [0, 0, 0], rotationY: 0, mode: 'move', space: 'global', lockMove: [true, false, false] })
    expect(g.pick(down(0.8, 0))).not.toBe('x') // ...and gone when X is the part's
    expect(g.pick(down(0, 0.8))).toBe('z') // the free axes keep theirs
    g.dispose()
  })

  it('a locked rotation has no ring to grab, and a trackball drag ending does not bring them back', () => {
    const g = new TransformGizmo()
    g.setState({ center: [0, 0, 0], rotationY: 0, mode: 'rotate', space: 'global' })
    expect(g.pick(down(Math.SQRT1_2, Math.SQRT1_2))).toBe('rotY')
    g.setState({ center: [0, 0, 0], rotationY: 0, mode: 'rotate', space: 'global', lockRotate: true })
    expect(g.pick(down(Math.SQRT1_2, Math.SQRT1_2))).toBeNull()
    g.endDrag()
    expect(g.pick(down(Math.SQRT1_2, Math.SQRT1_2))).toBeNull()
    g.dispose()
  })
})

describe('TransformGizmo plane pads follow the camera quadrant', () => {
  const state = { center: [0, 0, 0] as [number, number, number], rotationY: 0, mode: 'move' as const, space: 'global' as const }

  /** a camera at `pos` looking at the gizmo, already matrix-synced */
  function cameraAt(pos: [number, number, number]): PerspectiveCamera {
    const cam = new PerspectiveCamera(50, 1, 0.1, 1000)
    cam.position.set(...pos)
    cam.lookAt(0, 0, 0)
    cam.updateMatrixWorld(true)
    return cam
  }

  /** raycaster from the camera through the XZ pad's centre in the (sx, sz) quadrant */
  function padRay(g: TransformGizmo, cam: PerspectiveCamera, sx: number, sz: number): Raycaster {
    const s = g.root.scale.x
    const target = new Vector3(sx * 0.42 * s, 0, sz * 0.42 * s)
    return new Raycaster(cam.position.clone(), target.sub(cam.position).normalize())
  }

  it('keeps the baked +/+ quadrant for a camera on the +X/+Z side', () => {
    const g = new TransformGizmo()
    g.setState(state)
    const cam = cameraAt([5, 5, 5])
    g.updateScale(cam, 800)
    expect(g.pick(padRay(g, cam, 1, 1))).toBe('xz')
    g.dispose()
  })

  it('moves the pad to the near quadrant when the camera orbits behind it', () => {
    const g = new TransformGizmo()
    g.setState(state)
    const cam = cameraAt([-5, 5, -5])
    g.updateScale(cam, 800)
    // the pad (and the proxy that picks it) now sit in -X/-Z, nearest the camera
    expect(g.pick(padRay(g, cam, -1, -1))).toBe('xz')
    // and no longer in the quadrant they were baked into
    expect(g.pick(padRay(g, cam, 1, 1))).not.toBe('xz')
    g.dispose()
  })

  it('holds the quadrant while a drag is live', () => {
    const g = new TransformGizmo()
    g.setState(state)
    const near = cameraAt([5, 5, 5])
    g.updateScale(near, 800)
    g.beginDrag('xz', downRay(0, 0))
    // the part crosses to the far side of the camera mid-drag: the grabbed pad must
    // not jump quadrants out from under the cursor
    const far = cameraAt([-5, 5, -5])
    g.updateScale(far, 800)
    // (asserted from the near side: a ray at the +/+ pad would cross the Y arrow first)
    expect(g.pick(padRay(g, far, -1, -1))).not.toBe('xz')
    g.endDrag()
    g.updateScale(far, 800)
    expect(g.pick(padRay(g, far, -1, -1))).toBe('xz')
    g.dispose()
  })
})

describe('TransformGizmo drag guards', () => {
  /** a ray from `cam` along the -Z view, pitched `pitch` radians up (negative: down) */
  const pitched = (cam: [number, number, number], pitch: number): Ray =>
    new Ray(new Vector3(...cam), new Vector3(0, Math.sin(pitch), -Math.cos(pitch)))

  it('a floor-plane drag past the horizon neither flips behind the camera nor runs off to the horizon', () => {
    const g = new TransformGizmo()
    g.setState({ center: [0, 0, 0], rotationY: 0, mode: 'move', space: 'global' })
    const cam: [number, number, number] = [0, 1, 10]
    g.beginDrag('xz', rayFrom(cam, [0, 0, 0]))
    const before = g.dragDelta(rayFrom(cam, [0, 0, -2]))?.translation
    expect(before?.[2]).toBeCloseTo(-2, 5)
    // just above the horizon the floor plane is behind the camera: the part holds where it was (it went to z +1010)
    const above = g.dragDelta(pitched(cam, 0.001))?.translation
    expect(above?.[2]).toBeCloseTo(-2, 5)
    // just below it the hit is ~1 km out: the travel stops at 20 camera distances
    const below = g.dragDelta(pitched(cam, -0.001))?.translation
    expect(Math.hypot(below![0], below![1], below![2])).toBeLessThanOrEqual(20 * Math.hypot(1, 10) + 1e-6)
    g.dispose()
  })

  it('an orthographic floor-plane drag follows the cursor even where the plane is behind the ray origin', () => {
    const g = new TransformGizmo()
    g.setState({ center: [0, 0, 0], rotationY: 0, mode: 'move', space: 'global' })
    // orthographic rays are parallel and start on the camera plane: 10° down, this one from below the floor
    const dir = new Vector3(0, -Math.sin(Math.PI / 18), -Math.cos(Math.PI / 18))
    const at = (y: number, z: number): Ray => new Ray(new Vector3(0, y, z), dir.clone())
    g.beginDrag('xz', at(10 * Math.sin(Math.PI / 18), 10 * Math.cos(Math.PI / 18)), dir.clone().normalize(), undefined, true)
    const t = g.dragDelta(at(-1, 10))?.translation
    // that ray meets the floor at z = 10 + 1/tan(10°), behind its origin, and it is still the point under the cursor
    expect(t?.[2]).toBeCloseTo(10 + 1 / Math.tan(Math.PI / 18), 3)
    g.dispose()
  })

  it('grid snap steps a local-axis drag of a yawed part along that axis', () => {
    const g = new TransformGizmo()
    const yaw = Math.PI / 6
    g.setState({ center: [0, 0, 0], rotationY: yaw, mode: 'move', space: 'local' })
    g.beginDrag('x', downRay(0, 0))
    const ax = { x: Math.cos(yaw), z: -Math.sin(yaw) } // the part's local +X in world
    // 1.2 m along the axis snaps to one 1 m step ON the axis (world-component snapping gave (1, 0, 0), 0.5 m off it)
    const t = g.dragDelta(downRay(1.2 * ax.x, 1.2 * ax.z), { translate: 1, rotate: null })?.translation
    expect(t?.[0]).toBeCloseTo(ax.x, 5)
    expect(t?.[2]).toBeCloseTo(ax.z, 5)
    g.dispose()
  })

  it('a tilted ring turns by the cursor angle on the ring itself, step for step', () => {
    const g = new TransformGizmo()
    g.setState({ center: [0, 0, 0], rotationY: 0, mode: 'rotate', space: 'global' })
    // the camera 40° above the yaw ring, looking at its centre: the ring is an ellipse on screen
    const e = (40 * Math.PI) / 180
    const cam: [number, number, number] = [0, 10 * Math.sin(e), 10 * Math.cos(e)]
    const onRing = (deg: number): [number, number, number] => [Math.cos((deg * Math.PI) / 180), 0, -Math.sin((deg * Math.PI) / 180)]
    g.beginDrag('rotY', rayFrom(cam, onRing(-60)), new Vector3(...cam).negate().normalize())
    // the camera-facing reading turned these even 15° steps into 3°-ish then ~30°-ish steps
    for (let deg = -45; deg <= 120; deg += 15) {
      const d = g.dragDelta(rayFrom(cam, onRing(deg)))
      expect(d?.rotationAxis).toEqual([0, 1, 0])
      expect(d?.rotationDelta).toBeCloseTo(((deg + 60) * Math.PI) / 180, 5)
    }
    g.dispose()
  })

  it('the rotation wedge stays on the grab point while a local-space gizmo turns with the part', () => {
    const g = new TransformGizmo()
    g.setState({ center: [0, 0, 0], rotationY: 0, mode: 'rotate', space: 'local' })
    g.beginDrag('rotY', downRay(1, 0)) // grab on world +X
    g.dragDelta(downRay(Math.cos(0.5), -Math.sin(0.5)))
    g.setRotationFeedback(0.5)
    // the part turns by the drag, so the local gizmo turns with it: the wedge must not turn again on top
    g.setState({ center: [0, 0, 0], rotationY: 0.5, mode: 'rotate', space: 'local' })
    g.root.updateMatrixWorld(true)
    const internals = g as unknown as { edgeGeo: { getAttribute(n: string): { array: ArrayLike<number> } }; feedbackGroup: { matrixWorld: import('three').Matrix4 } }
    const a = internals.edgeGeo.getAttribute('position').array
    const start = new Vector3(a[3], a[4], a[5]).applyMatrix4(internals.feedbackGroup.matrixWorld).normalize()
    expect(start.x).toBeCloseTo(1, 5)
    expect(start.z).toBeCloseTo(0, 5)
    g.dispose()
  })

  it('a yaw-only ring ignores the X/Y/Z axis re-pick (a conveyor never leaves its yaw axis)', () => {
    const g = new TransformGizmo()
    g.setState({ center: [0, 0, 0], rotationY: 0, mode: 'rotate', space: 'global', rotateYawOnly: true })
    g.beginDrag('rotY', downRay(1, 0))
    for (const key of ['x', 'z', 'y', 'y', 'y'] as const) g.constrain(key)
    const d = g.dragDelta(downRay(Math.cos(0.4), -Math.sin(0.4)))
    expect(d?.rotationAxis).toEqual([0, 1, 0])
    // still the yaw drag (each offset down-ray reads its angle on a slightly different camera-facing plane)
    expect(d?.rotationDelta).toBeCloseTo(0.4, 1)
    g.dispose()
  })
})

describe('TransformGizmo view ring off the screen centre', () => {
  // a camera at the origin looking down -Z, and a part ahead and well to the right: its line of sight is not -Z
  const centre: [number, number, number] = [3, 0, -5]
  const sight = new Vector3(...centre).normalize()

  it('in perspective turns about the line of sight to the part, not the camera forward', () => {
    const g = new TransformGizmo()
    g.setState({ center: centre, rotationY: 0, mode: 'rotate', space: 'global' })
    g.beginDrag('rotView', rayFrom([0, 0, 0], [3.6, 0.2, -5]), CAM_FWD_Z)
    const axis = g.dragDelta(rayFrom([0, 0, 0], [3.4, 0.6, -5]))?.rotationAxis
    expect(axis).toBeDefined()
    const a = new Vector3(...axis!)
    // the same line either way round: the sign only says which way the turn is measured
    expect(Math.abs(a.dot(sight))).toBeCloseTo(1, 5)
    g.dispose()
  })

  it('in orthographic keeps the camera normal: every sight line is parallel', () => {
    const g = new TransformGizmo()
    g.setState({ center: centre, rotationY: 0, mode: 'rotate', space: 'global' })
    // an orthographic ray starts on the near plane, not at a camera point
    g.beginDrag('rotView', new Ray(new Vector3(3.6, 0.2, 5), new Vector3(0, 0, -1)), CAM_FWD_Z, undefined, true)
    const axis = g.dragDelta(new Ray(new Vector3(3.4, 0.6, 5), new Vector3(0, 0, -1)))?.rotationAxis
    expect(Math.abs(axis?.[2] ?? 0)).toBeCloseTo(1, 5)
    g.dispose()
  })

  it('draws the ring facing along the line of sight', () => {
    const g = new TransformGizmo()
    g.setState({ center: centre, rotationY: 0, mode: 'rotate', space: 'global' })
    const cam = new PerspectiveCamera(50, 1, 0.1, 1000)
    cam.updateMatrixWorld(true) // at the origin, looking down -Z
    g.updateScale(cam, 800)
    const ring = (g as unknown as { viewRingGroup: { getWorldQuaternion(q: Quaternion): Quaternion } }).viewRingGroup
    const normal = new Vector3(0, 0, 1).applyQuaternion(ring.getWorldQuaternion(new Quaternion()))
    expect(Math.abs(normal.dot(sight))).toBeCloseTo(1, 5)
    g.dispose()
  })
})
