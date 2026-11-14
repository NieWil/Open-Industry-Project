// The one worker every reader of the open program asks (program.worker.ts), and the order it is asked in.
//
// One worker, so the program is read once for all of them: the lint, the Inspector's tag fields and the Problems
// panel ask about the same text, and each stage of reading it (its structure, its problems, the compiled program) is
// kept in that one realm. The text is sent when it changes, not with every question.
//
// One question runs at a time. The lint goes first, since it is what someone typing is waiting for, and its work is
// the first part of the other two. A newer question replaces the one of its kind. When the one it replaces is
// running and is about another text, it is not waited for: the worker is dropped and a new one started, so a large
// program's stale compile never delays the current one.
//
// Where there is no Worker (unit tests, a host that refuses one), or it fails, the answer is worked out on the page.

import type { ProgramAnswers, ProgramMessage, ProgramReply, ProgramRequest } from './programWorkerAsk'

export type Kind = keyof ProgramAnswers

/** What the service needs of a worker. */
export interface ProgramWorker {
  onmessage: ((e: MessageEvent<ProgramReply>) => void) | null
  onerror: ((e: unknown) => void) | null
  postMessage(message: ProgramMessage): void
  terminate(): void
}

/** the order questions are answered in */
const ORDER: readonly Kind[] = ['check', 'surface', 'facts']

interface Job {
  id: number
  kind: Kind
  ask: ProgramRequest
  /** answer it with what the worker said */
  resolve: (answer: unknown) => void
  /** answer it on the page */
  here: () => void
  /** tell its caller it went stale before it was answered */
  stale: () => void
  /** running, and no longer wanted: its reply is thrown away */
  dropped?: boolean
}

export class ProgramService {
  #worker: ProgramWorker | null = null
  /** the text the worker holds */
  #sent: string | null = null
  #running: Job | null = null
  #queued = new Map<Kind, Job>()
  #nextId = 1

  /** `spawn` starts the worker; null where there is none to start. */
  constructor(private readonly spawn: (() => ProgramWorker) | null) {}

  /**
   * Ask one question. `here` works the answer out on the page, and `none` is what the caller is told when the
   * question went stale: a newer one of its kind was asked before it was answered.
   */
  request<K extends Kind>(ask: Extract<ProgramRequest, { kind: K }>, here: () => ProgramAnswers[K], none: ProgramAnswers[K]): Promise<ProgramAnswers[K]> {
    if (!this.spawn) return Promise.resolve(here())
    return new Promise((resolve) => {
      const job: Job = {
        id: this.#nextId++,
        kind: ask.kind,
        ask,
        resolve: (answer) => resolve(answer as ProgramAnswers[K]),
        here: () => resolve(here()),
        stale: () => resolve(none),
      }
      // A newer question replaces the one of its kind, and only that one. Readers do not all follow the program at
      // the same instant (the lint asks a moment after the store changes), so a question of another kind about
      // another text is still wanted by whoever asked it.
      this.#queued.get(ask.kind)?.stale()
      const running = this.#running
      if (running?.kind === ask.kind) {
        if (!running.dropped) running.stale()
        if (running.ask.source === ask.source) {
          // about the same text: it finishes, since its work is kept in the worker and the new one starts from it
          running.dropped = true
        } else {
          // about a text that is no longer the program: not waited for
          this.#running = null
          this.#stop()
        }
      }
      this.#queued.set(ask.kind, job)
      this.#next()
    })
  }

  #stop(): void {
    this.#worker?.terminate()
    this.#worker = null
    this.#sent = null
  }

  /** The worker failed: every question it had or was to get is answered on the page. */
  #failed(): void {
    const jobs = [...(this.#running && !this.#running.dropped ? [this.#running] : []), ...ORDER.flatMap((k) => this.#queued.get(k) ?? [])]
    this.#running = null
    this.#queued.clear()
    this.#stop()
    for (const job of jobs) job.here()
  }

  #next(): void {
    if (this.#running) return
    const kind = ORDER.find((k) => this.#queued.has(k))
    if (!kind) return
    const job = this.#queued.get(kind)!
    this.#queued.delete(kind)
    if (!this.#worker) {
      try {
        this.#worker = this.spawn!()
      } catch {
        this.#queued.set(kind, job)
        return this.#failed()
      }
      this.#worker.onmessage = (e) => this.#answered(e.data)
      // a worker that fails to load, or throws outside its own catch
      this.#worker.onerror = () => this.#failed()
    }
    this.#running = job
    const { source, ...rest } = job.ask
    const text = this.#sent === source ? {} : { source }
    this.#sent = source
    this.#worker.postMessage({ ...rest, ...text, id: job.id } as ProgramMessage)
  }

  #answered(reply: ProgramReply): void {
    const job = this.#running
    if (!job || job.id !== reply.id) return
    this.#running = null
    if (!job.dropped) {
      // (a reply of another kind is the worker saying it could not answer: the page does, and reports what went wrong)
      if (reply.kind === job.kind) job.resolve(reply.answer)
      else job.here()
    }
    this.#next()
  }
}
