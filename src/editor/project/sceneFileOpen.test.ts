import { describe, expect, it } from 'vitest'
import { loadSceneText } from './sceneFile'

// Guards against Open Scene, given a project, failing with the scene validator's first complaint ("parts must be
// an array"), which says nothing about what was picked. Both refusals return before the store is touched.
describe('Open Scene given a project', () => {
  const store = {} as Parameters<typeof loadSceneText>[0]

  it("names a project folder's project.json as a project", () => {
    const manifest = { version: 3, name: 'Servo Shuttle', activeScene: 0, scenes: [{ id: 'main', name: 'Main', scene: 'scenes/main.scene.json' }] }
    const msg = loadSceneText(store, JSON.stringify(manifest))
    expect(msg).toContain('Import Project')
    expect(msg).not.toContain('parts')
  })

  it('names a .oip archive as a project', () => {
    expect(loadSceneText(store, 'PK\u0003\u0004 rest of the zip')).toContain('Import Project')
  })
})
