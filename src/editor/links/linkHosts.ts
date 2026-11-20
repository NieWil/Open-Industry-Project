// One controller's view of the desktop shell's PLC hosts. The shell keeps one link per controller in a window
// (apps/desktop/linkKeys.cjs): link 0 for the default controller, and a number of its own for each named one
// (`Cell2::%IX0.0`, core/io/controllerTag.ts). A session is written for one link and never names it, so each gets a
// host that adds its number to every call and passes on only the pushes for it. A push with no number is link 0's,
// which is what a test's host sends.

import { controllerTag, tagsForController } from '../../core/io/controllerTag'
import { MAX_SCENE_PLCS } from '../../core/scene/scenePlcs'
import type { TagValue } from '../../plc/types'
import type { AdsHost, EipHost, ExternalPlcLink, ExternalPlcStatus, OpcUaHost, PlcIoHost } from './externalPlcStatus'
import type { OpcUaServerHost } from './opcUaServer'

/**
 * A named controller's link as the scene sees it. The session inside knows the controller's tags by its own names
 * (`%IX0.0`, derived from core/io/controllerTag.ts partsForController); the scene knows them as `Cell2::%IX0.0`. This
 * reads the scene's tags for that controller with the name taken off and puts it back on what the PLC writes.
 */
export function controllerLink(inner: ExternalPlcLink, controller: string): ExternalPlcLink {
  const driven = inner.driven.map((t) => controllerTag(controller, t))
  return {
    driven,
    start: (initial: Readonly<Record<string, TagValue>>) => inner.start(tagsForController(initial, controller)),
    exchange(simTags) {
      const out = inner.exchange(tagsForController(simTags, controller))
      if (out === null) return null
      const named: Record<string, number | boolean> = {}
      for (const key in out) named[controllerTag(controller, key)] = out[key]!
      return named
    },
    stop: () => inner.stop(),
    status: (): ExternalPlcStatus => inner.status(),
  }
}

const mine = (link: number) => (e: { link?: number }): boolean => (e.link ?? 0) === link

export function plcIoForLink(host: PlcIoHost, link: number): PlcIoHost {
  const ours = mine(link)
  return {
    listen: (opts) => host.listen({ ...opts, link }),
    connect: (opts) => host.connect({ ...opts, link }),
    close: () => host.close({ link }),
    onConnection: (cb) => host.onConnection((e) => ours(e) && cb(e)),
    onData: (cb) => host.onData((e) => ours(e) && cb(e)),
    // a connection's number is unique across the window's links, so it names its link by itself
    write: (id, bytes) => host.write(id, bytes),
    drop: (id) => host.drop(id),
  }
}

export function opcUaForLink(host: OpcUaHost, link: number): OpcUaHost {
  const ours = mine(link)
  return {
    connect: (opts) => host.connect({ ...opts, link }),
    browse: (opts) => host.browse({ ...opts, link }),
    describe: (opts) => host.describe({ ...opts, link }),
    exchange: (opts) => host.exchange({ ...opts, link }),
    close: () => host.close({ link }),
    onClosed: (cb) => host.onClosed((e) => ours(e) && cb(e)),
    ...(host.onProgress ? { onProgress: (cb: Parameters<NonNullable<OpcUaHost['onProgress']>>[0]) => host.onProgress!((e) => ours(e) && cb(e)) } : {}),
  }
}

export function opcUaServerForLink(host: OpcUaServerHost, link: number): OpcUaServerHost {
  const ours = mine(link)
  return {
    start: (opts) => host.start({ ...opts, link }),
    define: (opts) => host.define({ ...opts, link }),
    update: (opts) => host.update({ ...opts, link }),
    stop: () => host.stop({ link }),
    onWrite: (cb) => host.onWrite((e) => ours(e) && cb(e)),
    onClients: (cb) => host.onClients((e) => ours(e) && cb(e)),
  }
}

export function eipForLink(host: EipHost, link: number): EipHost {
  return {
    open: (opts) => host.open({ ...opts, link }),
    bind: (opts) => host.bind({ ...opts, link }),
    exchange: (opts) => host.exchange({ ...opts, link }),
    ...(host.tags ? { tags: () => host.tags!({ link }) } : {}),
    close: () => host.close({ link }),
  }
}

export function adsForLink(host: AdsHost, link: number): AdsHost {
  return {
    open: (opts) => host.open({ ...opts, link }),
    bind: (opts) => host.bind({ ...opts, link }),
    exchange: (opts) => host.exchange({ ...opts, link }),
    ...(host.symbols ? { symbols: () => host.symbols!({ link }) } : {}),
    close: () => host.close({ link }),
  }
}

/** The shell's link number the PLC connections window lists a PLC's variables on (apps/desktop/linkKeys.cjs BROWSE_LINK):
 *  one past every controller's (0 to MAX_SCENE_PLCS - 1), so a list read during a run opens a connection of its own
 *  beside theirs. Only the shell's ADS, EtherNet/IP and OPC UA links take it. */
export const BROWSE_LINK = MAX_SCENE_PLCS
