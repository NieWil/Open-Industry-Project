// The PLC panel: the window, the text editor, the status lines, the organizer column, attach and run (StEditor.tsx).
// App mounts "the PLC panel" through this one name. The engine reads IEC 61131-3 only; a program in a dialect this
// build does not have is shown read-only with the refusal (core/dialect.ts).

export { StEditor as PlcPanel } from './StEditor'
