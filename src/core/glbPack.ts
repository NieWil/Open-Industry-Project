// The binary half of a GLB writer: a buffer that views are appended to, and the container that wraps it with the
// glTF JSON. The model importers (stepToGlb, usdToGlb) each build their own JSON and share this.

export const ARRAY_BUFFER = 34962
export const ELEMENT_ARRAY_BUFFER = 34963
export const FLOAT = 5126
export const UNSIGNED_SHORT = 5123
export const UNSIGNED_INT = 5125

/** The one binary buffer of a GLB, and its bufferViews. */
export class GlbBin {
  readonly chunks: Uint8Array[] = []
  readonly bufferViews: object[] = []
  length = 0

  /** Append `bytes` as a new bufferView and return its index. `target` is left out for image data. */
  push(bytes: Uint8Array, target?: number): number {
    // every view starts 4-byte aligned (glTF requires it for FLOAT and UNSIGNED_INT data)
    const pad = (4 - (this.length % 4)) % 4
    if (pad) {
      this.chunks.push(new Uint8Array(pad))
      this.length += pad
    }
    this.bufferViews.push({ buffer: 0, byteOffset: this.length, byteLength: bytes.length, ...(target ? { target } : {}) })
    this.chunks.push(bytes)
    this.length += bytes.length
    return this.bufferViews.length - 1
  }
}

/** The bytes of a typed array, as a view (no copy). */
export const bytesOf = (a: ArrayBufferView): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength)

/** Wrap `gltf` (without bufferViews / buffers, which `bin` supplies) and `bin` into a GLB. */
export function packGlb(gltf: object, bin: GlbBin): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify({ ...gltf, bufferViews: bin.bufferViews, buffers: [{ byteLength: bin.length }] }))
  const jsonLength = Math.ceil(json.length / 4) * 4
  const binPadded = Math.ceil(bin.length / 4) * 4
  const total = 12 + 8 + jsonLength + 8 + binPadded
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x46546c67, true) // 'glTF'
  view.setUint32(4, 2, true)
  view.setUint32(8, total, true)
  view.setUint32(12, jsonLength, true)
  view.setUint32(16, 0x4e4f534a, true) // 'JSON'
  out.set(json, 20)
  out.fill(0x20, 20 + json.length, 20 + jsonLength) // JSON pads with spaces
  let at = 20 + jsonLength
  view.setUint32(at, binPadded, true)
  view.setUint32(at + 4, 0x004e4942, true) // 'BIN\0'
  at += 8
  for (const c of bin.chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}
