/**
 * The i18n seam: every user-facing string in the app resolves through one function.
 *
 * It ships no translations: one locale ('en'), `t()` returns the source string, no pixel changes. What it adds is
 * the split between prose and identifiers, which no automatic translator can make.
 *
 * /app/ opts out of browser translation (`translate="no"`, app/index.html) for two reasons that outlive any
 * improvement in translation quality:
 *
 * 1. **Prose vs identity.** Page translation walks the DOM, which doesn't record that "Belt Conveyor" is a label
 *    while `Conv1_Run` is an identifier an ST program matches by exact string. Translate that and the program
 *    loses its tag. The information is in the code, so the split belongs here.
 * 2. **It white-screens React.** Chrome rewraps translated text nodes in <font>, React 19 updates a node whose
 *    parent moved, and the app crashes. `translate="no"` on identity spans fixes (1), not (2).
 *
 * The desktop shell's menubar is native (apps/desktop/main.cjs), with no DOM to translate at all.
 *
 * Browsers are taking over producing translations (Chrome's on-device Translator API), not extraction (knowing
 * which strings are prose). So this module owns extraction and holds no translations: `setLocale()` accepts a
 * dictionary from anywhere, including an on-device translator fed by `messageCatalog()`.
 *
 * Shape notes:
 * - `t()` is synchronous, over an already-resolved dictionary; async work happens once in `setLocale()` at boot.
 * - Resolution order is active locale → source → the id itself. A missing translation degrades to
 *   English, never to a blank or a crash.
 * - Headless and DOM-free, like the rest of core.
 */

/** A message's stable key. Derived from something already unique and already stable (a command id),
 *  never from the English text - so rewording a label doesn't orphan its translations. */
export type MessageId = string

/** id → English source text. The extraction output: what a translator (or an on-device model) is
 *  handed, and the fallback every lookup lands on. */
const SOURCES = new Map<MessageId, string>()

/** The English forms of a count-dependent message. A locale adds the other CLDR categories it needs
 *  ('few', 'many', ...) under `<id>#<category>`; English has only these two. */
export interface PluralSource {
  readonly one: string
  readonly other: string
}

/** Ids declared with a PluralSource. Their forms live in SOURCES as `<id>#one` / `<id>#other`. */
const PLURALS = new Set<MessageId>()

let activeTag = 'en'
let active: ReadonlyMap<MessageId, string> | null = null
let pluralRules: Intl.PluralRules | null = null

const definedListeners = new Set<(id: MessageId, source: string) => void>()

function register(id: MessageId, source: string): void {
  const prior = SOURCES.get(id)
  if (prior !== undefined && prior !== source) {
    throw new Error(`i18n: message '${id}' redeclared with a different source ('${prior}' vs '${source}')`)
  }
  if (prior !== undefined) return
  SOURCES.set(id, source)
  for (const cb of definedListeners) cb(id, source)
}

/**
 * Hear about each message as it is declared, with its English source. A lazily loaded module declares its messages
 * when it loads, after boot, so a translator that worked from `messageCatalog()` alone would never see them. Plural
 * forms arrive as `<id>#one` / `<id>#other`, the keys a dictionary uses.
 */
export function onMessageDefined(cb: (id: MessageId, source: string) => void): () => void {
  definedListeners.add(cb)
  return () => definedListeners.delete(cb)
}

/**
 * Declare a message and get its id back. Call at module scope, next to the English text, so the
 * source string stays readable where it's defined instead of moving to a far-away table.
 *
 * A PluralSource declares a count-dependent message: `t(id, { count })` picks the form by the active
 * locale's plural rules, so "1 error" / "2 errors" is never built from a fragment.
 *
 * Re-declaring an id with the same source is fine (hot reload, a module evaluated twice). Re-declaring
 * it with a different source is a bug (two unrelated strings collapsing onto one translation), so it
 * throws rather than silently replacing the first.
 */
export function defineMessage(id: MessageId, source: string | PluralSource): MessageId {
  if (typeof source === 'string') {
    if (PLURALS.has(id)) throw new Error(`i18n: message '${id}' redeclared without its plural forms`)
    register(id, source)
    return id
  }
  if (SOURCES.has(id)) throw new Error(`i18n: message '${id}' redeclared with plural forms`)
  register(`${id}#one`, source.one)
  register(`${id}#other`, source.other)
  PLURALS.add(id)
  return id
}

/**
 * Declare a group of messages under one prefix and get their ids back by key: the form a component
 * uses, one table at the top of the file. `defineMessages('problems', { title: 'Problems' }).title`
 * is the id 'problems.title'.
 */
export function defineMessages<K extends string>(
  prefix: string,
  sources: Readonly<Record<K, string | PluralSource>>,
): Readonly<Record<K, MessageId>> {
  const ids = {} as Record<K, MessageId>
  for (const key of Object.keys(sources) as K[]) ids[key] = defineMessage(`${prefix}.${key}`, sources[key])
  return ids
}

function lookup(id: MessageId): string | undefined {
  return active?.get(id) ?? SOURCES.get(id)
}

/** A malformed tag throws in Intl, and a bad locale setting must not take every plural message down. */
function newPluralRules(tag: string): Intl.PluralRules {
  try {
    return new Intl.PluralRules(tag)
  } catch {
    return new Intl.PluralRules('en')
  }
}

function pluralForm(id: MessageId, count: number): string {
  pluralRules ??= newPluralRules(activeTag)
  const category = pluralRules.select(count)
  // the locale's own category, then its 'other', then the English forms
  return active?.get(`${id}#${category}`) ?? active?.get(`${id}#other`) ?? SOURCES.get(`${id}#${category}`) ?? SOURCES.get(`${id}#other`) ?? id
}

/**
 * Resolve a message for display. `params` fills `{name}` placeholders - a placeholder is the only way
 * to put a runtime value in a string, because concatenating fragments assumes English word order.
 * A plural message reads its form from `params.count`.
 *
 * An unresolved id returns the id itself rather than throwing: a missing string should look wrong in
 * the UI, not take the editor down.
 */
export function t(id: MessageId, params?: Readonly<Record<string, string | number>>): string {
  const raw = PLURALS.has(id) ? pluralForm(id, Number(params?.count ?? 0)) : (lookup(id) ?? id)
  if (!params) return raw
  return raw.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const v = params[key]
    return v === undefined ? whole : String(v)
  })
}

/**
 * Resolve a message whose placeholders take values that are not strings (a React element, say): the
 * text split around them, values in place. `tParts(id, { key: <kbd>G</kbd> })` keeps the sentence in
 * one translatable string while a styled piece sits inside it. Core stays free of React because the
 * values are opaque here.
 */
export function tParts<V>(id: MessageId, params: Readonly<Record<string, V>>): (string | V)[] {
  const raw = PLURALS.has(id) ? pluralForm(id, Number(params.count ?? 0)) : (lookup(id) ?? id)
  const out: (string | V)[] = []
  let last = 0
  for (const m of raw.matchAll(/\{(\w+)\}/g)) {
    const key = m[1]!
    if (!(key in params)) continue
    if (m.index > last) out.push(raw.slice(last, m.index))
    out.push(params[key]!)
    last = m.index + m[0].length
  }
  if (last < raw.length) out.push(raw.slice(last))
  return out
}

/**
 * Install a resolved dictionary. The dictionary can come from anywhere - a locale JSON, a translation
 * service, or Chrome's on-device Translator fed by `messageCatalog()` - because this module handles
 * only the prose/identity split and does no translating itself.
 *
 * Pass `null` (or 'en') to go back to the English sources.
 *
 * Call it at boot, before React mounts: components resolve their strings while rendering, and a mounted
 * tree doesn't re-render on its own, so changing the language reloads the page. Callers that snapshot
 * resolved strings must also re-read after this, as `desktopMenuModel()` does, whose output is posted to
 * the Electron main process.
 */
export function setLocale(tag: string, dict: ReadonlyMap<MessageId, string> | null): void {
  activeTag = tag
  active = dict
  pluralRules = null
}

/** The active locale tag ('en' when no dictionary is installed). */
export function activeLocale(): string {
  return activeTag
}

/** A message's English source, whatever the locale (a search that still finds translated text by its English). */
export function messageSource(id: MessageId): string | undefined {
  return SOURCES.get(id)
}

/** Every declared message as id → English source: the extraction output, and the input a translator
 *  (human or on-device) works from. Sorted so a dump is diffable. A plural's forms are listed as
 *  `<id>#one` and `<id>#other`. */
export function messageCatalog(): ReadonlyMap<MessageId, string> {
  return new Map([...SOURCES].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}
