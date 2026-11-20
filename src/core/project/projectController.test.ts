// A scene's controller table travels with its ST program through every format a scene is stored in:
// the project document, the project folder (inline in its manifest), and the standalone scene file.
// A document without one stays byte-identical, and a malformed one is refused with its location.

import { describe, expect, it } from 'vitest'
import type { Controller } from '../controller'
import { projectToScene, sceneToProject, serializeProject, validateProject } from './project'
import { AGENT_GUIDE, PROJECT_MANIFEST, folderFilesToProject, projectToFolderFiles } from './projectFolder'
import { serializeScene, validateScene } from '../scene/scene'
import { SCENE_VERSION } from '../types'
import type { SceneJSON } from '../types'

const PROGRAM = 'PROGRAM Counter\nVAR_OUTPUT n : INT; END_VAR\nn := n + 1;\nEND_PROGRAM\n'
const TABLE: Controller = {
  tasks: [{ name: 'Fast', intervalMs: 10, priority: 1 }],
  programs: [
    { name: 'A', type: 'Counter', task: 'Fast' },
    { name: 'B', type: 'Counter' },
  ],
}
const empty = (): SceneJSON => ({ version: SCENE_VERSION, parts: [] })

describe("a scene's controller table travels with its program", () => {
  it('through the project document, both ways', () => {
    const back = validateProject(JSON.parse(serializeProject(sceneToProject(empty(), PROGRAM, 'P', 20, TABLE))))
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.project.controller).toEqual(TABLE)
    expect(projectToScene(back.project).controller).toEqual(TABLE)
  })

  it('and only with it: a table without a program is not kept', () => {
    expect(sceneToProject(empty(), '', 'P', undefined, TABLE).controller).toBeUndefined()
  })

  it('leaves a document without a table exactly as it was written before tables existed', () => {
    expect(serializeProject(sceneToProject(empty(), PROGRAM, 'P', 20))).not.toContain('controller')
  })

  it('refuses a malformed table, saying where it is', () => {
    const doc = JSON.parse(serializeProject(sceneToProject(empty(), PROGRAM, 'P', 20, TABLE)))
    doc.controller.tasks[0].intervalMs = 0
    const result = validateProject(doc)
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.errors.join('\n')).toMatch(/scene\.controller\.tasks\[0\]\.intervalMs/)
  })

  it('through the standalone scene file', () => {
    const result = validateScene(JSON.parse(serializeScene(empty(), PROGRAM, 20, undefined, TABLE)))
    expect(result.ok && result.controller).toEqual(TABLE)
    expect(serializeScene(empty(), PROGRAM, 20)).not.toContain('controller')
  })

  it('through a project folder, inline in the manifest beside the program path', () => {
    const files = projectToFolderFiles(sceneToProject(empty(), PROGRAM, 'P', 20, TABLE))
    const manifest = JSON.parse(files.find((f) => f.path === PROJECT_MANIFEST)!.contents as string) as { program: string[]; controller?: Controller }
    expect(manifest.program.length).toBeGreaterThan(0)
    expect(manifest.controller).toEqual(TABLE)
    const back = folderFilesToProject(files)
    expect(back.ok && back.project.controller).toEqual(TABLE)
  })

  it('and tells an agent reading the folder how a table works', () => {
    const guide = projectToFolderFiles(sceneToProject(empty(), PROGRAM, 'P', 20, TABLE)).find((f) => f.path === AGENT_GUIDE)!.contents
    expect(guide).toContain('runs 2 programs on 1 task')
    expect(guide).toContain('"controller"')
    expect(guide).toContain('Instance.Name')
  })
})
