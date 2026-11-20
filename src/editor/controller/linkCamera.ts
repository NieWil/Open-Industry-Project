// The camera a copied room link carries: where the sharer was looking when they copied it. It is the visitor's
// opening view only. It never enters the room's document, and it leaves the address once it is read, so a reload
// reopens on the visitor's own remembered camera (controller/camera.ts restoreCamera).

/** the link parameter: six numbers joined by `_` (position, then look point), and a seventh `o` when orthographic */
export const CAMERA_PARAM = 'cam'

export interface LinkCamera {
  px: number
  py: number
  pz: number
  tx: number
  ty: number
  tz: number
  ortho: boolean
}

const FIELDS = ['px', 'py', 'pz', 'tx', 'ty', 'tz'] as const

/** a camera further out than this frames no scene (the bound a followed peer's camera has, collab/session.ts) */
const MAX_COORD = 1e5

/** a position closer to its look point than this has no direction to look in */
const MIN_REACH = 1e-3

/** The parameter's value for this camera, to the centimetre. `_` is the separator because a query leaves it unescaped. */
export function formatLinkCamera(pose: Omit<LinkCamera, 'ortho'>, ortho: boolean): string {
  // `+` drops trailing zeros and turns -0 into 0
  const parts = FIELDS.map((k) => String(+pose[k].toFixed(2)))
  if (ortho) parts.push('o')
  return parts.join('_')
}

/** The camera a parameter value names, or null for anything but six bounded numbers with somewhere to look. */
export function parseLinkCamera(raw: string | null): LinkCamera | null {
  if (!raw) return null
  const parts = raw.split('_')
  const ortho = parts.length === 7 && parts[6] === 'o'
  if (parts.length !== 6 && !ortho) return null
  const n = parts.slice(0, 6).map((part) => (/^-?\d{1,6}(\.\d{1,4})?$/.test(part) ? Number(part) : NaN))
  if (!n.every((v) => Math.abs(v) <= MAX_COORD)) return null // false for NaN too
  const [px = 0, py = 0, pz = 0, tx = 0, ty = 0, tz = 0] = n
  if (Math.hypot(px - tx, py - ty, pz - tz) < MIN_REACH) return null
  return { px, py, pz, tx, ty, tz, ortho }
}

/** Read the camera this tab's address carries, and take the parameter off the address, valid or not. */
export function takeLinkCamera(): LinkCamera | null {
  if (typeof location === 'undefined' || typeof history === 'undefined') return null
  try {
    const url = new URL(location.href)
    if (!url.searchParams.has(CAMERA_PARAM)) return null
    const camera = parseLinkCamera(url.searchParams.get(CAMERA_PARAM))
    url.searchParams.delete(CAMERA_PARAM)
    history.replaceState(history.state, '', url.pathname + url.search + url.hash)
    return camera
  } catch {
    return null
  }
}
