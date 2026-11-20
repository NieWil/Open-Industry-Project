// Entering a shared room from a solo tab without reloading it (Toolbar's Share actions). The room boot lives with the
// app's entry (main.tsx), which registers it here; the toolbar asks for it. With nothing registered, the caller
// reloads into the room instead, the way a room link opens.

import type { SeedKind } from '../collab/rooms'

type RoomEntry = (roomUrl: string, seed: SeedKind) => Promise<void>

let entry: RoomEntry | null = null

/** main.tsx, in a solo session: how this tab enters a room it has just minted */
export function registerRoomEntry(fn: RoomEntry): void {
  entry = fn
}

/**
 * Enter the room `roomUrl` names, seeded from this tab's document (`seed`: the demo it shows, or its own scene and
 * program). Resolves true once the tab is in the room; false when this surface cannot, and the caller should reload.
 */
export async function enterRoomInPlace(roomUrl: string, seed: SeedKind): Promise<boolean> {
  const enter = entry
  if (!enter) return false
  entry = null // a tab enters one room; a second Share action finds it already there
  await enter(roomUrl, seed)
  return true
}
