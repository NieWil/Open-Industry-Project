import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SCENE_VERSION } from '../../core/types'
import type { PartInstance, SceneJSON } from '../../core/types'
import { registerPackage, unregisterPackage } from '../../core/parts/partRegistry'
import { PACKAGE_FORMAT } from '../../core/parts/partPackage'
import type { PartPackage } from '../../core/parts/partPackage'
import { EditorStore } from './store'
import { canPasteProperties, copyProperties, pasteProperties } from './storeProperties'

function pkg(id: string, params: PartPackage['params']): PartPackage {
  return {
    format: PACKAGE_FORMAT,
    id,
    name: id,
    params,
    behavior: '',
    geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [1, 0.1, 1] }, offset: [0, -0.05, 0] }], joints: [], bounds: { length: 1, width: 1, top: 0.05, bottom: -0.1 } },
  }
}

const BELT = pkg('test.props.belt', {
  speed: { type: 'number', default: 1, min: 0, max: 2 },
  color: { type: 'color', default: '#808080' },
  note: { type: 'string', default: '' },
  runTag: { type: 'tag', default: '' },
  reverse: { type: 'boolean', default: false, hidden: true },
})
const SENSOR = pkg('test.props.sensor', { range: { type: 'number', default: 1 } })

function part(id: string, packageId: string, params: Record<string, unknown>): PartInstance {
  return { id, type: 'part', packageId, position: [0, 0, 0], rotationY: 0, params } as unknown as PartInstance
}

function scene(...parts: PartInstance[]): SceneJSON {
  return { version: SCENE_VERSION, parts }
}

const paramsOf = (store: EditorStore, id: string) =>
  store.getState().scene.parts.find((p) => p.id === id)!.params as unknown as Record<string, unknown>

beforeEach(() => {
  registerPackage(BELT)
  registerPackage(SENSOR)
})
afterEach(() => {
  unregisterPackage(BELT.id)
  unregisterPackage(SENSOR.id)
})

describe('Copy / Paste Properties', () => {
  it('pastes every property onto parts of the same type as one undo step, leaving tags and hidden params', () => {
    const store = new EditorStore(
      scene(
        part('a', BELT.id, { speed: 1.5, color: '#ff0000', runTag: 'A_Run', reverse: true }),
        part('b', BELT.id, { speed: 0.5, color: '#00ff00', note: 'mine', runTag: 'B_Run', reverse: false }),
        part('c', BELT.id, { speed: 0.2, runTag: 'C_Run' }),
      ),
    )
    store.select('a')
    copyProperties(store)
    store.selectMany(['b', 'c'])
    expect(canPasteProperties(store.getState())).toBe(true)
    pasteProperties(store)
    for (const [id, tag, reverse] of [['b', 'B_Run', false], ['c', 'C_Run', undefined]] as const) {
      const p = paramsOf(store, id)
      expect(p.speed).toBe(1.5)
      expect(p.color).toBe('#ff0000')
      expect('note' in p).toBe(false) // absent on the source, so absent here
      expect(p.runTag).toBe(tag)
      expect(p.reverse).toBe(reverse)
    }
    store.undo()
    expect(paramsOf(store, 'b')).toMatchObject({ speed: 0.5, note: 'mine' })
    expect(paramsOf(store, 'c').speed).toBe(0.2)
  })

  it('refuses a selection of another type', () => {
    const store = new EditorStore(scene(part('a', BELT.id, { speed: 1.5 }), part('s', SENSOR.id, { range: 2 })))
    store.select('a')
    copyProperties(store)
    store.select('s')
    expect(canPasteProperties(store.getState())).toBe(false)
    pasteProperties(store)
    expect(paramsOf(store, 's').range).toBe(2)
  })

  it('copies from exactly one part', () => {
    const store = new EditorStore(scene(part('a', BELT.id, { speed: 1.5 }), part('b', BELT.id, { speed: 0.5 })))
    store.selectMany(['a', 'b'])
    copyProperties(store)
    expect(store.getState().propertyClipboard).toBeNull()
  })
})
