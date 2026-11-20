// Build, sign, verify and (with --upload) publish a desktop release.
//
// THE RELEASE is .github/workflows/desktop.yml, started by hand with `upload` ticked: one version for both platforms,
// Windows built + signed (KeyLocker, from CI) and Linux built, each LAUNCHED before anything is uploaded, then both
// uploaded together by --publish. The modes below are its steps, and still run on their own:
//
//   npm run desktop:release                build + sign + verify Windows on this machine; uploads nothing
//   npm run desktop:release -- --upload    ...then publish it (Windows only: the pre-CI path, kept as a fallback)
//   node scripts/desktop-release.mjs --linux [--upload] [--prebuilt]
//   node scripts/desktop-release.mjs --publish [--upload]  check (+ upload) what OIP_RELEASE_DIR holds, all platforms
//   node scripts/desktop-release.mjs --print-version  steps 1-2 only: print the version a release would take
//
// --linux builds an AppImage (any distro) and a .deb (its install script adds the AppArmor profile Ubuntu 24.04+
// needs before Chromium's sandbox may start, which an AppImage cannot carry). Nothing is signed: Linux has no
// publisher check; the feed's sha512 over HTTPS is what an update is held to. Step 5 LAUNCHES the AppImage
// (scripts/desktop-smoke.mjs) and refuses an upload unless it boots, so it needs a display (xvfb-run).
// --prebuilt skips steps 3-4 and verifies (+ uploads) what OIP_RELEASE_DIR already holds for the version.
// --publish uploads prebuilt files only, after checking each against the sha512 its own feed file records (what an
// installed app checks too).
//
// The order, and what each step refuses:
//   1. scripts/desktop-release-check.mjs - a clean tree, HEAD on origin/main (an installer's build stamp claims
//      collab rooms; see that file). An --upload refuses its override outright: an unreleased build never ships.
//   2. the version is COMPUTED, never bumped by hand: CalVer YYYY.M.N (UTC), N counting this month's releases from
//      the newest one EITHER feed serves (latest.yml, latest-linux.yml), so one number never names two builds. A
//      date, not a compatibility promise; always a HIGHER semver, which electron-updater requires (0.1.x included).
//      An --upload refuses when a feed can't be read, since N would be guessed. OIP_RELEASE_VERSION_PIN hands every
//      job of one release the SAME version (from --print-version); it must still be newer than both feeds.
//      apps/desktop/package.json "version" is only for local builds; a release overrides it via extraMetadata.
//   3. npm run build, then the shell's license texts (scripts/desktop-licenses.mjs).
//   4. electron-builder with apps/desktop/electron-builder.release.cjs, whose sign hook (sign.cjs) signs every
//      executable with KeyLocker and verifies each one, timestamp included.
//   5. the installer and the app exe are verified again, and their publisher must match the one in app-update.yml
//      (`build.win.signtoolOptions.publisherName`): an installed app checks every update against that name, so a
//      mismatch ships an app that refuses its own updates. While it is unset, the build signs but cannot upload.
//   6. upload: the versioned installer + blockmap (immutable), then latest.yml - so an app sees the new version only
//      once everything it points at is there - then the stable-named copy the download link uses (Linux: same order;
//      --publish puts every versioned file of both platforms up before either feed file). The copy goes last because
//      the feed doesn't need it and it is the whole installer again: on a slow uplink (43 KB/s measured, ~50 minutes
//      per installer) that order has updates live an hour sooner.
//
// Env: OIP_R2_BUCKET (default oip-downloads), OIP_RELEASE_DIR (default a folder in the OS temp dir: electron-builder
// cannot rename its staging folder inside the repo while an editor watches it), OIP_RELEASE_VERSION_PIN,
// CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID for wrangler (or a prior `npx wrangler login`).

import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const shell = join(root, 'apps', 'desktop')
const pkg = JSON.parse(readFileSync(join(shell, 'package.json'), 'utf8'))
const { verifySigned } = require(join(shell, 'sign.cjs'))

const FEED = pkg.build.publish[0].url.replace(/\/$/, '')
const PREFIX = new URL(FEED).pathname.replace(/^\/|\/$/g, '') // desktop
const BUCKET = process.env.OIP_R2_BUCKET || 'oip-downloads'
const WRANGLER = 'wrangler@4.132.0' // = deploy-pages.yml
const upload = process.argv.includes('--upload')
const linux = process.argv.includes('--linux')
const prebuilt = process.argv.includes('--prebuilt')
const publishOnly = process.argv.includes('--publish')
const printVersion = process.argv.includes('--print-version')
const publisherName = pkg.build.win.signtoolOptions?.publisherName ?? null
const STABLE = 'Open-Industry-Project-Setup.exe'
// the Linux download links' names; the versioned ones are package.json `appImage` / `deb` artifactName
const STABLE_APPIMAGE = 'Open-Industry-Project.AppImage'
const STABLE_DEB = 'open-industry-project_amd64.deb'

const step = (msg) => console.log(`\n== ${msg}`)
const fail = (msg) => {
  console.error(`\ndesktop release: REFUSED - ${msg}`)
  process.exit(1)
}
// npm / npx are .cmd files on Windows, so they run through a shell: one command string, every argument quoted
const quote = (a) => (/^[\w@%+=:,./\-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`)
const run = (cmd, args, cwd = root, env = process.env) => execSync([cmd, ...args].map(quote).join(' '), { cwd, stdio: 'inherit', env })
// A put to the same key is safe to repeat. Cloudflare's API gateway once answered a 524 while the object still
// landed, which failed a release whose feeds were already live; a re-run can't recover that, so retry here.
const PUT_WAITS_MS = [5000, 15000]
const put = (file, key, contentType, cacheControl) => {
  const args = ['--yes', WRANGLER, 'r2', 'object', 'put', `${BUCKET}/${PREFIX}/${key}`, '--file', file, '--content-type', contentType, '--cache-control', cacheControl, '--remote']
  for (let attempt = 0; ; attempt++) {
    try {
      return run('npx', args)
    } catch (e) {
      if (attempt >= PUT_WAITS_MS.length) throw e
      console.log(`  upload of ${key} failed; retrying in ${PUT_WAITS_MS[attempt] / 1000} s`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, PUT_WAITS_MS[attempt])
    }
  }
}

// semver-ish compare, enough for x.y.z
const newer = (a, b) => {
  const pa = a.split(/[.-]/).map(Number)
  const pb = b.split(/[.-]/).map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
  return false
}

// CalVer YYYY.M.N: the next release this month after `served`, or .1 in a new month (or after a pre-CalVer 0.x)
const nextVersion = (served, now = new Date()) => {
  const ym = `${now.getUTCFullYear()}.${now.getUTCMonth() + 1}`
  const n = served?.startsWith(`${ym}.`) ? Number(served.slice(ym.length + 1)) + 1 : 1
  return `${ym}.${n}`
}

// After an upload, the feed must read `version` through the custom domain. A single read once failed a release that
// had landed (the feed served it moments later), and a re-run is then refused as not newer, so retry for ~75 s and
// say what the last read got.
const checkFeed = async (feed, version) => {
  let last = ''
  for (let i = 0; i < 6; i++) {
    if (i) await new Promise((r) => setTimeout(r, 5000 * i))
    try {
      const res = await fetch(`${FEED}/${feed}`, { cache: 'no-store' })
      const text = await res.text()
      if (res.ok && text.includes(`version: ${version}`)) return
      last = `HTTP ${res.status}: ${text.split('\n')[0].slice(0, 120) || '(empty)'}`
    } catch (e) {
      last = `fetch failed: ${e?.cause?.code ?? e?.message ?? e}`
    }
    console.warn(`  ${feed} does not read ${version} yet (${last})`)
  }
  fail(`uploaded, but ${FEED}/${feed} still does not read ${version} (last read: ${last}) - check the bucket's custom domain. The files are up; if the feed comes to serve ${version}, the release is done and a re-run will be refused as not newer`)
}

const what = printVersion ? 'version only' : publishOnly ? 'publish prebuilt files' : linux ? 'Linux: build, verify, launch' : 'build, sign, verify'
step(`desktop release (${what}${upload ? ', UPLOAD' : ' - no upload'}${prebuilt ? ', prebuilt' : ''})`)
const builds = !printVersion && !publishOnly
if (builds && linux && process.platform !== 'linux') fail('Linux packages are built on Linux (CI: .github/workflows/desktop.yml)')
if (builds && !linux && process.platform !== 'win32') fail('Windows releases are signed with KeyLocker on Windows (--linux for the Linux packages)')
if (upload && process.env.OIP_DESKTOP_UNRELEASED === '1') fail('OIP_DESKTOP_UNRELEASED=1 builds are for local use and never upload')
if (upload && !linux && !publisherName) fail('build.win.signtoolOptions.publisherName is unset; run without --upload once to read it off a real signature')

step('1. release check')
run(process.execPath, [join(root, 'scripts', 'desktop-release-check.mjs')])

step('2. version from the feeds')
// the newest version either platform's feed serves: one sequence for both (see 2. above)
let served = null
for (const feed of ['latest.yml', 'latest-linux.yml']) {
  let read = false
  try {
    const res = await fetch(`${FEED}/${feed}`, { cache: 'no-store' })
    const v = res.ok ? ((await res.text()).match(/^version:\s*(\S+)/m)?.[1] ?? null) : null
    if (v && (!served || newer(v, served))) served = v
    read = res.ok || res.status === 404 // 404 = no release on that platform yet
  } catch {
    /* offline: read stays false */
  }
  if (!read) {
    const msg = `could not read ${FEED}/${feed}, so this month's release count is unknown`
    if (upload || printVersion) fail(msg)
    console.warn(`warning: ${msg}`)
  }
}
// one release's jobs share the version computed once (--print-version); a release that landed since then has made
// it stale, and building or uploading under it would give one number to two builds
const pin = process.env.OIP_RELEASE_VERSION_PIN || null
const version = pin ?? nextVersion(served)
console.log(`feeds serve: ${served ?? '(nothing yet)'}; this release: ${version}${pin ? ' (pinned)' : ''}`)
if (pin && !/^\d+\.\d+\.\d+$/.test(pin)) fail(`OIP_RELEASE_VERSION_PIN "${pin}" is not x.y.z`)
if (served && !newer(version, served)) {
  fail(pin ? `pinned ${version} is not newer than the ${served} the feeds now serve - another release landed; start a new one` : `computed ${version} is not newer than the ${served} the feeds serve - is this machine's clock behind?`)
}
if (printVersion) {
  // the last stdout line is the version alone, for a workflow to capture
  console.log(version)
  process.exit(0)
}
const out = resolve(process.env.OIP_RELEASE_DIR || join(tmpdir(), `oip-desktop-release-${version}`))
const installer = `Open-Industry-Project-Setup-${version}.exe`

if (publishOnly) await publish()

if (prebuilt) {
  // a version that moved since the build (another release landed) leaves these names missing, and step 5 refuses
  console.log(`\n== 3-4. prebuilt: using ${out}`)
} else {
  step('3. build')
  run('npm', ['run', 'build'])
  run('npm', ['run', 'licenses'], shell)

  const env = { ...process.env, OIP_RELEASE_OUT: out, OIP_RELEASE_VERSION: version }
  if (linux) {
    step(`4. package (AppImage + deb) -> ${out}`)
    run('npx', ['electron-builder', '--linux', 'AppImage', 'deb', '--publish', 'never', '--config', 'electron-builder.release.cjs'], shell, env)
  } else {
    step(`4. package + sign (KeyLocker) -> ${out}`)
    run('npx', ['electron-builder', '--win', 'nsis', '--publish', 'never', '--config', 'electron-builder.release.cjs'], shell, env)
  }
}

if (linux) await releaseLinux()

step('5. verify')
const files = { installer: join(out, installer), app: join(out, 'win-unpacked', 'Open Industry Project.exe'), blockmap: join(out, `${installer}.blockmap`), latest: join(out, 'latest.yml') }
for (const [k, f] of Object.entries(files)) if (!existsSync(f)) fail(`${k} missing: ${f}`)
for (const f of [files.installer, files.app]) {
  const who = verifySigned(f)
  console.log(`  ${f.split(/[\\/]/).pop()}: signed, timestamped, publisher "${who}"`)
  const allowed = [].concat(publisherName ?? [])
  if (allowed.length && !allowed.includes(who)) fail(`publisher "${who}" is not the configured "${allowed.join('", "')}" - installed apps would refuse this update`)
  if (!allowed.length) console.log(`  -> set build.win.signtoolOptions.publisherName to "${who}" in apps/desktop/package.json before the first upload`)
}
const latest = readFileSync(files.latest, 'utf8')
if (!latest.includes(`version: ${version}`) || !latest.includes(installer)) fail(`latest.yml does not describe ${installer}`)

if (!upload) {
  console.log(`\ndesktop release: built and signed ${version} in ${out}. Nothing uploaded (add --upload).`)
  process.exit(0)
}

step(`6. upload to r2://${BUCKET}/${PREFIX}/`)
put(files.installer, installer, 'application/vnd.microsoft.portable-executable', 'public, max-age=31536000, immutable')
put(files.blockmap, `${installer}.blockmap`, 'application/octet-stream', 'public, max-age=31536000, immutable')
put(files.latest, 'latest.yml', 'text/yaml', 'no-cache') // after what it points at: apps see the release only once it is there
console.log('feed live; now the stable download copy')
put(files.installer, STABLE, 'application/vnd.microsoft.portable-executable', 'public, max-age=300')

step('7. check the feed')
await checkFeed('latest.yml', version)
console.log(`\ndesktop release: ${version} is live. Download link: ${FEED}/${STABLE}`)

// Steps 5-7 for --linux. Nothing to sign; what stands in for the signature check is LAUNCHING the package.
async function releaseLinux() {
  step('5. verify (Linux)')
  const appImage = `Open-Industry-Project-${version}.AppImage`
  const deb = `open-industry-project_${version}_amd64.deb`
  const files = { appImage: join(out, appImage), deb: join(out, deb), latest: join(out, 'latest-linux.yml') }
  for (const [k, f] of Object.entries(files)) if (!existsSync(f)) fail(`${k} missing: ${f}`)
  const latest = readFileSync(files.latest, 'utf8')
  if (!latest.includes(`version: ${version}`) || !latest.includes(appImage) || !latest.includes(deb)) fail(`latest-linux.yml does not describe ${appImage} and ${deb}`)
  console.log(`  ${appImage}, ${deb}, latest-linux.yml: present and consistent`)

  // the launch: an AppImage that will not start (no FUSE, a sandbox the OS refuses) is caught here, not by users
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    const msg = 'no display to launch the AppImage on (run under xvfb-run)'
    if (upload) fail(msg)
    console.warn(`warning: ${msg}; NOT launched`)
  } else {
    const smoke = [join(root, 'scripts', 'desktop-smoke.mjs'), files.appImage, '--out', out]
    if (process.env.CI) smoke.push('--software-gl') // a runner has no GPU
    try {
      run(process.execPath, smoke)
    } catch {
      fail('the AppImage did not boot (scripts/desktop-smoke.mjs said why above)')
    }
  }

  if (!upload) {
    console.log(`\ndesktop release: built ${version} for Linux in ${out}. Nothing uploaded (add --upload).`)
    process.exit(0)
  }

  step(`6. upload to r2://${BUCKET}/${PREFIX}/`)
  const IMMUTABLE = 'public, max-age=31536000, immutable'
  put(files.appImage, appImage, 'application/vnd.appimage', IMMUTABLE)
  put(files.deb, deb, 'application/vnd.debian.binary-package', IMMUTABLE)
  put(files.latest, 'latest-linux.yml', 'text/yaml', 'no-cache') // after what it points at, as on Windows
  console.log('feed live; now the stable download copies')
  put(files.appImage, STABLE_APPIMAGE, 'application/vnd.appimage', 'public, max-age=300')
  put(files.deb, STABLE_DEB, 'application/vnd.debian.binary-package', 'public, max-age=300')

  step('7. check the feed')
  await checkFeed('latest-linux.yml', version)
  console.log(`\ndesktop release: ${version} is live for Linux. Downloads: ${FEED}/${STABLE_APPIMAGE}, ${FEED}/${STABLE_DEB}`)
  process.exit(0)
}

// --publish: upload what OIP_RELEASE_DIR holds, every platform found there, as one release. The files were built,
// signed and launched by the jobs that made them; here they are only checked to be the files their feed files
// describe (sha512, as electron-updater will check them), then uploaded: every versioned file of every platform
// first, then the feed files, then the stable download copies.
async function publish() {
  const { createHash } = await import('node:crypto')
  const sha512 = (f) => createHash('sha512').update(readFileSync(f)).digest('base64')
  const platforms = [
    {
      name: 'Windows',
      feed: 'latest.yml',
      files: [
        { name: installer, type: 'application/vnd.microsoft.portable-executable', stable: STABLE },
        { name: `${installer}.blockmap`, type: 'application/octet-stream' },
      ],
    },
    {
      name: 'Linux',
      feed: 'latest-linux.yml',
      files: [
        { name: `Open-Industry-Project-${version}.AppImage`, type: 'application/vnd.appimage', stable: STABLE_APPIMAGE },
        { name: `open-industry-project_${version}_amd64.deb`, type: 'application/vnd.debian.binary-package', stable: STABLE_DEB },
      ],
    },
  ].filter((p) => existsSync(join(out, p.feed)))
  if (!platforms.length) fail(`${out} holds no latest.yml or latest-linux.yml to publish`)

  step(`5. check what ${out} holds`)
  for (const p of platforms) {
    const feedText = readFileSync(join(out, p.feed), 'utf8')
    if (!feedText.includes(`version: ${version}`)) fail(`${p.feed} is not version ${version}`)
    // `- url: <name>` followed by its `sha512: <hash>`
    const recorded = new Map([...feedText.matchAll(/-\s+url:\s*(\S+)\s*\n\s+sha512:\s*(\S+)/g)].map((m) => [m[1], m[2]]))
    for (const f of p.files) {
      const path = join(out, f.name)
      if (!existsSync(path)) fail(`${p.name}: ${f.name} missing from ${out}`)
      if (f.name.endsWith('.blockmap')) continue // described by nothing; electron-updater fetches it by name
      if (!recorded.has(f.name)) fail(`${p.feed} does not list ${f.name}`)
      if (recorded.get(f.name) !== sha512(path)) fail(`${f.name} is not the file ${p.feed} describes (sha512 differs)`)
    }
    console.log(`  ${p.name}: ${p.files.map((f) => f.name).join(', ')} match ${p.feed}`)
  }
  if (!upload) {
    console.log(`
desktop release: ${version} checked for ${platforms.map((p) => p.name).join(' and ')}. Nothing uploaded (add --upload).`)
    process.exit(0)
  }

  step(`6. upload to r2://${BUCKET}/${PREFIX}/`)
  const IMMUTABLE = 'public, max-age=31536000, immutable'
  for (const p of platforms) for (const f of p.files) put(join(out, f.name), f.name, f.type, IMMUTABLE)
  // after everything they point at; both together, so the platforms move to the new version at the same moment
  for (const p of platforms) put(join(out, p.feed), p.feed, 'text/yaml', 'no-cache')
  console.log('feeds live; now the stable download copies')
  for (const p of platforms) for (const f of p.files) if (f.stable) put(join(out, f.name), f.stable, f.type, 'public, max-age=300')

  step('7. check the feeds')
  for (const p of platforms) await checkFeed(p.feed, version)
  console.log(`\ndesktop release: ${version} is live for ${platforms.map((p) => p.name).join(' and ')}.`)
  process.exit(0)
}
