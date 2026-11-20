// SES lockdown for every realm that runs part code - the page and the sim worker - and the one switch the part
// sandbox reads (core/parts/partScript.ts). Design: docs/part-sandbox.md.
//
// A collab room can hand a custom part's JavaScript to anyone who opens its link (collab/codeTrust.ts). lockdown()
// freezes every shared intrinsic, so part code compiled in a Compartment reaches only what the host hands it: no
// window, storage, network, DOM or app objects, and nothing the app relies on to tamper with.
//
// The options are measured choices, not defaults:
//   evalTaming 'unsafe-eval'  the app's own realm keeps native eval / new Function (Compartments always get the
//                             safe evaluator). The default proxies every global lookup (~15-20x slower) and
//                             rejects any `import(` in evaluated text, which Playwright's page.evaluate uses.
//   localeTaming 'unsafe'     native localeCompare / toLocaleString; the default's locale-blind versions re-sort
//                             lists ('Zebra' before 'apple') and drop number grouping and date options.
//   errorTaming 'unsafe'      keep stack traces: diagnostics and the crash boundary read them.
//
// Living with a frozen realm, for every module in the app (AGENTS.md, "Dev / prod foot-guns"):
//   - never assign a property that an intrinsic prototype also has (`map.get = ...` on a Map instance throws: the
//     "override mistake"); define it with Object.defineProperty
//   - never fill a `new Array(n)` hole by hole in a hot loop (~25x slower once Array.prototype is frozen); use
//     `.fill(...)` first or push (core/geometry/geometryShapes.ts transformDescription)
//
// If lockdown cannot run, the app still works: part code compiles unsandboxed, partSandboxActive()
// (core/parts/partSandbox.ts) says so, and the room keeps asking before it runs a stranger's code.

import 'ses'

/** the lockdown() options every realm uses (see the header for why each one) */
export const LOCKDOWN_OPTIONS = {
  evalTaming: 'unsafe-eval',
  localeTaming: 'unsafe',
  errorTaming: 'unsafe',
  consoleTaming: 'unsafe',
  stackFiltering: 'verbose',
  overrideTaming: 'moderate',
} as const

/** Lock this realm down, once. Returns whether it is locked down now. Never throws. */
export function lockdownRealm(): boolean {
  if (Object.isFrozen(Array.prototype)) return true
  try {
    lockdown(LOCKDOWN_OPTIONS)
  } catch (e) {
    console.error('[oip] SES lockdown failed - part code will run unsandboxed in this session:', e)
  }
  return Object.isFrozen(Array.prototype)
}
