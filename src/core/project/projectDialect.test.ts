// A scene's program dialect travels with its program through every format a scene is stored in, where the controller
// table does (projectController.test.ts): the project document, the project folder's manifest and the standalone
// scene file. This build runs IEC only, so the field is a marker. IEC is never written, so a document without the
// field stays byte-identical. Any other value is kept byte for byte, with its program, and refused at
// run time. A value that is not a string at all is a malformed document.

import { describe, expect, it } from 'vitest'
import { projectToScene, sceneToProject, serializeProject, validateProject } from './project'
import { AGENT_GUIDE, PROJECT_MANIFEST, folderFilesToProject, projectToFolderFiles } from './projectFolder'
import { serializeScene, validateScene } from '../scene/scene'
import { SCENE_VERSION } from '../types'
import type { SceneJSON } from '../types'

// text in no IEC form: meaningless to the IEC front end, which is the point of keeping it unread
const FOREIGN = 'rung Start -> Motor;\n'
const empty = (): SceneJSON => ({ version: SCENE_VERSION, parts: [] })

describe("a scene's program dialect travels with its scene", () => {
  it('through the project document, kept exactly, and serialized again byte for byte', () => {
    const text = serializeProject(sceneToProject(empty(), FOREIGN, 'P', 20, null, 'other'))
    expect(JSON.parse(text).stDialect).toBe('other')
    const back = validateProject(JSON.parse(text))
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.repairs).toBeUndefined() // an unknown dialect is not something loading changed
    expect(back.project.stDialect).toBe('other')
    expect(back.project.stProgram).toBe(FOREIGN)
    expect(projectToScene(back.project).stDialect).toBe('other')
    expect(serializeProject(back.project)).toBe(text)
  })

  it('is never written for IEC, absent or spelled out, so an IEC document is exactly as it was before the field', () => {
    const before = serializeProject(sceneToProject(empty(), 'x := 1;', 'P', 20))
    expect(before).not.toContain('stDialect')
    expect(serializeProject(sceneToProject(empty(), 'x := 1;', 'P', 20, null, 'iec'))).toBe(before)
    // a hand-written "iec" loads as IEC and saves without the field
    const doc = JSON.parse(before)
    doc.stDialect = 'iec'
    const back = validateProject(doc)
    expect(back.ok && back.project.stDialect).toBeUndefined()
    expect(back.ok && serializeProject(back.project)).toBe(before)
  })

  it('and without one: a scene whose program is empty keeps its marker, in every format', () => {
    // the project document, and back with nothing repaired
    const text = serializeProject(sceneToProject(empty(), '', 'P', undefined, null, 'other'))
    const saved = JSON.parse(text)
    expect(saved.stDialect).toBe('other')
    expect(saved.stProgram).toBeUndefined()
    const back = validateProject(JSON.parse(text))
    expect(back.ok && back.repairs).toBeUndefined()
    expect(back.ok && back.project.stDialect).toBe('other')
    expect(back.ok && projectToScene(back.project).stDialect).toBe('other')
    expect(back.ok && serializeProject(back.project)).toBe(text)
    // the standalone scene file
    const sceneText = serializeScene(empty(), '', undefined, undefined, null, 'other')
    const scene = validateScene(JSON.parse(sceneText))
    expect(scene.ok && scene.stDialect).toBe('other')
    expect(scene.ok && scene.repairs).toBeUndefined()
    // the folder manifest, with no program file for it to sit beside
    const files = projectToFolderFiles(sceneToProject(empty(), '', 'P', undefined, null, 'other'))
    const manifest = JSON.parse(files.find((f) => f.path === PROJECT_MANIFEST)!.contents as string)
    expect(manifest.stProgram).toBeUndefined()
    expect(manifest.stDialect).toBe('other')
    const fromFolder = folderFilesToProject(files)
    expect(fromFolder.ok && fromFolder.project.stDialect).toBe('other')
    // and the agent guide says what it is
    expect(files.find((f) => f.path === AGENT_GUIDE)!.contents).toContain('no program yet; it is marked as the "other" dialect, which this version of the app cannot run')
    // an empty IEC scene still never gains the key
    expect(serializeProject(sceneToProject(empty(), '', 'P'))).not.toContain('stDialect')
  })

  it('refuses a dialect that is not a string, saying where it is', () => {
    for (const bad of [7, null, { name: 'other' }, '']) {
      const doc = JSON.parse(serializeProject(sceneToProject(empty(), FOREIGN, 'P', 20, null, 'other')))
      doc.stDialect = bad
      const result = validateProject(doc)
      expect(result.ok).toBe(false)
      expect(result.ok ? '' : result.errors.join('\n')).toMatch(/scene\.stDialect must/)
    }
  })

  it('through the standalone scene file', () => {
    const text = serializeScene(empty(), FOREIGN, 20, undefined, null, 'other')
    const result = validateScene(JSON.parse(text))
    expect(result.ok && result.stDialect).toBe('other')
    expect(result.ok && serializeScene(result.scene, result.stProgram, result.stScanMs, undefined, result.controller, result.stDialect)).toBe(text)
    expect(serializeScene(empty(), FOREIGN, 20)).not.toContain('stDialect')
    expect(serializeScene(empty(), FOREIGN, 20, undefined, null, 'iec')).not.toContain('stDialect')
    const bad = validateScene({ ...JSON.parse(text), stDialect: 3 })
    expect(bad.ok).toBe(false)
  })

  it('through a project folder, inline in the manifest beside the program path, and back byte for byte', () => {
    const files = projectToFolderFiles(sceneToProject(empty(), FOREIGN, 'P', 20, null, 'other'))
    const manifestText = files.find((f) => f.path === PROJECT_MANIFEST)!.contents as string
    const manifest = JSON.parse(manifestText) as { program: string[]; stDialect?: string }
    // one file, never split: this build cannot read the program, so it cannot tell where its blocks are
    expect(manifest.program).toEqual(['plc/program.st'])
    expect(manifest.stDialect).toBe('other')
    // the program file is the text as written, not something rewritten as IEC
    expect(files.find((f) => f.path === manifest.program[0])!.contents).toBe(FOREIGN)
    const back = folderFilesToProject(files)
    expect(back.ok && back.project.stDialect).toBe('other')
    expect(back.ok && projectToFolderFiles(back.project).find((f) => f.path === PROJECT_MANIFEST)!.contents).toBe(manifestText)
    // an IEC folder never gains the key
    const iec = projectToFolderFiles(sceneToProject(empty(), 'x := 1;', 'P', 20))
    expect(iec.find((f) => f.path === PROJECT_MANIFEST)!.contents).not.toContain('stDialect')
  })

  it('refuses a malformed dialect in a folder manifest, as it does a malformed table', () => {
    const files = projectToFolderFiles(sceneToProject(empty(), FOREIGN, 'P', 20, null, 'other'))
    const manifest = JSON.parse(files.find((f) => f.path === PROJECT_MANIFEST)!.contents as string)
    manifest.stDialect = false
    const edited = files.map((f) => (f.path === PROJECT_MANIFEST ? { ...f, contents: JSON.stringify(manifest) } : f))
    const result = folderFilesToProject(edited)
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.errors.join('\n')).toMatch(/scene\.stDialect/)
  })

  it('and tells an agent reading the folder what the field is, and that a foreign program is not its to edit', () => {
    const guide = (dialect?: string): string =>
      projectToFolderFiles(sceneToProject(empty(), FOREIGN, 'P', 20, null, dialect)).find((f) => f.path === AGENT_GUIDE)!.contents as string
    expect(guide()).toContain('"stDialect"')
    expect(guide()).toMatch(/Absent means IEC 61131-3/)
    expect(guide('s7')).toContain('in the "s7" dialect, which this version of the app cannot run')
    expect(guide('other')).toContain('in the "other" dialect, which this version of the app cannot run')
    expect(guide()).not.toContain('which this version of the app cannot run')
  })
})
