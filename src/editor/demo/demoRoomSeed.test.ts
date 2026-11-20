import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { DEFAULT_SIM_HZ } from '../../core/types'
import { demoFingerprint, syncDemoRoom } from '../../collab/demoRoom'
import type { DemoSeed } from '../../collab/demoRoom'
import { createPlcDemoScene, DEMO_CONTROLLER, DEMO_PROGRAM } from './demoScenes'
import { DEFAULT_SCAN_MS } from '../program/stProgram'

// A demo room (collab/demoRoom.ts) is "current" only while every client on one build builds the same demo: the
// room's fingerprint is compared with the one this client makes. Anything in the demo that varied per build of it
// (a random id, a timestamp) would read as a newer demo on every join, and every visitor would rewrite the room.

/** the seed main.tsx bootRoom hands syncDemoRoom */
function seed(): DemoSeed {
  return { scene: createPlcDemoScene(), stProgram: DEMO_PROGRAM, stScanMs: DEFAULT_SCAN_MS, controller: DEMO_CONTROLLER, simHz: DEFAULT_SIM_HZ }
}

describe('the demo as a room holds it', () => {
  it('is the same demo every time it is built', () => {
    expect(demoFingerprint(seed())).toBe(demoFingerprint(seed()))
  })

  it('a second client on the same build finds the room current and writes nothing', () => {
    const room = new Y.Doc()
    expect(syncDemoRoom(room, seed(), { minted: true, serverSynced: true, build: 1 })).toBe('seeded')
    const peer = new Y.Doc()
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(room))
    let writes = 0
    peer.on('update', () => writes++)
    expect(syncDemoRoom(peer, seed(), { minted: false, serverSynced: true, build: 1 })).toBe('current')
    expect(writes).toBe(0)
  })
})
