// A scene program written wholly inside `PROGRAM X … END_PROGRAM` - the form a PLC exports and most ST tutorials teach.
// A PROGRAM type runs as an instance (the default controller makes one per type, named after it), and an instance's
// variables are `<instance>.<variable>` (`Main.Extend`). Our binding rule (plc/link/plcLink.ts soleInstanceAliases): when
// the controller runs exactly one program instance, its variables are also the bare scene tags (`Extend`), so a part
// wired to either spelling is connected. With two or more PROGRAMs and no code outside them, no bare name is given
// (which program's `Extend` would it be?), and the program still loads, validates and runs while a part wired to
// `Extend` never sees it - which is what the warning below is for.

import { parseStructure } from './structure'

/** The PROGRAM types a scene program consists entirely of (no code or variables outside them, no CONFIGURATION),
 *  each with its variable names. Empty when the program has top-level code, or doesn't parse (a parse error is
 *  another tool's report). */
export function wrappedPrograms(source: string): { type: string; vars: string[] }[] {
  const { ast } = parseStructure(source)
  if (!ast || ast.configuration || ast.programDefs.length === 0) return []
  if (ast.decls.length > 0 || ast.body.length > 0) return []
  return ast.programDefs.map((p) => ({ type: p.name, vars: p.decls.map((d) => d.name) }))
}

/**
 * The warning both CLIs print, or null. `sceneTagRefs` are the tag names the scene's parts are wired to; a scene
 * that already refers to `Main.<variable>` meant the qualified names, so it is left alone. One wrapped PROGRAM needs
 * no warning: its variables answer to their bare names too.
 */
export function wrappedProgramWarning(scene: string, source: string, sceneTagRefs: readonly string[]): string | null {
  const wrapped = wrappedPrograms(source)
  if (wrapped.length < 2) return null
  const refs = sceneTagRefs.map((t) => t.toUpperCase())
  const qualifiedInUse = wrapped.some((w) => refs.some((r) => r.startsWith(`${w.type.toUpperCase()}.`)))
  if (qualifiedInUse) return null
  const first = wrapped[0]!
  const example = first.vars[0] ?? 'Variable'
  return (
    `scene "${scene}": the whole program is inside PROGRAMs ${wrapped.map((w) => w.type).join(', ')}, so its ` +
    `variables are scene tags named "${first.type}.${example}", not "${example}" - only a program that runs as ONE ` +
    `instance answers to bare names, and a part whose tag says "${example}" never sees it. Wire the parts to ` +
    `"${first.type}.<variable>", or put the code that owns the scene's I/O outside every PROGRAM (bare VAR_INPUT / ` +
    `VAR_OUTPUT blocks and statements).`
  )
}
