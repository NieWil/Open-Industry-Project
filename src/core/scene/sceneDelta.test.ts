import { describe, expect, it } from 'vitest'
import type { PartInstance } from '../types'
import { SceneDeltaBuilder, deltaTouches } from './sceneDelta'

const part = (id: string, kind: string): PartInstance =>
  ({ id, type: 'part', packageId: kind, position: [0, 0, 0], rotationY: 0, params: {} }) as unknown as PartInstance
const isSensor = (p: PartInstance): boolean => (p as { packageId?: string }).packageId === 'sensor'

describe('deltaTouches', () => {
  it('a full delta touches every consumer', () => {
    expect(deltaTouches(new SceneDeltaBuilder(true).build(), () => false)).toBe(true)
  })

  it('an edit of a part no consumer reads touches nothing', () => {
    const d = new SceneDeltaBuilder(false)
    d.record('r', part('r', 'robot'), part('r', 'robot'))
    expect(deltaTouches(d.build(), isSensor)).toBe(false)
  })

  it('an added, removed or edited read part touches', () => {
    const add = new SceneDeltaBuilder(false)
    add.record('s', undefined, part('s', 'sensor'))
    expect(deltaTouches(add.build(), isSensor)).toBe(true)
    const remove = new SceneDeltaBuilder(false)
    remove.record('s', part('s', 'sensor'), undefined)
    expect(deltaTouches(remove.build(), isSensor)).toBe(true)
    const edit = new SceneDeltaBuilder(false)
    edit.record('s', part('s', 'sensor'), part('s', 'sensor'))
    expect(deltaTouches(edit.build(), isSensor)).toBe(true)
  })

  it('a part that stops (or starts) being read touches: its old (or new) version counts', () => {
    const stop = new SceneDeltaBuilder(false)
    stop.record('x', part('x', 'sensor'), part('x', 'robot'))
    expect(deltaTouches(stop.build(), isSensor)).toBe(true)
    const start = new SceneDeltaBuilder(false)
    start.record('x', part('x', 'robot'), part('x', 'sensor'))
    expect(deltaTouches(start.build(), isSensor)).toBe(true)
  })
})
