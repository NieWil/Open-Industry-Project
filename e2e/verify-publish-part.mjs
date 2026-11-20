// Publish to Part Library (docs/part-libraries.md, "Publishing"; components/PublishPartDialog.tsx): a part of the
// project's library goes to the parts repository as a pull request under the author's GitHub account.
//
// GitHub and the sign-in Worker are stood in for by routes, so the gate checks what the app sends:
//
//   1. the command is on the project's own parts, not on the app's built-ins
//   2. the checks that need no network show before sign-in, and Submit waits for sign-in, a description and the rights
//   3. signing in shows GitHub's code, waits while it is pending, then names the account; the namespace is checked
//   4. Submit forks, commits the part's folder on a branch from main and opens the pull request, with the rights line
//      ticked; the dialog then says the submission is in review
//   5. reopened, it reads where the submission stands, and the same version cannot be sent twice
//   6. a part under another account's namespace is refused before anything is sent
//   7. a part the app made (user.*) is offered the author's own namespace, and renamed with its placed copies
//   8. Get parts offers publishing: the selected part at once, otherwise a choice of the project's own parts
//
//   node e2e/verify-publish-part.mjs [--headed]
/* global window, localStorage, console, process */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer as createVite } from 'vite'
import { startServer } from './_server.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const check = (n, ok, info = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`)
}

// parts made from the drum's source: one under the signed-in account, one under another
const vite = await createVite({ configFile: false, root: repo, logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true } })
const { buildPackage } = await vite.ssrLoadModule('/src/sim/buildPackage.ts')
const { RIGHTS_LINE } = await vite.ssrLoadModule('/src/core/parts/partSubmission.ts')
const source = (id, name) => {
  const m = JSON.parse(readFileSync(resolve(repo, 'src/sim/fixtures/nesting-bin/manifest.json'), 'utf8'))
  return buildPackage({ ...m, id, name }, readFileSync(resolve(repo, 'src/sim/fixtures/nesting-bin/behavior.js'), 'utf8'))
}
const mine = source('u.tester.bin', 'Tester bin')
const theirs = source('u.someone.bin', 'Someone bin')
const made = source('user.crate', 'Crate')
await vite.close()

// ── the stand-ins for the sign-in Worker and api.github.com ───────────────────────────────────────
const calls = []
let tokenAsks = 0
let pr = null
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-GitHub-Api-Version, Accept', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS' }
const reply = (route, body, status = 200) => route.fulfill({ status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const namespacesB64 = Buffer.from(JSON.stringify({ namespaces: {} })).toString('base64')

async function github(route) {
  const req = route.request()
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
  const url = new URL(req.url())
  const path = url.pathname
  const body = req.postData() ? JSON.parse(req.postData()) : undefined
  calls.push({ method: req.method(), path, body })
  const UP = '/repos/Open-Industry-Project/parts'
  if (path === '/user') return reply(route, { login: 'tester' })
  if (path === '/users/tester/orgs') return reply(route, [])
  if (path === `${UP}/contents/namespaces.json`) return reply(route, { content: namespacesB64 })
  if (path === `${UP}/git/ref/heads/main`) return reply(route, { object: { sha: 'main1' } })
  if (path === `${UP}/git/commits/main1`) return reply(route, { tree: { sha: 'tree1' } })
  if (path === `${UP}/forks`) return reply(route, { owner: { login: 'tester' }, name: 'parts' }, 202)
  if (path === '/repos/tester/parts') return reply(route, { full_name: 'tester/parts' })
  if (path === '/repos/tester/parts/merge-upstream') return reply(route, {})
  if (path === '/repos/tester/parts/git/blobs') return reply(route, { sha: `blob${calls.length}` })
  if (path === '/repos/tester/parts/git/trees') return reply(route, { sha: 'tree2' })
  if (path === '/repos/tester/parts/git/commits') return reply(route, { sha: 'commit2' })
  if (path === '/repos/tester/parts/git/refs') return reply(route, {})
  if (path === `${UP}/pulls` && req.method() === 'POST') {
    pr = body
    return reply(route, { number: 12, html_url: 'https://github.com/Open-Industry-Project/parts/pull/12' })
  }
  if (path === `${UP}/pulls/12`) return reply(route, { state: 'open', merged: false, user: { login: 'tester' } })
  if (path === `${UP}/pulls/12/reviews`) return reply(route, [])
  if (path === `/repos/Open-Industry-Project/parts/issues/12/comments`) return reply(route, [{ body: '✓ The checks passed.', user: { login: 'github-actions[bot]' } }])
  return reply(route, { message: `not stood in for: ${req.method()} ${path}` }, 500)
}

async function signin(route) {
  const req = route.request()
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
  const path = new URL(req.url()).pathname
  if (path === '/device/code') return reply(route, { device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 1, expires_in: 120 })
  if (path === '/device/token') return reply(route, ++tokenAsks < 2 ? { error: 'authorization_pending' } : { access_token: 'gho_test', token_type: 'bearer', scope: 'public_repo' })
  return reply(route, {}, 404)
}

const { port } = await startServer()
const browser = await chromium.launch({ headless: !process.argv.includes('--headed') })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const alerts = []
page.on('dialog', (d) => {
  alerts.push(d.message())
  void d.dismiss()
})
await page.route('https://api.github.com/**', github)
await page.route('https://signin.openindustryproject.org/**', signin)

const dialog = page.locator('[data-testid="publish-part"]')
const publishButton = page.getByRole('button', { name: 'Publish to Part Library…' })
const openFor = async (partId) => {
  await page.evaluate((id) => window.__oip.store.select(id), partId)
  await publishButton.waitFor({ timeout: 10000 })
  await publishButton.click()
  await dialog.waitFor({ timeout: 10000 })
}

try {
  await page.goto(`http://localhost:${port}/app/`)
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('oip-web/tutorial-done', '1')
    // Get parts reads no library from the network in this gate: the official ones are switched off
    localStorage.setItem(
      'oip-web/part-libraries-off',
      JSON.stringify(['https://parts.openindustryproject.org/oip.containers/index.json', 'https://parts.openindustryproject.org/oip.community/index.json']),
    )
  })
  await page.reload()
  await page.waitForFunction(() => window.__oip?.controller && window.__oip.store.getState().bundledPackages.length > 0, null, { timeout: 120000 })
  // the two parts in the project's library, each placed once, and a built-in beside them
  await page.evaluate(
    ({ a, b, c }) => {
      const { store, registerPackage } = window.__oip
      for (const p of [a, b, c]) {
        registerPackage(p)
        store.addUserPackage(p)
      }
      const s = store.getState()
      const place = (id, pkg, x) => ({ id, type: 'part', packageId: pkg.id, name: pkg.name, position: [x, 0, 0], rotationY: 0, params: {} })
      const builtIn = s.bundledPackages.find((p) => p.id === 'oip.box')
      store.commit('Place parts', {
        ...s.scene,
        packages: [...(s.scene.packages ?? []), a, b, c, builtIn],
        parts: [...s.scene.parts, place('mine_1', a, 0), place('theirs_1', b, 2), place('builtin_1', builtIn, 4), place('made_1', c, 6)],
      })
    },
    { a: mine, b: theirs, c: made },
  )

  // ── 1. on the project's own parts only ─────────────────────────────────────────────────────────
  await page.evaluate(() => window.__oip.store.select('builtin_1'))
  await page.locator('.inspector-head-action').first().waitFor({ timeout: 10000 })
  check('a built-in part has no Publish command', (await publishButton.count()) === 0)
  await page.evaluate(() => window.__oip.store.select('mine_1'))
  await publishButton.waitFor({ timeout: 10000 }).catch(() => {})
  check("the project's own part has it", (await publishButton.count()) === 1)

  // ── 2. the local checks, and what Submit waits for ─────────────────────────────────────────────
  await openFor('mine_1')
  const checks = dialog.locator('[data-testid="publish-checks"]')
  await checks.getByText('within the limits').waitFor({ timeout: 15000 }).catch(() => {})
  check('the checks that need no network pass before sign-in', await checks.getByText('within the limits').isVisible())
  const submit = dialog.locator('[data-testid="publish-submit"]')
  check('Submit waits for sign-in', await submit.isDisabled())

  // ── 3. sign-in ──────────────────────────────────────────────────────────────────────────────────
  await dialog.locator('[data-testid="publish-sign-in"]').click()
  await dialog.locator('[data-testid="publish-device-code"]').waitFor({ timeout: 10000 })
  check("signing in shows GitHub's code to enter", (await dialog.locator('[data-testid="publish-device-code"]').innerText()).includes('ABCD-1234'))
  await dialog.locator('[data-testid="publish-signed-in"]').waitFor({ timeout: 20000 })
  check('...waits while it is pending, then names the account', (await dialog.locator('[data-testid="publish-signed-in"]').innerText()).includes('tester') && tokenAsks >= 2)
  await checks.getByText('You may publish').waitFor({ timeout: 10000 }).catch(() => {})
  check('the namespace is checked against the account', await checks.getByText('You may publish “u.tester.bin”').isVisible())
  check('Submit still waits for a description and the rights line', await submit.isDisabled())
  await dialog.locator('[data-testid="publish-description"]').fill('A stacking bin for the test.')
  check('...and for the rights line', await submit.isDisabled())
  await dialog.locator('[data-testid="publish-rights"]').check()
  check('with all of it, Submit is ready', await submit.isEnabled())

  // ── 4. the pull request ─────────────────────────────────────────────────────────────────────────
  await submit.click()
  await dialog.locator('[data-testid="publish-state"][data-state="inReview"]').waitFor({ timeout: 20000 }).catch(() => {})
  check('Submit opens the pull request, and the dialog says it is in review', (await dialog.locator('[data-testid="publish-state"]').getAttribute('data-state')) === 'inReview')
  const order = calls.map((c) => `${c.method} ${c.path}`)
  const at = (s) => order.findIndex((o) => o.endsWith(s))
  check('it forks, uploads, commits on main and opens the pull request, in that order', at('/forks') >= 0 && at('/forks') < at('/git/blobs') && at('/git/blobs') < at('/git/trees') && at('/git/trees') < at('tester/parts/git/commits') && at('/git/refs') < at('/pulls'), order.filter((o) => o.startsWith('POST')).join(', '))
  const commit = calls.find((c) => c.path === '/repos/tester/parts/git/commits')?.body
  const tree = calls.find((c) => c.path === '/repos/tester/parts/git/trees')?.body
  check("the commit is on the repository's main", commit?.parents?.[0] === 'main1' && tree?.base_tree === 'tree1')
  const paths = (tree?.tree ?? []).map((t) => t.path).sort()
  check("it adds the part's folder under parts/<id>/", ['parts/u.tester.bin/behavior.js', 'parts/u.tester.bin/description.txt', 'parts/u.tester.bin/manifest.json'].every((p) => paths.includes(p)), paths.join(' '))
  check('the pull request comes from the fork and ticks the rights line', pr?.head?.startsWith('tester:part/u.tester.bin-') && pr?.body?.includes(`- [x] ${RIGHTS_LINE}`), pr?.head)
  check('the pull request asks nothing about training use', !pr?.body?.toLowerCase().includes('train'))

  // ── 5. reopened, it reads where the submission stands ───────────────────────────────────────────
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached', timeout: 10000 })
  await publishButton.click()
  await dialog.waitFor({ timeout: 10000 })
  await dialog.locator('[data-testid="publish-state"][data-state="inReview"]').waitFor({ timeout: 10000 }).catch(() => {})
  check('reopened, it reads the pull request and what the checks said', (await dialog.locator('[data-testid="publish-status"]').innerText()).includes('The checks passed'))
  await dialog.locator('[data-testid="publish-description"]').fill('Again.')
  await dialog.locator('[data-testid="publish-rights"]').check()
  check('the same version, still in review, cannot be sent twice', await submit.isDisabled())
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached', timeout: 10000 })

  // ── 6. another account's namespace ──────────────────────────────────────────────────────────────
  await openFor('theirs_1')
  await checks.getByText("another account's namespace").waitFor({ timeout: 10000 }).catch(() => {})
  check("a part under another account's namespace is refused before anything is sent", await checks.getByText("another account's namespace").isVisible())
  await dialog.locator('[data-testid="publish-description"]').fill('Not mine.')
  await dialog.locator('[data-testid="publish-rights"]').check()
  check('...and Submit stays off', await submit.isDisabled())
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached', timeout: 10000 })

  // ── 7. a part the app made is offered the author's own namespace ───────────────────────────────
  await openFor('made_1')
  const rename = dialog.locator('[data-testid="publish-rename"]')
  await rename.waitFor({ timeout: 10000 }).catch(() => {})
  check("a part the app made is offered the author's namespace", (await rename.innerText().catch(() => '')).includes('u.tester.crate'))
  await rename.click()
  await checks.getByText('You may publish “u.tester.crate”').waitFor({ timeout: 10000 }).catch(() => {})
  check('...which renames it, and it may then be published', await checks.getByText('You may publish “u.tester.crate”').isVisible())
  const moved = await page.evaluate(() => {
    const s = window.__oip.store.getState()
    return { placed: s.scene.parts.find((p) => p.id === 'made_1')?.packageId, library: s.userPackages.some((p) => p.id === 'u.tester.crate') && !s.userPackages.some((p) => p.id === 'user.crate') }
  })
  check('the placed copy and the library follow the new id', moved.placed === 'u.tester.crate' && moved.library, JSON.stringify(moved))
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached', timeout: 10000 })

  // ── 8. Get parts offers publishing ──────────────────────────────────────────────────────────────
  const getParts = page.locator('[data-testid="get-parts"]')
  const publishFromGetParts = getParts.locator('nav [data-testid="get-parts-publish"]')
  await page.evaluate(() => window.__oip.store.select('theirs_1'))
  await page.locator('[data-testid="catalog-get-parts"]').click()
  await getParts.waitFor({ timeout: 10000 })
  check('with a part of its own selected, Get parts offers to publish it by name', (await publishFromGetParts.innerText()).includes('Someone bin'))
  await publishFromGetParts.click()
  await dialog.waitFor({ timeout: 10000 })
  check('...and opens Publish for it, closing Get parts', (await dialog.innerText()).includes('Someone bin') && (await getParts.count()) === 0)
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached', timeout: 10000 })
  await page.evaluate(() => window.__oip.store.select(null))
  await page.locator('[data-testid="catalog-get-parts"]').click()
  await getParts.waitFor({ timeout: 10000 })
  await publishFromGetParts.click()
  const choices = getParts.locator('[data-testid="get-parts-publish-choice"]')
  await choices.first().waitFor({ timeout: 10000 }).catch(() => {})
  const offered = await choices.evaluateAll((els) => els.map((e) => e.dataset.partId).sort())
  check("with nothing selected, it lists the project's own parts, not the built-ins", JSON.stringify(offered) === JSON.stringify(['u.someone.bin', 'u.tester.bin', 'u.tester.crate']), offered.join(' '))
  await choices.filter({ hasText: 'Tester bin' }).click()
  await dialog.waitFor({ timeout: 10000 })
  check('choosing one opens Publish for it', (await dialog.innerText()).includes('Tester bin'))

  check('no alert was raised', alerts.length === 0, alerts.join(' | '))
} catch (e) {
  failures++
  console.log(`FAIL  ${e instanceof Error ? e.message : e}`)
} finally {
  await browser.close()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
