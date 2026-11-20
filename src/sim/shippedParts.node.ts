/// <reference types="node" />
// This build's first-party parts, read from the repository and baked the way the app bakes its bundle
// (editor/parts/bundledPackageData.ts): the built-ins (examples/parts/<dir>/{rig.json, behavior.ts}) and the first-party
// library parts (libraries/<library>/<dir>/{manifest.json, behavior.js}). For the node-side tests that run parts
// against this build: the old-parts corpus (partCorpus.test.ts) and the listed library (libraryCorpus.test.ts).

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PartPackage } from '../core/parts/partPackage'
import { buildPackage } from './buildPackage'
import type { PackageManifest } from './buildPackage'

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function shippedParts(repo: string = REPO_ROOT): PartPackage[] {
  const sources: { manifest: string; behavior: string }[] = []
  const root = join(repo, 'examples', 'parts')
  for (const e of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) sources.push({ manifest: join(root, e.name, 'rig.json'), behavior: join(root, e.name, 'behavior.ts') })
  const libs = join(repo, 'libraries')
  for (const lib of existsSync(libs) ? readdirSync(libs, { withFileTypes: true }).filter((d) => d.isDirectory()) : []) {
    for (const e of readdirSync(join(libs, lib.name), { withFileTypes: true }).filter((d) => d.isDirectory())) {
      sources.push({ manifest: join(libs, lib.name, e.name, 'manifest.json'), behavior: join(libs, lib.name, e.name, 'behavior.js') })
    }
  }
  return sources
    .filter((s) => existsSync(s.manifest) && existsSync(s.behavior))
    .map((s) => buildPackage(JSON.parse(readFileSync(s.manifest, 'utf8')) as PackageManifest, readFileSync(s.behavior, 'utf8').replace(/\r\n/g, '\n')))
}
