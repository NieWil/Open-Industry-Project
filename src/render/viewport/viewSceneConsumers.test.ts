import { describe, expect, it } from 'vitest'
import type { PartInstance } from '../../core/types'
import { SceneDeltaBuilder } from '../../core/scene/sceneDelta'
import { SceneConsumers } from './viewSceneConsumers'

const part = (id: string, packageId: string): PartInstance =>
  ({ id, type: 'part', packageId, position: [0, 0, 0], rotationY: 0, params: {} }) as unknown as PartInstance
const ok = (): { ok: boolean; reason: string } => ({ ok: true, reason: '' })

describe('SceneConsumers', () => {
  it('runs a consumer only when the delta touches a part it reads, and a self-gated one every sync', () => {
    const consumers = new SceneConsumers()
    const ran: string[] = []
    consumers.register({ name: 'self', reads: 'self', apply: () => ran.push('self'), audit: ok })
    consumers.register({ name: 'sensors', reads: (p) => (p as { packageId?: string }).packageId === 'sensor', apply: () => ran.push('sensors'), audit: ok })

    const robotEdit = new SceneDeltaBuilder(false)
    robotEdit.record('r', part('r', 'robot'), part('r', 'robot'))
    consumers.run(robotEdit.build())
    expect(ran).toEqual(['self'])

    const sensorEdit = new SceneDeltaBuilder(false)
    sensorEdit.record('s', part('s', 'sensor'), part('s', 'sensor'))
    consumers.run(sensorEdit.build())
    expect(ran).toEqual(['self', 'self', 'sensors'])
    expect(consumers.counts.get('sensors')).toEqual({ ran: 1, skipped: 1 })
  })

  it('names each consumer in the audit', () => {
    const consumers = new SceneConsumers()
    consumers.register({ name: 'a', reads: 'self', apply: () => {}, audit: () => ({ ok: false, reason: 'stale' }) })
    expect(consumers.audit()).toEqual([{ name: 'sceneConsumer:a', ok: false, reason: 'stale' }])
  })
})
