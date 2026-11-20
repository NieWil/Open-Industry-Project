// The PLC connections window's read of a PLC's variables: the tag field's own readers (externalPlc.ts readAdsTagList,
// readEipTagList, readOpcUaTagList), on a connection of the window's own (BROWSE_LINK), closed after. A run's link to
// the same PLC stays as it is beside it. The simulator's own program needs no read (program/plcConnections.ts).

import type { VariableSource } from '../program/plcConnections'
import type { AdsHost, EipHost, OpcUaHost, PlcTagList } from './externalPlcStatus'
import { adsForLink, BROWSE_LINK, eipForLink, opcUaForLink } from './linkHosts'

/** The desktop shell's hosts, as the editor controller holds them; null in a browser tab. */
export interface ListingHosts {
  adsHost: AdsHost | null
  eipHost: EipHost | null
  opcUaHost: OpcUaHost | null
}

/** Whether this app can read a source's variables: a PLC's need the desktop shell's host for its protocol. */
export function canList(hosts: ListingHosts, source: VariableSource): boolean {
  if (source.kind === 'ads') return !!hosts.adsHost?.symbols
  if (source.kind === 'eip') return !!hosts.eipHost?.tags
  if (source.kind === 'opcua') return hosts.opcUaHost !== null
  return true
}

// One read at a time: every read opens and closes the same link number, so a second one started while the first is
// still listing (the window closed and opened again, Read again, another controller) would have its link replaced
// by the shell and then closed by the first read's close.
let queue: Promise<unknown> = Promise.resolve()

/** The variables of the PLC a source names, grouped (PlcTagList.groups), or why they could not be read. */
export function readPlcVariables(hosts: ListingHosts, source: Exclude<VariableSource, { kind: 'program' }>): Promise<PlcTagList> {
  const run = queue.then(() => readOnce(hosts, source))
  queue = run.catch(() => {})
  return run
}

async function readOnce(hosts: ListingHosts, source: Exclude<VariableSource, { kind: 'program' }>): Promise<PlcTagList> {
  // the readers live with the link sessions, which load on use (controller/plcLinks.ts loadExternalPlc)
  const m = await import('./externalPlc')
  const always = (): boolean => true
  if (source.kind === 'ads') return m.readAdsTagList(adsForLink(hosts.adsHost!, BROWSE_LINK), source.netId, source.port, always)
  if (source.kind === 'eip') return m.readEipTagList(eipForLink(hosts.eipHost!, BROWSE_LINK), { gateway: source.gateway, path: source.path, family: source.family }, always)
  return m.readOpcUaTagList(opcUaForLink(hosts.opcUaHost!, BROWSE_LINK), source.endpoint, source.from, always)
}
