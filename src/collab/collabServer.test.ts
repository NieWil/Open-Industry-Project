import { describe, expect, it } from 'vitest'
import { shareableLink } from './collabServer'

describe('shareableLink', () => {
  it('points a link copied in the desktop app at the web app, keeping the room', () => {
    const room = `r-${'b'.repeat(64)}`
    const link = shareableLink(new URL(`oip://app/app/?room=${room}&view=1`))
    expect(link.toString()).toBe(`https://www.openindustryproject.org/app/?room=${room}&view=1`)
  })

  it('keeps the address of a page served over http(s)', () => {
    for (const href of ['https://www.openindustryproject.org/app/?room=e-x', 'http://localhost:5173/app/?room=e-x&server=ws%3A%2F%2Flocalhost%3A1234']) {
      expect(shareableLink(new URL(href)).toString()).toBe(href)
    }
  })
})
