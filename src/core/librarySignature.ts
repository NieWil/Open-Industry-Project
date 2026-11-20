// The project's signature on a part library's index (docs/part-libraries.md, "Publisher identity"). One key, the
// project's, signs every index the project publishes: its own libraries and the listed library built from the parts
// repository. The index names each part file by its SHA-256, and a part file holds its models and textures, so the
// signature covers every byte a listed part brings.
//
// What is signed is the index without its `signature` field, in canonical JSON (keys sorted, no spaces), so the
// signature does not depend on how the file was formatted. Ed25519, verified with Web Crypto (browsers, the worker,
// node). The public keys are part of the build (librarySigningKeys.ts); the private key exists only in CI secrets.

import { LIBRARY_SIGNING_KEYS } from './librarySigningKeys'
import { base64ToBytes } from './parts/partAssets'

/** An index's signature: which key signed it, and the signature over its canonical JSON. */
export interface LibrarySignature {
  /** the key's id: the first 16 hex digits of the SHA-256 of its raw public key */
  key: string
  /** Ed25519 signature, base64 */
  sig: string
}

/** A public key the build trusts. */
export interface LibrarySigningKey {
  id: string
  /** the raw 32-byte Ed25519 public key, base64 */
  publicKey: string
}

/** JSON with every object's keys sorted and no whitespace: one text for one value, however it was formatted. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
}

/** The bytes an index's signature covers: the index without `signature`, canonical. */
export function signedBytes(index: Record<string, unknown>): Uint8Array {
  const { signature: _signature, ...rest } = index
  return new TextEncoder().encode(canonicalJson(rest))
}

export type SignatureCheck = 'signed' | 'unsigned' | 'unknownKey' | 'invalid'

/**
 * Check an index's signature against `keys`. 'unsigned' when it carries none. 'unknownKey' when a key this build does
 * not have signed it: a build made before a new key was added, which a reader takes as unsigned, so an installed app
 * still reads the project's libraries after a key is added (oip-web's CI fails on it instead, scripts/library-corpus.mjs).
 * 'invalid' when a key this build trusts did not sign these bytes (a changed file, or a runtime without Ed25519), which a
 * reader must refuse rather than read as unsigned.
 */
export async function checkLibrarySignature(
  index: Record<string, unknown>,
  keys: readonly LibrarySigningKey[] = LIBRARY_SIGNING_KEYS,
  subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle,
): Promise<SignatureCheck> {
  const s = index.signature
  if (s === undefined) return 'unsigned'
  if (typeof s !== 'object' || s === null) return 'invalid'
  const { key, sig } = s as Partial<LibrarySignature>
  const trusted = keys.find((k) => k.id === key)
  const sigBytes = typeof sig === 'string' ? base64ToBytes(sig) : null
  const pub = trusted ? base64ToBytes(trusted.publicKey) : null
  if (typeof key === 'string' && !trusted) return 'unknownKey'
  if (!trusted || !sigBytes || !pub || !subtle) return 'invalid'
  try {
    const cryptoKey = await subtle.importKey('raw', pub as Uint8Array<ArrayBuffer>, { name: 'Ed25519' }, false, ['verify'])
    const ok = await subtle.verify({ name: 'Ed25519' }, cryptoKey, sigBytes as Uint8Array<ArrayBuffer>, signedBytes(index) as Uint8Array<ArrayBuffer>)
    return ok ? 'signed' : 'invalid'
  } catch {
    return 'invalid'
  }
}
