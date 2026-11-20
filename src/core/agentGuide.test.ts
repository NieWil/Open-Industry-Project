// The agent guide is derived from the document, because a hand-written context file becomes wrong the
// first time a tag is renamed. These specs pin the derivation (the tag table, the direction mapping, the
// placeable-package list) rather than the prose around it.

import { describe, expect, it } from 'vitest'
import { agentGuideMarkdown } from './agentGuide'
import type { GuideDoc, PartExtent } from './agentGuide'
import type { ParamSchema } from './parts/partApi'

/** A scene shaped like the real thing: parts referring to packages the scene embeds. */
function scene(params: ParamSchema, partParams: Record<string, unknown>, partName?: string): unknown {
  return {
    version: 4,
    parts: [{ id: 'p1', type: 'part', packageId: 'acme.belt', position: [0, 0, 0], params: partParams, ...(partName ? { name: partName } : {}) }],
    packages: [{ id: 'acme.belt', name: 'Belt', params }],
  }
}

function doc(sceneJson: unknown): GuideDoc {
  return {
    name: 'Test Line',
    scene: { id: 'scene', name: 'Test Line', scenePath: 'scene.json', programPaths: ['plc/Latch.st', 'plc/Cell.ld', 'plc/program.st'], scene: sceneJson },
  }
}

const TAG_SPECS: ParamSchema = {
  runTag: { type: 'tag', dir: 'in', stType: 'BOOL', default: '' },
  runningTag: { type: 'tag', dir: 'out', stType: 'BOOL', default: '' },
  speedTag: { type: 'tag', dir: 'in', stType: 'REAL', default: '' },
  length: { type: 'number', default: 2 },
}

describe('the tag table', () => {
  it('lists the tag names the scene actually wires, not the parameter names', () => {
    const md = agentGuideMarkdown(doc(scene(TAG_SPECS, { runTag: 'Motor', speedTag: 'Belt1Speed' })))
    expect(md).toContain('`Motor`')
    expect(md).toContain('`Belt1Speed`')
  })

  it("maps a part's 'in' tag to 'program writes' and its 'out' tag to 'program reads'", () => {
    const md = agentGuideMarkdown(doc(scene(TAG_SPECS, { runTag: 'Motor', runningTag: 'Running' })))
    expect(md).toMatch(/\| `Motor` \| program writes \| BOOL \|/)
    expect(md).toMatch(/\| `Running` \| program reads \| BOOL \|/)
  })

  it('carries the ST type, so the program declares the right one', () => {
    const md = agentGuideMarkdown(doc(scene(TAG_SPECS, { speedTag: 'Speed' })))
    expect(md).toMatch(/\| `Speed` \| program writes \| REAL \|/)
  })

  it('skips unset tags - an empty tag param wires nothing', () => {
    const md = agentGuideMarkdown(doc(scene(TAG_SPECS, { runTag: 'Motor', speedTag: '' })))
    expect(md).toContain('`Motor`')
    expect(md).not.toMatch(/\| `` \|/)
  })

  it('ignores non-tag params (a length is not a tag)', () => {
    const md = agentGuideMarkdown(doc(scene(TAG_SPECS, { length: 3, runTag: 'Motor' })))
    expect(md).not.toMatch(/\| `3` \|/)
  })

  it('names the part by its author-given name, falling back to its id', () => {
    expect(agentGuideMarkdown(doc(scene(TAG_SPECS, { runTag: 'M' }, 'Infeed belt')))).toContain('Infeed belt')
    expect(agentGuideMarkdown(doc(scene(TAG_SPECS, { runTag: 'M' })))).toContain('p1')
  })

  it('says so plainly when a scene wires no tags at all', () => {
    const md = agentGuideMarkdown(doc(scene(TAG_SPECS, {})))
    expect(md).toContain('wires no PLC tags yet')
  })

  it('reports both parts when two share one tag, rather than collapsing them', () => {
    const two = {
      version: 4,
      parts: [
        { id: 'a', type: 'part', packageId: 'acme.belt', params: { runTag: 'Shared' }, name: 'A' },
        { id: 'b', type: 'part', packageId: 'acme.belt', params: { runTag: 'Shared' }, name: 'B' },
      ],
      packages: [{ id: 'acme.belt', name: 'Belt', params: TAG_SPECS }],
    }
    const rows = agentGuideMarkdown(doc(two)).split('\n').filter((l) => l.includes('`Shared`'))
    expect(rows).toHaveLength(2)
  })
})

describe('the placeable-package table', () => {
  it('lists every package the scene embeds, with its settable params', () => {
    const md = agentGuideMarkdown(doc(scene(TAG_SPECS, { runTag: 'M' })))
    expect(md).toContain('`acme.belt`')
    expect(md).toContain('`length`')
  })

  it('omits hidden params - they are not the author\'s to set', () => {
    const withHidden: ParamSchema = { ...TAG_SPECS, reverse: { type: 'boolean', default: false, hidden: true } }
    expect(agentGuideMarkdown(doc(scene(withHidden, {})))).not.toContain('`reverse`')
  })

  it('says how to add a part type the scene does not embed, instead of hand-writing a package', () => {
    const md = agentGuideMarkdown(doc(scene(TAG_SPECS, {})))
    expect(md).toContain('not something to write by hand')
    expect(md).toContain('npm run add-part')
  })
})

describe('robustness', () => {
  it('handles a scene with no embedded packages without throwing', () => {
    const md = agentGuideMarkdown(doc({ version: 4, parts: [{ id: 'x', type: 'part', packageId: 'gone' }] }))
    expect(md).toContain('uses no part packages yet')
  })

  it('lists a package the scene carries no copy of, through resolve (a project scene: library and built-ins)', () => {
    const scene = { version: 4, parts: [{ id: 'b1', type: 'part', packageId: 'oip.belt', params: { runTag: 'Motor' } }] }
    const md = agentGuideMarkdown(doc(scene), { resolve: (id) => (id === 'oip.belt' ? { name: 'Belt Conveyor', params: TAG_SPECS } : undefined) })
    expect(md).toContain('Belt Conveyor')
    expect(md).toContain('Motor') // its tag is in the PLC table, read through the resolved schema
  })

  it('handles an empty and a malformed scene', () => {
    expect(agentGuideMarkdown(doc({ version: 4, parts: [] }))).toContain('This scene is empty')
    expect(() => agentGuideMarkdown(doc(null))).not.toThrow()
    expect(() => agentGuideMarkdown({ scene: { id: 'scene', scenePath: 'scene.json' } })).not.toThrow()
  })

  it('escapes a pipe in a tag or part name so the markdown table survives it', () => {
    const md = agentGuideMarkdown(doc(scene(TAG_SPECS, { runTag: 'a|b' }, 'x|y')))
    expect(md).toContain('a\\|b')
    expect(md).toContain('x\\|y')
  })

  it('truncates a very large table rather than emitting thousands of rows', () => {
    const parts = Array.from({ length: 120 }, (_, i) => ({ id: `p${i}`, type: 'part', packageId: 'acme.belt', params: { runTag: `T${i}` } }))
    const md = agentGuideMarkdown(doc({ version: 4, parts, packages: [{ id: 'acme.belt', name: 'Belt', params: TAG_SPECS }] }))
    expect(md).toContain('more tags not listed')
    expect(md.split('\n').filter((l) => /^\| `T\d+`/.test(l)).length).toBeLessThan(60)
  })

  it('is deterministic - the same document renders byte-identically', () => {
    const d = doc(scene(TAG_SPECS, { runTag: 'M', speedTag: 'S' }))
    expect(agentGuideMarkdown(d)).toBe(agentGuideMarkdown(d))
  })
})

describe('the honesty clauses', () => {
  // These are the claims the product rests on; a guide that quietly drops them is worse than none,
  // because an agent then reports "verified" for work nothing checked.
  it('warns that compiling here does not prove it runs on real hardware', () => {
    expect(agentGuideMarkdown(doc(scene(TAG_SPECS, {})))).toContain('does not prove it runs on a physical')
  })

  it('warns that geometry is not checked by anything', () => {
    expect(agentGuideMarkdown(doc(scene(TAG_SPECS, {})))).toContain('Almost nothing checks geometry')
  })

  // an agent told it was the only writer treated the folder as the one source, never used the editing tools, and
  // was surprised when a file load stopped its run
  it('tells the agent the folder syncs both ways and that a load stops the run', () => {
    for (const door of ['files', 'tools'] as const) {
      const md = agentGuideMarkdown(doc(scene(TAG_SPECS, {})), { door })
      expect(md).toMatch(/both ways/)
      expect(md).toMatch(/stops a running sim/)
      expect(md).toContain('sync_folder')
    }
  })
})

describe('registering files in the manifest', () => {
  // An .st written but not referenced from project.json is silently ignored, and test-project reports it
  // as `tag "X" never appeared`. That reads like a tag typo, so the reader checks the tag names, which the
  // guide says are correct. The guide tells the agent that creating a file is only half of adding one.
  const md = (): string =>
    agentGuideMarkdown(doc(scene(TAG_SPECS, { runTag: 'Motor' })))

  it('says creating a file is not enough on its own', () => {
    expect(md()).toContain('Creating a file is not enough')
  })

  it('shows how to reference a program and a test', () => {
    expect(md()).toContain('"program": ["plc/program.st"]')
    expect(md()).not.toContain('stProgram')
    // a project holds one scene: the manifest names it, it lists none
    expect(md()).not.toContain('"scenes"')
    expect(md()).toMatch(/"tests": \["tests\/my-test\.test\.json"\]/)
  })

  it('lists the program files in order, each by what it holds, and says the order is the program order', () => {
    const text = md()
    const at = (s: string): number => text.indexOf(s)
    expect(at('plc/Latch.st')).toBeLessThan(at('plc/Cell.ld'))
    expect(text).toMatch(/plc\/Latch\.st +a POU in Structured Text/)
    expect(text).toMatch(/plc\/Cell\.ld +a POU in ladder/)
    expect(text).toMatch(/plc\/program\.st +the code outside every POU/)
    expect(text).toContain('lists them IN ORDER')
  })

  it('warns that the misleading symptom looks like a tag typo', () => {
    expect(md()).toContain('never appeared')
  })

  it('names the CLI-vs-app asymmetry rather than leaving it to be discovered', () => {
    // test-project scans tests/ on disk; the app is manifest-driven and sees none
    expect(md()).toContain('The app does not')
  })
})

describe('the extent column', () => {
  // In a trial, an agent failed to place a despawner in four guesses and got it right first try from
  // `x -1..1, y 0..1, z -1..1`. A part is a volume, and the document carries its parameters but never its size.
  const withMeasure = (e: PartExtent | null) =>
    agentGuideMarkdown(doc(scene(TAG_SPECS, { runTag: 'M' })), { measure: () => e })

  it('reports the span about the origin, not a bare size', () => {
    expect(withMeasure({ hx: 3, hz: 0.762, y0: -0.4, y1: 0.05 })).toContain('x -3..3, y -0.4..0.05, z -0.762..0.762')
  })

  it('shows a centre-origin part as symmetric and a tail-origin part as starting at 0', () => {
    expect(withMeasure({ hx: 2, hz: 1, y0: 0, y1: 1 })).toContain('x -2..2')
    expect(withMeasure({ hx: 2, cx: 2, hz: 1, y0: 0, y1: 1 })).toContain('x 0..4')
  })

  it('omits the whole column when nothing can be measured, rather than printing zeros', () => {
    // the cold-registry case: a wrong number here would be worse than a missing one
    const md = withMeasure(null)
    expect(md).not.toContain('Extent about its position')
    expect(md).toContain('| Package | Name | Shape handles |')
  })

  it('omits it entirely when no measure function is supplied', () => {
    expect(agentGuideMarkdown(doc(scene(TAG_SPECS, {})))).not.toContain('Extent about its position')
  })

  it('survives a measure function that throws', () => {
    const md = agentGuideMarkdown(doc(scene(TAG_SPECS, { runTag: 'M' })), {
      measure: () => {
        throw new Error('registry cold')
      },
    })
    expect(md).toContain('`acme.belt`')
    expect(md).not.toContain('Extent about its position')
  })

  it('rounds to millimetres instead of leaking float noise', () => {
    expect(withMeasure({ hx: 2.2500000000004, hz: 1, y0: 0, y1: 0.1 })).toContain('x -2.25..2.25')
  })

  it('tells the reader the numbers belong to that instance, not the package', () => {
    expect(withMeasure({ hx: 1, hz: 1, y0: 0, y1: 1 })).toContain('true of THAT instance')
  })

  it('stays deterministic with a measure supplied', () => {
    const d = doc(scene(TAG_SPECS, { runTag: 'M' }))
    const m = { measure: () => ({ hx: 1, hz: 1, y0: 0, y1: 1 }) }
    expect(agentGuideMarkdown(d, m)).toBe(agentGuideMarkdown(d, m))
  })
})

describe('guidance on what to assert', () => {
  // In a trial, every structural check (load, seating, wiring, compile) passed on a control program that
  // deadlocked the line. Only the behavioural test caught it, because it asserted liveness. An agent writes
  // both the logic and its test, so the test can easily agree with the bug, and no other checker covers that.
  const md = (): string => agentGuideMarkdown(doc(scene(TAG_SPECS, { runTag: 'Motor' })))

  it('warns that a stop-only assertion is satisfied by a deadlock', () => {
    expect(md()).toContain('never releases')
    expect(md()).toContain('deadlocks')
  })

  it('shows the safety/liveness pair rather than describing it', () => {
    expect(md()).toContain('it stops (safety)')
    expect(md()).toContain('it recovers (liveness)')
  })

  it('tells the agent a check that passed before the change tests nothing', () => {
    expect(md()).toContain('would pass without your change')
  })

  it('points at probes as the harder-to-fake assertion', () => {
    expect(md()).toContain('OUTCOME over the mechanism')
  })
})

describe('every JSON example is valid JSON', () => {
  // A snippet the agent cannot paste is worse than none. `//` comments inside a ```json block would
  // lead readers to write test files that fail to parse.
  it('parses every ```json fence in the guide', () => {
    const md = agentGuideMarkdown(doc(scene(TAG_SPECS, { runTag: 'M' })))
    const fences = [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]!)
    expect(fences.length).toBeGreaterThan(0)
    for (const body of fences) {
      // a fragment showing one field is wrapped so it parses as the object it belongs to
      const text = body.trim().startsWith('{') ? body : `{${body}}`
      expect(() => JSON.parse(text), `not valid JSON:\n${body}`).not.toThrow()
    }
  })
})

describe('pointing at the verified subset', () => {
  // The conformance risk grows with generated volume. A human writing a seal-in uses common constructs;
  // a program generated at scale uses whatever is legal. The manifest splits accepted features into
  // oracle-verified and merely-accepted, and the guide tells the agent to prefer the verified ones.
  const md = (): string => agentGuideMarkdown(doc(scene(TAG_SPECS, { runTag: 'M' })))

  it('names the section an agent has to read to find the safe subset', () => {
    expect(md()).toContain('oracleCoverage')
  })

  it('says unverified means unwitnessed, not broken', () => {
    // overstating this would push agents off legal constructs for no reason
    expect(md()).toContain('unwitnessed')
    expect(md()).toContain('does not mean broken')
  })

  it('asks for a disclosure when the verified subset will not do', () => {
    expect(md()).toContain('say so')
  })
})

// ST features, taught where an agent reads them. An agent does not use a feature the guide does not mention, and
// falls into a portability trap the guide does not name. `npm run check-st` compiles the examples whenever they
// change; these specs check that the guide still contains them.
describe('the ST section teaches the language as it stands', () => {
  const md = agentGuideMarkdown(doc(scene(TAG_SPECS, {})))
  it('dates and times: their literals, the arithmetic table, the fault, and no conversion to a number', () => {
    for (const s of ['D#2024-02-29', 'TOD#07:30:00', 'DT#2024-02-29-07:30:00', 'SUB_TOD_TOD', 'CONCAT_DATE_TOD', 'FAULTS the', 'now - started >= T#5m', 'whole seconds on MATIEC']) expect(md).toContain(s)
  })
  it('calls: an omitted input, and named standard-function arguments kept in order for OpenPLC', () => {
    expect(md).toContain('Scale(v := 5)')
    expect(md).toContain('write them in the standard order')
  })
  it('the names targets reserve, dt among them', () => {
    expect(md).toContain('`S` or `R`')
    expect(md).toContain('call it `stepTime`')
  })
  it('ladder labels, jumps, RETURN and rung comments', () => {
    for (const s of ['>>Done;', 'Done: |Estop| RETURN;', 'Jumps go', 'rung\'s comment']) expect(md).toContain(s)
  })
  it('reading a failed test before changing anything', () => {
    expect(md).toContain('--trace')
    expect(md).toContain('--context')
  })
})

describe('the guide an agent reads through the tools (get_guide)', () => {
  const files = agentGuideMarkdown(doc(scene(TAG_SPECS, { runTag: 'Motor' })))
  const tools = agentGuideMarkdown(doc(scene(TAG_SPECS, { runTag: 'Motor' })), { door: 'tools' })

  it('names the tools, and none of the files or CLIs an agent at the folder uses', () => {
    for (const tool of ['set_pou', 'run_test', 'save_test', 'snap_part', 'get_package', 'capture_view', 'open_project']) expect(tools).toContain(`\`${tool}\``)
    expect(tools).toMatch(/`trace: \["A", "B"\]`/)
    expect(tools).not.toMatch(/npm run|project\.json|scene\.json|tests\/|AGENTS\.md|GENERATED/)
  })

  it('keeps what both doors share: the tag table, the ST notes, the test format', () => {
    expect(tools).toContain('| `Motor` |')
    expect(tools).toContain('Writing the Structured Text program')
    expect(tools).toContain('Each check names exactly one **source**')
  })

  it('leaves the folder guide as it was', () => {
    expect(files).toContain('npm run test-project')
    expect(files).toContain('### Adding a file')
    expect(files).not.toContain('## What you can do with the tools')
  })
})
