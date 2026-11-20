// Which part libraries this app reads (docs/part-libraries.md): the index URLs. Apart from partLibraries.ts, which
// fetches and installs, because the Catalog asks this on its first render to decide whether it has a Libraries tab,
// and the rest loads only when that tab opens.
//
// Three sources, all per viewer:
//   - `?library=<url>` (repeatable) names the libraries for this session, and nothing else is read
//   - the official libraries (OFFICIAL_PART_LIBRARIES), part of the build: adding one is a change to this file, which
//     every deploy carries, so no request is made for the list; each can be switched off in Settings
//   - the viewer's own libraries, added in Settings (another publisher's library, a self-hosted mirror)

/**
 * The project's own libraries and the listed library of other publishers' parts (Community, built from the parts
 * repository), shown to everyone unless switched off. Structure is left out: it repeats parts the app ships, so Get
 * parts would offer what the Parts dock already has.
 */
export const OFFICIAL_PART_LIBRARIES: readonly string[] = [
  'https://parts.openindustryproject.org/oip.containers/index.json',
  'https://parts.openindustryproject.org/oip.community/index.json',
]

const LIBRARIES_KEY = 'oip-web/part-libraries'
const OFF_KEY = 'oip-web/part-libraries-off'

/** Fired on `window` when the viewer's lists change, so the Catalog and Settings re-read them. */
export const LIBRARIES_CHANGED = 'oip-part-libraries-changed'

/** Only http(s) URLs are read as libraries. */
export function isLibraryIndexUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

function readList(key: string): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(saved) ? saved.filter((u): u is string => typeof u === 'string' && isLibraryIndexUrl(u)) : []
  } catch {
    return []
  }
}

function writeList(key: string, urls: readonly string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify([...new Set(urls.filter(isLibraryIndexUrl))]))
  } catch {
    // storage blocked (a private window): the change lasts for this page only
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(LIBRARIES_CHANGED))
}

/** The viewer's own libraries, added in Settings. */
export function addedLibraryUrls(): string[] {
  return readList(LIBRARIES_KEY)
}

/** Save the viewer's own libraries. */
export function setLibraryUrls(urls: readonly string[]): void {
  writeList(LIBRARIES_KEY, urls)
}

/** Official libraries the viewer has switched off. */
export function officialLibrariesOff(): string[] {
  return readList(OFF_KEY)
}

/** Switch an official library on or off for this viewer. */
export function setOfficialLibraryOn(url: string, on: boolean): void {
  const off = officialLibrariesOff().filter((u) => u !== url)
  writeList(OFF_KEY, on ? off : [...off, url])
}

/**
 * The index URLs this app reads: the `?library=` ones for this session, else the official libraries left on and the
 * viewer's own. Empty when there are none, and Get parts then says how to add one.
 */
export function libraryUrls(search: string = typeof location === 'undefined' ? '' : location.search, official: readonly string[] = OFFICIAL_PART_LIBRARIES): string[] {
  const fromLink = new URLSearchParams(search).getAll('library').filter(isLibraryIndexUrl)
  if (fromLink.length > 0) return fromLink
  const off = new Set(officialLibrariesOff())
  return [...new Set([...official.filter((u) => !off.has(u)), ...addedLibraryUrls()])]
}
