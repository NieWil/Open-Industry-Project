// core/checkLayout.ts's spur-side warning against the real first-party roller and spur. A spur is itself a merge and
// takes end joins only, so a conveyor end placed against its side meets a closed guard. The snap engine never seats
// one there, so the case is a hand or script placement; a spur snapped onto a line must stay clean.

import { beforeAll, describe, expect, it } from 'vitest'
import { checkLayout, formatLayoutFinding } from '../core/checkLayout'
import { clearPackages, getPackage } from '../core/parts/partRegistry'
import { createSdkPart } from '../core/scene/scene'
import { findSnap } from '../core/snap/snapFeatures'
import type { PartInstance } from '../core/types'
import { registerBundledPackages } from './parts/bundledExamples'

beforeAll(() => {
  clearPackages()
  registerBundledPackages()
})

const Y = 0.8
const W = 1.524 // the shipped beds' width
const place = (packageId: string, id: string, pos: [number, number, number], rotationY = 0): PartInstance =>
  ({ ...createSdkPart(getPackage(packageId)!, id, pos, rotationY), name: id }) as PartInstance
const spur = (): PartInstance => place('oip.spur-conveyor', 'spur', [0, Y, 0])
const endJoinSide = (parts: PartInstance[]) => checkLayout(parts).filter((f) => f.kind === 'endJoinSide')

describe("a conveyor end against a spur's side", () => {
  it('warns on the conveyor whose end meets the side, naming the spur', () => {
    // a 4 m roller pointing −Z, its front end on the spur's +Z edge
    const roller = place('oip.roller-conveyor', 'feed', [0, Y, W / 2 + 2], Math.PI / 2)
    const [f, ...rest] = endJoinSide([spur(), roller])
    expect(rest).toEqual([])
    expect(f!.partId).toBe('feed')
    expect(f!.severity).toBe('warning')
    expect(formatLayoutFinding(f!)).toContain('the side of spur (spur), a spur conveyor that takes end joins only')
  })

  it('does not warn for a spur snapped onto a line, or a bed parked alongside one', () => {
    const host = place('oip.roller-conveyor', 'host', [0, Y, -4])
    const moving = place('oip.spur-conveyor', 'merge', [0.2, Y, -4 + W], Math.PI / 2)
    const snap = findSnap(moving, { position: moving.position, rotationY: moving.rotationY }, [host])
    expect(snap?.join).toContain('flank')
    const merged = { ...moving, position: snap!.pose.position, rotationY: snap!.pose.rotationY } as PartInstance
    const alongside = place('oip.roller-conveyor', 'beside', [0, Y, W + 0.02])
    expect(endJoinSide([host, merged, spur(), alongside])).toEqual([])
  })
})
