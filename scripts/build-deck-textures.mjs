// Generates the walking-surface textures of the `'tread'` and `'deck'` finishes (src/render/parts/common.ts):
//
//   public/textures/TreadPlate.webp        steel tread plate, albedo (finish 'tread': stairs, access platforms)
//   public/textures/TreadPlateNormal.webp  its raised lugs, tangent-space normal map
//   public/textures/DeckSolidNormal.webp   relief for the solid deck (finish 'deck'), under BuildingFloor.webp
//   public/textures/BuildingFloor.webp     the solid deck's concrete, albedo
//
// and the building's floor slab, public/models/building/textures/BuildingPart_Floor_A_BaseColor.webp, with the
// cloud laid over it, BuildingPart_FloorMacro_BaseColor.webp beside it
//
// Run: node scripts/build-deck-textures.mjs [--preview <dir>]
//
// Every texel is computed here, from seeded noise and the lug geometry below, so these textures have no source
// but this script (THIRD_PARTY_NOTICES.md "3D models, textures and other media").
//
// One image tile is 0.5 m of surface: the deck finishes tile DECK_TILES_PER_M = 2 times per metre. Everything here
// is PERIODIC over the tile (the lug lattice has a whole, even number of cells across it; the noise wraps), so
// the seams never show. Normal maps follow the loader's flipY = false: image rows run along +V, so green is the
// slope along increasing row, not its inverse.
import sharp from 'sharp'
import { mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'

const OUT = join(import.meta.dirname, '..', 'public', 'textures')
const TILE_M = 0.5 // metres of surface one image covers
const previewAt = process.argv.indexOf('--preview')
const PREVIEW = previewAt > 0 ? process.argv[previewAt + 1] : null

// ---------------------------------------------------------------- seeded noise

let seed = 0x7ead9a7e
function rand() {
  // mulberry32
  seed = (seed + 0x6d2b79f5) | 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** Value noise on a `cells` x `cellsV` lattice that wraps, sampled at u, v in 0..1 (periodic over the tile). */
function periodicNoise(cells, cellsV = cells) {
  const g = new Float32Array(cells * cellsV).map(() => rand() * 2 - 1)
  const at = (i, j) => g[(((j % cellsV) + cellsV) % cellsV) * cells + (((i % cells) + cells) % cells)]
  const fade = (t) => t * t * (3 - 2 * t)
  return (u, v) => {
    const x = u * cells
    const y = v * cellsV
    const i = Math.floor(x)
    const j = Math.floor(y)
    const fx = fade(x - i)
    const fy = fade(y - j)
    const a = at(i, j) + (at(i + 1, j) - at(i, j)) * fx
    const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * fx
    return a + (b - a) * fy
  }
}

/** Fractal sum of periodic octaves, `base` cells at the coarsest; roughly -1..1. */
function fbm(base, octaves, gain = 0.5) {
  const layers = []
  for (let o = 0; o < octaves; o++) layers.push({ n: periodicNoise(base << o), amp: gain ** o })
  const norm = layers.reduce((s, l) => s + l.amp, 0)
  return (u, v) => layers.reduce((s, l) => s + l.n(u, v) * l.amp, 0) / norm
}

// ---------------------------------------------------------------- height -> normal map

/** Tangent-space normal map from a periodic height field in METRES (central differences, wrapped). */
function normalMapFrom(height, size) {
  const px = TILE_M / size // metres per texel
  const out = Buffer.alloc(size * size * 3)
  const h = (x, y) => height[((y + size) % size) * size + ((x + size) % size)]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) / (2 * px)
      const dy = (h(x, y + 1) - h(x, y - 1)) / (2 * px)
      const len = Math.hypot(dx, dy, 1)
      const o = (y * size + x) * 3
      out[o] = Math.round(((-dx / len) * 0.5 + 0.5) * 255)
      out[o + 1] = Math.round(((-dy / len) * 0.5 + 0.5) * 255)
      out[o + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255)
    }
  }
  return out
}

/** Separable box blur of radius `r` texels over a periodic field (two passes, so close to a tent). */
function blurWrapped(src, size, r) {
  let a = src
  for (let pass = 0; pass < 2; pass++) {
    const h = new Float32Array(size * size)
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      let s = 0
      for (let k = -r; k <= r; k++) s += a[y * size + ((x + k + size) % size)]
      h[y * size + x] = s / (2 * r + 1)
    }
    const v = new Float32Array(size * size)
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      let s = 0
      for (let k = -r; k <= r; k++) s += h[((y + k + size) % size) * size + x]
      v[y * size + x] = s / (2 * r + 1)
    }
    a = v
  }
  return a
}

const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)))

// ---------------------------------------------------------------- tread plate

// Raised lugs on a square lattice, each one turned a quarter turn from its four neighbours: the familiar
// alternating pattern of steel tread plate. 12 cells across the 0.5 m tile = a 42 mm pitch (real plate runs
// about 30-45 mm; the coarse end, so the pattern still reads at the distance a scene is viewed from); even, so
// the alternation wraps too. Each lug is a lens (widest at its middle, tapering to points) with a rounded crown.
const TREAD_SIZE = 512
const CELLS = 12
const LUG_LEN = 0.74 // of the pitch, tip to tip
const LUG_WID = 0.24 // of the pitch, at the middle
const LUG_H = 0.0018 // crown height, metres

function treadPlate() {
  const size = TREAD_SIZE
  const pitch = size / CELLS
  const halfL = (LUG_LEN * pitch) / 2
  const halfW = (LUG_WID * pitch) / 2
  const height = new Float32Array(size * size)
  const lugMask = new Float32Array(size * size) // 0..1 crown, for the albedo's wear
  const SS = 3 // supersamples per axis, so a lug's flank is not a staircase in the normal map
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hSum = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS
          const fy = y + (sy + 0.5) / SS
          const i = Math.floor(fx / pitch)
          const j = Math.floor(fy / pitch)
          let best = 0
          // the lug of this cell and its neighbours (a tip can reach across a cell edge)
          for (let dj = -1; dj <= 1; dj++) {
            for (let di = -1; di <= 1; di++) {
              const ci = i + di
              const cj = j + dj
              const cx = (ci + 0.5) * pitch
              const cy = (cj + 0.5) * pitch
              const s = ((ci + cj) & 1) === 0 ? 1 : -1 // alternate the diagonal: +45 / -45 degrees
              const rx = fx - cx
              const ry = fy - cy
              const along = (rx + s * ry) * Math.SQRT1_2
              const across = (-s * rx + ry) * Math.SQRT1_2
              const t = along / halfL
              if (t <= -1 || t >= 1) continue
              const w = halfW * Math.pow(1 - t * t, 0.55)
              const a = Math.abs(across) / w
              if (a >= 1) continue
              const crown = Math.sqrt(1 - a * a) // rounded section
              const hh = crown * Math.min(1, (1 - Math.abs(t)) * 4) // ramp the tips down
              if (hh > best) best = hh
            }
          }
          hSum += best
        }
      }
      const v = hSum / (SS * SS)
      height[y * size + x] = v * LUG_H
      lugMask[y * size + x] = v
    }
  }

  // albedo: mill-finish steel, faintly mottled (faintly: anything broad repeats visibly every half metre), the lug crowns worn brighter, the floor beside each lug a
  // touch darker where grime sits. Linear-ish values in 0..255 sRGB; the material does not tint it further.
  const mottle = fbm(4, 4)
  const grain = fbm(64, 3)
  // grime gathers round each lug's foot: the lug mask blurred (wrapped), less the lug itself
  const near = blurWrapped(lugMask, size, 4)
  const albedo = Buffer.alloc(size * size * 3)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size
      const v = (y + 0.5) / size
      const m = lugMask[y * size + x]
      const grime = Math.max(0, near[y * size + x] * 1.6 - m) * 22
      const base = 132 + mottle(u, v) * 5 + grain(u, v) * 7 - grime + m * m * 48
      albedo[(y * size + x) * 3] = clamp255(base * 0.985)
      albedo[(y * size + x) * 3 + 1] = clamp255(base * 0.995)
      albedo[(y * size + x) * 3 + 2] = clamp255(base * 1.02)
    }
  }
  return { albedo, normal: normalMapFrom(height, size), size }
}

// ---------------------------------------------------------------- solid deck relief

// A finished slab's surface: a gentle broad undulation, a fine trowelled grain, and sparse shallow pits. Small
// heights: it should catch a grazing light, not read as rough stone.
const SOLID_SIZE = 512

function solidDeck() {
  const size = SOLID_SIZE
  const broad = fbm(3, 3)
  const fine = fbm(48, 3, 0.55)
  // trowel marks: noise stretched along U, its lookup bent by a broad noise (a periodic offset keeps the wrap)
  const bend = fbm(2, 2)
  const streak = periodicNoise(12, 160)
  const height = new Float32Array(size * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size
      const v = (y + 0.5) / size
      const trowel = streak(u, (((v + bend(u, v) * 0.06) % 1) + 1) % 1)
      height[y * size + x] = broad(u, v) * 0.0004 + fine(u, v) * 0.00012 + trowel * 0.00005
    }
  }
  // pits: small round dimples, wrapped across the tile edge
  const PITS = 140
  for (let p = 0; p < PITS; p++) {
    const px = rand() * size
    const py = rand() * size
    const r = 1.2 + rand() * 2.6 // texels (~1-3 mm)
    const depth = 0.00025 + rand() * 0.00035
    const R = Math.ceil(r) + 1
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const d = Math.hypot(dx + (px % 1) - 0.5, dy + (py % 1) - 0.5) / r
        if (d >= 1) continue
        const xx = (Math.floor(px) + dx + size) % size
        const yy = (Math.floor(py) + dy + size) % size
        height[yy * size + xx] -= depth * (1 - d * d)
      }
    }
  }
  return { normal: normalMapFrom(height, size), size }
}

// ---------------------------------------------------------------- write

async function write(name, raw, size, opts) {
  const img = sharp(raw, { raw: { width: size, height: size, channels: 3 } })
  await img.clone().webp(opts).toFile(join(OUT, name))
  if (PREVIEW) {
    mkdirSync(PREVIEW, { recursive: true })
    await img.clone().png().toFile(join(PREVIEW, basename(name).replace(/\.webp$/, '.png')))
  }
  console.log(`wrote ${name}`)
}

const tread = treadPlate()
await write('TreadPlate.webp', tread.albedo, tread.size, { quality: 90 })
// normal maps lossless: lossy webp blocks show up as facets the moment light grazes the surface
await write('TreadPlateNormal.webp', tread.normal, tread.size, { lossless: true })
const solid = solidDeck()
await write('DeckSolidNormal.webp', solid.normal, solid.size, { lossless: true })

// ---------------------------------------------------------------- concrete: the building floor and the deck
//
// One concrete field, drawn with two mixes of its noise layers:
//
//   - the 'deck' finish (public/textures/BuildingFloor.webp, render/parts/common.ts): one image per 0.5 m, so 512
//     square is already ~1 mm a texel. Pale, and tinted by DECK_TINT.
//   - the warehouse slab (render/parts/building.ts, material `Floor_01`): one image per 10 m cell, so a texel is
//     ~1 cm. 1024 square: 2048 looked no different from where a scene is edited and cost 4x the GPU memory
//     (~22 MB with mips, for a surface whose whole spread is a few sRGB steps); 512 reads soft at walking eye
//     height. Mostly fine grain (SLAB_MIX): weighted to the ~25 cm blotches as the deck is, the slab read as felt
//     or stucco, and anything broad inside the tile repeats every 10 m as a visible grid. The material tints it
//     (FLOOR_TINT). Its broad clouds come from FloorMacro instead.
//
// The field: broad mottling, finer blotches, a grain, sparse light scratches and a few dark pits, normalised so
// each surface sets only its mean and spread. Generated AFTER the deck textures above: they share the seeded
// stream, and this order keeps their bytes unchanged.
const CONCRETE_SIZE = 1024
const FLOOR_MEAN = [95, 93, 89] // sRGB, faintly warm
const DECK_CONCRETE_SIZE = 512
const DECK_CONCRETE_MEAN = [230, 224, 214]
const DECK_CONCRETE_SPREAD = 10

const SLAB_MIX = { broad: 0.1, blotch: 0.3, grain: 0.8 }
const SLAB_SPREAD = 3.5 // standard deviation of the luminance, sRGB steps
// FloorMacro: one channel of cloud, periodic, linear. The shader samples it twice at two periods that share no
// common repeat and multiplies 2x each sample, so 128 is neutral, and so is the loader's #808080 fallback.
const MACRO_SIZE = 256
const MACRO_SPREAD = 6 // standard deviation, 8-bit steps around 128

/** The concrete field, CONCRETE_SIZE square, periodic, as standard scores (mean 0, deviation 1). `mix` weighs
 *  its three noise layers. */
function concreteField(mix = { broad: 0.3, blotch: 0.75, grain: 0.45 }) {
  const size = CONCRETE_SIZE
  const broad = fbm(4, 3)
  const blotch = fbm(40, 3, 0.65)
  const grain = fbm(160, 2, 0.7)
  const field = new Float32Array(size * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size
      const v = (y + 0.5) / size
      field[y * size + x] = broad(u, v) * mix.broad + blotch(u, v) * mix.blotch + grain(u, v) * mix.grain
    }
  }
  // a mark is laid down as a soft dot every half texel along its path, wrapped across the tile edge
  const dab = (fx, fy, r, amount) => {
    const R = Math.ceil(r) + 1
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const xx = Math.floor(fx) + dx
        const yy = Math.floor(fy) + dy
        const d = Math.hypot(xx + 0.5 - fx, yy + 0.5 - fy) / r
        if (d >= 1) continue
        field[(((yy % size) + size) % size) * size + (((xx % size) + size) % size)] += amount * (1 - d * d)
      }
    }
  }
  // scratches: short, mostly along one axis (traffic runs along the aisles), lighter than the slab
  const SCRATCHES = 600
  for (let s = 0; s < SCRATCHES; s++) {
    const x0 = rand() * size
    const y0 = rand() * size
    const len = (0.15 + rand() * 0.6) * (size / 10) // 0.15-0.75 m
    const angle = (rand() < 0.7 ? 0 : Math.PI / 2) + (rand() - 0.5) * 0.5
    const amount = 0.2 + rand() * 0.3
    for (let t = 0; t < len; t += 0.5) {
      const fade = Math.sin((Math.PI * t) / len) // taper both ends
      dab(x0 + Math.cos(angle) * t, y0 + Math.sin(angle) * t, 0.9, amount * fade * 0.5)
    }
  }
  // pits: small dark dimples
  const PITS = 90
  for (let p = 0; p < PITS; p++) dab(rand() * size, rand() * size, 0.8 + rand() * 1.4, -(0.6 + rand() * 0.8))

  // normalise, so the knobs above set the CHARACTER and each surface's spread sets the contrast
  let sum = 0
  let sq = 0
  for (const f of field) {
    sum += f
    sq += f * f
  }
  const mean = sum / field.length
  const sd = Math.sqrt(sq / field.length - mean * mean)
  for (let i = 0; i < field.length; i++) field[i] = (field[i] - mean) / sd
  return field
}

/** sRGB albedo of a concrete `field` at a mean colour and a luminance spread, `size` square: a smaller size
 *  averages whole blocks of the field, which keeps the tile periodic (a resampling filter would clamp at the
 *  edges and leave a seam at every repeat) */
function concreteAlbedo(field, meanRgb, spread, size = CONCRETE_SIZE) {
  const k = CONCRETE_SIZE / size
  const albedo = Buffer.alloc(size * size * 3)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let f = 0
      for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) f += field[(y * k + j) * CONCRETE_SIZE + x * k + i]
      const d = (f / (k * k)) * spread
      for (let c = 0; c < 3; c++) albedo[(y * size + x) * 3 + c] = clamp255(meanRgb[c] + d)
    }
  }
  return albedo
}

// the 2x2 average trims the finest grain, so the deck's spread lands at ~9.7 rather than exactly 10
await write('BuildingFloor.webp', concreteAlbedo(concreteField(), DECK_CONCRETE_MEAN, DECK_CONCRETE_SPREAD, DECK_CONCRETE_SIZE), DECK_CONCRETE_SIZE, { quality: 90 })
await write(join('..', 'models', 'building', 'textures', 'BuildingPart_Floor_A_BaseColor.webp'), concreteAlbedo(concreteField(SLAB_MIX), FLOOR_MEAN, SLAB_SPREAD), CONCRETE_SIZE, { quality: 90 })

/** FloorMacro's cloud as grey 8-bit RGB, normalised to MACRO_SPREAD around 128. */
function floorMacro() {
  const size = MACRO_SIZE
  const cloud = fbm(3, 4, 0.55)
  const field = new Float32Array(size * size)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) field[y * size + x] = cloud((x + 0.5) / size, (y + 0.5) / size)
  let sum = 0
  let sq = 0
  for (const f of field) {
    sum += f
    sq += f * f
  }
  const mean = sum / field.length
  const sd = Math.sqrt(sq / field.length - mean * mean)
  const out = Buffer.alloc(size * size * 3)
  for (let i = 0; i < field.length; i++) out.fill(clamp255(128 + ((field[i] - mean) / sd) * MACRO_SPREAD), i * 3, i * 3 + 3)
  return out
}
await write(join('..', 'models', 'building', 'textures', 'BuildingPart_FloorMacro_BaseColor.webp'), floorMacro(), MACRO_SIZE, { quality: 90 })
