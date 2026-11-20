// The entry parameters a document switch leaves behind: the demo's, and a shared project's room. Its own module so the
// working copy's code (projectFile.ts) and the library's (documentStore.ts) can both use it without importing each other.

/**
 * Drop the entry params before a reload into another document. `/app/?scene=demo` puts the app into the demo preview
 * at boot, and `?room=` into a shared project (main.tsx), so switching documents from inside either would write the
 * chosen project into the working copy and then reload straight back, silently undoing the switch. Mirrors
 * store.clearDemoUrl, which retires the demo's param when an edit forks the demo.
 */
export function clearEntryParams(): void {
  if (typeof window === 'undefined' || typeof history === 'undefined') return
  try {
    const url = new URL(window.location.href)
    // ...and a shared project's room: switching to another document leaves it (opening it again rejoins it, from
    // this browser's record of what it shared: project/sharedProject.ts)
    // ...and the document a desktop window was opened on (libraryDb.pinTabDocument)
    const entry = ['scene', 'room', 'view', 'server', 'present', 'doc'].filter((p) => url.searchParams.has(p))
    if (entry.length === 0) return
    for (const p of entry) url.searchParams.delete(p)
    history.replaceState(history.state, '', url.pathname + url.search + url.hash)
  } catch {
    // best-effort: a malformed URL or disabled history must never block the switch
  }
}
