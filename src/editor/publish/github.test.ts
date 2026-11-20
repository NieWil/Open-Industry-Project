import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RIGHTS_LINE } from '../../core/parts/partSubmission'
import type { PartPackage } from '../../core/parts/partPackage'
import { buildPackage } from '../../sim/buildPackage'
import { finishSignIn, savedSession, startSignIn, submissionStatus, submitPart } from './github'
import { pullRequestText, submissionFiles } from './submission'

function fakeStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    },
  } as Storage
}

const json = (v: unknown, status = 200): Response => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } })
const noSleep = (): Promise<void> => Promise.resolve()

beforeEach(() => vi.stubGlobal('localStorage', fakeStorage()))
afterEach(() => vi.unstubAllGlobals())

describe('GitHub sign-in (device flow through the sign-in Worker)', () => {
  it('shows the code, waits while it is pending, slows down when told, and keeps the session', async () => {
    const answers = [{ error: 'authorization_pending' }, { error: 'slow_down', interval: 10 }, { access_token: 'gho_x' }]
    const seen: string[] = []
    const fetchFn = async (url: string): Promise<Response> => {
      seen.push(url)
      if (url.endsWith('/device/code')) return json({ device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900 })
      if (url.endsWith('/device/token')) return json(answers.shift())
      if (url === 'https://api.github.com/user') return json({ login: 'jdoe' })
      return json({}, 404)
    }
    const code = await startSignIn(fetchFn, 'https://signin.test')
    expect(code.userCode).toBe('ABCD-1234')
    const waits: number[] = []
    const session = await finishSignIn(code, undefined, fetchFn, 'https://signin.test', async (ms) => void waits.push(ms))
    expect(session).toEqual({ token: 'gho_x', login: 'jdoe' })
    expect(waits).toEqual([5000, 5000, 10000])
    expect(savedSession()).toEqual(session)
  })

  it('says so when the author declines', async () => {
    const fetchFn = async (): Promise<Response> => json({ error: 'access_denied' })
    await expect(finishSignIn({ deviceCode: 'dc', userCode: 'x', verificationUri: '', interval: 1, expiresIn: 60 }, undefined, fetchFn, 'https://s', noSleep)).rejects.toThrow(/declined/)
  })
})

const PKG = buildPackage(
  { id: 'u.jdoe.bin', name: 'Bin', geometry: { kind: 'rig', links: [{ name: 'body', shape: { kind: 'box', size: [0.6, 0.3, 0.4] }, offset: [0, 0, 0] }], joints: [] }, cargo: {} },
  "definePart({ params: { mass: { type: 'number', default: 2 } }, step() {} })",
) as PartPackage

describe('a submission', () => {
  it("is the part's folder and its description, under parts/<id>/", () => {
    const files = submissionFiles(PKG, { description: 'A bin.' })
    expect(files.map((f) => f.path).sort()).toEqual(['parts/u.jdoe.bin/behavior.js', 'parts/u.jdoe.bin/description.txt', 'parts/u.jdoe.bin/manifest.json'])
    const text = pullRequestText(PKG, { description: 'A bin.', update: false })
    expect(text.body).toContain(`- [x] ${RIGHTS_LINE}`)
  })

  it('forks, commits the folder on a branch from main, and opens the pull request from the fork', async () => {
    const calls: string[] = []
    let forkReady = false
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      const path = url.replace('https://api.github.com', '')
      calls.push(`${init?.method ?? 'GET'} ${path}`)
      if (path === '/repos/Open-Industry-Project/parts/git/ref/heads/main') return json({ object: { sha: 'main1' } })
      if (path === '/repos/Open-Industry-Project/parts/git/commits/main1') return json({ tree: { sha: 'tree1' } })
      if (path === '/repos/Open-Industry-Project/parts/forks') return json({ owner: { login: 'jdoe' }, name: 'parts' }, 202)
      if (path === '/repos/jdoe/parts') {
        const ready = forkReady
        forkReady = true
        return ready ? json({}) : json({ message: 'Not Found' }, 404)
      }
      if (path === '/repos/jdoe/parts/merge-upstream') return json({})
      if (path === '/repos/jdoe/parts/git/blobs') return json({ sha: `blob${calls.length}` })
      if (path === '/repos/jdoe/parts/git/trees') {
        expect(JSON.parse(String(init?.body)).base_tree).toBe('tree1')
        return json({ sha: 'tree2' })
      }
      if (path === '/repos/jdoe/parts/git/commits') {
        expect(JSON.parse(String(init?.body)).parents).toEqual(['main1'])
        return json({ sha: 'commit2' })
      }
      if (path === '/repos/jdoe/parts/git/refs') return json({})
      if (path === '/repos/Open-Industry-Project/parts/pulls') {
        expect(JSON.parse(String(init?.body)).head).toMatch(/^jdoe:part\/u\.jdoe\.bin-/)
        return json({ number: 7, html_url: 'https://github.com/Open-Industry-Project/parts/pull/7' })
      }
      return json({ message: `unexpected ${path}` }, 500)
    }
    const files = submissionFiles(PKG, { description: 'A bin.' })
    const pr = await submitPart({ token: 't', login: 'jdoe' }, { partId: PKG.id, files, ...pullRequestText(PKG, { description: 'A bin.', update: false }) }, () => {}, fetchFn, noSleep)
    expect(pr).toEqual({ number: 7, url: 'https://github.com/Open-Industry-Project/parts/pull/7' })
    expect(calls.filter((c) => c.endsWith('/git/blobs'))).toHaveLength(files.length)
  })

  it('reads where it stands, with what reviewers and the checks said', async () => {
    const fetchFn = async (url: string): Promise<Response> => {
      if (url.endsWith('/pulls/7')) return json({ state: 'open', merged: false, user: { login: 'jdoe' } })
      if (url.endsWith('/pulls/7/reviews')) return json([{ state: 'CHANGES_REQUESTED', body: 'Where is the model from?', user: { login: 'owner' } }])
      if (url.endsWith('/issues/7/comments')) return json([{ body: 'thanks', user: { login: 'jdoe' } }, { body: '✗ u.jdoe.bin: too big', user: { login: 'github-actions[bot]' } }])
      return json({}, 404)
    }
    const s = await submissionStatus({ token: 't', login: 'jdoe' }, 7, fetchFn)
    expect(s.state).toBe('changesRequested')
    expect(s.comments.map((c) => c.author)).toEqual(['owner', 'github-actions[bot]'])
  })
})
