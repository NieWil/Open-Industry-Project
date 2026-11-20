// The ladder view's selection: a ladder selection (plc/ladder/ladderEdit.ts) in one routine of the sheet.

import type { LadderSel } from '../../../plc/ladder/ladderEdit'

export interface Sel extends LadderSel {
  routine: number
}

/** Where something goes with nothing selected: the first section. */
export const FRONT = 0
