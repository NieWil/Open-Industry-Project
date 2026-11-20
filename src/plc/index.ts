// Public API for the in-browser Structured Text (IEC 61131-3 subset) toolchain.
//
// Scope today: VAR / VAR_INPUT / VAR_OUTPUT, BOOL + faithful integer types
// (SINT/INT/DINT/BYTE/WORD/DWORD with two's-complement wrap) + REAL, the full
// boolean/comparison/arithmetic/bitwise expression set, IF/ELSIF/ELSE,
// CASE (with `lo..hi` ranges), FOR/WHILE/REPEAT loops + EXIT, the standard
// timers/counters/edge blocks (TON/TOF/TP/R_TRIG/F_TRIG/CTU/CTD/CTUD), the
// standard stateless function library (ABS/MIN/MAX/LIMIT, SEL/MUX, the REAL math
// set SQRT/LN/LOG/EXP/EXPT/trig, the bit shifts/rotates SHL/SHR/ROL/ROR, and the
// `<src>_TO_<dst>` conversion family - see builtins.ts), user-defined
// FUNCTION_BLOCKs (own VAR sections, persistent state, nesting), and stateless
// FUNCTIONs (scalar return, positional calls in expressions), bounded ARRAYs
// (1+ dimensions, `ARRAY[lo..hi, ...] OF T`, runtime bounds-checked, scalar or
// struct elements), and STRUCT types (`TYPE … STRUCT … END_STRUCT; END_TYPE`)
// whose fields may be scalars, arrays, or nested structs - so arbitrary access
// paths like `p.inner.data[i]` and `items[k].qty` resolve.
//
// Not yet: 64-bit integers (LINT would need a BigInt path). RS/SR
// latches are left as the user-FB pattern (so those names stay free for user POUs).

export { BUILTIN_FUNCTIONS, isBuiltinFunc } from './builtins'
export { diagnostics, parseAndCheck, syntaxDiagnostics } from './checker'
// a scene's controller table (core/controller.ts) as the engine runs it
export {
  ControllerError,
  controllerDiagnostics,
  controllerFor,
  controllerRuns,
  plcOfProgram,
  plcOfTask,
  pinnedTaskMessages,
  controllerSource,
  declaresConfiguration,
  defaultController,
  defaultInterval,
  deleteMainProgram,
  mainProgramCode,
  extractController,
  programTypes,
  runnableSource,
  topLevelStatements,
} from './controller'
export type { ControllerDiagnostics, ControllerRun } from './controller'
// ...and the edits an organizer makes to one, with the tag renames they cause
export {
  addProgram,
  addTask,
  moveProgram,
  programNameError,
  programsOnTask,
  removeProgram,
  removeTask,
  renameProgram,
  renameProgramType,
  renameTask,
  scheduleProgram,
  setProgramTask,
  setProgramPlc,
  setTaskPlc,
  setProgramType,
  setTaskTiming,
  taskNameError,
  alignProgramType,
} from './controllerEdits'
export type { TagRename } from './controllerEdits'
// ...and the same table read as an organizer tree: tasks, the programs each runs, the unscheduled
export { taskTree, type TaskTree, type TaskTreeProgram, type TaskTreeTask } from './taskTree'
export { compile } from './interpreter'
// Not re-exported here: giving the controller's tags I/O addresses (Assign I/O, Import I/O list), ./ioAssign. Only
// those commands use it and they load it when run; a re-export here would put it in the first frame
export { locatedVariables } from './locatedIndex'
export { KEYWORDS, valueRefs } from './lexer'
// which watch-table entry a name in the text stands for, read in the POU it is written in
export { watchInstances, watchScopes } from './watchScope'
export type { MonitoredProgram, WatchInstance, WatchScopes } from './watchScope'
export { toTypeScript } from './emit'
// Not re-exported here: the portability doors, a program leaving as a spec-legal IEC file or PLCopen XML (./export)
// and coming back in (./importText, ./importXml). Import them from their modules. The app loads this barrel before its
// first frame, and a module the barrel re-exports goes into that eager chunk even when only a lazily loaded one calls it
// (editor/program/stFileTransfer.ts is that one), which would put the whole PLCopen writer and reader under the eager-JS budget.
// a program as its blocks - a view over the same source string, not a second storage format
export { declaredName, flattenDocument, parseDocument, type StBlock, type StBlockKind, type StDocument } from './document'
// ...and the structural edits over that view: the POU list every PLC tool lets you manage
export {
  addBlock,
  blockNameError,
  defaultBlockName,
  deleteBlock,
  moveBlock,
  renameBlock,
  type DocumentEdit,
  type NewBlockKind,
} from './document'
export { LocalPlcLink, loadProgram, NO_WIRED_BINDINGS, type PlcLink, type WiredBindings } from './link/plcLink'
export { commsTags, deviceTags, devicesForTag, sceneTags, unhandledProgramTags } from './bindings'
export type { DeviceTagField, DeviceTagUse, DeviceTags, SceneTag, TaggedPart } from './bindings'
export {
  DEFAULT_MAX_CATCHUP_SCANS,
  DEFAULT_SCAN_HZ,
  DEFAULT_SCAN_PERIOD_SEC,
  ScanEngine,
  type Scannable,
  type ScanResult,
  type Schedulable,
  TaskScheduler,
} from './scanEngine'
export { type ProcessImage, type ProcessImageSnapshot, SimController } from './simController'
export { FB_TYPES, SCALAR_TYPES, StError, USER_FB_TYPES } from './types'
export { FAULT, StFault, type FaultCode } from './faults'
// The tag and saved-value tooling (tags.ts, tagValues.ts, tagInfo.ts) is not re-exported here: a module this barrel
// names is in the app's first frame (the eager-JS budget). Import it from its module.
export type { CompiledProgram, Diagnostic, ScalarType, SourcePos, TagValue, TaskInfo } from './types'

/** A self-contained sample: a start/stop seal-in latch with an on-delay lamp. */
export const SAMPLE_PROGRAM = `VAR_INPUT
  Start : BOOL;
  Stop  : BOOL;
END_VAR
VAR_OUTPUT
  Motor : BOOL;
  Lamp  : BOOL;
END_VAR
VAR
  OnDelay : TON;   (* lamp lights 2s after the motor starts *)
END_VAR

(* classic seal-in / latch with an on-delay lamp *)
Motor := (Start OR Motor) AND NOT Stop;
OnDelay(IN := Motor, PT := T#2s);
Lamp := OnDelay.Q;
`
