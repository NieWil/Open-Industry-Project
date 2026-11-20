// Read a GLB's node + material names straight from its JSON chunk, so the Inspector can list them instead of
// an author scripting a walk of the model. A whole imported GLB is otherwise opaque: to split it into
// articulated rig links you need its node names, and to recolour it you need its material names (and to know
// which ones ship fully-metallic, which render dark with no scene envMap). This parses the GLB container (12-byte header + a JSON chunk) - pure, no three.js/DOM beyond atob - so it runs in
// the editor without loading the model into the renderer.

export interface GlbMaterialInfo {
  name: string
  /** glTF metallicFactor (defaults to 1). High + untextured renders near-black without a scene envMap. */
  metalness: number
  /** does the material carry a base-color texture? (a textured metal still shows its albedo) */
  textured: boolean
  /** does a metallic-roughness texture set its metalness? metallicFactor then only scales the texture's values */
  metalnessTextured: boolean
}

export interface GlbContents {
  /** named nodes (a mesh link can ref one via shape.node to take just that node's geometry) */
  nodes: string[]
  /** materials by name (remap each via shape.materials → a package material id) */
  materials: GlbMaterialInfo[]
}

type Pbr = { metallicFactor?: number; baseColorTexture?: unknown; metallicRoughnessTexture?: unknown }

/** Decode a base64 string (no `data:` prefix) to bytes. Uses the platform atob (browser + node). */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Parse a GLB's first (JSON) chunk and pull node + material names. Returns empty arrays on anything that isn't
 * a well-formed GLB (a non-binary glTF, a truncated file) rather than throwing - the panel just shows nothing.
 */
export function inspectGlb(dataBase64: string): GlbContents {
  try {
    const bytes = b64ToBytes(dataBase64)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    // GLB header: magic 'glTF' (0x46546C67), version, total length; then chunk[0] = length, type 'JSON', data.
    if (view.getUint32(0, true) !== 0x46546c67) return { nodes: [], materials: [] }
    const jsonLen = view.getUint32(12, true)
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen))) as {
      nodes?: { name?: string }[]
      materials?: { name?: string; pbrMetallicRoughness?: Pbr }[]
    }
    const nodes = (json.nodes ?? []).map((n) => n.name).filter((n): n is string => typeof n === 'string' && n !== '')
    const materials = (json.materials ?? [])
      .filter((m): m is { name: string; pbrMetallicRoughness?: Pbr } => typeof m.name === 'string' && m.name !== '')
      .map((m) => ({
        name: m.name,
        metalness: m.pbrMetallicRoughness?.metallicFactor ?? 1,
        textured: m.pbrMetallicRoughness?.baseColorTexture != null,
        metalnessTextured: m.pbrMetallicRoughness?.metallicRoughnessTexture != null,
      }))
    return { nodes, materials }
  } catch {
    return { nodes: [], materials: [] }
  }
}
