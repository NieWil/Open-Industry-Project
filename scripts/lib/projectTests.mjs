// A project folder's test specs, found the way `test-project` finds them, for every CLI that needs them
// (test-project runs them; check-wiring counts the tags they read and drive). docs/project-tests.md "The runner".

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** every tests/*.test.json in the folder, sorted: `name` is the file name */
export function readTestSpecs(root) {
  const dir = join(root, 'tests')
  let names
  try {
    names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.test.json'))
  } catch {
    return []
  }
  return names.sort().map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }))
}

/** the test files project.json lists, as folder-relative paths (`tests/sort.test.json`); [] when it lists none or
 *  cannot be read (the codec then says why) */
export function listedTestPaths(root) {
  try {
    const m = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'))
    return Array.isArray(m.tests) ? m.tests.filter((t) => typeof t === 'string').map((t) => t.replace(/\\/g, '/').replace(/^\.\//, '')) : []
  } catch {
    return []
  }
}

/**
 * Every test of a loaded project folder. A project whose manifest CARRIES its tests is the source of truth (they
 * arrive validated with the document); a `tests/*.test.json` the manifest does not list runs too, marked `unlisted`
 * (the app runs only the listed ones), and all of them when it lists none. A folder from before a project held one
 * scene splits on read (core/project/project.ts `splitOff`): each carried test stays with the project it names.
 *
 * Each test is named by its FILE where it has one (`sort.test.json`), so two tests whose display names share a word
 * stay apart. Returns `all` ({ name, spec, project, file?, unlisted? }) and `bad` ({ file, lines }: specs that
 * cannot run, with the lines that say why).
 *
 * @param {{ project: any, splitOff?: any[] }} loaded  folderFilesToProject's result
 * @param {string[]} listed  listedTestPaths(root)
 * @param {{ name: string, text: string }[]} files  readTestSpecs(root)
 * @param {(data: unknown) => { ok: true, spec: any } | { ok: false, errors: string[] }} validateTestSpec  core/project/projectTest.ts
 */
export function collectTests(loaded, listed, files, validateTestSpec) {
  const projects = [loaded.project, ...(loaded.splitOff ?? [])]
  const all = []
  const carries = projects.some((p) => (p.tests ?? []).length > 0)
  if (carries) {
    for (const project of projects) {
      ;(project.tests ?? []).forEach((spec, i) => {
        // the manifest's i-th path is the i-th spec of a project that did not split; a split one's specs moved
        const file = !loaded.splitOff && listed[i] ? listed[i].split('/').pop() : undefined
        all.push({ name: file ?? spec.name ?? `test-${i + 1}`, spec, project, ...(file ? { file } : {}) })
      })
    }
  }
  const bad = []
  for (const { name, text } of files.filter(({ name }) => !carries || !listed.includes(`tests/${name}`))) {
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      bad.push({ file: name, lines: [`✗ ${name}: not valid JSON`] })
      continue
    }
    const v = validateTestSpec(parsed)
    if (!v.ok) {
      bad.push({ file: name, lines: [`✗ ${name}: invalid test spec`, ...v.errors.map((e) => `    - ${e}`)] })
      continue
    }
    all.push({ name, spec: v.spec, project: loaded.project, file: name, ...(carries ? { unlisted: true } : {}) })
  }
  return { all, bad }
}

/**
 * `--only <x>`: which tests run. An EXACT match wins: the file name with or without `.test.json`, or the display
 * name. Only when nothing matches exactly does a substring of either pick, and `ambiguous` then lists what it
 * picked when that is more than one, so `--only lane2-full` never quietly runs `lane2-full-logic` too.
 *
 * @template {{ name: string, file?: string, spec: { name?: string } }} T
 * @template {{ file: string }} B
 * @param {T[]} all
 * @param {B[]} bad
 * @param {string | null} only
 * @returns {{ specs: T[], unreadable: B[], match: 'all' | 'exact' | 'substring' | 'none', ambiguous: string[] }}
 */
export function pickTests(all, bad, only) {
  if (!only) return { specs: all, unreadable: bad, match: 'all', ambiguous: [] }
  const fileIs = (file) => file !== undefined && (file === only || file === `${only}.test.json`)
  const exact = all.filter((s) => fileIs(s.file) || (s.spec.name ?? s.name) === only)
  const exactBad = bad.filter((b) => fileIs(b.file))
  if (exact.length + exactBad.length > 0) return { specs: exact, unreadable: exactBad, match: 'exact', ambiguous: [] }
  const has = (text) => (text ?? '').includes(only)
  const specs = all.filter((s) => has(s.file) || has(s.spec.name ?? s.name))
  const unreadable = bad.filter((b) => has(b.file))
  const n = specs.length + unreadable.length
  if (n === 0) return { specs, unreadable, match: 'none', ambiguous: [] }
  const ambiguous = n > 1 ? [...specs.map((s) => s.file ?? s.name), ...unreadable.map((b) => b.file)] : []
  return { specs, unreadable, match: 'substring', ambiguous }
}

/** how a report names a test: its file in tests/, or its display name for one the document carries without a file */
export function testLabel(t) {
  return t.file ? `tests/${t.file}` : `test "${t.spec.name ?? t.name}"`
}
