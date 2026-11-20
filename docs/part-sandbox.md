# The part sandbox

A custom part's behavior is JavaScript, and a collab room syncs every part's code to everyone who opens its link. So
part code is **untrusted input**. This doc covers how it runs without reaching anything else, and what keeps it
that way.

## The layers

| Layer | Where | What it stops |
|---|---|---|
| **Code-trust gate** | `src/collab/codeTrust.ts` | A room's code from running at all until it is allowed (or, where the sandbox is on, until it is known to be someone else's). Trusted without asking: code this app ships, in any build (`src/editor/parts/shippedBehaviors.ts`), and code this browser wrote. |
| **SES lockdown** | `src/core/realmLockdown.ts`, run by `src/core/lockdownBoot.ts`, which `src/editor/main.tsx` and `src/sim/worker.ts` import first (on a dev server only, the page skips it when localStorage has `oip-web/no-lockdown`; the worker always locks down) | Tampering with the intrinsics the app relies on, and every path from a handed-in function back to the host (`fn.constructor('return this')`). |
| **Compartment** | `src/core/parts/partScript.ts` `compileSandboxed` | Part code seeing anything but the language's own globals: no `window`, storage, network, DOM, workers or app objects. |
| **The boundary** | `resolvePartParams`, `src/core/hostCopy.ts`, the `ctx` setters in `src/sim/embeddedBehavior.ts` | A part corrupting host data it is handed, or handing back data that changes after it was checked. |
| **Determinism scan and shims, loop budget** | `src/core/determinism.ts`, `partScript.ts` SHIMS, `src/core/loopGuard.ts` | Not security: reproducibility (`Math.random`, `Date`), and a runaway loop freezing the page. They still run inside the sandbox. |
| **Desktop main process** | `apps/desktop/folderGrants.cjs`, `endpointConsent.cjs` | What an escape would be worth on the desktop: main only touches folders the user handed it, and asks natively before any socket that leaves the machine. |

## How part code is compiled

Every host compiles through `compilePartScript` (`partScript.ts`). When the realm is locked down
(`partSandboxActive()`, `src/core/parts/partSandbox.ts`), the source compiles inside a fresh `Compartment` per distinct source, wrapped as:

```js
(function (Array, Object, Number, ..., parseInt) {      // BOUND_GLOBALS: read once, as locals
  return function (definePart, Math, Date, ..., __oipLoop) {   // SHIMS + the loop guard (loopGuard.ts LOOP_GUARD), hardened
    "use strict"; <part source, loop-instrumented>
  }
})
```

The common globals are bound as parameters because a Compartment resolves every other free name through a scope
proxy, which costs ~15-20x per lookup. Measured with the bindings: `step()` 1.9 µs per call against 2.2 µs
unsandboxed, and `geometry()` about 1.1x on average. Hosts that never lock down (the CLIs, the `unit-unlocked`
test project) compile with `new Function`.

## The lockdown options

`LOCKDOWN_OPTIONS` in `realmLockdown.ts`, six in all. The first three are measured choices:

- `evalTaming: 'unsafe-eval'`. The app's own realm keeps native `eval` and `new Function`. Compartments always use
  the safe evaluator. The default slows every global lookup in such code and rejects `import(` in evaluated text,
  which Playwright's `page.evaluate` uses.
- `localeTaming: 'unsafe'`. Native `localeCompare` and `toLocaleString`. The default re-sorts lists (`Zebra` before
  `apple`), drops number grouping, and ignores date options across the UI.
- `errorTaming: 'unsafe'`. Stack traces stay readable for diagnostics and the crash boundary.

The other three keep the host's diagnostics native. `realmLockdown.ts` does not record a measurement for them:

- `consoleTaming: 'unsafe'`. The native `console` is left as it is, not wrapped by SES.
- `stackFiltering: 'verbose'`. Stack traces keep every frame instead of SES's filtered, concise form.
- `overrideTaming: 'moderate'`. SES's own default, stated explicitly: the common override-mistake properties on
  frozen prototypes stay assignable on instances. Anything else still throws, hence the rule below.

## Living in a frozen realm

These apply to every module, because the whole page and the sim worker run locked down:

- **Never assign a property that an intrinsic prototype also has.** For example, `map.get = ...` on a `Map`
  instance throws (the "override mistake"). Use `Object.defineProperty` instead. In the renderer this fails silently: the error is caught and the
  renderer falls back to WebGL.
- **Never fill a `new Array(n)` hole by hole in a hot loop.** Writing into holes is ~25x slower once
  `Array.prototype` is frozen. Use `.fill(...)` first, or `push`.
- **Fake timers cannot run locked down.** sinon assigns `now` on a subclass of the frozen `Date`. Specs that fake
  timers run in the `unit-unlocked` project automatically (`vite.config.ts`), as do specs marked
  `@unlocked-realm`.
- Lockdown failing (an unsupported browser) is survivable: `partSandboxActive()` is false, part code compiles
  unsandboxed, and rooms fall back to asking before they run someone else's code.

## What part code is handed, and what comes back

The host must never hand part code a reference it relies on, or keep one the part still holds. As audited:

- **No engine objects** (Jolt, three.js, the store, the sim world, the PLC engine) are reachable from `ctx`, the
  geometry builder, or `definePart`. Their functions do lead back to the host's `Function`, which is exactly what
  lockdown disarms.
- **Params in** are copies (`resolvePartParams` `ownCopy`). Without the copy, `numberList` rows and schema defaults
  would be the store's and the manifest's own arrays, and the store only freezes in dev.
- **Values out** are read once and validated as locals (`readVec3`, `finiteOrUndef` in `embeddedBehavior.ts`).
  Checking a field and then reading it again would let a getter pass the check and hand NaN to Jolt.
- **Results kept** are host copies (`hostCopy`): `geometry()` output on the render, collision and catalog path,
  and a definition's `snap`, `unit` and `lamps`. The sim path already round-trips through JSON.

**When the SDK gains a capability, review it against this list.** A leak in the interface is far likelier than a
hole in SES.

## SES's track record

- **Assessment.** MetaMask ran a red-team engagement against the shim in July 2021: 5 days, with Agoric's maintainers
  as the blue team. Its conclusion: "to the best of our abilities, we did not find any escapes from this
  confinement". The findings were low severity or informational, e.g. the "has hazard" in the scope proxy, judged not
  exploitable.
- **Published advisories** (github.com/endojs/endo/security/advisories), three in all:
  - **GHSA-whpx-q3rq-w8jc** (low, 2022). TypedArray hardening; fixed in 0.16.0.
  - **GHSA-9c4h-3f7h-322r** (critical, 2023, CVE-2023-39532). `{...import(x)}` in guest code reached the host's
    module loader. Fixed in 0.18.7 and the other affected release lines. Compartments here reject `import(` outright,
    and `partSandbox.test.ts` checks it.
  - **GHSA-h9w6-f932-gq62** (high, 2025). A host page's top-level `<script>` `const`/`let`/`class` bindings leaked
    into Compartments; fixed in 1.12.0. The app has no such bindings: it is all modules.
- **Pinned:** `ses@2.3.0`, past every fix above. Keep it current like any security-critical dependency.
- **Precedent the other way.** Figma moved plugins off the Realms shim (SES's predecessor) to QuickJS in 2019, after
  several escapes were found in that shim.

## What it does not stop

- **Memory exhaustion, and hangs that are not loops** (deep recursion, a pathological regex). SES has no memory cap
  or interrupt, and the loop budget only stops loops. In the simulation worker the watchdog below ends such a run. In
  the page (a `geometry()` that never returns) a part can still freeze or crash its tab: the recovery open in
  [Rooms](#rooms) keeps such a room openable, a listed part was run at each of its settings in a capped process before
  it was listed ([part-libraries.md](part-libraries.md), "Trust"). Nothing in the page caps part code's memory or
  time.
- **Timing side channels.** These are low risk: part code gets no clock (`Date` and `performance` are shims, and
  `Math.random` throws).
- **Bugs in SES itself.** The defence in depth is the gate, the desktop main-process checks, and keeping `ses`
  current.

## Hangs in the simulation

The sim worker runs `step()`, `init()` and the worker's own `geometry()` calls. The page watches it
([sim/client.ts](../src/sim/client.ts)). A running world sends frames many times a second. A paused one sends none, but
its step loop keeps ticking a counter the page shares with the worker (where memory cannot be shared, it sends a small
'alive' message once a second instead). Part code runs on the loop's thread, so a stuck call stops both. A run that
shows neither for 10 s (30 s before its first frame, which waits on the world build and a cold Jolt compile) is stuck.
The page ends the worker, stops the run and says so; the next Play starts a fresh worker. A hidden tab restarts the
clock instead of judging, since its timers are throttled. A check that runs late, after the page was hidden, still
sees the counter has moved and leaves a live worker alone.

To say which part, part code marks itself in a small buffer the page shares with the worker
([core/parts/partScript.ts](../src/core/parts/partScript.ts) `setPartCallBeacon`). The outermost call into part code (an entry point
or a script's top level, the same place the loop budget resets) writes that it is in part code and the part's name,
and clears the mark on the way out. The worker names a script by the package whose behavior it is, once per placed
part. The page reads the buffer before it ends the worker. Where memory cannot be shared (a page that is not
cross-origin isolated) the run is still ended, without a name. Gated by `e2e/verify-sim-hang.mjs`.

## Rooms

Where `partSandboxActive()` holds, in a browser or the desktop, a room's foreign code runs sandboxed by default,
with nothing shown. On the desktop an escape would also meet the main process's folder grants and endpoint consent.
Where lockdown failed, `RoomCodePrompt` asks first: the code is held until allowed.

**Staying openable when a room's code freezes the page.** The sandbox confines code; it cannot stop it spinning. A
hostile part that hangs `geometry()` on open would freeze the page on every open. Two
safe opens hold the foreign code for that open, and the prompt says why (`RoomCodeMode.safe`):

- **`&nocode` in the link.** Anyone can use it to get into a room deliberately.
- **Recovery.** Before foreign code runs, the boot marks the room as opening (`oip-web/room-opening`,
  `codeTrust.ts markRoomOpening`). This happens at the first review, when a peer adds more code, and when a held room
  is allowed. A normal leave (`pagehide`) or 30 s of staying responsive clears the mark. A frozen tab that gets
  closed, or a crash, fires neither, so the next open finds the mark and is safe by itself. The user only has to
  reopen the link.

In the page, that is all the protection there is. A hostile link can cost one frozen tab, as any website can.

## Gates

- `src/editor/partSandbox.test.ts`: escapes blocked, no host globals, intrinsics frozen, determinism and the loop
  budget intact, every built-in part still builds.
- `src/editor/roomCodeTrust.test.ts` (`@unlocked-realm`): the gate as the last line of defence where the sandbox
  is absent.
- `src/collab/codeTrust.test.ts`, `src/editor/parts/shippedBehaviors.test.ts`, `src/core/sha256.test.ts`.
- `apps/desktop/folderGrants.test.cjs` and `endpointConsent.test.cjs`.
- Every e2e gate runs the app locked down, since the app locks itself down at boot.
