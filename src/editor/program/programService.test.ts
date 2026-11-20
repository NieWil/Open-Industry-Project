// The one program worker's queue (programService.ts), driven with a stand-in worker.
import { describe, expect, it } from 'vitest'
import { ProgramService, type ProgramWorker } from './programService'
import type { ProgramMessage, ProgramReply, ProgramRequest } from './programWorkerAsk'

class FakeWorker implements ProgramWorker {
  onmessage: ((e: MessageEvent<ProgramReply>) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  got: ProgramMessage[] = []
  stopped = false
  postMessage(message: ProgramMessage): void {
    this.got.push(message)
  }
  terminate(): void {
    this.stopped = true
  }
  /** answer the question it was sent last */
  answer(answer: unknown, kind?: string): void {
    const last = this.got[this.got.length - 1]!
    this.onmessage!({ data: { id: last.id, kind: kind ?? last.kind, answer } } as MessageEvent<ProgramReply>)
  }
}

function setup(): { service: ProgramService; workers: FakeWorker[] } {
  const workers: FakeWorker[] = []
  const service = new ProgramService(() => {
    const w = new FakeWorker()
    workers.push(w)
    return w
  })
  return { service, workers }
}

const ask = <K extends ProgramRequest['kind']>(kind: K, source: string, more: object = {}): Extract<ProgramRequest, { kind: K }> =>
  ({ kind, source, controller: null, scanMs: 10, ...more }) as unknown as Extract<ProgramRequest, { kind: K }>
const NONE = { source: [], controller: ['stale'] }
const check = (service: ProgramService, source: string): Promise<unknown> => service.request(ask('check', source), () => ({ source: [], controller: ['page'] }), NONE)
const surface = (service: ProgramService, source: string): Promise<unknown> => service.request(ask('surface', source), () => null, null)
const facts = (service: ProgramService, source: string, more: object = {}): Promise<unknown> => service.request(ask('facts', source, more), () => 'page' as never, 'stale' as never)

describe('the program service', () => {
  it('asks one worker everything, one question at a time, and sends a text once', async () => {
    const { service, workers } = setup()
    const a = surface(service, 'A')
    const b = check(service, 'A')
    expect(workers).toHaveLength(1)
    const w = workers[0]!
    expect(w.got).toHaveLength(1) // the second waits for the first
    expect(w.got[0]).toMatchObject({ kind: 'surface', source: 'A' })
    w.answer({ inputs: [] })
    expect(await a).toEqual({ inputs: [] })
    expect(w.got).toHaveLength(2)
    expect(w.got[1]!.kind).toBe('check')
    expect('source' in w.got[1]!).toBe(false) // the worker holds the text
    w.answer({ source: [], controller: [] })
    expect(await b).toEqual({ source: [], controller: [] })
    expect(workers).toHaveLength(1)
  })

  it('answers the lint before the other two', async () => {
    const { service, workers } = setup()
    void surface(service, 'A') // running
    const f = facts(service, 'A')
    const c = check(service, 'A')
    const w = workers[0]!
    w.answer(null)
    expect(w.got[1]!.kind).toBe('check')
    w.answer({ source: [], controller: [] })
    await c
    expect(w.got[2]!.kind).toBe('facts')
    w.answer('facts')
    expect(await f).toBe('facts')
  })

  it('drops the worker when the running question is replaced by one about another text', async () => {
    const { service, workers } = setup()
    const old = facts(service, 'A')
    const waiting = check(service, 'A')
    const now = facts(service, 'B')
    expect(await old).toBe('stale')
    expect(workers).toHaveLength(2)
    expect(workers[0]!.stopped).toBe(true)
    // the question of another kind is still wanted, and goes first; the new worker is sent its text
    expect(workers[1]!.got[0]).toMatchObject({ kind: 'check', source: 'A' })
    workers[1]!.answer({ source: [], controller: [] })
    expect(await waiting).toEqual({ source: [], controller: [] })
    expect(workers[1]!.got[1]).toMatchObject({ kind: 'facts', source: 'B' })
    workers[1]!.answer('for B')
    expect(await now).toBe('for B')
  })

  it('leaves a question alone when another kind asks about another text', async () => {
    // the lint asks about the text a moment after the Problems panel does: neither cancels the other
    const { service, workers } = setup()
    const panel = facts(service, 'B')
    const lint = check(service, 'A')
    const w = workers[0]!
    w.answer('for B')
    expect(await panel).toBe('for B')
    expect(w.got[1]).toMatchObject({ kind: 'check', source: 'A' }) // the text is sent again when it differs
    w.answer({ source: [], controller: [] })
    expect(await lint).toEqual({ source: [], controller: [] })
    expect(workers).toHaveLength(1)
  })

  it('keeps the worker for a newer question about the same text, and uses only the newer answer', async () => {
    const { service, workers } = setup()
    const first = facts(service, 'A', { tags: { '': ['X'] } })
    const second = facts(service, 'A', { tags: { '': ['Y'] } })
    expect(await first).toBe('stale')
    const w = workers[0]!
    expect(w.stopped).toBe(false)
    w.answer('for X') // the running one finishes: its work is kept in the worker
    expect(w.got).toHaveLength(2)
    w.answer('for Y')
    expect(await second).toBe('for Y')
    expect(workers).toHaveLength(1)
  })

  it('answers on the page what the worker says it could not', async () => {
    const { service, workers } = setup()
    const c = check(service, 'A')
    workers[0]!.answer(undefined, 'failed')
    expect(await c).toEqual({ source: [], controller: ['page'] })
  })

  it('answers every waiting question on the page when the worker fails, and starts another for the next', async () => {
    const { service, workers } = setup()
    const c = check(service, 'A')
    const f = facts(service, 'A')
    workers[0]!.onerror!(new Error('gone'))
    expect(await c).toEqual({ source: [], controller: ['page'] })
    expect(await f).toBe('page')
    void check(service, 'A')
    expect(workers).toHaveLength(2)
    expect(workers[1]!.got[0]).toMatchObject({ source: 'A' })
  })

  it('answers on the page where there is no worker to start', async () => {
    const service = new ProgramService(null)
    expect(await check(service, 'A')).toEqual({ source: [], controller: ['page'] })
  })
})
