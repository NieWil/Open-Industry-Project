import type { PartInstance } from './types'
import { deriveGuardOpenings, hostGuardFrame } from './guards/guardOpenings'
import { bedView } from './parts/partGeometry'
import { beltXToSExt, buildBeltPath } from './conveyor/beltPath'

type SRange = [number, number]

/**
 * The openings a conveyor's neighbours cut in its guards (a spur's mouth, a side-merged straight), in the same
 * tail-relative row space its authored `guardOpenings` rows use. Guard-openings mode reads them so the gaps the
 * scene already made are not offered as solid guard: no hover ghost there, and no sweep that would author a row
 * on top of a cut that exists anyway (and outlives the neighbour that made it).
 *
 * deriveGuardOpenings returns neighbour cuts and, on a rig host, its own authored rows folded in. The host is
 * passed with no rows so only the neighbours' remain. Its ranges are in the host's centreline X: a belt maps plan X
 * to arc length through its path, a straight bed shifts its centre origin onto the tail.
 */
export function junctionOpeningRows(host: PartInstance, parts: readonly PartInstance[]): { left: SRange[]; right: SRange[] } {
  const frame = hostGuardFrame(host)
  if (!frame) return { left: [], right: [] }
  const bare = { ...host, params: { ...host.params, guardOpenings: [] } } as unknown as PartInstance
  const cut = deriveGuardOpenings(bare, parts)
  const view = bedView(bare, 'path')
  const path = view ? buildBeltPath(view.segments, view.height) : null
  const toRow = (x: number): number => (path ? beltXToSExt(path, x) : x - frame.bedLo)
  const map = (ranges: readonly SRange[]): SRange[] =>
    ranges.map(([a, b]) => {
      const sa = toRow(a)
      const sb = toRow(b)
      return sa <= sb ? [sa, sb] : [sb, sa]
    })
  return { left: map(cut.left), right: map(cut.right) }
}
