/// <reference types="vitest/config" />
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { computeAssetVersions } from './scripts/lib/asset-versions.mjs'
import { bundledLicenses } from './scripts/lib/bundled-licenses.mjs'
import { monacoDompurify } from './scripts/lib/monaco-dompurify.mjs'

const entry = (p: string): string => fileURLToPath(new URL(p, import.meta.url))

/** the unit specs that run without lockdown (see `test.projects` below): those that fake timers, and those that
 *  say `@unlocked-realm` because they test a host where the part sandbox is absent */
const UNLOCKED_SPECS: string[] = readdirSync(entry('./src'), { recursive: true, encoding: 'utf8' })
  .filter((f) => {
    if (!f.endsWith('.test.ts')) return false
    const text = readFileSync(join(entry('./src'), f), 'utf8')
    return text.includes('useFakeTimers') || text.includes('@unlocked-realm')
  })
  .map((f) => `src/${f.split('\\').join('/')}`)

// Threaded Jolt (?joltthreads, sim/worker.ts) needs SharedArrayBuffer, which browsers only
// expose in a cross-origin isolated context: these two headers on the document + every
// same-origin subresource. Everything we serve is same-origin (models/textures/fonts local,
// collab is a WebSocket, which COEP exempts), so isolation breaks nothing in dev.
// CORP: Chromium admits same-origin responses under COEP implicitly, but WebKit refuses
// worker-graph loads without an explicit Cross-Origin-Resource-Policy header ("Worker load
// was blocked by Cross-Origin-Embedder-Policy"; see e2e/probes/webkit-mt-smoke.mjs), so the
// Safari path needs it stated. Prod ships the same three headers via public/_headers
// (/app + worker-bearing /assets). The shell is also no-store: a host that strips all headers
// on 304s (the same class of bug as coiHeadersOn304 below) kills the Safari sim worker on
// revisit. Cloudflare does not, so the no-store is a deliberate second safeguard (see
// public/_headers).
const coiHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
}

// server.headers only decorates full responses; vite's etag short-circuit sends 304s bare.
// Chromium checks COEP against the cached entry so it never notices, but WebKit validates the
// raw 304 on worker loads and kills the sim worker with "Worker load was blocked by
// Cross-Origin-Embedder-Policy" on any revisit (whichever worker-graph module revalidates
// first). Setting the headers in a middleware before the short-circuit puts them on every
// response, 304s included. Probes: e2e/probes/webkit-mt-smoke.mjs, e2e/probes/webkit-worker-probe.mjs.
const coiHeadersOn304 = {
  name: 'oip-coi-headers-on-304',
  configureServer(server: { middlewares: { use: (fn: (req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => void) => void } }) {
    server.middlewares.use((_req, res, next) => {
      for (const [k, v] of Object.entries(coiHeaders)) res.setHeader(k, v)
      next()
    })
  },
}

// monaco's monarch compiler builds keyword tables with `result[e] = true` on a plain {}, and the
// JS/TS keyword list contains 'constructor'. Under SES lockdown Object.prototype is frozen, so that
// write is the override mistake (realmLockdown.ts): it throws, the tokenizer never compiles, and the
// behavior editor loses its syntax highlighting with only an SES_UNHANDLED_REJECTION in the console.
// defineProperty makes the same own property without the inherited setter. The table is read with
// hasOwnProperty, so it must keep its prototype (Object.create(null) would break the reader). Applied
// to the build and to dev's dependency pre-bundle (optimizeDeps below), which plugins don't reach.
// Throws if the target line is gone, so a monaco upgrade makes someone re-check rather than silently
// shipping the bug again; delete this when monaco stops assigning keyword hashes.
const MONARCH_HASH_WRITE = 'result[e] = true;'
const monarchKeywordHash = {
  name: 'oip-monarch-keyword-hash',
  transform(code: string, id: string) {
    if (!id.replace(/\\/g, '/').endsWith('/monarch/monarchCompile.js')) return null
    if (!code.includes(MONARCH_HASH_WRITE)) {
      throw new Error(`oip-monarch-keyword-hash: "${MONARCH_HASH_WRITE}" not found in ${id}; monaco changed - re-check the SES override mistake (vite.config.ts)`)
    }
    return code.replace(MONARCH_HASH_WRITE, 'Object.defineProperty(result, e, { value: true, writable: true, enumerable: true, configurable: true });')
  },
}

// OIP_DEV_PROD_ASSETS=1 npm run dev - serve /models and /textures from dist/ instead of public/.
//
// The most common bug class in this repo is "works in dev, broken in prod", and its root
// cause is structural: `vite dev` serves public/ raw, so day-to-day development never exercises the
// Draco-compressed rigs, the webp/resized textures, or the pruned UVs that scripts/optimize-assets.mjs
// produces. Incidents traced to exactly that gap include the de-textured Box (stripped UVs), the dark
// building walls (quantized UVs), the Diverter rendering stuck extended (meshopt-baked node
// transforms), and the dock doors texturing themselves after the loading cover. Every one was found
// by a user or by a late prod check, not while writing the code.
//
// With this on, a dev build reads the optimized assets, so whoever writes the feature sees what ships. Off by default: it needs a prior `npm run build`, and editing a source asset has no
// effect until you rebuild (that surprise is worse than the divergence for routine UI work).
// `npm run preview:slow` remains the full-fidelity check (real SWA routes + a throttled link); this
// is the cheap everyday approximation.
const devProdAssets = {
  name: 'oip-dev-prod-assets',
  configureServer(server: {
    middlewares: { use: (fn: (req: { url?: string }, res: DevRes, next: () => void) => void) => void }
    config: { logger: { warn: (msg: string) => void } }
  }) {
    if (!process.env.OIP_DEV_PROD_ASSETS) return
    const dist = fileURLToPath(new URL('./dist/', import.meta.url))
    if (!existsSync(dist)) {
      server.config.logger.warn('[oip] OIP_DEV_PROD_ASSETS is set but dist/ is missing — run `npm run build` first; serving public/ as usual')
      return
    }
    server.config.logger.warn('[oip] OIP_DEV_PROD_ASSETS: /models and /textures are served from dist/ (optimized). Rebuild to pick up source-asset edits.')
    // registered from configureServer directly, so it runs before vite's public-dir middleware
    server.middlewares.use((req, res, next) => {
      const path = (req.url ?? '').split('?')[0] ?? ''
      if (!path.startsWith('/models/') && !path.startsWith('/textures/')) return next()
      const file = join(dist, decodeURIComponent(path).replace(/^\//, ''))
      if (!file.startsWith(dist) || !existsSync(file)) return next() // traversal guard + fall through
      const ext = extname(file).toLowerCase()
      res.setHeader('Content-Type', DEV_ASSET_MIME[ext] ?? 'application/octet-stream')
      res.setHeader('Cache-Control', 'no-cache') // always revalidate: dist changes under the server
      res.end(readFileSync(file))
    })
  },
}
interface DevRes {
  setHeader: (k: string, v: string) => void
  end: (body?: Buffer) => void
}
const DEV_ASSET_MIME: Record<string, string> = {
  '.glb': 'model/gltf-binary',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ktx2': 'image/ktx2',
}

// three.js owns a live WebGL/WebGPU context + GPU resources and a set of module-level
// singletons (the WebGPU node-material factories, registered once at mount). A partial
// react-refresh hot-update leaves the old context running with stale code, or resets those
// singletons to null without re-registering them - both show up as black/corrupt artifacts.
// Force a full page reload for any edit under src/render/ so the renderer is rebuilt cleanly;
// the rest of the app keeps fast HMR. Dev-only (handleHotUpdate never runs in a build).
const renderFullReload = {
  name: 'oip-render-full-reload',
  handleHotUpdate({ file, server }: { file: string; server: { ws: { send: (p: { type: 'full-reload'; path: string; triggeredBy: string }) => void } } }) {
    if (file.replace(/\\/g, '/').includes('/src/render/')) {
      // triggeredBy names the file to an agent whose call the reload cut off (editor/agent/desktopAgent.ts)
      server.ws.send({ type: 'full-reload', path: '*', triggeredBy: file })
      return [] // skip the default partial HMR - we've triggered a full reload instead
    }
  },
}

// Content versions for the unhashed assets (/models, /textures, /thumbnails), so a changed file gets a URL no cache
// has seen (scripts/lib/asset-versions.mjs says why). A build hands the table to src/core/assetVersions.ts through
// `define` and rewrites the asset URLs spelled in the HTML pages (the landing's warm list) the same way, so a warm
// and the app's own load fetch one URL. Dev and the unit tests get null: URLs pass through, and vite serves public/
// unchanged.
const ASSET_URL_IN_HTML = /(['"])(\/(?:models|textures|thumbnails)\/[^'"?#\s]+)\1/g
const assetVersions = (() => {
  let versions: Record<string, string> | null = null
  return {
    name: 'oip-asset-versions',
    config(_config: unknown, { command }: { command: 'build' | 'serve' }) {
      versions = command === 'build' ? computeAssetVersions(entry('./')) : null
      return { define: { __OIP_ASSET_VERSIONS__: JSON.stringify(versions) } }
    },
    transformIndexHtml(html: string) {
      if (!versions) return html
      const table = versions
      return html.replace(ASSET_URL_IN_HTML, (all, q: string, url: string) => (table[url] ? `${q}${url}?v=${table[url]}${q}` : all))
    },
  }
})()

/**
 * Identifies the build inside the device benchmark's result blob (src/editor/bench.ts). Two
 * pastes from different builds must not be compared by accident, and a phone has no other way to
 * say which code produced its numbers. `+dirty` marks an uncommitted tree, which is the normal
 * state while iterating on the very fields being measured.
 */
function buildId(): string {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0
    return dirty ? sha + '+dirty' : sha
  } catch {
    return 'unknown' // no git (a tarball build) - better than a fake id
  }
}

/**
 * When this build's source was committed, in unix seconds: the build stamp that orders builds, which the id
 * (a hash) cannot. A collab room records the newest one that has joined it as an editor, and an older build
 * goes view-only there rather than write back what it cannot read (collab/schema.ts ROOM_BUILD_META). The
 * commit's time, not the clock's, so two builds of one commit agree. 0 without git: no stamp, no check.
 */
function buildTime(): number {
  try {
    return Number(execFileSync('git', ['show', '-s', '--format=%ct', 'HEAD'], { encoding: 'utf8' }).trim()) || 0
  } catch {
    return 0
  }
}

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(buildId()), __BUILD_TIME__: JSON.stringify(buildTime()) },
  plugins: [
    react(),
    renderFullReload,
    assetVersions,
    coiHeadersOn304,
    devProdAssets,
    monarchKeywordHash,
    // monaco's vendored DOMPurify -> the npm package package.json pins (scripts/lib/monaco-dompurify.mjs)
    monacoDompurify(),
    // dist/THIRD_PARTY_LICENSES.txt: the license text of every package in the output (scripts/lib/bundled-licenses.mjs)
    bundledLicenses({ emit: true }),
    VitePWA({
      // 'prompt' (not autoUpdate): we never silently reload out from under an in-progress
      // edit / collab session. A new deploy surfaces a "Reload" toast (UpdatePrompt) the user
      // clicks when ready. injectRegister:false because we register manually in UpdatePrompt
      // so we can poll for new builds (long-open tabs only re-check at registration otherwise).
      registerType: 'prompt',
      injectRegister: false,
      // copied verbatim into dist so the manifest/index can reference them
      includeAssets: ['favicon-16.png', 'favicon-32.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Open Industry Project',
        short_name: 'OIP',
        description: 'Browser-based industrial conveyor and material-handling simulator.',
        // the toolbar's colour, not the app background: this tints the status bar, and the
        // toolbar is what sits under it. background_color below stays --bg (it is the splash).
        theme_color: '#202225',
        background_color: '#17181b',
        display: 'standalone',
        orientation: 'any',
        // the installed PWA opens straight into the editor, not the marketing landing
        start_url: '/app/',
        scope: '/',
        icons: [
          { src: '/icons/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/pwa-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // An activating worker takes control of tabs that loaded without one (a first visit, Ctrl+Shift+R), so the
        // Reload toast's controllerchange fires in every tab. It does not skip waiting: a new build still waits
        // for Reload.
        clientsClaim: true,
        // precache the app shell. The Jolt SIMD build ships a separate ~2 MB .wasm
        // and the three.js chunk is large, so the default 2 MiB cap would silently
        // drop them from the precache and break offline launch.
        globPatterns: ['**/*.{js,css,html,wasm}'],
        // ...except the model importers' readers: the STEP CAD kernel (editor/stepImport.ts, 7.6 MB) and the USD
        // reader (editor/usdImport.ts, 2.3 MB). Only an author importing such a file needs them, so they download
        // on that first import instead of for every visitor
        globIgnores: ['**/occt-import-js-*.wasm', '**/usd_wasm_bg-*.wasm'],
        maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
        // The SPA lives under /app/; its deep links (e.g. /app/?scene=demo) must fall back
        // to the app shell, not the marketing landing. Falling back to /index.html would serve
        // the landing for any /app/ navigation that missed the precache, i.e. any query-string
        // URL like ?scene=demo.
        navigateFallback: '/app/index.html',
        // An allowlist, mirroring public/_redirects' one rule (/app/* -> /app/): the editor is
        // the only SPA on the origin, so every other navigation is a real file and must reach
        // the network. A denylist (/, /index.html, /st/) hands the editor shell to every page it
        // forgets: the landing footer's /THIRD_PARTY_NOTICES.md and /LICENSE would open the app
        // for anyone who had visited it, while the server itself answered correctly.
        navigateFallbackAllowlist: [/^\/app\//],
        // 3D assets are too large to precache; cache them on first use instead.
        runtimeCaching: [
          {
            // A versioned asset URL (`?v=<content hash>`, src/core/assetVersions.ts) names one set of bytes for
            // good, so the cached copy is always right: CacheFirst, no revalidation. A changed file arrives
            // under a new URL, and the old entries age out of the cache below.
            urlPattern: ({ url }) => /\/(models|textures|thumbnails)\//.test(url.pathname) && url.searchParams.has('v'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'oip-assets-versioned',
              expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
              rangeRequests: true,
            },
          },
          {
            urlPattern: ({ url }) => /\/(models|textures|thumbnails)\//.test(url.pathname),
            // An unversioned asset URL (a path the build had no file for, e.g. a package asset added at run time)
            // keeps StaleWhileRevalidate: its name is stable, so CacheFirst would serve the old bytes for the full
            // maxAge without ever hitting the network; SWR serves cached instantly but refetches in the
            // background, so an edited asset self-heals on the next load instead of going stale for weeks.
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'oip-assets',
              expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
              rangeRequests: true,
            },
          },
        ],
      },
      // keep the SW out of `vite dev` so it can't cache stale modules during HMR
      devOptions: { enabled: false },
    }),
  ],
  // jolt: discovered late inside the worker graph otherwise, forcing a dev full-reload.
  // Both worker variants are listed (the /wasm-multithread one sits behind the dynamic
  // ?joltthreads import in sim/worker.ts). iwer/devui: behind the dynamic ?xremu import;
  // pre-bundle so first use doesn't trigger a mid-boot "optimized dependencies changed"
  // reload that races the app mount. occt-import-js: the STEP importer's worker (editor/stepImport.worker.ts),
  // first reached when someone imports a CAD file - a reload then would throw away the import.
  // meshoptimizer: the USD importer's simplifier (editor/usdImport.ts), the same case as occt-import-js.
  // @huggingface/usd-web-viewer (editor/usdImport.ts) is left out: it finds its worker and wasm next to its own
  // module (new URL(..., import.meta.url)), which pre-bundling would move.
  optimizeDeps: {
    include: ['jolt-physics', 'jolt-physics/wasm', 'jolt-physics/wasm-multithread', 'iwer', '@iwer/devui', 'occt-import-js', 'meshoptimizer'],
    exclude: ['@huggingface/usd-web-viewer'],
    rolldownOptions: { plugins: [monarchKeywordHash, monacoDompurify()] },
  },
  // The watcher walks the whole root before the first response goes out, so local tool output the app never imports
  // (oracle checkouts, tsc's declaration emit, census builds, e2e output) is ignored: tens of thousands of such files
  // can hold a cold server's first /app/ response for ~40 s. dist/ is already ignored by vite as the outDir.
  server: {
    headers: coiHeaders,
    watch: { ignored: ['**/.oracle*/**', '**/.types/**', '**/.eager-census/**', '**/.census-*/**', '**/e2e/out/**', '**/e2e/shots/**', '**/e2e/__shots/**'] },
  },
  preview: { headers: coiHeaders },
  // one three.js for everything: @iwer/devui (the ?xremu WebXR emulator) nests its own
  // older three, and mixing two copies in one WebGL context throws at render time
  // (r185 materials lack the onBuild hook its r165 renderer calls). Dedupe collapses
  // every 'three' import onto the root copy; the app itself has only one anyway.
  resolve: { dedupe: ['three'] },
  // the worker builds only collect for the licenses file: the page build, which they finish before, writes it
  worker: { format: 'es', plugins: () => [bundledLicenses()] },
  build: {
    target: 'es2022',
    // The browsers with a native CSS light-dark() (src/editor/appearance.ts). Below them Lightning CSS
    // "lowers" it to a pair of --lightningcss-light/-dark flags, and that is not the same thing: a token
    // defined on :root is then resolved once, at the root, in the page's theme, so a subtree pinned to
    // `color-scheme: dark` (the HUD over the 3D view, its loading cover) inherits the light values:
    // unreadable stats text in production only, while dev, which serves the CSS untouched, is right.
    // The inline light-dark() in TSX style objects (StEditor, stLang) is never lowered at all, so this is
    // also the floor those already had.
    cssTarget: ['chrome123', 'edge123', 'firefox120', 'safari17.5'],
    chunkSizeWarningLimit: 6000,
    rollupOptions: {
      // multi-page: the marketing landing at /, the editor SPA at /app/, the generated
      // PLC language page at /plc/ (written by `npm run capabilities -- --write`, which is
      // also what keeps it in sync with the engine; see scripts/capabilities.mjs), and the
      // hand-written guides under /guides/, and the part libraries' privacy page at /privacy/.
      input: {
        main: entry('./index.html'),
        app: entry('./app/index.html'),
        plc: entry('./plc/index.html'),
        guideModbus: entry('./guides/modbus/index.html'),
        guideOpcua: entry('./guides/opcua/index.html'),
        guidePlcServer: entry('./guides/plc-server/index.html'),
        guideS7: entry('./guides/s7/index.html'),
        guideSlmp: entry('./guides/slmp/index.html'),
        guideAds: entry('./guides/ads/index.html'),
        guideReference: entry('./guides/reference/index.html'),
        guidePartModel: entry('./guides/part-model/index.html'),
        guidePartMotion: entry('./guides/part-motion/index.html'),
        guidePartFeedback: entry('./guides/part-feedback/index.html'),
        guidePartProduct: entry('./guides/part-product/index.html'),
        guides: entry('./guides/index.html'),
        privacy: entry('./privacy/index.html'),
      },
    },
  },
  test: {
    environment: 'node',
    testTimeout: 120000,
    // Two projects, one suite. `unit` runs every spec in a locked-down realm, as the app runs (core/realmLockdown.ts);
    // `unit-unlocked` runs the specs that fake timers, which lockdown forbids (core/lockdown.testSetup.ts), and the
    // ones marked `@unlocked-realm`. The split is read from the source, so a new spec ends up in the right project.
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['src/**/*.test.ts'], exclude: UNLOCKED_SPECS, setupFiles: ['src/core/lockdown.testSetup.ts'] },
      },
      { extends: true, test: { name: 'unit-unlocked', include: UNLOCKED_SPECS.length ? UNLOCKED_SPECS : ['src/__none__.test.ts'] } },
    ],
  },
})
