// Where an EtherNet/IP link goes: the controller family, its address and the route to its CPU. Kept apart from
// core/io/eip.ts because the first frame's status line (editor/links/externalPlcStatus.ts) needs it and nothing else.

/**
 * Which kind of controller answers. `logix` is a ControlLogix or CompactLogix, reached through a path to its slot;
 * `micro800` is a Micro820/850/870, always reached at its own port, so it has no path. Both speak the same CIP tag
 * services, so everything past opening the link is the same.
 */
export type EipFamily = 'logix' | 'micro800'

export const isEipFamily = (v: unknown): v is EipFamily => v === 'logix' || v === 'micro800'

/** Where an EtherNet/IP link goes: the address, the route to the CPU ('' for none), and the controller family. */
export interface EipTarget {
  gateway: string
  path: string
  family: EipFamily
}

/** A link's target from its settings. A Micro800 has no path, so a path kept from a Logix setup is not sent. */
export function eipTarget(link: { eipGateway: string; eipPath: string; eipFamily: EipFamily }): EipTarget {
  return { gateway: link.eipGateway, path: link.eipFamily === 'micro800' ? '' : link.eipPath, family: link.eipFamily }
}

/** "10.0.0.5 (path 1,0)" or "10.0.0.5 (Micro800)": where a link goes, as the status and the tag picker say it. */
export function eipEndpoint(target: EipTarget): string {
  // i18n-ok: a product family's name
  if (target.family === 'micro800') return `${target.gateway} (Micro800)`
  return `${target.gateway}${target.path ? ` (path ${target.path})` : ''}`
}
