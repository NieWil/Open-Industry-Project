// FOURTH EXTERNAL ORACLE - the IMPORT direction, against files this project did not write.
//
// The other oracles check what we export; the importers were only checked by round-tripping through
// our own exporter, which is internal consistency, and "what a round trip CANNOT check is a file this
// project never wrote" (importText.test.ts). So this feeds both importers files from two pinned upstreams:
//
//   - beremiz/beremiz - PLCopen TC6 XML projects written by a real graphical toolchain: ladder and FBD
//     bodies, an OLDER namespace (`tc6.xsd`, not `tc6_0201`), and vendor extensions.
//   - beremiz/matiec - `AnnexF/*_st.txt`, the worked examples out of IEC 61131-3's own Annex F.
//
// What it asserts: not "the file must compile", since a real file legitimately uses things this subset lacks,
// so a compile refusal is reported, not failed. What must hold is that nothing is dropped in silence:
// every POU and data type the source declares comes out either in the program or named in the notes.
// A crash is a failure too.
//
// Usage:
//   npm run st-oracle:import              # fetch (cached) and check
//   npm run st-oracle:import -- --offline # use only what is already cached

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(ROOT, '.oracle-import')
const offline = process.argv.includes('--offline')

// Pinned by COMMIT, like every other oracle here: an upstream that moves under us would change
// the verdict without changing this repo. Both SHAs are ones this project already trusts -
// the Beremiz one is where oracle-plcopen.mjs takes the TC6 schema from, and the matiec one is
// MATIEC_REF out of .github/workflows/st-oracle.yml.
const SOURCES = [
  {
    repo: 'beremiz/beremiz',
    sha: '9e2d62361e86d9c9afaef23e30bbe1750de34968',
    kind: 'xml',
    what: 'PLCopen TC6 projects from a real graphical toolchain',
    pick: (path) => /\.xml$/i.test(path),
    // .xml is also Beremiz's own confnode config format, so the NAMESPACE decides
    keep: (text) => text.includes('plcopen.org/xml/tc6'),
    min: 5,
  },
  {
    repo: 'beremiz/matiec',
    sha: '7949c0bda1787de9c7cacaa4876ede49f85262dd',
    kind: 'st',
    what: "IEC 61131-3 Annex F worked examples, and MATIEC's own ST function-block library",
    // `_il` files are Instruction List, a different language entirely
    pick: (path) => /^(AnnexF\/.*_st\.txt|lib\/.*\.txt)$/i.test(path),
    keep: (text) => /\b(FUNCTION_BLOCK|FUNCTION|PROGRAM|CONFIGURATION)\b/i.test(text),
    min: 10,
  },
  {
    // The only file here whose ST sits in `<xhtml:p>`, the shape OpenPLC's editor (and a current
    // Beremiz) writes: the pinned Beremiz projects above predate it and put bare CDATA in `<ST>`.
    // Pinned to the commit scripts/oracle-openplc.mjs runs. GPL-3.0, fetched into the cache and
    // never committed, like everything else this script reads.
    repo: 'Autonomy-Logic/openplc-editor',
    sha: '13fee913d66fb4d93f7528c3359144819da1c275',
    kind: 'xml',
    what: "a project OpenPLC's own editor wrote",
    pick: (path) => path === 'configs/mocks/plcMock.xml',
    keep: (text) => text.includes('plcopen.org/xml/tc6'),
    min: 1,
  },
]

const cachePath = (repo, sha, path) => join(WORK, repo.replace('/', '__'), sha.slice(0, 8), path.replace(/[/\\]/g, '__'))

async function cached(key, fetchIt) {
  if (existsSync(key)) return readFileSync(key, 'utf8')
  if (offline) return null
  const text = await fetchIt()
  mkdirSync(dirname(key), { recursive: true })
  writeFileSync(key, text, 'utf8')
  return text
}

/** Every file in a pinned tree, in ONE request, so no path has to be guessed at. */
async function listTree(repo, sha) {
  const key = cachePath(repo, sha, '__tree.json')
  const text = await cached(key, async () => {
    const res = await fetch(`https://api.github.com/repos/${repo}/git/trees/${sha}?recursive=1`, {
      headers: process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {},
    })
    if (!res.ok) throw new Error(`could not list ${repo}@${sha.slice(0, 8)} (${res.status}). Rate limited? Set GH_TOKEN.`)
    return await res.text()
  })
  if (text === null) throw new Error(`--offline, but ${repo} is not cached yet`)
  const json = JSON.parse(text)
  if (json.truncated) throw new Error(`${repo} tree came back truncated; this script assumes it does not`)
  return json.tree.filter((e) => e.type === 'blob').map((e) => e.path)
}

async function fetchFile(repo, sha, path) {
  const key = cachePath(repo, sha, path)
  return await cached(key, async () => {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/${sha}/${path}`)
    if (!res.ok) throw new Error(`could not fetch ${path} (${res.status})`)
    return await res.text()
  })
}

// ---- what the source file declares, so the check can be "did each of these survive" ----

// The first program POU's name is exempt, in both readers below. This subset leaves the program
// POU implicit (there is no `PROGRAM <name>` header in the form this engine runs), so the name
// of the loaded program has nowhere to be kept, by design. Requiring it would ask the importer
// to invent a place to put it. Every other declaration must survive,
// including the second program and beyond, which really are dropped and must say so.

/** POU and data-type names a PLCopen document declares, via the importer's OWN reader. */
function declaredInXml(parseXml, text) {
  const names = []
  let firstProgram = null
  const walk = (node) => {
    if ((node.name === 'pou' || node.name === 'dataType') && node.attrs.name) {
      if (node.name === 'pou' && node.attrs.pouType === 'program' && firstProgram === null) firstProgram = node.attrs.name
      else names.push(node.attrs.name)
    }
    node.children.forEach(walk)
  }
  walk(parseXml(text))
  return names
}

const deepText = (node) => node.text + node.children.map(deepText).join('\n')
const squash = (s) => s.replace(/\s+/g, '')

/** Every ST body a PLCopen document carries, as `{ name, body, first }`. The names rule above cannot
 *  see a body arriving EMPTY, and one did: the importer once read a body only from an
 *  `<xhtml>` element, so a body in `<xhtml:p>` (what OpenPLC writes) came in as nothing, silently. */
function stBodiesInXml(parseXml, text) {
  const out = []
  let first = true
  const walk = (node) => {
    if (node.name === 'pou' && node.attrs.name) {
      const st = node.children.find((c) => c.name === 'body')?.children.find((c) => c.name === 'ST')
      const isProgram = node.attrs.pouType === 'program'
      if (st && squash(deepText(st)) !== '') out.push({ name: node.attrs.name, body: deepText(st), first: isProgram && first })
      if (isProgram) first = false
    }
    node.children.forEach(walk)
  }
  walk(parseXml(text))
  return out
}

/** POU names an ST file declares. Rough - a coverage check, not a parse, over files
 *  that are known-good ST rather than something being edited. */
function declaredInSt(text) {
  // the CONFIGURATION goes first: `PROGRAM G : GRAVEL` in there is an INSTANCE of a POU, not a
  // declaration of one, and counting it asks for a name that was never a POU to survive
  const stripped = text
    .replace(/\(\*[\s\S]*?\*\)/g, ' ')
    .replace(/\bCONFIGURATION\b[\s\S]*?\bEND_CONFIGURATION\b/gi, ' ')
  const names = []
  let seenProgram = false
  for (const m of stripped.matchAll(/\b(FUNCTION_BLOCK|FUNCTION|PROGRAM)\s+([A-Za-z_]\w*)/gi)) {
    if (/^END_/i.test(m[2])) continue
    if (/^PROGRAM$/i.test(m[1]) && !seenProgram) {
      seenProgram = true
      continue
    }
    names.push(m[2])
  }
  return [...new Set(names)]
}

async function main() {
  console.log('ST import oracle - real files, from projects this one did not write\n')
  mkdirSync(WORK, { recursive: true })

  const vite = await createServer({ configFile: false, root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false } })
  let importIecText, importPlcopenXml, parseXml, parseAndCheck
  try {
    ;({ importIecText } = await vite.ssrLoadModule('/src/plc/exchange/importText.ts'))
    ;({ importPlcopenXml, parseXml } = await vite.ssrLoadModule('/src/plc/exchange/importXml.ts'))
    ;({ parseAndCheck } = await vite.ssrLoadModule('/src/plc/checker.ts'))
  } finally {
    await vite.close()
  }

  const failures = []
  let checked = 0
  let compiled = 0

  for (const src of SOURCES) {
    console.log(`${src.repo}@${src.sha.slice(0, 8)} - ${src.what}`)
    const paths = (await listTree(src.repo, src.sha)).filter(src.pick)
    const files = []
    for (const path of paths) {
      const text = await fetchFile(src.repo, src.sha, path)
      if (text !== null && src.keep(text)) files.push({ path, text })
    }

    // A source that stops yielding files is a finding, not a quiet pass: the upstream layout
    // changed, or the filter went stale, and either way the oracle just stopped checking.
    if (files.length < src.min) {
      failures.push({
        file: src.repo,
        detail: `only ${files.length} usable files found, expected at least ${src.min}. The upstream layout or the filter has changed - this oracle is no longer checking what it claims to.`,
      })
    }
    console.log(`  ${files.length} files\n`)

    for (const { path, text } of files) {
      checked++
      let result
      try {
        result = src.kind === 'xml' ? importPlcopenXml(text) : importIecText(text)
      } catch (e) {
        // A refusal is legitimate for a file that is not a program at all, but these ARE
        // programs - they were picked by content - so throwing on one is the failure.
        failures.push({ file: path, detail: `the importer threw: ${e instanceof Error ? e.message : String(e)}` })
        console.log(`  THREW     ${path}\n            ${e instanceof Error ? e.message : String(e)}`)
        continue
      }

      const declared = src.kind === 'xml' ? declaredInXml(parseXml, text) : declaredInSt(text)
      const haystack = `${result.source}\n${result.notes.join('\n')}`
      // whole words: a one-letter POU name would otherwise "survive" inside any other identifier
      const vanished = declared.filter((n) => !new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(haystack))

      // The rule: what the file declared is either in the program or named in the notes. A name
      // that is in neither was dropped in silence, which both importers must never do.
      if (vanished.length > 0) {
        failures.push({ file: path, detail: `dropped without a word: ${vanished.join(', ')}` })
      }

      // A POU that made it into the program must have brought its code. (One left out for a reason
      // is covered by the notes, above.) The first program has no header of its own to look for:
      // this subset leaves it implicit.
      const emptied = []
      if (src.kind === 'xml') {
        for (const { name, body, first } of stBodiesInXml(parseXml, text)) {
          const kept = first || new RegExp(`\\b(PROGRAM|FUNCTION_BLOCK|FUNCTION)\\s+${name}\\b`).test(result.source)
          if (kept && !squash(result.source).includes(squash(body))) emptied.push(name)
        }
      }
      if (emptied.length > 0) failures.push({ file: path, detail: `loaded without its code: ${emptied.join(', ')}` })

      let compiles = true
      let why = ''
      try {
        parseAndCheck(result.source)
      } catch (e) {
        compiles = false
        why = e instanceof Error ? e.message : String(e)
      }
      if (compiles) compiled++

      const outDir = join(WORK, 'imported')
      mkdirSync(outDir, { recursive: true })
      writeFileSync(join(outDir, path.replace(/[/\\]/g, '__')), `${result.source}\n(* notes:\n${result.notes.join('\n')}\n*)\n`, 'utf8')

      const mark = vanished.length > 0 ? 'DROPPED  ' : emptied.length > 0 ? 'EMPTIED  ' : compiles ? 'compiles ' : 'reported '
      console.log(`  ${mark} ${path}  (${declared.length} declared, ${result.notes.length} notes${compiles ? '' : `, does not compile: ${why.split('\n')[0]}`})`)
      if (vanished.length > 0) console.log(`            dropped without a word: ${vanished.join(', ')}`)
    }
    console.log('')
  }

  // Not compiling is REPORTED, never failed: a file from a real toolchain uses plenty this
  // subset does not have, and saying so is the correct outcome. The gate is silence.
  console.log(`${checked} files checked - ${compiled} produced a program that compiles here, ${checked - compiled} did not (expected: they use more than this subset has)`)
  console.log(`artifacts in ${WORK}\n`)

  if (failures.length > 0) {
    console.error(`${failures.length} FAILURE(S) - content that reached neither the program nor the notes:\n`)
    for (const f of failures) console.error(`  ${f.file}\n    ${f.detail}`)
    return 1
  }
  console.log('No file lost content silently.')
  return 0
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e)
    process.exit(2)
  },
)
