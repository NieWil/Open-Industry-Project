// Import part files a person handed over (the file picker, a drop on the Parts dock or on the viewport): ask before a
// file replaces a part already here, and list every file that failed in one alert.
import { defineMessages, t } from '../../core/i18n'
import type { EditorController } from '../controller'

const M = defineMessages('partImport', {
  replaceLoaded: 'A part “{name}” is already loaded. Replace it with the one from “{file}”?',
  importErrorLine: '{file}: {error}',
  importFailed: "Couldn't import:\n{errors}",
})

/** the files in a drop that can be part files (.oippart, .part.json or any JSON) */
export function partFilesOf(files: FileList | readonly File[]): File[] {
  return Array.from(files).filter((f) => /\.(json|oippart)$/i.test(f.name) || f.type === 'application/json')
}

/**
 * Import each file. With `placeAt`, a single file is also placed at that screen point (a drop on the viewport); several
 * are imported only, since one point can't hold them all.
 */
export async function importPartFiles(controller: EditorController, files: File[], placeAt?: { x: number; y: number }): Promise<void> {
  const errors: string[] = []
  const place = files.length === 1 ? placeAt : undefined
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const confirmReplace = (name: string): boolean => window.confirm(t(M.replaceLoaded, { name, file: file.name }))
    const error = place ? await controller.dropPartFile(bytes, place.x, place.y, confirmReplace) : await controller.importPart(bytes, confirmReplace)
    if (error) errors.push(t(M.importErrorLine, { file: file.name, error }))
  }
  if (errors.length > 0) alert(t(M.importFailed, { errors: errors.join('\n') }))
}
