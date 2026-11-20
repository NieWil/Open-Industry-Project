// The PLC program's two file transfers: download it as IEC 61131-3 text or PLCopen XML, and load one someone else wrote.
//
// Commands rather than PLC panel handlers (commands.ts: file.importPlc / file.exportPlcSt / file.exportPlcXml), so the
// File menu, the palette and the panel's own buttons are one action with one rule. What a transfer has to say goes to
// the store (state.stFileReport) rather than to the panel: a command can run while the PLC panel is a background tab
// or not mounted at all, and an import's checklist is the one message that must not vanish on the way.

import { dialectRefusal, isKnownDialect } from '../../core/dialect'
import { controllerFor, extractController, runnableSource } from '../../plc'
// from their modules, not the barrel: this module loads lazily, and those three with it (plc/index.ts says why)
import { exportProgram, type ExportTarget } from '../../plc/exchange/export'
import { controllerExport, exportableControllers, NothingToExportError, tableControllers } from '../../plc/controllerExport'
import { importIecText } from '../../plc/exchange/importText'
import { importPlcopenXml } from '../../plc/exchange/importXml'
import type { EditorStore } from '../store/store'

/**
 * Download the program in a form another toolchain opens.
 *
 * The ST subset exists so a program can leave here, and this is how it leaves. `iec-text` is a spec-legal
 * source file (the CONFIGURATION/RESOURCE/TASK wrapper is generated from the tasks the program runs on), and
 * `plcopen-xml` is the PLCopen interchange format IEC tools import. A program that does not compile is refused
 * rather than exported half-formed, and anything the target may not carry is reported instead of dropped silently.
 *
 * The generated TASK carries the program's own scan time, not a fixed 100 ms: the period the program was simulated at
 * is the one a reader of the file should see.
 *
 * A project whose tasks name several controllers exports one controller at a time, since each PLC takes a download of
 * its own: `plc` (null or absent: the default one), its tasks and instances and the POUs they reach
 * (plc/controllerExport.ts). The File menu exports the default controller's and says where the others' come from.
 */
export function exportStProgram(store: EditorStore, target: ExportTarget, plc?: string | null): void {
  const { stProgram: src, controller, stScanMs: scanMs, projectName, stDialect, externalPlc } = store.getState()
  // both targets are IEC, and a program in a dialect this build does not have cannot be read as IEC to produce one
  if (stDialect !== undefined && !isKnownDialect(stDialect)) {
    store.showStFileReport({
      headline: 'Could not export the program',
      detail: dialectRefusal(stDialect),
      items: ['Nothing was downloaded.'],
      tone: 'error',
      keepOnEdit: false,
    })
    store.revealPanel('st')
    return
  }
  const others = tableControllers(controller, externalPlc.mainName)
  const perController = others.length > 0 || (plc !== undefined && plc !== null)
  const name = plc ?? externalPlc.mainName
  // the others named only where they have a file to give: a controller with an empty task has no export to point at
  const exportable = exportableControllers(controller, externalPlc.mainName)
  const elsewhere = `${exportable.join(', ')} ${exportable.length === 1 ? 'has its own file' : 'have their own'}: right-click ${exportable.length === 1 ? 'it' : 'one'} in the PLC panel's organizer to export ${exportable.length === 1 ? 'it' : 'each'}.`
  const notes: string[] = []
  let result: ReturnType<typeof exportProgram>
  try {
    if (perController) {
      const own = controllerExport(src, controller, scanMs, plc ?? null, externalPlc.mainName)
      result = exportProgram(runnableSource(own.source, own.table), target, { projectName: projectName || 'program', scanMs })
      // the controller names the file, beside the project: line.st becomes line-cell2.st
      result = { ...result, filename: result.filename.replace(/(\.[a-z]+)$/, `-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}$1`) }
      notes.push(`What goes onto ${name}: its tasks, the program instances on them and the POUs they use.`)
      if (own.dropped.length > 0) notes.push(`Left out ${own.dropped.join(', ')}, which ${name} does not use.`)
      if (plc === undefined && exportable.length > 0) notes.push(elsewhere)
    } else {
      // a file carries the tasks the program runs from as the CONFIGURATION they stand for
      result = exportProgram(runnableSource(src, controllerFor(src, controller, scanMs)), target, { projectName: projectName || 'program', scanMs })
    }
  } catch (e) {
    const empty = e instanceof NothingToExportError
    store.showStFileReport({
      headline: 'Could not export the program',
      detail: e instanceof Error ? e.message : String(e),
      items: empty
        ? ['Nothing was downloaded.', ...(plc === undefined && exportable.length > 0 ? [elsewhere] : [])]
        : ['Nothing was downloaded. A program leaves only once it compiles: fix what the code editor marks, then export again.'],
      tone: 'error',
      keepOnEdit: false, // the fix is an edit, and the code editor's own marks carry on from there
    })
    store.revealPanel('st')
    return
  }
  // an export warning is a note about what the target may not carry: the same checklist as an import note, and worth
  // bringing the panel forward for, where a clean export's download is its own confirmation
  store.showStFileReport({
    headline: `Exported ${result.filename}`,
    // which part of the project the file holds is a fact about it, not work to tick off
    ...(notes.length > 0 ? { detail: notes.join(' ') } : {}),
    items: result.warnings,
    tone: result.warnings.length ? 'warn' : 'ok',
    whole: !perController,
    keepOnEdit: false, // a receipt for a file already written: the first keystroke makes it stale
  })
  // so is a file that holds only part of the project: the person should see which part
  if (result.warnings.length > 0 || notes.length > 0) store.revealPanel('st')
  const url = URL.createObjectURL(new Blob([result.content], { type: target === 'plcopen-xml' ? 'application/xml' : 'text/plain' }))
  const a = document.createElement('a')
  a.href = url
  a.download = result.filename
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Load a file someone else wrote: IEC 61131-3 text, or a PLCopen TC6 project.
 *
 * The reverse of export, for both formats, for anyone arriving with code already in hand. `.st` covers a paste or an
 * IEC toolchain, while PLCopen XML is what an IEC tool's own export button produces. A file that declares a controller
 * arrives as one, its TASK period is adopted as the scan time (the cycle the author designed against), and anything
 * the subset cannot hold is named rather than dropped.
 *
 * The program, its table and its scan time are applied as one undo step (store.commitProgram), so Ctrl-Z takes the whole
 * import back, and a room replicates it like any other program edit.
 */
export async function importStFile(store: EditorStore, file: File): Promise<void> {
  if (store.getState().readOnly) return
  // A failure goes in the same card as a success, with the same "here is what to do" shape, and survives an edit,
  // since it is the one message the reader has to go and act on.
  const refuse = (headline: string, detail: string, items: string[]): void => {
    store.showStFileReport({ headline, detail, items, tone: 'error', keepOnEdit: true })
    store.revealPanel('st')
  }
  let text: string
  try {
    text = await file.text()
  } catch (e) {
    refuse(`Could not read ${file.name}`, e instanceof Error ? e.message : String(e), [
      'Nothing was loaded, so the program in the editor is untouched.',
      'If the file was moved or is on a drive that went away since you picked it, choose it again.',
    ])
    return
  }
  // The name picks the reader, with the content as a fallback so a PLCopen project saved under some other extension
  // still opens. Only the XML path can throw (an unparseable document is the wrong file, where half-written ST is a
  // program in progress), so it is caught and shown.
  const isXml = /\.xml$/i.test(file.name) || /^\s*(<\?xml|<project\b)/i.test(text)
  let imported: ReturnType<typeof importIecText>
  try {
    imported = isXml ? importPlcopenXml(text) : importIecText(text)
  } catch (e) {
    // The reader threw, so this is the wrong file, and the only useful reply names which reader it went to and
    // what that reader takes. The last item fires on the specific near-miss: an .xml name sent ST source (or a vendor
    // archive) to the XML reader.
    const looksXml = /^\s*(<\?xml|<)/.test(text)
    refuse(`Could not import ${file.name}`, e instanceof Error ? e.message : String(e), [
      'Nothing was loaded, so the program in the editor is untouched.',
      'This door takes PLCopen TC6 XML - what an IEC tool writes when it exports PLCopen XML - or IEC 61131-3 Structured Text saved as .st. A vendor project archive or a compiled download is neither.',
      ...(looksXml ? [] : ['This file does not start like an XML document. If it is ST source, save it as .st: the .xml name is what sent it to the XML reader.']),
    ])
    return
  }
  const { notes, scanMs: fileScan } = imported
  // A file that declares a controller arrives as one: its CONFIGURATION becomes this scene's task table and the program
  // keeps its POUs. A CONFIGURATION the table cannot hold (an event task, say) stays in the text as written, where the
  // engine still reads it; a single program clears any table the scene had.
  const split = extractController(imported.source)
  const source = split ? split.source : imported.source
  // the readers take IEC 61131-3 only, so the result is IEC whatever dialect the program it replaces was in (null),
  // in the same undo step as the program
  const familyBefore = store.getState().stDialect
  store.commitProgram(`Import ${file.name}`, { source, controller: split ? split.controller : null, dialect: null, ...(fileScan !== null ? { scanMs: fileScan } : {}) })
  // a program in a dialect this build does not run was replaced by an IEC one: said, rather than left to be noticed
  const family = familyBefore !== undefined ? `the program it replaced was in the '${familyBefore}' dialect; this one is IEC 61131-3` : undefined
  const tasks = split
    ? `${split.controller.programs.length} program(s) on ${split.controller.tasks.length} task(s), from its CONFIGURATION`
    : fileScan !== null
      ? `scan time set to ${store.getState().stScanMs} ms from its TASK` // as the store clamped it
      : undefined
  // The notes go in as a list. Each one names a construct the subset could not hold and what to do about it, so this
  // is a punch list to work through before trusting the simulation.
  store.showStFileReport({
    headline: `Imported ${file.name}`,
    detail: [family, tasks].filter((s) => s !== undefined).join('; ') || undefined,
    items: notes,
    tone: notes.length ? 'warn' : 'ok',
    whole: true,
    // an import checklist is a to-do list over the program now in the editor: the reader is meant to edit while
    // working through it, so a keystroke must not wipe it
    keepOnEdit: true,
  })
  store.revealPanel('st')
}
