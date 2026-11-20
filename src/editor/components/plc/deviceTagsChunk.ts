import { readyLazy } from '../../readyLazy'

// The device tags dialog as a lazy chunk that opens at once (readyLazy.tsx says why `lazy` + Suspense could not).
// Its own module so the organizer tree can open it without loading anything else with it.
export const DeviceTagsDialogChunk = readyLazy(() => import('./DeviceTagsDialog').then((m) => m.DeviceTagsDialog))
