import { describe, expect, it } from 'vitest'
import { folderFilesToProject, PROJECT_MANIFEST, projectToFolderFiles } from '../../core/project/projectFolder'
import { PROJECT_VERSION } from '../../core/project/project'
import type { ProjectJSON } from '../../core/project/project'
import { SCENE_VERSION } from '../../core/types'
import { compile, runnableSource } from '../../plc'
import { parseDocument } from '../../plc/document'
import { DEMO_CONTROLLER, DEMO_PROGRAM } from '../demo/demoScenes'
import { FOLDER_OPTIONS } from './folderOptions'

describe('the demo project in a folder', () => {
  const project = (): ProjectJSON => ({
    version: PROJECT_VERSION,
    name: 'Demo',
    // the program is what is under test; the scene's parts would need the app's built-ins declared
    scene: { version: SCENE_VERSION, parts: [] },
    stProgram: DEMO_PROGRAM,
    controller: DEMO_CONTROLLER,
  })

  it('keeps each POU in a file of its own language: the ladder cell program .ld, the truck block .st', () => {
    const files = projectToFolderFiles(project(), FOLDER_OPTIONS)
    const listed = JSON.parse(files.find((f) => f.path === PROJECT_MANIFEST)!.contents as string).program as string[]
    expect(listed).toContain('plc/Palletizer.ld')
    expect(listed).toContain('plc/PalletTruck.st')
    for (const path of listed) expect(files.some((f) => f.path === path)).toBe(true)
  })

  it('reads back as the same blocks, and the program still compiles', () => {
    const files = projectToFolderFiles(project(), FOLDER_OPTIONS)
    const back = folderFilesToProject(files)
    if (!back.ok) throw new Error(back.errors.join('; '))
    expect(parseDocument(back.project.stProgram!).blocks).toEqual(parseDocument(DEMO_PROGRAM).blocks)
    expect(() => compile(runnableSource(back.project.stProgram!, DEMO_CONTROLLER))).not.toThrow()
    // and the folder it reads back as is the one it was read from
    expect(projectToFolderFiles(back.project, FOLDER_OPTIONS).filter((f) => f.path.startsWith('plc/'))).toEqual(files.filter((f) => f.path.startsWith('plc/')))
  })
})
