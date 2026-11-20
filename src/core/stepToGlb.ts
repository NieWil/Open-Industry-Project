// A tessellated STEP model (what occt-import-js returns) -> a GLB the existing model import takes.
//
// STEP is a B-rep format; the CAD kernel (editor/stepImport.worker.ts) reads it and tessellates each solid into
// triangles. Everything after that is here, in core, because it is pure arithmetic over typed arrays and both
// surfaces need the same answer: the worker in the browser, the desktop app, and the unit tests. GLB stays the
// one format the rest of the app reads: nothing downstream of this function knows the model was ever STEP.
//
// The clean-up is not optional. Measured on two conveyor machine assemblies exported from CAD (393 and 467
// solids): parts under 25 mm - screws, nuts, washers - were ~36% of the
// solids and ~40% of the triangles, and a solid per draw would have put one machine over the whole demo scene's
// draw budget. Those assemblies had only 2-3 distinct colours, so merging by colour takes one to ~3 meshes.

import { ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER, FLOAT, GlbBin, packGlb, UNSIGNED_INT, UNSIGNED_SHORT } from './glbPack'

/** One tessellated solid, as occt-import-js hands it over (only the fields this reads). */
export interface StepMesh {
  name?: string
  color?: [number, number, number]
  attributes: { position: { array: ArrayLike<number> }; normal?: { array: ArrayLike<number> } }
  index: { array: ArrayLike<number> }
}

export type StepUpAxis = 'z' | 'y'

export interface StepToGlbOptions {
  /** drop solids whose bounding-box diagonal is under this, in millimetres (0 keeps everything) */
  minPartMm: number
  /** one mesh per distinct colour instead of one per solid; far fewer draws, but no per-solid node names */
  mergeByColour: boolean
  /** which of the file's axes points up. STEP does not say; stepUpAxisGuess reads a likely answer off the header */
  upAxis: StepUpAxis
}

export const DEFAULT_STEP_OPTIONS: StepToGlbOptions = { minPartMm: 10, mergeByColour: true, upAxis: 'z' }

export interface StepUpAxisGuess {
  up: StepUpAxis
  /** the program the header names (originating system, else preprocessor), or null without a readable header */
  system: string | null
  /** false when that program is not one whose default is known: `up` is then only the Z-up default */
  known: boolean
}

// A STEP file stores coordinates and no up axis: what is "up" is whichever axis the engineer drew the model
// along, and that follows their CAD program's default. So the header's FILE_NAME record, which names the exporting
// program, is the best evidence there is - a likely answer, not a fact, which is why the import offers it as a
// preselected choice. A file passed through a converter names the converter, and then nothing is known.
const UP_BY_SYSTEM: [RegExp, StepUpAxis][] = [
  [/solid\s*works|swstep/i, 'y'],
  [/inventor/i, 'y'],
  [/catia|3dexperience|\bnx\b|unigraphics|creo|pro\s*\/?\s*engineer|solid\s*edge|onshape|freecad|autocad/i, 'z'],
]

/** The likely up axis of a STEP file, from the start of its text (the header is in the first few KB). */
export function stepUpAxisGuess(headerText: string): StepUpAxisGuess {
  const fields = fileNameFields(headerText)
  // FILE_NAME(name, time_stamp, (author), (organization), preprocessor_version, originating_system, authorization)
  const candidates = [fields?.[5], fields?.[4]].filter((s): s is string => !!s && s.trim() !== '')
  for (const s of candidates)
    for (const [re, up] of UP_BY_SYSTEM) if (re.test(s)) return { up, system: s.trim(), known: true }
  return { up: 'z', system: candidates[0]?.trim() ?? null, known: false }
}

/** FILE_NAME's top-level arguments, each a string (a list argument joined), or null when there is none. */
function fileNameFields(text: string): string[] | null {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '')
  const at = src.search(/FILE_NAME\s*\(/i)
  if (at < 0) return null
  const fields: string[] = []
  let cur = ''
  let depth = 0
  for (let i = src.indexOf('(', at); i < src.length; i++) {
    const c = src[i]!
    if (c === "'") {
      // a STEP string; '' inside it is an escaped quote
      let j = i + 1
      for (; j < src.length; j++) {
        if (src[j] === "'") {
          if (src[j + 1] === "'") j++
          else break
        }
      }
      cur += src.slice(i + 1, j).replace(/''/g, "'")
      i = j
    } else if (c === '(') depth++
    else if (c === ')') {
      if (--depth === 0) {
        fields.push(cur)
        return fields
      }
    } else if (c === ',' && depth === 1) {
      fields.push(cur)
      cur = ''
    }
  }
  return null
}

export interface StepToGlbStats {
  solids: number
  /** solids dropped as smaller than `minPartMm` */
  skipped: number
  /** meshes in the GLB */
  meshes: number
  triangles: number
  /** the model's extent in metres, glTF axes (Y up) */
  size: [number, number, number]
}

/** colour of a solid that carries none: a neutral machined grey */
const DEFAULT_COLOUR: [number, number, number] = [0.7, 0.7, 0.72]

interface Piece {
  name: string
  colour: [number, number, number]
  pos: Float32Array
  nrm: Float32Array | null
  idx: ArrayLike<number>
}

/**
 * `meshes` are in metres with the file's own axes, up being `options.upAxis`: the worker asks the kernel for `linearUnit: 'meter'`, which
 * converts from whatever unit the file declares. The GLB is glTF's axes (Y up), sits on Y = 0 and is centred in
 * X and Z, so it sits on the node's origin the way a catalog part does rather than wherever the CAD origin was
 * (often metres away on a sub-assembly cut out of a plant model).
 */
export function stepToGlb(meshes: readonly StepMesh[], options: StepToGlbOptions = DEFAULT_STEP_OPTIONS): { glb: Uint8Array; stats: StepToGlbStats } {
  const minDiag = options.minPartMm / 1000
  // Z-up -> Y-up: (x, y, z) -> (x, z, -y), a -90 degree turn about X (a rotation, so handedness is kept).
  // A Y-up file is already in glTF's axes.
  const zUp = options.upAxis !== 'y'
  const pieces: Piece[] = []
  let skipped = 0
  for (const m of meshes) {
    const src = m.attributes.position.array
    if (src.length < 9 || m.index.array.length < 3) continue
    const pos = new Float32Array(src.length)
    const lo = [Infinity, Infinity, Infinity]
    const hi = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < src.length; i += 3) {
      pos[i] = src[i]!
      pos[i + 1] = zUp ? src[i + 2]! : src[i + 1]!
      pos[i + 2] = zUp ? -src[i + 1]! : src[i + 2]!
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k]!, pos[i + k]!)
        hi[k] = Math.max(hi[k]!, pos[i + k]!)
      }
    }
    if (Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) < minDiag) {
      skipped++
      continue
    }
    let nrm: Float32Array | null = null
    const ns = m.attributes.normal?.array
    if (ns && ns.length === src.length) {
      nrm = new Float32Array(ns.length)
      for (let i = 0; i < ns.length; i += 3) {
        nrm[i] = ns[i]!
        nrm[i + 1] = zUp ? ns[i + 2]! : ns[i + 1]!
        nrm[i + 2] = zUp ? -ns[i + 1]! : ns[i + 2]!
      }
    }
    const colour: [number, number, number] = m.color ? [m.color[0], m.color[1], m.color[2]] : DEFAULT_COLOUR
    pieces.push({ name: m.name?.trim() || 'solid', colour, pos, nrm, idx: m.index.array })
  }

  // where the kept model sits: centre X/Z on the origin, base on Y = 0
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (const p of pieces)
    for (let i = 0; i < p.pos.length; i += 3)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k]!, p.pos[i + k]!)
        hi[k] = Math.max(hi[k]!, p.pos[i + k]!)
      }
  const shift = pieces.length ? [-(lo[0]! + hi[0]!) / 2, -lo[1]!, -(lo[2]! + hi[2]!) / 2] : [0, 0, 0]
  for (const p of pieces)
    for (let i = 0; i < p.pos.length; i += 3) {
      p.pos[i] = p.pos[i]! + shift[0]!
      p.pos[i + 1] = p.pos[i + 1]! + shift[1]!
      p.pos[i + 2] = p.pos[i + 2]! + shift[2]!
    }

  const groups = options.mergeByColour ? mergeByColour(pieces) : pieces
  const glb = writeGlb(groups)
  const size: [number, number, number] = pieces.length ? [hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!] : [0, 0, 0]
  let triangles = 0
  for (const g of groups) triangles += g.idx.length / 3
  return { glb, stats: { solids: meshes.length, skipped, meshes: groups.length, triangles, size } }
}

/** colours closer than this (per channel, 0..1) are the same paint: CAD exports jitter the last digit */
const COLOUR_STEP = 1 / 64

function mergeByColour(pieces: Piece[]): Piece[] {
  const byKey = new Map<string, Piece[]>()
  for (const p of pieces) {
    const key = p.colour.map((c) => Math.round(c / COLOUR_STEP)).join(',')
    const list = byKey.get(key)
    if (list) list.push(p)
    else byKey.set(key, [p])
  }
  const out: Piece[] = []
  let n = 0
  for (const list of byKey.values()) {
    let verts = 0
    let indices = 0
    for (const p of list) {
      verts += p.pos.length
      indices += p.idx.length
    }
    const pos = new Float32Array(verts)
    // a merged mesh keeps normals only if every piece had them; the renderer would otherwise mix lit and unlit
    const nrm = list.every((p) => p.nrm) ? new Float32Array(verts) : null
    const idx = new Uint32Array(indices)
    let v = 0
    let i = 0
    for (const p of list) {
      pos.set(p.pos, v)
      if (nrm) nrm.set(p.nrm!, v)
      const base = v / 3
      for (let k = 0; k < p.idx.length; k++) idx[i + k] = p.idx[k]! + base
      v += p.pos.length
      i += p.idx.length
    }
    out.push({ name: `colour-${++n}`, colour: list[0]!.colour, pos, nrm, idx })
  }
  return out
}

/** One node + mesh + material per piece, all in one binary buffer. */
function writeGlb(pieces: Piece[]): Uint8Array {
  const bin = new GlbBin()
  const accessors: object[] = []
  const materials: object[] = []
  const meshes: object[] = []
  const nodes: object[] = []
  for (const p of pieces) {
    const count = p.pos.length / 3
    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < p.pos.length; i += 3)
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k]!, p.pos[i + k]!)
        max[k] = Math.max(max[k]!, p.pos[i + k]!)
      }
    const posView = bin.push(new Uint8Array(p.pos.buffer, p.pos.byteOffset, p.pos.byteLength), ARRAY_BUFFER)
    const attributes: Record<string, number> = { POSITION: accessors.length }
    accessors.push({ bufferView: posView, componentType: FLOAT, count, type: 'VEC3', min, max })
    if (p.nrm) {
      attributes.NORMAL = accessors.length
      accessors.push({ bufferView: bin.push(new Uint8Array(p.nrm.buffer, p.nrm.byteOffset, p.nrm.byteLength), ARRAY_BUFFER), componentType: FLOAT, count, type: 'VEC3' })
    }
    // 16-bit indices when they fit: half the index bytes on most single solids
    const small = count <= 0xffff
    const idx = small ? Uint16Array.from(p.idx) : p.idx instanceof Uint32Array ? p.idx : Uint32Array.from(p.idx)
    const idxView = bin.push(new Uint8Array(idx.buffer, idx.byteOffset, idx.byteLength), ELEMENT_ARRAY_BUFFER)
    const indices = accessors.length
    accessors.push({ bufferView: idxView, componentType: small ? UNSIGNED_SHORT : UNSIGNED_INT, count: idx.length, type: 'SCALAR' })
    materials.push({ name: p.name, pbrMetallicRoughness: { baseColorFactor: [...p.colour, 1], metallicFactor: 0, roughnessFactor: 0.6 } })
    meshes.push({ name: p.name, primitives: [{ attributes, indices, material: materials.length - 1 }] })
    nodes.push({ name: p.name, mesh: meshes.length - 1 })
  }
  const gltf = {
    asset: { version: '2.0', generator: 'oip-web STEP import' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    materials,
    accessors,
  }
  return packGlb(gltf, bin)
}
