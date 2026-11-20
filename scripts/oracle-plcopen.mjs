#!/usr/bin/env node
// Third external oracle: validates the PLCopen XML export against PLCopen's own TC6 schema.
//
// Why: string assertions written by the emitter's author are internal consistency. An
// interchange file is worth what the importer on the other side thinks of it, and the schema
// is the closest thing to that importer we can run in CI. Two things it enforces that string
// tests missed: TC6's `configuration` is a sequence (`<resource>` before `<globalVars>`), and
// a standard FB instance (`t : TON`) is a derived type, not an elementary `<TON/>`. We emit
// `tc6_0201` because that is the namespace the published schema validates.
//
// The schema is PLCopen's, taken from Beremiz (the toolchain OpenPLC's editor is built on)
// and pinned by commit: an oracle tracking someone else's HEAD can turn red on a change not ours.
//
// Usage:
//   npm run st-oracle:xml                      # fetch the schema if needed, validate all
//   PLCOPEN_XSD=/path/to/tc6_xml_v201.xsd npm run st-oracle:xml
//   npm run st-oracle:xml -- --render-only     # write the XML, skip validation

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(ROOT, '.oracle-xml')
const XSD_URL =
  'https://raw.githubusercontent.com/beremiz/beremiz/9e2d62361e86d9c9afaef23e30bbe1750de34968/plcopen/tc6_xml_v201.xsd'
const renderOnly = process.argv.includes('--render-only')

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
}

/** The schema, from PLCOPEN_XSD or fetched once into the work dir. */
async function schemaPath() {
  if (process.env.PLCOPEN_XSD) return process.env.PLCOPEN_XSD
  const cached = join(WORK, 'tc6_xml_v201.xsd')
  if (existsSync(cached)) return cached
  const res = await fetch(XSD_URL)
  if (!res.ok) throw new Error(`could not fetch the TC6 schema (${res.status}). Set PLCOPEN_XSD to a local copy.`)
  writeFileSync(cached, Buffer.from(await res.arrayBuffer()))
  return cached
}

async function main() {
  console.log('PLCopen TC6 schema oracle')
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })

  // The exporter reaches the type checker, so it cannot be loaded by Node's bare TypeScript
  // loader the way exportText.ts can - vite's SSR loader is how the other project scripts
  // (validate-project, test-project) reach src/, and it keeps this pointed at the REAL
  // exporter rather than a copy.
  const vite = await createServer({ configFile: false, root: ROOT, logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false } })
  let cases
  let toPlcopenXml
  try {
    ;({ toPlcopenXml } = await vite.ssrLoadModule('/src/plc/exchange/export.ts'))
    ;({ CONFORMANCE_CASES: cases } = await vite.ssrLoadModule('/src/plc/conformanceCases.ts'))
  } finally {
    await vite.close()
  }

  // `rejects` cases never compile, so there is nothing to export; everything else goes.
  const exportable = cases.filter((c) => !c.rejects)
  const files = []
  const refused = []
  for (const c of exportable) {
    try {
      const xml = toPlcopenXml(c.src, { projectName: c.name, timestamp: '2026-01-01T00:00:00' })
      const file = join(WORK, `${slug(c.name)}.xml`)
      writeFileSync(file, xml, 'utf8')
      files.push({ name: c.name, file })
    } catch (e) {
      refused.push({ name: c.name, why: e instanceof Error ? e.message : String(e) })
    }
  }
  console.log(`  corpus: ${cases.length} cases - ${files.length} exported, ${refused.length} refused by the exporter`)
  for (const r of refused) console.log(`  REFUSED   ${r.name}\n            ${r.why}`)

  if (renderOnly) {
    console.log(`\nrendered ${files.length} documents into ${WORK} (no validation)`)
    return refused.length ? 1 : 0
  }

  const xsd = await schemaPath()
  // the namespace is the point of the check, so assert the schema is the one we think it is
  const target = /targetNamespace="([^"]+)"/.exec(readFileSync(xsd, 'utf8'))?.[1]
  if (target !== 'http://www.plcopen.org/xml/tc6_0201') {
    throw new Error(`unexpected schema targetNamespace ${target}`)
  }
  console.log(`  schema: ${xsd}\n          ${target}\n`)

  let ok = 0
  const failures = [...refused.map((r) => ({ name: r.name, detail: `exporter refused it: ${r.why}` }))]
  for (const { name, file } of files) {
    try {
      execFileSync('xmllint', ['--noout', '--schema', xsd, file], { stdio: 'pipe' })
      ok++
      console.log(`  valid     ${name}`)
    } catch (e) {
      const why = String(e.stderr ?? e.stdout ?? e.message).split('\n').filter(Boolean).slice(0, 3).join('\n      ')
      if (/xmllint/.test(String(e.message)) && e.code === 'ENOENT') {
        console.error('\n  xmllint not found. Install libxml2-utils, or set PLCOPEN_XSD and run it yourself.')
        return 2
      }
      failures.push({ name, detail: why })
      console.log(`  INVALID   ${name}`)
    }
  }

  console.log(`\n  ${ok} of ${files.length} documents validate against the TC6 schema`)
  if (failures.length) {
    console.log(`\n${failures.length} failure(s):`)
    for (const f of failures) console.log(`  - ${f.name}\n      ${f.detail}`)
    return 1
  }
  console.log('\nevery exported document is schema-valid PLCopen TC6.')
  return 0
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e)
    process.exit(2)
  },
)
