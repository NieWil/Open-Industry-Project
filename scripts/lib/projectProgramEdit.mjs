// Editing a project folder's PLC program and wiring together, shared by scripts/rename-tag.mjs and
// scripts/assign-io.mjs. The folder is read the way the app reads it (loadProject: the built-ins declared, the
// project's own part library registered), the edit is made on the ProjectJSON in memory, and the folder codec
// (core/project/projectFolder.ts projectToFolderFiles, split one file per POU as the app splits it) writes it back.
// Only the program files, the scene and project.json's program keys (program, stScanMs, controller) are written, and of
// those only what changed. project.json is patched, not regenerated, so its part paths and everything else in it stay
// as they are; part folders, tests and AGENTS.md are never touched (the app rewrites AGENTS.md on its next save).
//
//   const proj = await openProgramProject(vite, folder)   // throws an Error with `exit` like openProjectForEdit
//   proj.project                                          // core ProjectJSON
//   proj.write(nextProject)                               // -> the paths written or removed

import { existsSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { declareBuiltIns } from './builtIns.mjs'
import { readProjectFolder } from './projectFolderFiles.mjs'
import { loadProject } from './projectLibrary.mjs'

export async function openProgramProject(vite, folder) {
  if (!existsSync(join(folder, 'project.json'))) throw Object.assign(new Error(`${folder} has no project.json`), { exit: 2 })
  await declareBuiltIns(vite)
  const loaded = await loadProject(vite, folder)
  if (loaded.errors) throw Object.assign(new Error(`${folder} does not load:\n  ${loaded.errors.join('\n  ')}`), { exit: 1 })
  const { projectToFolderFiles } = await vite.ssrLoadModule('/src/core/project/projectFolder.ts')
  const { programFiles } = await vite.ssrLoadModule('/src/plc/programFiles.ts')
  const before = new Map(readProjectFolder(folder).map((f) => [f.path, f.contents]))
  const manifest = JSON.parse(before.get('project.json'))
  const sceneFile = manifest.scene

  // Loading fills in each part's params (defaults, names), so the loaded scene is not the file. The scene file is
  // patched instead: each param the edit changed, on the part as the file has it, so nothing it does not store
  // appears in it.
  const patchedScene = (scene) => {
    const raw = JSON.parse(before.get(sceneFile))
    const was = new Map(loaded.project.scene.parts.map((p) => [p.id, p]))
    for (const part of scene.parts) {
      const old = was.get(part.id)
      if (!old || old === part) continue
      const target = raw.parts.find((p) => p.id === part.id)
      if (!target) continue
      for (const [key, value] of Object.entries(part.params ?? {})) {
        if (old.params?.[key] !== value) (target.params ??= {})[key] = value
      }
    }
    return JSON.stringify(raw, null, 2) + '\n'
  }

  const write = (next) => {
    const files = new Map(projectToFolderFiles(next, { splitProgram: programFiles }).map((f) => [f.path, f.contents]))
    const coded = JSON.parse(files.get('project.json'))
    const patched = { ...manifest }
    for (const key of ['program', 'stScanMs', 'controller']) {
      if (coded[key] === undefined) delete patched[key]
      else patched[key] = coded[key]
    }
    const out = new Map([
      ['project.json', JSON.stringify(patched, null, 2) + '\n'],
      ...(next.scene !== loaded.project.scene ? [[sceneFile, patchedScene(next.scene)]] : []),
      ...[...files].filter(([path]) => path.startsWith('plc/')),
    ])
    const written = []
    for (const [path, contents] of out) {
      if (before.get(path) === contents) continue
      const target = join(folder, ...path.split('/'))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, contents)
      written.push(path)
    }
    // a program file the old manifest listed and the new one does not
    for (const path of manifest.program ?? []) {
      if (out.has(path) || !before.has(path)) continue
      unlinkSync(join(folder, ...path.split('/')))
      written.push(`${path} (removed)`)
    }
    return written
  }
  return { project: loaded.project, write }
}
