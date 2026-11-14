// Checks and compiles the open program off the main thread, for the readers that only ask about it
// (programWorkerClient.ts): what it declares, and what is wrong with it. Checking costs about 19 ms per thousand
// lines and compiling about 30, on the page a stall once a program is a few thousand lines long. Working out the
// controller table it runs under reads the whole text too, so that is done here as well: the page hands over the
// program as the store holds it.
//
// On the walker engine: this worker runs no SES lockdown, and the walker builds a program without generating code,
// so no text from the program is ever evaluated here. Both engines declare the same surface (they share the program
// builders, plc/pou.ts).
import { diagnostics, keepCheckedPrograms } from '../../plc/checker'
import { compile, setScanEngine } from '../../plc/interpreter'
import type { Build } from './programFacts'
import { checkOfAsk, factsOfAsk, surfaceOfAsk, type ProgramReply, type ProgramRequest } from './programWorkerAsk'

setScanEngine('walker')
// Problems and the compile read a text once between them (plc/checker.ts keepCheckedPrograms).
keepCheckedPrograms(true)

// The last few texts compiled. The Problems panel asks again when a part's tag changes, with the same program: that
// answer then costs a few lookups, not a compile.
const built = new Map<string, ReturnType<Build>>()
const build: Build = (text) => {
  let b = built.get(text)
  if (!b) {
    try {
      // Checked for its problems first, so the compile takes that reading whichever of the two was asked for first.
      // The check's answer is remembered, and the Problems panel and the lint ask for it next.
      diagnostics(text)
      b = { program: compile(text), error: null }
    } catch (error) {
      b = { program: null, error }
    }
    if (built.size >= 4) built.delete(built.keys().next().value!)
    built.set(text, b)
  }
  return b
}

self.onmessage = (e: MessageEvent<ProgramRequest & { id: number }>) => {
  const ask = e.data
  let reply: ProgramReply
  try {
    if (ask.kind === 'surface') reply = { id: ask.id, kind: 'surface', answer: surfaceOfAsk(ask, (text) => build(text).program) }
    else if (ask.kind === 'check') reply = { id: ask.id, kind: 'check', answer: checkOfAsk(ask) }
    else reply = { id: ask.id, kind: 'facts', answer: factsOfAsk(ask, build) }
  } catch {
    // the page works the answer out itself, and reports what went wrong as it always did
    reply = { id: ask.id, kind: 'failed' }
  }
  self.postMessage(reply)
}
