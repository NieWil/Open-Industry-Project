/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { versionedAssetUrl } from './assetVersions'

const TABLE = { '/models/Box.glb': '1a2b3c4d5e', '/thumbnails/pkg/oip_box.webp': 'ffeeddccbb' }

describe('versionedAssetUrl', () => {
  it('appends the content version of an asset the build versioned', () => {
    expect(versionedAssetUrl('/models/Box.glb', TABLE)).toBe('/models/Box.glb?v=1a2b3c4d5e')
    expect(versionedAssetUrl('/thumbnails/pkg/oip_box.webp', TABLE)).toBe('/thumbnails/pkg/oip_box.webp?v=ffeeddccbb')
  })

  it('passes everything else through unchanged', () => {
    for (const url of [
      '/models/NotShipped.glb', // a path the build had no file for
      '/models/Box.glb?v=old', // already carries a query
      'models/Box.glb', // not root-relative
      'https://example.com/models/Box.glb',
      'data:image/webp;base64,AAAA',
      'blob:https://example.com/1234',
      'toString', // an Object.prototype name is not a table entry
    ]) {
      expect(versionedAssetUrl(url, TABLE)).toBe(url)
    }
  })

  it('is the identity outside a production build (no table: dev, these tests, the node CLIs)', () => {
    expect(versionedAssetUrl('/models/Box.glb')).toBe('/models/Box.glb')
  })
})

// A file that fetches over the network must version what it fetches. Otherwise a deploy's changed model can be served
// stale for a day, and one asset is split across two URLs, so a warm and the real load download it twice. This
// catches a new fetch site. A file that fetches nothing the app serves under /models, /textures or /thumbnails is
// listed below with why.
const NETWORK_SINK = /\bfetch\(|\bnew Image\(|\.src\s*=[^=]|\bsrc=\{|[lL]oader\.load(?:Async)?\(/
const FETCHES_NO_APP_ASSET: Record<string, string> = {
  'editor/components/CatalogPlaceButton.tsx': "shelf cards show the part's own data-URL thumbnail",
  'editor/components/GetPartsWindow.tsx': "shows a library's pictures from the library's host, each named by its hash",
  'editor/components/inspector/header.tsx': 'renders the url Inspector.tsx headerThumb already versioned',
  'editor/publish/github.ts': "talks to GitHub and the sign-in Worker, not to app assets",
  'plc/link/plcLink.ts': 'talks to a PLC bridge, not to app assets',
  'collab/roomAssets.ts': "fetches a room's part assets from the collab server by SHA-256: the name is the content",
}

describe('every network fetch in src/ versions its asset URL', () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), '..')
  const files = readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.endsWith('.d.ts'))
    .map((f) => f.split('\\').join('/'))

  it('finds the fetch sites it polices (not vacuous)', () => {
    const fetching = files.filter((f) => NETWORK_SINK.test(code(join(src, f))))
    expect(fetching).toEqual(expect.arrayContaining(['render/gltf.ts', 'render/prefetch.ts', 'editor/prefetchSceneAssets.ts']))
  })

  for (const f of files) {
    const text = code(join(src, f))
    if (!NETWORK_SINK.test(text) || f in FETCHES_NO_APP_ASSET) continue
    it(f, () => {
      expect(text, `${f} fetches over the network but never calls versionedAssetUrl (src/core/assetVersions.ts)`).toContain(
        'versionedAssetUrl(',
      )
    })
  }
})

/** a file's text without its comments, so prose about `fetch(` is not a fetch */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}
