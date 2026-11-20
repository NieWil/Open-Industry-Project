import { describe, expect, it } from 'vitest'
import { drawnElsewhere, meshLinkBox } from './glbBox'

// a GLB's JSON with three unit cubes: Body at x 0, Head at x 2 and, inside Head, Bit one further along x
const cube = { attributes: { POSITION: 0 } }
const json = {
  scene: 0,
  scenes: [{ nodes: [0, 1] }],
  nodes: [
    { name: 'Body', mesh: 0 },
    { name: 'Head', mesh: 0, translation: [2, 0, 0], children: [2] },
    { name: 'Bit', mesh: 0, translation: [1, 0, 0] },
  ],
  meshes: [{ primitives: [cube] }],
  accessors: [{ min: [0, 0, 0], max: [1, 1, 1] }],
}

const mesh = (keepNode?: string) => ({ shape: { kind: 'mesh', asset: 'm', ...(keepNode ? { keepNode } : {}) } })

describe('drawnElsewhere', () => {
  it('names the nodes other links of the asset keep, and none for a node ref', () => {
    const body = mesh()
    const head = mesh('Head')
    const bit = mesh('Bit')
    const links = [body, head, bit, { shape: { kind: 'mesh', asset: 'other', keepNode: 'Body' } }, { shape: { kind: 'frame' } }]
    expect(drawnElsewhere(links, body)).toEqual(['Head', 'Bit'])
    expect(drawnElsewhere(links, head)).toEqual(['Bit'])
    expect(drawnElsewhere(links, bit)).toEqual(['Head'])
    expect(drawnElsewhere(links, { shape: { kind: 'mesh', asset: 'm', node: 'Body' } })).toBeUndefined()
    expect(drawnElsewhere([body], body)).toBeUndefined()
  })
})

describe('meshLinkBox with drawnElsewhere', () => {
  it('leaves kept pieces out of the model, and a nested piece out of the piece around it', () => {
    expect(meshLinkBox(json, {})).toEqual({ min: [0, 0, 0], max: [4, 1, 1] })
    expect(meshLinkBox(json, { drawnElsewhere: ['Head'] })).toEqual({ min: [0, 0, 0], max: [1, 1, 1] })
    expect(meshLinkBox(json, { keepNode: 'Head', drawnElsewhere: ['Bit'] })).toEqual({ min: [2, 0, 0], max: [3, 1, 1] })
    // a piece kept around this one does not cut it
    expect(meshLinkBox(json, { keepNode: 'Bit', drawnElsewhere: ['Head'] })).toEqual({ min: [3, 0, 0], max: [4, 1, 1] })
  })
})
