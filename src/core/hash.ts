/**
 * A 53-bit content hash (cyrb53), rendered with the length in front so two texts of different sizes
 * can never compare equal. Not cryptographic and not meant to be: it answers "did this file change?"
 * between two copies of the same project, where there is no adversary.
 *
 * The Electron shell carries an identical copy (apps/desktop/projectFolderIo.cjs) because it checks
 * core/project/folderSync.ts `FolderWriteOp.expect` against the file on disk. Both are pinned to the same vectors by their
 * tests, so they cannot drift apart silently.
 */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `${text.length}:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`
}

/**
 * The same hash over raw BYTES, for a binary file in a project folder (a part's asset file, core/parts/partAssets.ts). A
 * `b` in front keeps it from ever equalling a text hash, so a file that changes kind reads as changed. The Electron
 * shell carries an identical copy, pinned by the same vectors, like {@link hashText}.
 */
export function hashBytes(bytes: Uint8Array): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < bytes.length; i++) {
    const ch = bytes[i]!
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `b${bytes.length}:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`
}

/** {@link hashText} or {@link hashBytes}, by what the file holds. */
export function hashContents(contents: string | Uint8Array): string {
  return typeof contents === 'string' ? hashText(contents) : hashBytes(contents)
}
