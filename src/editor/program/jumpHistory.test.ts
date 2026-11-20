import { describe, expect, it } from 'vitest'
import { JumpHistory } from './jumpHistory'

describe('jump history', () => {
  it('has nowhere to go before a jump', () => {
    const h = new JumpHistory()
    expect(h.canGoBack()).toBe(false)
    expect(h.goBack(5)).toBeNull()
    expect(h.goForward(5)).toBeNull()
  })

  it('walks back through the jumps and forward again', () => {
    const h = new JumpHistory()
    h.jumped(10) // 10 -> 200
    h.jumped(200) // 200 -> 3000
    expect(h.goBack(3000)).toBe(200)
    expect(h.goBack(200)).toBe(10)
    expect(h.canGoBack()).toBe(false)
    expect(h.goForward(10)).toBe(200)
    expect(h.goForward(200)).toBe(3000)
    expect(h.canGoForward()).toBe(false)
  })

  it('returns to where the caret was when Back was pressed, not to the jump target', () => {
    const h = new JumpHistory()
    h.jumped(10)
    // the caret wandered to 250 after landing on 200
    expect(h.goBack(250)).toBe(10)
    expect(h.goForward(10)).toBe(250)
  })

  it('drops what lay ahead when a new jump is made after going back', () => {
    const h = new JumpHistory()
    h.jumped(10)
    h.goBack(200)
    h.jumped(10)
    expect(h.canGoForward()).toBe(false)
    expect(h.goBack(400)).toBe(10)
  })

  it('forgets the oldest jump past its limit', () => {
    const h = new JumpHistory()
    for (let i = 0; i < 60; i++) h.jumped(i)
    let n = 0
    let last: number | null = null
    for (let to = h.goBack(999); to !== null; to = h.goBack(to)) {
      n++
      last = to
    }
    expect(n).toBe(50)
    expect(last).toBe(10)
  })
})
