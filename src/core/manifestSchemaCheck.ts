// Checks a part manifest against packages/part-sdk/manifest.schema.json, the schema build-part-sdk.mjs generates
// from src/core/parts/partPackage.ts. A validator for exactly the JSON Schema subset that generator emits (type / const /
// enum / properties / required / additionalProperties / items / prefixItems / min+maxItems / if-then under allOf /
// anyOf / $ref), so neither the CLIs nor the app need a schema library.
//
// Why a structural check at all, when validatePart already validates: validatePart reads the fields it knows and
// IGNORES the rest, so a typo (`noColision: true`) validates, bakes, and silently does nothing. Unknown keys are what
// this catches. No imports: scripts/lib/manifestSchema.mjs loads this file with node's own type stripping.

export interface SchemaProblem {
  path: string
  message: string
}

type Schema = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any -- a JSON Schema document

export function checkManifestAgainst(manifest: unknown, schema: Schema): SchemaProblem[] {
  const resolveRef = (s: Schema | undefined): Schema | undefined => {
    while (s && s.$ref) s = schema.$defs[String(s.$ref).replace('#/$defs/', '')]
    return s
  }
  const typeOf = (v: unknown): string => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v)
  // returns the errors for `value` against `s` without recording them, so if/anyOf can probe branches
  const run = (raw: Schema | undefined, value: any, path: string): SchemaProblem[] => { // eslint-disable-line @typescript-eslint/no-explicit-any -- value is arbitrary JSON the schema walk narrows
    const out: SchemaProblem[] = []
    const s = resolveRef(raw)
    if (!s) return out
    if ('const' in s && value !== s.const) out.push({ path, message: `must be ${JSON.stringify(s.const)}` })
    if (s.enum && !s.enum.includes(value)) out.push({ path, message: `must be one of ${s.enum.map((e: unknown) => JSON.stringify(e)).join(', ')} (got ${JSON.stringify(value)})` })
    if (s.type && typeOf(value) !== s.type) {
      out.push({ path, message: `must be ${s.type === 'object' ? 'an object' : s.type === 'array' ? 'an array' : `a ${s.type}`} (got ${typeOf(value)})` })
      return out
    }
    if (s.type === 'number' && !Number.isFinite(value)) out.push({ path, message: 'must be a finite number' })
    if (s.type === 'array') {
      if (s.minItems !== undefined && value.length < s.minItems) out.push({ path, message: `must have ${s.minItems}${s.maxItems === s.minItems ? '' : '+'} items (got ${value.length})` })
      else if (s.maxItems !== undefined && value.length > s.maxItems) out.push({ path, message: `must have at most ${s.maxItems} items (got ${value.length})` })
      value.forEach((item: unknown, i: number) => {
        const itemSchema = s.prefixItems ? s.prefixItems[i] : s.items
        if (itemSchema) out.push(...run(itemSchema, item, `${path}[${i}]`))
      })
    }
    // keyed on the VALUE, not `s.type`: an if-schema carries `properties` with no `type`
    if (typeOf(value) === 'object' && (s.properties || s.required || 'additionalProperties' in s)) {
      for (const key of s.required ?? []) if (!(key in value)) out.push({ path, message: `is missing required "${key}"` })
      for (const [key, v] of Object.entries(value)) {
        const prop = s.properties?.[key]
        if (prop) out.push(...run(prop, v, `${path}.${key}`))
        else if (s.additionalProperties === false) {
          const known = Object.keys(s.properties ?? {})
          const near = known.find((k) => k.toLowerCase() === key.toLowerCase() || editDistance(k, key) <= 2)
          out.push({ path: `${path}.${key}`, message: `is not a known field${near ? ` (did you mean "${near}"?)` : ''} - it would be IGNORED` })
        } else if (typeof s.additionalProperties === 'object') out.push(...run(s.additionalProperties, v, `${path}.${key}`))
      }
    }
    for (const part of s.allOf ?? []) {
      if (part.if) {
        if (run(part.if, value, path).length === 0) out.push(...run(part.then, value, path))
      } else out.push(...run(part, value, path))
    }
    if (s.anyOf) {
      const tries: SchemaProblem[][] = s.anyOf.map((b: Schema) => run(b, value, path))
      if (!tries.some((t) => t.length === 0)) out.push(...tries.reduce((a, b) => (b.length < a.length ? b : a)))
    }
    return out
  }
  return run(schema, manifest, 'manifest')
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0]![j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length]![b.length]!
}
