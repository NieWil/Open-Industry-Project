// The reference line: a large scene and program made from the built-in parts, for measuring the app at the size a
// site controller's project has. The demo scene is a few dozen parts and a short program, and every slow spot found
// on a real line (a lookup per rung operand, a compile per pooled mesh, an index of every value per image) was
// invisible on it.
//
// It is built in the page from whatever the built-in parts declare, so it needs no project file and follows the
// parts as they change: `stations` belt conveyors in rows, a sensor over each, every tag param wired to a variable
// of a program that has a function block instance, an array of structures and two rungs per station.
//
//   stations   parts   wired tags   program         values a running program holds
//   100        200       800       1,925 lines    about 52,000
//   400        800     3,200       7,625 lines    about 210,000
//   1000     2,000     8,000      19,025 lines    about 525,000

/** How many elements each station's array of structures has: three scalars each, so most of the program's values. */
const ZONES = 170

/**
 * Load the reference line into the open editor and wait for the scene to settle. Returns what was built.
 * The page must have the `?hook` test hook and its built-in parts registered.
 */
export async function loadReference(page, { stations = 400, timeout = 300000 } = {}) {
  await page.waitForFunction(() => !!window.__oip?.getPackage?.('oip.belt-conveyor') && !!window.__oip.getPackage('oip.diffuse-sensor'), null, { timeout })
  const built = await page.evaluate(
    ({ stations, zones }) => {
      const { store, getPackage } = window.__oip
      const kinds = [
        { pkg: getPackage('oip.belt-conveyor'), name: 'Belt', y: 0.5, dz: 0 },
        { pkg: getPackage('oip.diffuse-sensor'), name: 'Eye', y: 1.1, dz: 0.5 },
      ]
      const parts = []
      /** every wired tag: its variable, its IEC type, and whether the part writes it (a sensor) or reads it */
      const tags = []
      const perRow = Math.ceil(Math.sqrt(stations))
      for (let s = 0; s < stations; s++) {
        const x = (s % perRow) * 3.2
        const z = Math.floor(s / perRow) * 2.4
        for (const kind of kinds) {
          const params = {}
          for (const [key, spec] of Object.entries(kind.pkg.params ?? {})) {
            if (!spec) continue
            if (spec.type === 'tag') {
              const variable = `${kind.name}${s}_${key}`
              params[key] = variable
              tags.push({ variable, type: spec.stType ?? 'BOOL', fromPart: spec.dir === 'out', station: s })
            } else if ('default' in spec) params[key] = spec.default
          }
          // a part talks to the controller only once its comms switch is on
          if (kind.pkg.commsParam) params[kind.pkg.commsParam] = true
          parts.push({ id: `${kind.name.toLowerCase()}${s}`, type: 'part', packageId: kind.pkg.id, name: `${kind.name} ${s}`, position: [x, kind.y, z + kind.dz], rotationY: 0, params })
        }
      }

      // the program: every wired tag a variable, and per station an instance, an array of structures and two rungs
      const decls = []
      const body = []
      const rungs = []
      for (const t of tags) decls.push(`  ${t.variable} : ${t.type};`)
      for (let s = 0; s < stations; s++) {
        const mine = tags.filter((t) => t.station === s)
        const seen = mine.find((t) => t.fromPart && t.type === 'BOOL')?.variable
        const driven = mine.find((t) => !t.fromPart && t.type === 'BOOL')?.variable
        decls.push(`  Start${s}, Stop${s}, Run${s}, Jam${s} : BOOL;`, `  St${s} : Station;`, `  Zone${s} : ARRAY[0..${zones - 1}] OF Zone;`, `  Speed${s} : REAL;`)
        body.push(
          `St${s}(Eye := ${seen ?? `Start${s}`}, Enable := Run${s});`,
          `Jam${s} := St${s}.Held;`,
          `FOR i := 0 TO ${zones - 1} DO Zone${s}[i].Run := St${s}.Motor; Zone${s}[i].Count := Zone${s}[i].Count + 1; END_FOR;`,
          `Speed${s} := Speed${s} * 0.5 + 1.0;`,
          ...(driven ? [`${driven} := St${s}.Motor;`] : []),
        )
        rungs.push(`  [|Start${s}|, |Run${s}|] |/Stop${s}| (Run${s});`, `  |Run${s}| |/Jam${s}| (Stop${s});`)
      }
      const program = `TYPE Zone : STRUCT
  Run : BOOL;
  Count : DINT;
  Speed : REAL;
END_STRUCT; END_TYPE

FUNCTION_BLOCK Station
VAR_INPUT Eye, Enable : BOOL; END_VAR
VAR_OUTPUT Motor, Held : BOOL; END_VAR
VAR Dwell : TON; Seen : R_TRIG; Total : DINT; END_VAR
Seen(CLK := Eye);
IF Seen.Q THEN Total := Total + 1; END_IF;
Dwell(IN := Eye AND Enable, PT := T#500ms);
Held := Dwell.Q;
Motor := Enable AND NOT Held;
END_FUNCTION_BLOCK

PROGRAM Main
VAR
  i : INT;
${decls.join('\n')}
END_VAR
${body.join('\n')}
LADDER
${rungs.join('\n')}
END_LADDER
END_PROGRAM
`
      store.loadScene({ version: store.getState().scene.version, parts, packages: kinds.map((k) => k.pkg) })
      store.loadStProgram(program)
      return { parts: parts.length, tags: tags.length, lines: program.split('\n').length, bytes: program.length }
    },
    { stations, zones: ZONES },
  )
  await page.waitForFunction(() => window.__oip.assetsBusy?.() === false, null, { timeout, polling: 250 })
  return built
}
