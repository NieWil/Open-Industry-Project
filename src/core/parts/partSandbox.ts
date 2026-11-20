// Is part code sandboxed in this realm? True once core/realmLockdown.ts has locked the realm down (the page and the
// sim worker do it first thing), so core/parts/partScript.ts compiles part code inside an SES Compartment. Free
// of imports: partScript reaches every host (CLIs, tests, the part SDK build), and none of them should pull
// in the SES shim just to ask. docs/part-sandbox.md.

/** Can part code run sandboxed here: the realm is locked down and Compartments exist? */
export function partSandboxActive(): boolean {
  return Object.isFrozen(Array.prototype) && typeof (globalThis as { Compartment?: unknown }).Compartment === 'function'
}
