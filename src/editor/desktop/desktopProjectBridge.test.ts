// The codec × real baker integration the core tests can't hold (core can't import sim). A project
// written to the folder layout and rebuilt through sim/validatePart must round-trip exactly: the
// baked fields (params etc.) dropped from manifest.json are re-derived from behavior.js to the same
// values. A broken script must fail the open with a located diagnostic, not load inert.

import { describe, expect, it } from 'vitest'
import { buildPackage } from '../../sim/buildPackage'
import { PROJECT_VERSION, serializeProject, validateProject } from '../../core/project/project'
import type { ProjectJSON } from '../../core/project/project'
import { SCENE_VERSION } from '../../core/types'
import { folderFilesToProject, projectToFolderFiles } from '../../core/project/projectFolder'
import { bakePart } from '../parts/bakePart'

const BEHAVIOR = `definePart({
  params: { speed: { type: 'number', default: 0.5 } },
  step(ctx) { ctx.setSurfaceVelocity(ctx.params.speed) },
})`

function sampleProject(): ProjectJSON {
  const pkg = buildPackage({ id: 'acme.deck', name: 'Deck', geometry: { kind: 'rig', links: [{ name: 'deck', shape: { kind: 'box', size: [2, 0.1, 1] }, offset: [0, -0.05, 0], conveys: true }], joints: [], bounds: { length: 2, width: 1, top: 0.05, bottom: -0.1 } } }, BEHAVIOR)
  const result = validateProject({
    version: PROJECT_VERSION,
    name: 'Baked',
    packages: [pkg],
    scene: {
      version: SCENE_VERSION,
      parts: [{ id: 'cp_1', type: 'part', packageId: pkg.id, position: [0, 0, 0], rotationY: 0 }],
    },
  })
  if (!result.ok) throw new Error(result.errors.join('; '))
  return result.project
}

describe('project folder × the real part baker', () => {
  it('round-trips a real package: params re-baked from behavior.js equal the originals', () => {
    const project = sampleProject()
    const back = folderFilesToProject(projectToFolderFiles(project), { bakePart })
    if (!back.ok) throw new Error(back.errors.join('; '))
    expect(serializeProject(back.project)).toBe(serializeProject(project))
    expect(back.project.packages?.[0]?.params).toEqual({ speed: { type: 'number', default: 0.5 } })
  })

  it('fails the open when an edited behavior.js is broken, naming the part folder', () => {
    const files = projectToFolderFiles(sampleProject()).map((f) =>
      f.path === 'parts/acme.deck/behavior.js' ? { ...f, contents: 'definePart({ step() { ' } : f,
    )
    const result = folderFilesToProject(files, { bakePart })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.some((e) => e.includes('parts/acme.deck') && e.includes('[load]'))).toBe(true)
  })

  it('fails the open on a nondeterministic script edit (the twin stays reproducible)', () => {
    const files = projectToFolderFiles(sampleProject()).map((f) =>
      f.path === 'parts/acme.deck/behavior.js'
        ? { ...f, contents: 'definePart({ step() { Math.random() } })' }
        : f,
    )
    const result = folderFilesToProject(files, { bakePart })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.some((e) => e.includes('parts/acme.deck') && e.includes('[determinism]'))).toBe(true)
  })
})
