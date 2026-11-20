import { describe, expect, it } from 'vitest'
import type { TestSpec } from './projectTest'
import { coverByTests, testTagUse } from './projectTestTags'

const spec: TestSpec = {
  duration: 10,
  inputs: [
    { at: 0, tag: 'Start', value: true },
    { at: 1, tag: 'Lane1Blocked', value: true },
    { at: 2, tag: 'Start', value: false },
  ],
  faults: [
    { at: 3, kind: 'commsLoss', statusTag: 'IoFault' },
    { at: 4, kind: 'actuatorDead', part: 'm1' },
  ],
  checks: [
    { at: 5, tag: 'Running', equals: true },
    { always: true, tag: 'MainOut', max: { tag: 'SpawnedCount' } },
    { at: 6, tag: 'Speed', near: { tag: 'Setpoint' }, tolerance: 0.1 },
    { at: 7, probe: { count: {} }, min: { tag: 'Wanted' } },
  ],
}

describe('testTagUse', () => {
  it('reads every checked tag and right-hand tag operand, once each', () => {
    expect(testTagUse(spec).reads).toEqual(['Running', 'MainOut', 'SpawnedCount', 'Speed', 'Setpoint', 'Wanted'])
  })
  it('drives every input tag and a commsLoss status tag, once each', () => {
    expect(testTagUse(spec).writes).toEqual(['Start', 'Lane1Blocked', 'IoFault'])
  })
})

describe('coverByTests', () => {
  const problems = [
    { kind: 'unread', tag: 'MainOut' },
    { kind: 'unread', tag: 'Start' }, // driven by the test, not read: still unread
    { kind: 'undriven', tag: 'Lane1Blocked' },
    { kind: 'undriven', tag: 'Running' }, // read by the test, not driven: still undriven
    { kind: 'contested', tag: 'SpawnedCount' }, // an error no test answers
  ]
  it('answers an unread tag a test reads and an undriven tag a test drives, naming the tests', () => {
    const r = coverByTests(problems, [
      { label: 'tests/a.test.json', spec },
      { label: 'tests/b.test.json', spec },
    ])
    expect(r.problems.map((p) => p.tag)).toEqual(['Start', 'Running', 'SpawnedCount'])
    expect(r.covered.map((c) => [c.problem.tag, c.by])).toEqual([
      ['MainOut', ['tests/a.test.json', 'tests/b.test.json']],
      ['Lane1Blocked', ['tests/a.test.json', 'tests/b.test.json']],
    ])
  })
  it('matches tag names exactly', () => {
    expect(coverByTests([{ kind: 'unread', tag: 'mainout' }], [{ label: 't', spec }]).covered).toEqual([])
  })
})
