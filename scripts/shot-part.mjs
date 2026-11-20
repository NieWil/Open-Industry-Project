// Screenshot one custom part, headless, for an agent that cannot look at the app:
//
//   node scripts/shot-part.mjs <part-folder> [--out <dir>] [--pose <joint>=<value>,...] [--sub-pose <link>=<json>]...
//                              [--params <k>=<v>,...] [--focus <x>,<y>,<z>,<r>]
//
// A part folder is manifest.json (or an example's rig.json) + behavior.js (or behavior.ts), as check-part reads.
// Writes front.png / side.png / top.png / iso.png of the part at REST into --out (default <part-folder>/shots/).
// REST is what the stopped editor shows: the part's own step() settled on its params with no tags or Use.
// --pose writes a second set *-posed.png with those joint values applied. --sub-pose poses a link the way the behavior's
// ctx.setSubPose does, as JSON: `--sub-pose 'carriage={"position":[0,0.2,0]}'`, and `slat[3]={"rotation":[0,0,1]}` for
// one copy of a posable array. It repeats, once per link or copy, and goes in the same posed set. --focus frames a CLOSE-UP: a sphere of
// radius r round the part-local point (x, y, z), for detail too small to judge whole (a handle, a seam).
//
// How, all existing machinery:
//   - BAKE: src/sim/validatePart.ts through vite ssrLoadModule. The package is renamed `<id>.shot` because bundled
//     ids are authoritative in the registry: otherwise an edited `oip.diverter` would render as the shipped one.
//   - RENDER: the real editor via e2e/_server.mjs startServer(), a scene holding only this part (no building),
//     shot with e2e/_shot.mjs cleanShot().
//   - SETTLE: waits for the part's view entry AND window.__oip.assetsBusy() === false (a positive signal).
//   - FRAME: world AABB of every visible mesh under the part's view entry (including ones a draw-merge pass hid);
//     each view is a perspective camera fitted to its bounding sphere. front = from +Z (X right), side = from +X
//     (-Z right), top = from +Y (X right, -Z up), iso = from (+X, +Y, +Z). The part is lifted so its lowest point
//     sits on the floor, or, for a legged part (a rest:'surfaceBelow' param), its origin at that height.
//   - POSE: view.applyIdlePose(partId, { joints, subPoses }), the idle preview's own applier; unnamed joints keep their rest
//     value, and posed shots are framed on the union of both boxes. For a pose the behavior derives from a param
//     (diverter `diverted`, blade stop `active`), pass --params instead.
//   - --params sets instance params before load (true/false/numbers parsed; anything else is a string).
//
// Exit 0 = shots written, 1 = render problem (no meshes, page/console errors, bake failure), 2 = usage/IO.

/* global window */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const USAGE = 'usage: node scripts/shot-part.mjs <part-folder> [--out <dir>] [--pose <joint>=<value>,...] [--sub-pose <link>=<json>]... [--params <k>=<v>,...] [--focus <x>,<y>,<z>,<r>] [--headed]'
const usage = (msg) => {
  if (msg) console.error(msg)
  console.error(USAGE)
  process.exit(2)
}

// ---- args -------------------------------------------------------------------------------------------------
const argv = process.argv.slice(2)
let folder = null
let outDir = null
let poseArg = null
let paramsArg = null
let focusArg = null
const subPoseArgs = []
const headed = argv.includes('--headed')
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--headed') continue
  if (a === '--out' || a === '--pose' || a === '--sub-pose' || a === '--params' || a === '--focus') {
    const v = argv[++i]
    if (v === undefined) usage(`${a} needs a value`)
    if (a === '--out') outDir = v
    else if (a === '--sub-pose') subPoseArgs.push(v)
    else if (a === '--pose') poseArg = v
    else if (a === '--focus') focusArg = v
    else paramsArg = v
  } else if (a.startsWith('--')) usage(`unknown option ${a}`)
  else if (folder === null) folder = a
  else usage(`one part folder only (got ${folder} and ${a})`)
}
if (!folder) usage()
folder = resolve(folder)
if (!existsSync(folder) || !statSync(folder).isDirectory()) usage(`not a folder: ${folder}`)
outDir = resolve(outDir ?? join(folder, 'shots'))

const parseValue = (s) => {
  if (s === 'true') return true
  if (s === 'false') return false
  if (s.trim() !== '' && Number.isFinite(Number(s))) return Number(s)
  return s
}
const parsePairs = (s, what) => {
  const out = {}
  for (const item of s.split(',').map((x) => x.trim()).filter(Boolean)) {
    const eq = item.indexOf('=')
    if (eq <= 0) usage(`${what}: expected <name>=<value>, got "${item}"`)
    out[item.slice(0, eq).trim()] = parseValue(item.slice(eq + 1).trim())
  }
  return out
}
const pose = poseArg ? parsePairs(poseArg, '--pose') : null
const paramOverrides = paramsArg ? parsePairs(paramsArg, '--params') : {}
const focus = focusArg ? focusArg.split(',').map(Number) : null
if (focus && (focus.length !== 4 || !focus.every(Number.isFinite) || focus[3] <= 0)) usage(`--focus: expected <x>,<y>,<z>,<r> in part-local metres, got "${focusArg}"`)
if (pose) for (const [k, v] of Object.entries(pose)) if (typeof v !== 'number') usage(`--pose ${k}: a joint value must be a number (m or rad), got "${v}"`)
// --sub-pose <link>[<i>]=<json>, into applyIdlePose's subPoses: { link: { position?, rotation?, quat?, instances? } }
const vec = (v, n) => Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x))
const subPoses = {}
for (const arg of subPoseArgs) {
  const m = /^([^=[\]]+?)\s*(?:\[(\d+)\])?\s*=(.*)$/s.exec(arg)
  if (!m) usage(`--sub-pose: expected <link>=<json> or <link>[<i>]=<json>, got "${arg}"`)
  const [, link, index, json] = m
  let p
  try {
    p = JSON.parse(json)
  } catch (e) {
    usage(`--sub-pose ${link}: not JSON (${e.message}): ${json}`)
  }
  if (typeof p !== 'object' || p === null || Array.isArray(p)) usage(`--sub-pose ${link}: expected an object like {"position":[x,y,z]}`)
  for (const k of Object.keys(p)) if (k !== 'position' && k !== 'rotation' && k !== 'quat') usage(`--sub-pose ${link}: "${k}" is not position, rotation (Euler XYZ, rad) or quat`)
  if (p.position !== undefined && !vec(p.position, 3)) usage(`--sub-pose ${link}: position wants [x, y, z] in metres`)
  if (p.rotation !== undefined && !vec(p.rotation, 3)) usage(`--sub-pose ${link}: rotation wants [x, y, z] in radians`)
  if (p.quat !== undefined && !vec(p.quat, 4)) usage(`--sub-pose ${link}: quat wants [x, y, z, w]`)
  const name = link.trim()
  if (index === undefined) subPoses[name] = { ...subPoses[name], ...p }
  else {
    const instances = subPoses[name]?.instances ?? []
    while (instances.length <= Number(index)) instances.push(null)
    instances[Number(index)] = p
    subPoses[name] = { ...subPoses[name], instances }
  }
}
const posing = pose !== null || subPoseArgs.length > 0

const pick = (names) => names.map((n) => join(folder, n)).find((p) => existsSync(p))
const manifestPath = pick(['manifest.json', 'rig.json'])
const behaviorPath = pick(['behavior.js', 'behavior.ts'])
if (!manifestPath) usage(`no manifest.json (or rig.json) in ${folder}`)
if (!behaviorPath) usage(`no behavior.js (or behavior.ts) in ${folder}`)
let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (e) {
  usage(`${manifestPath} is not valid JSON: ${e.message}`)
}

// ---- bake (node side) -------------------------------------------------------------------------------------
const PART_ID = 'shot_part'
let pkg, part, footprint, sceneVersion, standHeight = 0
{
  const vite = await createServer({
    configFile: false,
    root: repo,
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  })
  try {
    const { validatePart } = await vite.ssrLoadModule('/src/sim/validatePart.ts')
    const { registerPackage } = await vite.ssrLoadModule('/src/core/parts/partRegistry.ts')
    const { partFootprint, surfaceBelowParam } = await vite.ssrLoadModule('/src/core/parts/partGeometry.ts')
    const { createSdkPart } = await vite.ssrLoadModule('/src/core/scene/scene.ts')
    ;({ SCENE_VERSION: sceneVersion } = await vite.ssrLoadModule('/src/core/types/base.ts'))
    const result = validatePart(manifest, readFileSync(behaviorPath, 'utf8'))
    if (!result.ok || !result.package) {
      console.error(`✗ ${folder}: the part does not bake`)
      for (const d of result.diagnostics) console.error(`    ✗ [${d.kind}] ${d.line ? `behavior line ${d.line}: ` : ''}${d.message}`)
      console.error('  (npm run check-part -- <folder> explains more)')
      process.exit(1)
    }
    pkg = { ...result.package, id: `${result.package.id}.shot` }
    const geo = pkg.geometry
    if (pose) {
      const joints = geo.kind === 'rig' ? geo.joints : []
      for (const [name, v] of Object.entries(pose)) {
        const j = joints.find((x) => x.name === name)
        if (!j) usage(`--pose: no joint "${name}" (the part's joints: ${joints.map((x) => x.name).join(', ') || 'none'})`)
        if ((j.min !== undefined && v < j.min) || (j.max !== undefined && v > j.max)) console.warn(`! --pose ${name}=${v} is outside the joint's range ${j.min}..${j.max}`)
      }
    }
    {
      const links = geo.kind === 'rig' ? geo.links : []
      for (const [name, sp] of Object.entries(subPoses)) {
        const l = links.find((x) => x.name === name)
        if (!l) usage(`--sub-pose: no link "${name}" (the part's links: ${links.map((x) => x.name).join(', ') || 'none'})`)
        if (sp.instances && !l.array?.posable) usage(`--sub-pose ${name}[i]: "${name}" is not a posable array (array.posable), so it has no copies to pose one by one`)
      }
    }
    for (const k of Object.keys(paramOverrides)) if (!(k in (pkg.params ?? {}))) usage(`--params: no param "${k}" (the part's params: ${Object.keys(pkg.params ?? {}).join(', ') || 'none'})`)
    registerPackage(pkg)
    part = createSdkPart(pkg, PART_ID, [0, 0, 0], 0, { placed: true })
    Object.assign(part.params, paramOverrides)
    try {
      footprint = partFootprint(part)
    } catch {
      footprint = null
    }
    // A part that stands on legs (a platform) declares a rest:'surfaceBelow' param: the editor stands its ORIGIN
    // that high above the surface under it, and its geometry grows down to reach. Its footprint says nothing
    // about that, so without this the deck top sat on the floor, the columns buried and the deck z-fighting it.
    const standParam = surfaceBelowParam(part)
    const stand = standParam ? part.params[standParam] : undefined
    standHeight = typeof stand === 'number' && stand > 0 ? stand : 0
  } finally {
    await vite.close()
  }
}
// sit the part on the floor: a device whose origin is a mount point (blade stop, sensors) hangs below y = 0, and a
// legged part stands its origin standHeight up (see standHeight above)
const lift = standHeight || (footprint && footprint.y0 < 0 ? -footprint.y0 : 0)
part.position = [0, lift, 0]

// ---- render (browser side) --------------------------------------------------------------------------------
const { startServer } = await import('../e2e/_server.mjs')
const { cleanShot } = await import('../e2e/_shot.mjs')
const { chromium } = await import('playwright')

const VIEWS = [
  { name: 'front', az: 0, el: 0 },
  { name: 'side', az: 90, el: 0 },
  { name: 'top', az: 0, el: 89.5 },
  { name: 'iso', az: 45, el: 30 },
]
const errors = []
const benign = (s) => /GLTFLoader: Couldn't load texture|Download the React DevTools|\[vite\]/.test(s)
const written = []
let meshCount = 0
let failed = false

const { url, vite } = await startServer({ quiet: true })
let browser
try {
  mkdirSync(outDir, { recursive: true })
  browser = await chromium.launch({ headless: !headed })
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } })
  page.on('pageerror', (e) => !benign(String(e)) && errors.push(`pageerror: ${String(e)}`))
  page.on('console', (m) => m.type() === 'error' && !benign(m.text()) && errors.push(`console: ${m.text()}`))

  // A cold dev server re-optimizes deps and RELOADS the page once, and a src/ save elsewhere fires HMR; either
  // destroys the context mid-setup. Boot again from the top when that happens (a navigation, not a failure).
  const boot = async () => {
    errors.length = 0 // what a torn-down attempt logged is not this part's problem
    await page.goto(url)
    await page.waitForFunction(() => !!(window.__oip?.store && window.__oip.view && window.__oip.controller), null, { timeout: 60000 })
    // the bundled catalog loads async at boot; let it land so nothing it does races our scene swap
    await page.waitForFunction(() => window.__oip.store.getState().bundledPackages.length > 0, null, { timeout: 30000 }).catch(() => {})
    await page.evaluate(
      ([scene]) => {
        const st = window.__oip.store
        st.loadScene(scene, { persist: false })
        st.setState({ selectedIds: [] })
      },
      [{ version: sceneVersion, parts: [part], packages: [pkg] }],
    )
    // settle: the entry exists and no asset fetch is in flight - held over a few frames (a POSITIVE signal,
    // not a timed guess; the short hold only covers the frame the GLB swap lands on)
    await page.waitForFunction(
      (id) => {
        const o = window.__oip
        if (!o.view.entries.get(id)?.visual.object || (o.assetsBusy?.() ?? false)) {
          o.__shotQuiet = 0
          return false
        }
        o.__shotQuiet = (o.__shotQuiet ?? 0) + 1
        return o.__shotQuiet >= 10
      },
      PART_ID,
      { timeout: 60000, polling: 'raf' },
    )
    await page.waitForTimeout(600) // idle-pose settle (refreshIdlePoses) + a bundle re-record
  }
  for (let attempt = 1; ; attempt++) {
    try {
      await boot()
      break
    } catch (e) {
      if (attempt >= 4 || !/context was destroyed|navigation|Target closed/i.test(e.message)) throw e
      await page.waitForLoadState('load').catch(() => {})
    }
  }

  const measure = () =>
    page.evaluate((id) => {
      const root = window.__oip.view.entries.get(id)?.visual.object
      if (!root) return null
      root.updateMatrixWorld(true)
      const min = [Infinity, Infinity, Infinity]
      const max = [-Infinity, -Infinity, -Infinity]
      const tx = (m, x, y, z) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]
      // The draw-merge passes hide a part's own meshes and draw them from elsewhere: the instance pool from
      // scene-wide banks (poolHidden), the static fold from a merged copy under
      // this root (staticFoldSource). Those sources are still where they draw, so they count as shown, and the
      // fold's merged copy (staticFold) is skipped so nothing counts twice. Without this a pooled part (stairs)
      // measured zero meshes, failed the run and framed an empty box at the origin.
      const merged = (o) => o.userData.poolHidden || o.userData.staticFoldSource
      const shown = (o) => {
        for (let p = o; p; p = p.parent) if (!p.visible && !(p === o && merged(o))) return false
        return true
      }
      let meshes = 0
      root.traverse((o) => {
        if (!o.isMesh || !o.geometry || o.userData.staticFold || !shown(o)) return
        meshes++
        const g = o.geometry
        if (!g.boundingBox) g.computeBoundingBox()
        const b = g.boundingBox
        if (!b || !Number.isFinite(b.min.x)) return
        const W = o.matrixWorld.elements
        const inst = o.isInstancedMesh ? o.count : 1
        for (let k = 0; k < inst; k++) {
          const I = o.isInstancedMesh ? o.instanceMatrix.array.slice(k * 16, k * 16 + 16) : null
          for (let c = 0; c < 8; c++) {
            let p = [c & 1 ? b.max.x : b.min.x, c & 2 ? b.max.y : b.min.y, c & 4 ? b.max.z : b.min.z]
            if (I) p = tx(I, ...p)
            p = tx(W, ...p)
            for (let a = 0; a < 3; a++) {
              if (p[a] < min[a]) min[a] = p[a]
              if (p[a] > max[a]) max[a] = p[a]
            }
          }
        }
      })
      return { meshes, box: Number.isFinite(min[0]) ? { min, max } : null }
    }, PART_ID)

  const union = (a, b) => (!a ? b : !b ? a : { min: a.min.map((v, k) => Math.min(v, b.min[k])), max: a.max.map((v, k) => Math.max(v, b.max[k])) })
  const fallbackBox = footprint
    ? { min: [(footprint.cx ?? 0) - footprint.hx, footprint.y0 + lift, -footprint.hz], max: [(footprint.cx ?? 0) + footprint.hx, footprint.y1 + lift, footprint.hz] }
    : { min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] }

  const shoot = async (box, suffix) => {
    for (const v of VIEWS) {
      await page.evaluate(
        ([box, az, el]) => {
          const view = window.__oip.view
          const cam = view.camera
          const c = box.min.map((m, k) => (m + box.max[k]) / 2)
          const r = Math.max(0.05, Math.hypot(...box.max.map((m, k) => (m - box.min[k]) / 2)))
          const vfov = (cam.fov * Math.PI) / 180
          const hfov = 2 * Math.atan(Math.tan(vfov / 2) * cam.aspect)
          const d = (r / Math.sin(Math.min(vfov, hfov) / 2)) * 1.08
          const A = (az * Math.PI) / 180
          const E = (el * Math.PI) / 180
          const p = [c[0] + d * Math.cos(E) * Math.sin(A), c[1] + d * Math.sin(E), c[2] + d * Math.cos(E) * Math.cos(A)]
          if (cam.near > r * 0.05) {
            cam.near = Math.max(0.001, r * 0.05)
            cam.updateProjectionMatrix()
          }
          // the editor's orbit clamp (minDistance 1.5 m) would otherwise push the camera back out, so a small part
          // - a 16 cm sensor, any --focus close-up - came out a speck in the middle of the floor
          if (view.controls && view.controls.minDistance > d * 0.5) view.controls.minDistance = d * 0.5
          view.setCameraPose({ px: p[0], py: p[1], pz: p[2], tx: c[0], ty: c[1], tz: c[2] }, { instant: true })
        },
        [box, v.az, v.el],
      )
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
      await page.waitForTimeout(150)
      const file = join(outDir, `${v.name}${suffix}.png`)
      await cleanShot(page, file)
      written.push(file)
    }
  }

  const rest = await measure()
  meshCount = rest?.meshes ?? 0
  if (meshCount === 0) {
    failed = true
    errors.push('the part rendered no meshes (its view entry is empty)')
  }
  // a --focus close-up frames its sphere (part-local, so lifted like the part) instead of the measured part
  const focusBox = focus ? { min: [focus[0] - focus[3], focus[1] + lift - focus[3], focus[2] - focus[3]], max: [focus[0] + focus[3], focus[1] + lift + focus[3], focus[2] + focus[3]] } : null
  const restBox = focusBox ?? rest?.box ?? fallbackBox
  await shoot(restBox, '')

  if (posing) {
    await page.evaluate(([id, joints, subs]) => window.__oip.view.applyIdlePose(id, { ...(joints ? { joints } : {}), ...(Object.keys(subs).length ? { subPoses: subs } : {}) }), [PART_ID, pose, subPoses])
    await page.waitForTimeout(200)
    const posed = await measure()
    await shoot(focusBox ?? union(restBox, posed?.box ?? null), '-posed')
  }
} catch (e) {
  failed = true
  errors.push(`script: ${e.message}`)
} finally {
  await browser?.close().catch(() => {})
  vite.kill()
}

for (const f of written) console.log(f)
const r3 = (n) => Math.round(n * 1000) / 1000
console.log(
  `${failed || errors.length ? '✗' : '✓'} ${pkg.id.replace(/\.shot$/, '')} "${pkg.name}": ${meshCount} mesh(es) rendered, ${written.length} shot(s)` +
    `${lift ? `, lifted ${r3(lift)} m onto the floor` : ''}${posing ? `, posed ${[...Object.entries(pose ?? {}).map(([k, v]) => `${k}=${v}`), ...subPoseArgs].join(' ')}` : ''}` +
    `, ${errors.length} error(s)`,
)
for (const e of errors.slice(0, 10)) console.log(`    ✗ ${e}`)
process.exit(failed || errors.length ? 1 : 0)
