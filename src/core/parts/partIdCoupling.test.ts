import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// App code names capabilities, never part ids (docs/part-libraries.md, "App code names capabilities, not parts"). A built-in is a part the app
// happens to ship: when app code names one by id, that part can never move to a library, and a part from a library
// can never do what it does. So app code may name a part only where it is content (a scene, a tutorial, the list of
// parts the app ships), or on the list below, which says why and only ever shrinks. Comments are not counted: an id
// in a comment is an example, not a dependency.

/** Files that are content: they place, show or list particular parts, which is what content does. */
const CONTENT: Record<string, string> = {
  'editor/demo/demoScenes.ts': 'the demo scenes place the parts they show',
  'editor/demo/demoAcceptance.ts': 'checks the demo scenes it belongs to',
  'editor/parts/bundledExamples.ts': 'the list of parts the app ships',
  'editor/tutorial/steps.ts': 'the tutorial walks through particular parts',
  'editor/prefetchSceneAssets.ts': "warms the demo's cargo textures before its first frame",
}

/**
 * App code that still names a part. Each is a coupling to remove, not a pattern to copy. Shrink this list; never grow
 * it without the reason being as strong as these.
 */
const KNOWN_COUPLINGS: Record<string, string> = {
  'core/frame.ts': 'a kind-only spawn (ctx.spawn({ kind }), kept so stored part versions keep spawning) is the built-in of its kind (kindSpawnRef)',
  'core/parts/partPackage.ts': 'a stored unit load that names no pieces gets oip.pallet + oip.box (unitPiecesOf); a new one names its pieces',
  'core/stairReseat.ts': 'stairs re-seat on a platform by id: should be a declared snap capability',
  'core/builtInVersion.ts': 'the Pallet Spawner is hidden from the catalog by id: should be a manifest flag',
}

const ID_IN_STRING = /^oip\.[a-z0-9]+(?:[-_.][a-z0-9]+)*$/
// a template that builds an id from a value: `oip.${kind}`
const ID_TEMPLATE_HEAD = /^oip\.\$\{$/

/**
 * Every string literal in `src` (quote, double quote, and each template's literal parts), comments skipped. A template
 * part that runs into an expression ends in `${`, so `oip.${kind}` reads as 'oip.${' and the namespace alone as 'oip.'.
 */
function stringsOf(src: string): string[] {
  const out: string[] = []
  let i = 0
  const n = src.length
  // template nesting: a `}` closes an expression in a template only when the brace depth matches
  const templates: number[] = []
  let depth = 0
  const readTemplateChunk = (): void => {
    // at the character after ` or }: read up to the closing ` or ${
    let s = ''
    while (i < n) {
      const c = src[i]!
      if (c === '\\') {
        s += src.slice(i, i + 2)
        i += 2
        continue
      }
      if (c === '`') {
        i++
        out.push(s)
        return
      }
      if (c === '$' && src[i + 1] === '{') {
        i += 2
        out.push(s + '${')
        templates.push(depth)
        depth++
        return
      }
      s += c
      i++
    }
  }
  while (i < n) {
    const c = src[i]!
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end < 0 ? n : end + 2
    } else if (c === "'" || c === '"') {
      let s = ''
      i++
      while (i < n && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') {
          s += src.slice(i, i + 2)
          i += 2
        } else s += src[i++]
      }
      i++
      out.push(s)
    } else if (c === '`') {
      i++
      readTemplateChunk()
    } else if (c === '{') {
      depth++
      i++
    } else if (c === '}') {
      depth--
      i++
      if (templates.length > 0 && templates[templates.length - 1] === depth) {
        templates.pop()
        readTemplateChunk()
      }
    } else i++
  }
  return out
}

describe('app code names no part by id', () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const files = readdirSync(src, { recursive: true, encoding: 'utf8' })
    .map((f) => f.replace(/\\/g, '/'))
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.endsWith('.d.ts') && !f.includes('__snapshots__'))
  const naming = new Map<string, string[]>()
  for (const f of files) {
    const ids = stringsOf(readFileSync(join(src, f), 'utf8')).filter((s) => ID_IN_STRING.test(s) || ID_TEMPLATE_HEAD.test(s))
    if (ids.length > 0) naming.set(f, [...new Set(ids)])
  }

  it('finds the ids it is looking for (the scanner reads strings and skips comments)', () => {
    expect(stringsOf("const a = 'oip.box' // 'oip.tote'\n/* 'oip.rack' */ const b = `x${'oip.fence'}y` + \"oip.stairs\"")).toEqual(['oip.box', 'x${', 'oip.fence', 'y', 'oip.stairs'])
    expect(stringsOf('const u = "https://x.example/a" // not a comment start inside the string')).toEqual(['https://x.example/a'])
    expect(stringsOf('const t = `oip.${kind}`')).toEqual(['oip.${', ''])
    expect(naming.get('core/frame.ts')).toEqual(['oip.${'])
    expect(naming.has('editor/demo/demoScenes.ts')).toBe(true)
  })

  it('names a part only in content or a listed coupling', () => {
    const unlisted = [...naming].filter(([f]) => !(f in CONTENT) && !(f in KNOWN_COUPLINGS)).map(([f, ids]) => `${f}: ${ids.join(', ')}`)
    expect(unlisted, 'app code that names a part by id: give the engine a capability the part declares instead').toEqual([])
  })

  it('lists no file that has stopped naming parts, so the list only shrinks', () => {
    const stale = [...Object.keys(CONTENT), ...Object.keys(KNOWN_COUPLINGS)].filter((f) => !naming.has(f))
    expect(stale, 'remove these from the lists in this test').toEqual([])
  })
})
