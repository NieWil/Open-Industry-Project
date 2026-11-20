// The license texts of every third-party package that actually SHIPS, written next to what ships.
//
// THIRD_PARTY_NOTICES.md is the human account (what is bundled, the Jolt fork, the GPL boundary), but it
// pointed at `node_modules/<package>/LICENSE` for the texts themselves - which exist in a checkout and in
// nothing anybody downloads. MIT and BSD both require the notice to travel WITH the copy, so the texts are
// generated from the build itself instead of a hand-kept list:
//   - `bundledLicenses()` is a vite plugin. It reads which node_modules packages ended up in the output
//     chunks - the page build's and every worker build's (the Jolt wasm glue only exists in the worker) - and
//     emits dist/THIRD_PARTY_LICENSES.txt. Complete by construction: a dependency that starts shipping is in
//     the file on the next build, and one tree-shaken away drops out.
//   - `writePackageLicenses()` does the same for a list of installed package folders, which is how the desktop
//     shell covers its main-process dependencies (scripts/desktop-licenses.mjs).
// A shipped package with no license FILE is listed with its declared license and flagged, rather than dropped.
// Two things a per-package list can't see are covered too: third-party code nested INSIDE another package's
// files (read from each shipped file's own header, KNOWN_EMBEDDED below), and the service worker, which
// workbox-build writes after the bundle (read back from sw.js / workbox-*.js in closeBundle).

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

// LICENSE / COPYING / NOTICE, and the licenses of the code a package bundles: Monaco's ThirdPartyNotices.txt,
// @huggingface/usd-web-viewer's THIRD_PARTY_LICENSES (the Rust crates compiled into its wasm)
const LICENSE_FILE = /^(licen[sc]e|copying|notice|thirdpartynotices|third_party_licen[sc]es)([-._].*)?$/i

/** The package a module id belongs to: its folder under the LAST node_modules, or null for the app's own code. */
export function packageRootOf(id) {
  const clean = id.replace(/^\0+/, '').split('?')[0].replaceAll('\\', '/')
  const at = clean.lastIndexOf('/node_modules/')
  if (at < 0) return null
  const rest = clean.slice(at + '/node_modules/'.length).split('/')
  const depth = rest[0].startsWith('@') ? 2 : 1
  if (rest.length <= depth) return null
  return clean.slice(0, at + '/node_modules/'.length) + rest.slice(0, depth).join('/')
}

/** { name, version, license, texts: [{file, text}] } for an installed package folder, or null without a package.json. */
export function readPackageLicense(root) {
  const pkgFile = join(root, 'package.json')
  if (!existsSync(pkgFile)) return null
  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  } catch {
    return null
  }
  const license =
    typeof pkg.license === 'string'
      ? pkg.license
      : (pkg.license?.type ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type ?? l).join(' OR ') : 'not declared in package.json'))
  const files = readdirSync(root)
  // the root's license files, then any in dist/: some packages put the licenses of what they BUILT IN there
  // (occt-import-js: dist/license.occt.txt, Open CASCADE's LGPL text, beside its own). A text already printed
  // under another file name is named, not repeated.
  const dist = join(root, 'dist')
  const distFiles = existsSync(dist) && statSync(dist).isDirectory() ? readdirSync(dist).filter((f) => LICENSE_FILE.test(f)).sort() : []
  const seenText = new Map()
  const texts = [
    ...files.filter((f) => LICENSE_FILE.test(f)).sort().map((file) => ({ file, path: join(root, file) })),
    ...distFiles.map((file) => ({ file: `dist/${file}`, path: join(dist, file) })),
  ]
    .filter((f) => statSync(f.path).isFile())
    .map(({ file, path }) => {
      const text = readFileSync(path, 'utf8').trim()
      const key = text.replace(/\s+/g, ' ')
      if (seenText.has(key)) return { file, text: `(the same text as ${seenText.get(key)} above)` }
      seenText.set(key, file)
      return { file, text }
    })
  // no license file: the README's own License section, which is where some small packages state theirs
  if (texts.length === 0) {
    const readme = files.find((f) => /^readme(\..*)?$/i.test(f))
    const section = readme ? licenseSection(readFileSync(join(root, readme), 'utf8')) : null
    if (section) texts.push({ file: `${readme} (License section)`, text: section })
  }
  return { name: pkg.name ?? root.split(/[\\/]/).pop(), version: pkg.version ?? '?', license, texts }
}

/** A markdown README's "License" section (heading to the next heading of the same or a higher level), or null. */
function licenseSection(md) {
  const lines = md.split(/\r?\n/)
  const start = lines.findIndex((l) => /^#{1,6}\s*licen[sc]e\b/i.test(l))
  if (start < 0) return null
  const level = lines[start].match(/^#+/)[0].length
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const h = lines[i].match(/^(#+)\s/)
    if (h && h[1].length <= level) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n').trim()
}

/** The file's text: a header, then one section per package, sorted by name; `appendix` (lines) goes last. */
export function renderLicenses(title, entries, appendix = []) {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  const missing = sorted.filter((e) => e.texts.length === 0)
  const rule = '='.repeat(78)
  const out = [
    title,
    '',
    `${sorted.length} packages. Generated from the build itself by scripts/lib/bundled-licenses.mjs; see`,
    'THIRD_PARTY_NOTICES.md for the account of what is bundled and why.',
  ]
  if (missing.length) out.push('', `No license file in the package, declared license only: ${missing.map((e) => `${e.name}@${e.version}`).join(', ')}`)
  for (const e of sorted) {
    out.push('', rule, `${e.name}@${e.version}  (${e.license})`, rule)
    for (const t of e.texts) out.push('', `--- ${t.file} ---`, '', t.text)
    if (e.texts.length === 0) out.push('', `(no license file shipped in the package; its package.json declares ${e.license})`)
  }
  if (appendix.length) out.push('', ...appendix)
  return out.join('\n') + '\n'
}

/** Write the licenses of these installed package folders to `file`. Returns the entries written. */
export function writePackageLicenses(file, title, roots, extra = []) {
  const seen = new Map()
  for (const root of roots) {
    const e = readPackageLicense(root)
    if (e) seen.set(`${e.name}@${e.version}`, e)
  }
  // `extra`: shipped code no package folder carries (a fetched native library), already in entry form
  const entries = [...seen.values(), ...extra]
  writeFileSync(file, renderLicenses(title, entries))
  return entries
}

// ── code inside a package that is not the package's own ──────────────────────────────────────────────
// The per-package list above can't see third-party code NESTED in another package (monaco carries DOMPurify and
// a glob matcher, three carries the meshoptimizer decoder), and minification strips those files' own license
// headers out of the bundle. So the plugin reads the leading comment of every shipped source file under
// node_modules and keeps each copyright header whose holder the package's own license files never name.
// Known ones get a proper entry (KNOWN_EMBEDDED, with the full license text); any other is still printed
// verbatim at the end of the file AND warned about at build time, so a new one is noticed, not lost.

const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`

const BSD2_TEXT = `Redistribution and use in source and binary forms, with or without modification, are permitted provided that the
following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following
   disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following
   disclaimer in the documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES,
INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`

const BSD3_TEXT = `Redistribution and use in source and binary forms, with or without modification, are permitted provided that the
following conditions are met:

    * Redistributions of source code must retain the above copyright notice, this list of conditions and the following
      disclaimer.
    * Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the
      following disclaimer in the documentation and/or other materials provided with the distribution.
    * Neither the name of Google Inc. nor the names of its contributors may be used to endorse or promote products
      derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES,
INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`

const nm = (...p) => join(process.cwd(), 'node_modules', ...p)
const versionOf = (...p) => readPackageLicense(nm(...p))?.version ?? '?'

/**
 * Third-party code that ships inside another package's files (`module`: a shipped module id) or as an emitted
 * asset (`asset`: an output file name). Each yields one entry when, and only when, it is in the build.
 */
const KNOWN_EMBEDDED = [
  {
    key: 'dompurify',
    // monaco's own copy (when scripts/lib/monaco-dompurify.mjs keeps it) or the npm package it is redirected to
    module: /\/(monaco-editor\/esm\/vs\/base\/browser\/dompurify\/dompurify\.js|dompurify\/dist\/purify\.[^/]+)$/,
    entry: (file) => {
      const version = readFileSync(file, 'utf8').slice(0, 400).match(/DOMPurify (\d+\.\d+\.\d+)/)?.[1] ?? '?'
      const npm = readPackageLicense(nm('dompurify'))
      const viaNpm = /[\\/]dompurify[\\/]dist[\\/]/.test(file)
      return {
        name: 'DOMPurify (copyright notice)',
        version,
        license: 'Apache-2.0 OR MPL-2.0',
        texts: [
          {
            file: 'attribution',
            text:
              `DOMPurify ${version}. (c) Cure53 and other contributors. https://github.com/cure53/DOMPurify\n` +
              'Dual licensed under the Apache License 2.0 and the Mozilla Public License 2.0; distributed here under either.\n' +
              (viaNpm
                ? `Monaco's markdown sanitizer, bundled from the npm dompurify package (whose license texts are its own section, dompurify@${npm?.version ?? '?'}).`
                : 'Monaco\'s markdown sanitizer, as distributed inside monaco-editor (esm/vs/base/browser/dompurify/dompurify.js).'),
          },
          ...(viaNpm ? [] : (npm?.texts ?? [])),
        ],
      }
    },
  },
  {
    key: 'meshoptimizer',
    module: /\/three\/examples\/jsm\/libs\/meshopt_decoder\.module\.js$/,
    entry: (file) => ({
      name: 'meshoptimizer decoder (as distributed in three/examples/jsm/libs/meshopt_decoder.module.js)',
      version: readFileSync(file, 'utf8').slice(0, 2000).match(/Built from meshoptimizer ([\d.]+)/)?.[1] ?? `three ${versionOf('three')}`,
      license: 'MIT',
      texts: [{ file: 'MIT', text: `meshoptimizer, https://github.com/zeux/meshoptimizer\n\nCopyright (C) 2016-2026, by Arseny Kapoulkine (arseny.kapoulkine@gmail.com)\n\n${MIT_TEXT}` }],
    }),
  },
  {
    key: 'glob-to-regexp',
    module: /\/vscode-[a-z]+-languageservice\/lib\/esm\/utils\/glob\.js$/,
    entry: () => ({
      name: 'glob matcher by Nick Fitzgerald (vscode-json-languageservice utils/glob.js, as distributed in monaco-editor)',
      version: `monaco-editor ${versionOf('monaco-editor')}`,
      license: 'MIT (the file header); its origin, glob-to-regexp, is BSD-2-Clause',
      texts: [
        {
          file: 'file header',
          text: 'Copyright (c) Microsoft Corporation. All rights reserved.\nCopyright (c) 2013, Nick Fitzgerald\nLicensed under the MIT License.',
        },
        { file: 'MIT', text: `Copyright (c) Microsoft Corporation.\nCopyright (c) 2013, Nick Fitzgerald\n\n${MIT_TEXT}` },
        { file: 'BSD-2-Clause (glob-to-regexp, https://github.com/fitzgen/glob-to-regexp)', text: `Copyright (c) 2013, Nick Fitzgerald\nAll rights reserved.\n\n${BSD2_TEXT}` },
      ],
    }),
  },
  {
    key: 'v8',
    module: /\/ses\/src\/make-safe-evaluator\.js$/,
    entry: () => ({
      name: 'V8 (portions adapted in ses/src/make-safe-evaluator.js)',
      version: `ses ${versionOf('ses')}`,
      license: 'BSD-3-Clause',
      texts: [
        {
          file: 'BSD-3-Clause (V8, https://github.com/v8/v8/blob/main/LICENSE.v8)',
          text: `Portions adapted from V8 - Copyright 2016 the V8 project authors.\nCopyright 2006-2011, the V8 project authors. All rights reserved.\n\n${BSD3_TEXT}`,
        },
      ],
    }),
  },
  {
    key: 'codicons',
    asset: /(^|\/)codicon[-.][^/]*\.(ttf|woff2?)$/,
    entry: () => ({
      name: 'Codicons (the icon font codicon.ttf, as distributed in monaco-editor)',
      version: `monaco-editor ${versionOf('monaco-editor')}`,
      license: 'CC-BY-4.0',
      texts: [
        {
          file: 'attribution',
          text: [
            'Codicons, the Visual Studio Code icon font, by Microsoft. Copyright (c) Microsoft Corporation.',
            'Source: https://github.com/microsoft/vscode-codicons',
            'Licensed under the Creative Commons Attribution 4.0 International license (CC BY 4.0):',
            'https://creativecommons.org/licenses/by/4.0/legalcode',
            'Shipped unmodified, as monaco-editor distributes it (esm/vs/base/browser/ui/codicons/codicon/codicon.ttf); only',
            'the file name changes (a content hash). The licensor offers the material as-is and makes no representations or',
            'warranties of any kind (CC BY 4.0, section 5).',
          ].join('\n'),
        },
      ],
    }),
  },
]

/** The comments a source file opens with (a shebang, `//` lines and block comments), or '' */
export function leadingComment(src) {
  let i = 0
  const out = []
  if (src.startsWith('#!')) i = src.indexOf('\n') + 1 || src.length
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i++
    if (src.startsWith('//', i)) {
      const end = src.indexOf('\n', i)
      out.push(src.slice(i, end < 0 ? src.length : end))
      i = end < 0 ? src.length : end + 1
    } else if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2)
      if (end < 0) break
      out.push(src.slice(i, end + 2))
      i = end + 2
    } else break
  }
  return out.join('\n')
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** The copyright holders a header names, e.g. "Arseny Kapoulkine", "Cure53" */
export function copyrightHolders(header) {
  const holders = []
  for (const raw of header.split(/\r?\n/)) {
    const line = raw.replace(/^[\s/*!]+/, '').replace(/[\s*/]+$/, '')
    if (!/copyright|\(c\)|©|@license/i.test(line)) continue
    if (/^(the above )?copyright notice|copyright (law|holders?\b(?! of))/i.test(line)) continue
    const at = line.search(/copyright|\(c\)|©/i)
    if (at < 0) continue
    let h = line.slice(at)
    h = h.split('|')[0]
    h = h.replace(/copyrighttext:?|copyright|\(c\)|©/gi, ' ')
    h = h.replace(/\([^)]*\)/g, ' ').replace(/,\s*under\b.*$/i, ' ').replace(/,\s*[\w-]+(\.[\w-]+)+\b/g, ' ')
    h = h.replace(/https?:\/\/\S+/g, ' ').replace(/[(<]?[\w.+-]+@[\w.-]+[)>]?/g, ' ')
    h = h.replace(/\b\d{4}(\s*[-–]\s*(\d{4}|present))?\b/gi, ' ')
    h = h.replace(/\ball rights reserved\.?/gi, ' ').replace(/\blicen[sc]ed under.*$/i, ' ')
    h = h.replace(/^[\s,.:;-]*(by\b)?/i, '').replace(/^\s*the\s+/i, '').replace(/\b(and )?(other )?(contributors|authors|affiliates)\.?\s*$/i, '')
    h = h.replace(/[\s,.:;-]+$/, '').trim()
    if (norm(h).length >= 3) holders.push(h)
  }
  return holders
}

// One collection shared by the page build and its worker builds. Vite builds a worker when the page build
// reaches its import, so every worker's generateBundle has run before the page's - which emits the file.
const shipped = new Set()
// Assets that ship third-party code without being a module of the graph, so no package folder names them.
// The Draco decoder is Google's Apache-2.0 build that three.js carries in examples/jsm/libs/draco/ with no
// license file beside it, and DRACOLoader emits it as an asset; Apache-2.0 requires the license text to go along.
let dracoShipped = false
// KNOWN_EMBEDDED keys found -> the file that matched; and the unknown foreign headers, by package + header text
const embedded = new Map()
const foreign = new Map()
const ownTexts = new Map()

function dracoEntry() {
  const apache = join(process.cwd(), 'node_modules', 'typescript', 'LICENSE.txt') // the standard Apache-2.0 text
  return {
    name: 'draco (Google Draco 3D decoder, as distributed in three/examples/jsm/libs/draco)',
    version: readPackageLicense(join(process.cwd(), 'node_modules', 'three'))?.version ?? '?',
    license: 'Apache-2.0',
    texts: [
      {
        file: 'attribution',
        text: 'Draco 3D Data Compression. Copyright The Draco Authors (Google LLC). https://github.com/google/draco\nLicensed under the Apache License, Version 2.0.',
      },
      ...(existsSync(apache) ? [{ file: 'Apache-2.0', text: readFileSync(apache, 'utf8').trim() }] : []),
    ],
  }
}

/** What a package says is its own: its license files plus package.json's author, contributors, homepage, repository */
function ownText(root) {
  let pkg = {}
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  } catch {
    // no package.json: the license files alone
  }
  const people = [pkg.author, ...(pkg.contributors ?? []), ...(pkg.maintainers ?? [])].map((p) => (typeof p === 'string' ? p : (p?.name ?? '')))
  const repo = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? '')
  return norm([...(readPackageLicense(root)?.texts ?? []).map((t) => t.text), ...people, pkg.homepage ?? '', repo].join('\n'))
}

/** A header's legal part: its lines up to the last one about copyright or licensing (the rest describes the code) */
function legalPart(head) {
  const lines = head.split(/\r?\n/)
  let last = 0
  lines.forEach((l, i) => {
    if (/copyright|licen[sc]e|warrant|permission|\(c\)|©|spdx|https?:/i.test(l)) last = i
  })
  return lines.slice(0, last + 1).join('\n')
}

/** Read one shipped module's header; record a KNOWN_EMBEDDED match or a foreign copyright holder. */
function scanModule(id, root) {
  const file = id.replace(/^\0+/, '').split('?')[0]
  const slash = file.replaceAll('\\', '/')
  for (const k of KNOWN_EMBEDDED) if (k.module?.test(slash)) embedded.set(k.key, file)
  if (!/\.(m?js|cjs|css)$/.test(slash) || !existsSync(file)) return
  let head
  try {
    head = leadingComment(readFileSync(file, 'utf8').slice(0, 8192))
  } catch {
    return
  }
  if (!head) return
  const holders = copyrightHolders(head)
  if (!holders.length) return
  if (!ownTexts.has(root)) ownTexts.set(root, ownText(root))
  const own = ownTexts.get(root)
  const strangers = holders.filter((h) => !own.includes(norm(h)))
  if (!strangers.length || KNOWN_EMBEDDED.some((k) => k.module?.test(slash))) return
  const pkg = readPackageLicense(root)
  const legal = legalPart(head)
  const key = `${pkg?.name}\n${legal}`
  const at = foreign.get(key) ?? { pkg: `${pkg?.name}@${pkg?.version}`, name: pkg?.name, header: legal, holders: strangers, files: [] }
  const rel = slash.slice(slash.lastIndexOf('/node_modules/') + '/node_modules/'.length)
  if (!at.files.includes(rel)) at.files.push(rel)
  foreign.set(key, at)
}

function foreignAppendix() {
  if (!foreign.size) return []
  const rule = '='.repeat(78)
  const out = [
    rule,
    'Notices found inside bundled files whose copyright holder the package\'s own license files do not name',
    rule,
    '',
    'Each header below is reproduced verbatim from the file it opens; minification removes it from the bundle.',
  ]
  for (const f of foreign.values()) out.push('', `--- ${f.pkg}: ${f.files.join(', ')} ---`, '', f.header)
  return out
}

// The service worker: workbox-build writes sw.js and workbox-<hash>.js AFTER the bundle, from the workbox
// runtime packages, so they are never chunk modules. Each runtime module stamps itself `workbox:<name>:<version>`
// in the output, which is how the shipped set is read back from the files themselves.
function workboxEntries(outDir) {
  if (!outDir || !existsSync(outDir)) return []
  const files = readdirSync(outDir).filter((f) => f === 'sw.js' || /^workbox-[\w-]+\.js$/.test(f))
  const found = new Map()
  for (const f of files) for (const m of readFileSync(join(outDir, f), 'utf8').matchAll(/workbox:([a-z-]+):(\d+\.\d+\.\d+)/g)) found.set(m[1], m[2])
  const entries = []
  for (const [name, version] of found) {
    if (name === 'sw' || name === 'window' || name === 'build') continue // workbox-window is a page chunk already
    const candidates = [nm('workbox-build', 'node_modules', `workbox-${name}`), nm(`workbox-${name}`)]
    const pkgs = candidates.map(readPackageLicense).filter(Boolean)
    const e = pkgs.find((p) => p.version === version) ?? pkgs[0]
    if (!e) continue
    entries.push({ ...e, texts: [{ file: 'where it ships', text: `In the service worker (sw.js, ${files.filter((f) => f !== 'sw.js').join(', ') || 'workbox-*.js'}), written by workbox-build.` }, ...e.texts] })
  }
  return entries
}

/** `{ emit: true }` on the page build (writes the file), plain on `worker.plugins` (only collects). */
export function bundledLicenses({ emit = false } = {}) {
  let outDir = null
  let pageEntries = null
  const title = 'Open Industry Project - license texts of the third-party code in this build'
  return {
    name: 'oip-bundled-licenses',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    generateBundle(_options, bundle) {
      for (const out of Object.values(bundle)) {
        if (out.type === 'asset') {
          if (/(^|\/)draco_/.test(out.fileName)) dracoShipped = true
          for (const k of KNOWN_EMBEDDED) if (k.asset?.test(out.fileName)) embedded.set(k.key, out.fileName)
        }
        if (out.type !== 'chunk') continue
        for (const id of Object.keys(out.modules)) {
          const root = packageRootOf(id)
          if (!root) continue
          shipped.add(root.split('/').join(sep))
          scanModule(id, root)
        }
      }
      if (!emit) return
      const seen = new Map()
      for (const root of shipped) {
        const e = readPackageLicense(root)
        if (e) seen.set(`${e.name}@${e.version}`, e)
      }
      if (dracoShipped) seen.set('draco', dracoEntry())
      for (const k of KNOWN_EMBEDDED) if (embedded.has(k.key)) seen.set(`embedded:${k.key}`, k.entry(embedded.get(k.key)))
      for (const f of foreign.values()) {
        this.warn(`third-party header inside ${f.pkg} not covered by KNOWN_EMBEDDED (scripts/lib/bundled-licenses.mjs): ${f.holders.join('; ')} in ${f.files[0]}${f.files.length > 1 ? ` (+${f.files.length - 1})` : ''}`)
      }
      pageEntries = [...seen.values()]
      this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_LICENSES.txt', source: renderLicenses(title, pageEntries, foreignAppendix()) })
    },
    // after vite-plugin-pwa's own closeBundle (sequential, default order) has written the service worker
    closeBundle: {
      order: 'post',
      sequential: true,
      handler() {
        if (!emit || !pageEntries) return
        const sw = workboxEntries(outDir)
        if (!sw.length) return
        const have = new Set(pageEntries.map((e) => `${e.name}@${e.version}`))
        const all = [...pageEntries, ...sw.filter((e) => !have.has(`${e.name}@${e.version}`))]
        writeFileSync(join(outDir, 'THIRD_PARTY_LICENSES.txt'), renderLicenses(title, all, foreignAppendix()))
      },
    },
  }
}
