// Whether the program a running sim is executing is still the one the document holds, which is what the PLC dock's
// Reload offers to fix (commands.ts `sim.reloadProgram`).
//
// A reload is a restart of the program, not a patch: the worker builds a new scan host, so every variable, timer and
// sequence step starts over while the plant keeps moving (there is no online change). That is why it waits to be
// asked rather than following every keystroke, and why "is there anything to reload" has to be answered exactly: the
// button lighting up is the only sign that the text on screen is not what runs.
//
// Pure, so the rule is testable without a sim worker; the controller holds the record (editor/controller.ts).

import { sameController, type Controller } from '../../core/controller'
import { dialectRefusal, isKnownDialect } from '../../core/dialect'
import { controllerFor } from '../../plc'

/** What the controller last tried to attach: the document's program inputs, as they were at that moment. */
export interface AttachedProgram {
  readonly source: string
  /** the program's own controller table, or null when it has none */
  readonly controller: Controller | null
  /**
   * The scan time the attach baked into the program, or null when a later scan-time edit still reaches it. A program
   * with no table of its own that declares a PROGRAM runs from the default table, whose one task carries the scan time
   * as its interval, and the live retune (the worker's setScanPeriod) only moves the period of a program with no tasks.
   * So for that shape a scan-time edit is an edit the running program does not have yet; for any other it is not.
   */
  readonly bakedScanMs: number | null
  /** the program's dialect (core/dialect.ts), absent for IEC */
  readonly dialect?: string
}

/** The document fields a program attach reads. */
export interface ProgramInputs {
  readonly stProgram: string
  readonly controller: Controller | null
  readonly stScanMs: number
  /** absent = IEC */
  readonly stDialect?: string
}

/**
 * Why the document's program must not be attached at all, or null when it may be. A program written for a dialect this
 * build does not have (core/dialect.ts) is refused before anything reads it: compiling it as IEC would report errors
 * that are not in it, or run whatever part of it happened to parse.
 */
export function programRefusal(doc: Pick<ProgramInputs, 'stDialect'>): string | null {
  return doc.stDialect !== undefined && !isKnownDialect(doc.stDialect) ? dialectRefusal(doc.stDialect) : null
}

/** Record an attach attempt. Called whether or not it compiles: a program that failed to attach is not out of date
 *  until the author changes it, because reloading the same text would fail the same way. */
export function attachedProgram(doc: ProgramInputs): AttachedProgram {
  const baked = doc.controller === null && controllerFor(doc.stProgram, null, doc.stScanMs) !== null
  return {
    source: doc.stProgram,
    controller: doc.controller,
    bakedScanMs: baked ? doc.stScanMs : null,
    ...(doc.stDialect !== undefined ? { dialect: doc.stDialect } : {}),
  }
}

/**
 * Would a reload run anything different? True when the document's program, its controller table, its dialect or a
 * scan time the attach baked in has changed since the last attempt, and when nothing is attached at all (`attached`
 * null: the PLC dropped the program on a runtime fault, which forgets the record). Only meaningful while the sim runs.
 */
export function programOutOfDate(attached: AttachedProgram | null, doc: ProgramInputs): boolean {
  if (!attached) return true
  if (doc.stProgram !== attached.source) return true
  if (doc.stDialect !== attached.dialect) return true
  if (doc.controller !== attached.controller && !sameController(doc.controller, attached.controller)) return true
  return attached.bakedScanMs !== null && doc.stScanMs !== attached.bakedScanMs
}

/** Why the running sim cannot take the document's program again, or null when it can. */
export type ReloadBlocker = 'stopped' | 'external' | 'partScene'
