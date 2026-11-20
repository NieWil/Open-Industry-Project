// electron-builder's sign hook for release builds (scripts/desktop-release.mjs passes it; `npm run pack` and
// `npm run dist` stay unsigned). Signs one file with the DigiCert KeyLocker key, then verifies the signature.
//
// The key lives in DigiCert's cloud HSM and never on this machine. `smctl sign --simple` sends the file's hash,
// gets the signature back, and timestamps it (http://timestamp.digicert.com), so it needs no signtool on PATH and
// no certificate synced into the Windows store. The timestamp keeps a signature valid after the certificate
// expires; a release without one would become untrusted on the day the certificate lapses.
//
// smctl's exit code is not trusted on its own: every file is checked afterwards with the Windows SDK's
// signtool (`verify /pa`, the Authenticode policy Windows applies), and a missing timestamp fails it too.
//
// Env: OIP_SIGN_KEYPAIR (default the account's production keypair), OIP_SMCTL / OIP_SIGNTOOL to point at the tools.

const { execFileSync } = require('node:child_process')
const { existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

const KEYPAIR = process.env.OIP_SIGN_KEYPAIR || 'key_1638501538'

function smctlPath() {
  return process.env.OIP_SMCTL || 'C:\\Program Files\\DigiCert\\DigiCert One Signing Manager Tools\\smctl.exe'
}

/** The newest Windows SDK signtool, or OIP_SIGNTOOL. */
function signtoolPath() {
  if (process.env.OIP_SIGNTOOL) return process.env.OIP_SIGNTOOL
  const root = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin'
  const versions = existsSync(root) ? readdirSync(root).filter((v) => /^10\./.test(v)).sort().reverse() : []
  for (const v of versions) {
    const p = join(root, v, 'x64', 'signtool.exe')
    if (existsSync(p)) return p
  }
  throw new Error('signtool.exe not found - install the Windows SDK, or set OIP_SIGNTOOL')
}

/** Verify `file`'s Authenticode signature and timestamp; returns the signer's subject line. Throws if either is missing. */
function verifySigned(file) {
  let out
  try {
    out = execFileSync(signtoolPath(), ['verify', '/pa', '/v', file], { encoding: 'utf8' })
  } catch (e) {
    throw new Error(`signature does not verify on ${file}:\n${e.stdout ?? ''}${e.stderr ?? ''}`)
  }
  if (!/The signature is timestamped/i.test(out)) throw new Error(`signed but NOT timestamped: ${file}`)
  // signtool prints the signing chain root -> leaf, then the timestamp's own chain: the publisher is the last
  // "Issued to" before the timestamp section
  const signerSection = out.split(/The signature is timestamped/i)[0]
  const names = [...signerSection.matchAll(/Issued to: (.+)/g)].map((m) => m[1].trim())
  return names[names.length - 1] ?? ''
}

function signFile(file) {
  const out = execFileSync(smctlPath(), ['sign', '--simple', '--keypair-alias', KEYPAIR, '--input', file], { encoding: 'utf8' })
  if (/FAILED|error/i.test(out) && !/SUCCESSFUL/i.test(out)) throw new Error(`smctl could not sign ${file}:\n${out}`)
  return verifySigned(file)
}

/** electron-builder calls this once per file (and per hash algorithm: the release config asks for sha256 only). */
module.exports = async function sign(configuration) {
  const file = configuration.path
  const publisher = signFile(file)
  console.log(`  signed + verified + timestamped: ${file.split(/[\\/]/).pop()} (publisher: ${publisher})`)
}
module.exports.verifySigned = verifySigned
module.exports.signtoolPath = signtoolPath
