// A PLC's variables as the PLC connections window lists them (editor/components/plc/PlcConnectionsWindow.tsx), whatever
// they come from: a TwinCAT symbol table (ads.ts adsSymbolGroups), a Logix controller's tag listing (eip.ts
// eipVariableGroups), an OPC UA browse (opcUa.ts opcUaVariableGroups) or the simulator's own program
// (editor/program/plcConnections.ts programVariableGroups). Grouped by the program or list a name sits in.

/** One variable a part's tag field can be wired to. */
export interface PlcVariable {
  /** the full name a tag field takes (`MAIN.Extend`, `Program:MainProgram.Eye`) */
  name: string
  /** the name inside its group */
  short: string
  /** the type as the PLC names it, '' when the source does not say (an OPC UA browse) */
  typeName: string
  /** a single bit or a number, null when the source does not say */
  kind: 'bool' | 'number' | null
  /** the simulator's own program only: the variable is the program's input or output */
  dir?: 'in' | 'out'
}

/** The variables of one program or list. `name` is '' for the controller's own variables outside any program. */
export interface PlcVariableGroup {
  name: string
  variables: PlcVariable[]
}

/** Whether a variable can be wired to a tag field of `stType`: a bit to a BOOL field, a number to a numeric one. Unknown on either side fits. */
export function variableFits(v: Pick<PlcVariable, 'kind'>, stType: 'BOOL' | 'INT' | 'DINT' | 'REAL' | null): boolean {
  return stType === null || v.kind === null || (stType === 'BOOL') === (v.kind === 'bool')
}

/**
 * Group variables by `groupOf` (a name's group, '' for none), each group's variables by their short name. Groups sort by
 * `rank` (lower first), then by name; the '' group first among its rank.
 */
export function groupVariables(variables: readonly PlcVariable[], groupOf: (v: PlcVariable) => string, rank: (group: string) => number = () => 0): PlcVariableGroup[] {
  const groups = new Map<string, PlcVariable[]>()
  for (const v of variables) {
    const g = groupOf(v)
    const list = groups.get(g) ?? []
    list.push(v)
    groups.set(g, list)
  }
  return [...groups]
    .map(([name, vs]) => ({ name, variables: vs.sort((a, b) => a.short.localeCompare(b.short)) }))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
}
