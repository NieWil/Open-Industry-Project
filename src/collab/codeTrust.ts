import type { PartPackage } from '../core/parts/partPackage'
import { getPackage } from '../core/parts/partRegistry'

// The room's CODE trust gate. A custom part's `behavior` is JavaScript. Where the realm is locked down it runs in
// the part sandbox (docs/part-sandbox.md), in a browser or the desktop, and this gate decides only WHETHER a room's
// code runs: it runs unless this open is a safe one (`?nocode`, or the recovery below). Where lockdown failed, this
// gate is the whole protection: part code then runs with the page's access (the determinism guards are not a
// security boundary), so the room's code is held until the user allows it.
//
// A room syncs every peer's packages, so without this gate joining one would run everyone's part code on this
// machine with no prompt, view-only viewers included, and `geometry()` runs on the main thread. A room is reached
// by a link, so anyone holding one could do that to anyone who opens it.
//
// So a package from the room reaches the store (the registry AND scene.packages, which the sim falls back to)
// only in an ADMITTED form: its data as the room holds it (params, rig, assets), and its code only if this
// browser trusts that code. Otherwise the part is HELD: it keeps its shape and settings and runs code we
// already trust in place of its author's (the version it ran before, else the built-in of the same id, else
// nothing). Nothing downstream (render, sim worker, thumbnails, the catalog) ever sees the held source, so no
// path can run it by accident.
//
// Trusted without asking: code this app ships or ever shipped (a first-party part, byte for byte, matched by
// SHA-256 against every released version - editor/parts/shippedBehaviors.ts), code this client wrote into
// the room itself, and code the registry already runs for that id. Everything else waits until the user allows
// the ROOM's code (a per-room decision, remembered in this browser, like an editor's workspace trust).

/**
 * The script a held part runs in place of its author's: declares nothing, does nothing.
 *
 * It explains itself in a comment because it can leave the room. A scene exported while the room's code was
 * blocked carries this script, not the author's (nothing downstream is ever handed the held source, an
 * export included). Without the comment, the swapped part would look like one that genuinely does nothing. The export says so too, at the moment it happens (editor/commands.ts).
 */
export const INERT_BEHAVIOR =
  "// This part's code is not included here. It was written by someone else in a collaborative room and was\n" +
  '// not allowed to run on the computer this was saved from, so the part keeps its shape and its settings\n' +
  '// and runs this stand-in instead. To get the real one, rejoin that room and allow its code.\n' +
  'definePart({ step() {} })\n'

/** a package whose code this client is holding back, as the join prompt lists it */
export interface HeldPackage {
  id: string
  name: string
  /** what its placed parts run meanwhile: no code, this app's own part of the same id, or the version it ran here
   *  before */
  runs: 'nothing' | 'built-in' | 'previous'
}

/** what the gate needs from the app: which code it ships */
export interface FirstPartyCode {
  /** true when `source` is a behavior this app ships (running it is running our own code) */
  isFirstParty(source: string): boolean
  /** the behavior this app ships for package `id`, or undefined when it ships no such part */
  sourceFor(id: string): string | undefined
}

const NO_FIRST_PARTY: FirstPartyCode = { isFirstParty: () => false, sourceFor: () => undefined }

/** an id whose registry copy carries a stand-in's code in place of the room's */
interface StandIn {
  /** the source this client runs instead */
  standIn: string
  /** the room's source (the latest seen), never run here; kept so a write from this client puts it back */
  roomCode: string
}

export class PackageGate {
  private trustedRoom: boolean
  /** code this client authored and wrote into the room (it already runs it) */
  private readonly own = new Set<string>()
  /**
   * Every id admitted with a stand-in, kept until its room code turns trusted. It outlives the doc's
   * copy: when a peer deletes a held package, the registry still carries the stand-in, and the bridge's
   * missing-package safety net would otherwise write that stand-in back into the room for everyone.
   */
  private readonly standIns = new Map<string, StandIn>()
  /** every package id that has arrived from the room, so a re-send of one isn't mistaken for this client's code */
  private readonly fromRoom = new Set<string>()
  /** what the prompt lists: the packages in the doc right now whose code is held */
  private heldList: readonly HeldPackage[] = []
  /** ids of the packages in the doc right now whose code is someone else's (held or not): what arms the recovery mark */
  private foreignList: readonly string[] = []
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly firstParty: FirstPartyCode = NO_FIRST_PARTY,
    trusted = false,
    /** told about each newly noted own source, so the room boot can remember it past a reload (rememberOwnCode) */
    private readonly onOwn?: (source: string) => void,
  ) {
    this.trustedRoom = trusted
  }

  /** the user has allowed this room's code */
  get trusted(): boolean {
    return this.trustedRoom
  }

  /** would `pkg`'s code run here without asking? */
  isTrustedCode(pkg: PartPackage): boolean {
    const src = pkg.behavior
    return this.trustedRoom || this.own.has(src) || this.firstParty.isFirstParty(src) || getPackage(pkg.id)?.behavior === src
  }

  /** the form of `pkg` the store may hold: itself when its code is trusted, else its data with a stand-in's code */
  admit(pkg: PartPackage): PartPackage {
    this.fromRoom.add(pkg.id)
    if (this.isTrustedCode(pkg)) {
      this.standIns.delete(pkg.id) // its registry copy is about to be this trusted code
      return pkg
    }
    // the stand-in, in order: the one already chosen, what this id already runs here (the registry only ever
    // holds admitted code), the built-in of the same id, nothing at all
    const standIn = this.standIns.get(pkg.id)?.standIn ?? getPackage(pkg.id)?.behavior ?? this.firstParty.sourceFor(pkg.id) ?? INERT_BEHAVIOR
    this.standIns.set(pkg.id, { standIn, roomCode: pkg.behavior })
    return { ...pkg, behavior: standIn }
  }

  /**
   * Admit the room's WHOLE package list and make the held set exactly the packages in it whose code is not
   * trusted. Called with every package the doc holds (at join, on each package change, on trust), so a
   * package that leaves the room, or whose code turns trusted, stops being held.
   */
  review(pkgs: readonly PartPackage[]): PartPackage[] {
    const out: PartPackage[] = []
    const next: HeldPackage[] = []
    const foreign: string[] = []
    for (const pkg of pkgs) {
      // asked before admitting: once admitted, a trusted room's code is also "what the registry runs"
      if (!this.own.has(pkg.behavior) && !this.firstParty.isFirstParty(pkg.behavior)) foreign.push(pkg.id)
      const admitted = this.admit(pkg)
      out.push(admitted)
      if (admitted === pkg) continue
      const standIn = admitted.behavior
      const runs = standIn === INERT_BEHAVIOR ? 'nothing' : standIn === this.firstParty.sourceFor(pkg.id) ? 'built-in' : 'previous'
      next.push({ id: pkg.id, name: pkg.name, runs })
    }
    const same = (a: readonly HeldPackage[], b: readonly HeldPackage[]): boolean =>
      a.length === b.length && a.every((h, i) => h.id === b[i]!.id && h.name === b[i]!.name && h.runs === b[i]!.runs)
    const sameIds = foreign.length === this.foreignList.length && foreign.every((id, i) => id === this.foreignList[i])
    if (!same(next, this.heldList) || !sameIds) {
      this.heldList = next
      this.foreignList = foreign
      this.notify()
    }
    return out
  }

  /** ids of the packages in the doc whose code someone else wrote, whether held or running (editor/main.tsx armRecovery) */
  getForeign = (): readonly string[] => this.foreignList

  /** a scene decoded from the doc, with its embedded packages admitted (the sim runs these when the registry lacks one) */
  admitScene<S extends { packages?: PartPackage[] }>(scene: S): S {
    const pkgs = scene.packages
    if (!pkgs || pkgs.length === 0) return scene
    let changed = false
    const admitted = pkgs.map((p) => {
      const a = this.admit(p)
      if (a !== p) changed = true
      return a
    })
    return changed ? { ...scene, packages: admitted } : scene
  }

  /**
   * What this client may write to the doc for `pkg`. A held package's registry copy carries the stand-in, so a
   * data edit (a rig tweak, a param default) pushed from here would otherwise overwrite its author's code with
   * ours for everyone. Only the stand-in is swapped back; a script this user typed is theirs to write.
   */
  docForm(pkg: PartPackage): PartPackage {
    const s = this.standIns.get(pkg.id)
    return s && pkg.behavior === s.standIn ? { ...pkg, behavior: s.roomCode } : pkg
  }

  /** record code this client wrote into the room: it runs its own code, so a peer re-sending it is no news */
  noteOwn(source: string): void {
    if (this.own.has(source) || this.firstParty.isFirstParty(source)) return // this app's own needs no remembering
    this.own.add(source)
    this.onOwn?.(source)
  }

  /** has a package with this id ever arrived from the room? */
  cameFromRoom(id: string): boolean {
    return this.fromRoom.has(id)
  }

  /** does this package run a stand-in here in place of the room's code? */
  isHeld(id: string): boolean {
    return this.standIns.has(id)
  }

  /** the held packages (stable identity between changes, for useSyncExternalStore) */
  getHeld = (): readonly HeldPackage[] => this.heldList

  /** the user allows this room's code: everything held now runs, and later code from the room runs too */
  trustRoom(): void {
    if (this.trustedRoom) return
    this.trustedRoom = true
    this.standIns.clear()
    this.notify()
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private notify(): void {
    for (const cb of this.listeners) cb()
  }
}

// --- the per-room decision, remembered in this browser -------------------------------------------------

const TRUSTED_ROOMS_KEY = 'oip-web/trusted-rooms'
/** a bound on the list, oldest dropped first: a room not visited in a long while asks again */
const TRUSTED_ROOMS_CAP = 200

function readTrustedRooms(): string[] {
  try {
    const raw = localStorage.getItem(TRUSTED_ROOMS_KEY)
    const list = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** has this browser allowed the code of the room with this server doc name? (keyed by doc name, so an edit
 *  link and a view link of one room share the answer) */
export function isRoomCodeTrusted(docName: string): boolean {
  return readTrustedRooms().includes(docName)
}

// --- recovery from a room whose code froze or crashed the page -------------------------------------------------
// SES confines part code but cannot stop it spinning or allocating (docs/part-sandbox.md). Where a room's code runs
// on open, a hostile part could freeze the page on every open. So the boot marks a room as OPENING before its
// foreign code runs and clears the mark once the page has stayed responsive;
// a mark still there on the next open means the last one never got that far, and that open holds the code instead.

const OPENING_KEY = 'oip-web/room-opening'

function readOpening(): Record<string, number> {
  try {
    const raw = localStorage.getItem(OPENING_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, number>) : {}
  } catch {
    return {}
  }
}

function writeOpening(map: Record<string, number>): void {
  try {
    if (Object.keys(map).length === 0) localStorage.removeItem(OPENING_KEY)
    else localStorage.setItem(OPENING_KEY, JSON.stringify(map))
  } catch {
    /* blocked storage: no recovery memory, the link's ?nocode still works */
  }
}

/** did the last open of this room in this browser never finish (the page froze or crashed while its code ran)? */
export function roomOpenDidNotFinish(docName: string): boolean {
  return readOpening()[docName] !== undefined
}

/** mark this room as opening, before its foreign code runs; `roomOpenFinished` clears it */
export function markRoomOpening(docName: string, now: number): void {
  const map = readOpening()
  map[docName] = now
  // a bound, oldest first: rooms abandoned mid-open (a closed tab) must not pile up
  const kept = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 50)
  writeOpening(Object.fromEntries(kept))
}

/** the room opened and stayed responsive: its next open runs its code as usual */
export function roomOpenFinished(docName: string): void {
  const map = readOpening()
  if (!(docName in map)) return
  delete map[docName]
  writeOpening(map)
}

/** remember that this browser allows the code of this room */
export function rememberRoomCodeTrust(docName: string): void {
  try {
    const list = readTrustedRooms().filter((n) => n !== docName)
    list.push(docName)
    localStorage.setItem(TRUSTED_ROOMS_KEY, JSON.stringify(list.slice(-TRUSTED_ROOMS_CAP)))
  } catch {
    /* blocked storage: the answer lasts for this visit only */
  }
}

// --- taking the answers back (Settings > Live editing) -------------------------------------------------
// Rooms are listed by count, not by name: a doc name is a hash of the room's secret, so a list of them would
// tell the reader nothing. A forgotten answer is asked again on the room's next open, not in a room already open.

function storedListLength(key: string): number {
  try {
    const raw = localStorage.getItem(key)
    const list = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(list) ? list.length : 0
  } catch {
    return 0
  }
}

/** how many rooms this browser allows the code of */
export function trustedRoomCount(): number {
  return storedListLength(TRUSTED_ROOMS_KEY)
}

/** forget every "allow this room's code": each room asks again on its next open */
export function forgetTrustedRooms(): void {
  try {
    localStorage.removeItem(TRUSTED_ROOMS_KEY)
  } catch {
    /* blocked storage: nothing was remembered */
  }
}

// --- code this browser wrote into a room, remembered past a reload ------------------------------------
// Without it, a room's creator would be asked about their own custom parts the next time they open the room, and
// the likely answer (allow the room) would also wave through whatever a collaborator adds later. Stored as SHA-256
// fingerprints, not a fast hash: a matching fingerprint makes code trusted, so it must not be forgeable.

const OWN_CODE_KEY = 'oip-web/own-part-code'
/** a bound on the list, oldest dropped first */
const OWN_CODE_CAP = 500

async function codeFingerprint(source: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function readOwnFingerprints(): string[] {
  try {
    const raw = localStorage.getItem(OWN_CODE_KEY)
    const list = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** remember that this browser wrote `source` into a room (fire and forget; storage failures only cost a prompt) */
export async function rememberOwnCode(source: string): Promise<void> {
  try {
    const fp = await codeFingerprint(source)
    const list = readOwnFingerprints().filter((x) => x !== fp)
    list.push(fp)
    localStorage.setItem(OWN_CODE_KEY, JSON.stringify(list.slice(-OWN_CODE_CAP)))
  } catch {
    /* no crypto.subtle or no storage: this code is not remembered */
  }
}

/** the sources among `sources` that this browser wrote into a room before (see rememberOwnCode) */
export async function ownCodeAmong(sources: readonly string[]): Promise<string[]> {
  const known = new Set(readOwnFingerprints())
  if (known.size === 0) return []
  try {
    const out: string[] = []
    for (const src of new Set(sources)) if (known.has(await codeFingerprint(src))) out.push(src)
    return out
  } catch {
    return []
  }
}
