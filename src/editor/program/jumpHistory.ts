// Where the caret was before each jump in the program text (Go to definition), so a jump can be walked back and
// forward again. Offsets are kept as they were when recorded: an edit made since moves the text under them, so a
// return lands near the place rather than exactly on it, and the editor clamps one past the end.

/** enough for a long trail of definitions; the oldest falls off */
const MAX_JUMPS = 50

export class JumpHistory {
  private readonly back: number[] = []
  private readonly forward: number[] = []

  /** a jump left `from`: Back returns there, and what lay ahead of the old position is dropped */
  jumped(from: number): void {
    this.back.push(from)
    if (this.back.length > MAX_JUMPS) this.back.shift()
    this.forward.length = 0
  }

  canGoBack(): boolean {
    return this.back.length > 0
  }

  canGoForward(): boolean {
    return this.forward.length > 0
  }

  /** the offset the last jump left, with the caret now at `from`; null when there is none */
  goBack(from: number): number | null {
    const to = this.back.pop()
    if (to === undefined) return null
    this.forward.push(from)
    return to
  }

  /** the offset the last Back left, with the caret now at `from`; null when there is none */
  goForward(from: number): number | null {
    const to = this.forward.pop()
    if (to === undefined) return null
    this.back.push(from)
    return to
  }
}
