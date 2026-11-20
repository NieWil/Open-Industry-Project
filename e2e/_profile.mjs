// CPU profiles of a page, attributed by function: the shared half of every "where does the time go" probe.
//
// `profiled(page, run)` records a V8 CPU profile and the page's long tasks while `run` drives the page, and
// `report` prints what the page was doing in any window of it: time working and idle, the stalls, and the functions
// that account for it, by inclusive time (what to open first) and by self time (where it is actually spent).
//
// Function names only read well on an unminified build: e2e/probes/profile-steps.mjs makes one beside dist/.

/** Count the page's long tasks from before its first script runs. Call before the page navigates. */
export async function watchLongTasks(page) {
  await page.addInitScript(() => {
    window.__longTasks = []
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__longTasks.push([e.startTime, e.duration])
    }).observe({ entryTypes: ['longtask'] })
  })
}

/** The page's clock, in ms since it navigated. */
export const pageNow = (page) => page.evaluate(() => performance.now())

/**
 * Record a CPU profile while `run` drives the page. Returns the profile, when it began and ended on the page's clock
 * (so a window given in page time can be cut out of it), and the long tasks the page saw.
 *
 * `run` may navigate: the profiler belongs to the tab, not the document. Pass `fromNavigation` then, and windows are
 * read on the new document's clock.
 */
export async function profiled(page, run, { fromNavigation = false, intervalUs = 500 } = {}) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: intervalUs })
  const startedAt = fromNavigation ? 0 : await pageNow(page)
  await cdp.send('Profiler.start')
  let result
  let profile
  try {
    result = await run()
  } finally {
    ;({ profile } = await cdp.send('Profiler.stop'))
    await cdp.detach().catch(() => {})
  }
  const longTasks = await page.evaluate(() => window.__longTasks ?? [])
  return { profile, startedAt, endedAt: await pageNow(page), longTasks, result }
}

const label = (node) => {
  const { functionName, url, lineNumber } = node.callFrame
  // a built chunk is `name-<hash>.js`: the hash says nothing and changes on every build
  const file = url.split('/').pop().split('?')[0].replace(/-[A-Za-z0-9_-]{8}\.js$/, '')
  return `${functionName || '(anonymous)'} ${file}:${lineNumber + 1}`
}

/** Frames that are on every stack and say nothing about whose time it is. */
const PLUMBING = /^\((root|idle)\)|^(performWork|performUnitOfWork|performSyncWork|workLoop|renderRoot|beginWork|renderWithHooks|updateFunctionComponent|mountStateImpl|mountMemo|updateMemo|useState|useMemo|exports\.use|commit|flush|recursively|processRootSchedule|run |(anonymous) react)/

/**
 * What the page did between `from` and `to` (ms on the page's clock; the whole profile when left out).
 * `{ work, idle, stalls, inclusive, self }`, the two lists as `[label, ms]` from the largest.
 */
export function attribute({ profile, startedAt, endedAt, longTasks }, { from = startedAt, to = endedAt } = {}) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const parent = new Map()
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
  const self = new Map()
  const inclusive = new Map()
  let work = 0
  let idle = 0
  let clock = startedAt
  profile.samples.forEach((id, i) => {
    const dt = profile.timeDeltas[i] / 1000
    clock += dt
    if (clock < from || clock > to) return
    const own = label(byId.get(id))
    if (own.startsWith('(idle)')) idle += dt
    else if (!own.startsWith('(root)')) work += dt
    self.set(own, (self.get(own) ?? 0) + dt)
    const seen = new Set()
    for (let at = id; at !== undefined; at = parent.get(at)) {
      const l = label(byId.get(at))
      if (seen.has(l)) continue
      seen.add(l)
      inclusive.set(l, (inclusive.get(l) ?? 0) + dt)
    }
  })
  const sorted = (m) => [...m].filter(([k]) => !PLUMBING.test(k)).sort((a, b) => b[1] - a[1])
  const stalls = longTasks.filter(([at, ms]) => at >= from && at < to && ms >= 100).map(([at, ms]) => [Math.round(at), Math.round(ms)])
  return { work: Math.round(work), idle: Math.round(idle), stalls, inclusive: sorted(inclusive), self: sorted(self) }
}

/** Print {@link attribute}'s answer for a window. */
export function report(title, recording, { from, to, top = 25, log = console.log } = {}) {
  const a = attribute(recording, { from, to })
  const span = from !== undefined && to !== undefined ? `${Math.round(to - from)} ms: ` : ''
  log(`\n==== ${title}: ${span}${a.work} ms working, ${a.idle} ms idle`)
  log(`stalls of 100 ms or more: ${a.stalls.length === 0 ? 'none' : a.stalls.map(([at, ms]) => `${ms} ms at ${at}`).join(', ')}`)
  if (top <= 0) return a
  log('-- inclusive (what to open first)')
  for (const [k, v] of a.inclusive.slice(0, top)) log(`${v.toFixed(0).padStart(7)}  ${k}`)
  log('-- self (where it is spent)')
  for (const [k, v] of a.self.slice(0, Math.max(8, top >> 1))) log(`${v.toFixed(0).padStart(7)}  ${k}`)
  return a
}
