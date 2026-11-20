// GitHub, for publishing a part (docs/part-libraries.md, "Publishing"): signing the author in, and opening the
// submission's pull request under their own account.
//
// Sign-in is GitHub's device flow: GitHub shows a code, the author enters it at github.com/login/device, and the app
// polls for the token. GitHub's two sign-in endpoints answer no CORS, so they are reached through the sign-in Worker
// (workers/github-signin), which holds no secret and keeps nothing. Everything else is api.github.com, which answers
// the app directly. The token (scope public_repo) is kept in this browser only, and Sign out forgets it.
//
// A submission is a fork of the parts repository, a branch on it with one commit adding the part's folder, and a pull
// request from that branch. The commit is made through the Git data API (blobs, a tree on the repository's current
// main, a commit, a branch), so nothing is cloned.

import { PARTS_REPOSITORY } from '../../core/parts/partSubmission'
import type { NamespaceFile } from '../../core/parts/partSubmission'
import { bytesToBase64 } from '../../core/parts/partAssets'

/** The sign-in Worker (workers/github-signin). */
export const SIGNIN_URL = 'https://signin.openindustryproject.org'
const API = 'https://api.github.com'
const TOKEN_KEY = 'oip-web/github-sign-in'

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

export interface GitHubSession {
  token: string
  login: string
}

/** The signed-in author, if any. */
export function savedSession(): GitHubSession | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY)
    const s = raw ? (JSON.parse(raw) as Partial<GitHubSession>) : null
    return s && typeof s.token === 'string' && typeof s.login === 'string' ? { token: s.token, login: s.login } : null
  } catch {
    return null
  }
}

function saveSession(s: GitHubSession | null): void {
  try {
    if (s) localStorage.setItem(TOKEN_KEY, JSON.stringify(s))
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    // storage blocked: the session lasts for this page
  }
}

/** Forget the token. It stays valid at GitHub until the author revokes the app there (Settings > Applications). */
export function signOut(): void {
  saveSession(null)
}

export interface DeviceCode {
  /** what the author types at verificationUri */
  userCode: string
  verificationUri: string
  deviceCode: string
  /** seconds between polls */
  interval: number
  expiresIn: number
}

/** Start a sign-in: GitHub's code for the author to enter. */
export async function startSignIn(fetchFn: Fetch = fetch, signinUrl = SIGNIN_URL): Promise<DeviceCode> {
  const res = await fetchFn(`${signinUrl}/device/code`, { method: 'POST' })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok || typeof body.device_code !== 'string' || typeof body.user_code !== 'string') {
    throw new Error(typeof body.error_description === 'string' ? body.error_description : `GitHub sign-in is not available (${res.status})`)
  }
  return {
    userCode: body.user_code,
    verificationUri: typeof body.verification_uri === 'string' ? body.verification_uri : 'https://github.com/login/device',
    deviceCode: body.device_code,
    interval: typeof body.interval === 'number' ? body.interval : 5,
    expiresIn: typeof body.expires_in === 'number' ? body.expires_in : 900,
  }
}

/**
 * Wait for the author to enter the code, then keep the session. Polls at GitHub's interval, slowing when told to;
 * stops on `signal`, on a refusal and when the code expires.
 */
export async function finishSignIn(code: DeviceCode, signal?: AbortSignal, fetchFn: Fetch = fetch, signinUrl = SIGNIN_URL, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<GitHubSession> {
  let interval = code.interval
  const until = Date.now() + code.expiresIn * 1000
  while (Date.now() < until) {
    await sleep(interval * 1000)
    if (signal?.aborted) throw new Error('sign-in cancelled')
    const res = await fetchFn(`${signinUrl}/device/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_code: code.deviceCode }) })
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (typeof body.access_token === 'string') {
      const login = await whoAmI(body.access_token, fetchFn)
      const session = { token: body.access_token, login }
      saveSession(session)
      return session
    }
    if (body.error === 'authorization_pending') continue
    if (body.error === 'slow_down') {
      interval = typeof body.interval === 'number' ? body.interval : interval + 5
      continue
    }
    if (body.error === 'access_denied') throw new Error('sign-in was declined on GitHub')
    if (body.error === 'expired_token') break
    throw new Error(typeof body.error_description === 'string' ? body.error_description : `GitHub sign-in failed (${res.status})`)
  }
  throw new Error('the code expired before it was entered: start again')
}

async function whoAmI(token: string, fetchFn: Fetch): Promise<string> {
  const user = await api<{ login: string }>({ token, login: '' }, 'GET', '/user', undefined, fetchFn)
  return user.login
}

/** A GitHub API error, with GitHub's message. */
export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function api<T>(session: GitHubSession, method: string, path: string, body?: unknown, fetchFn: Fetch = fetch): Promise<T> {
  const res = await fetchFn(`${API}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  if (res.status === 401) {
    saveSession(null)
    throw new GitHubError(401, 'GitHub no longer accepts this sign-in: sign in again')
  }
  const text = await res.text()
  const json = text ? (JSON.parse(text) as unknown) : null
  if (!res.ok) throw new GitHubError(res.status, (json as { message?: string } | null)?.message ?? `GitHub answered ${res.status}`)
  return json as T
}

const UP = `/repos/${PARTS_REPOSITORY.owner}/${PARTS_REPOSITORY.repo}`

/** The parts repository's namespace file. */
export async function readNamespaces(session: GitHubSession, fetchFn: Fetch = fetch): Promise<NamespaceFile> {
  const file = await api<{ content: string }>(session, 'GET', `${UP}/contents/namespaces.json?ref=${PARTS_REPOSITORY.branch}`, undefined, fetchFn)
  const text = new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\s/g, '')), (c) => c.charCodeAt(0)))
  return JSON.parse(text) as NamespaceFile
}

/** The organizations the author is a public member of (what the parts repository's CI can see too). */
export async function publicOrgs(session: GitHubSession, fetchFn: Fetch = fetch): Promise<string[]> {
  const orgs = await api<{ login: string }[]>(session, 'GET', `/users/${encodeURIComponent(session.login)}/orgs`, undefined, fetchFn)
  return orgs.map((o) => o.login)
}

export interface Submission {
  number: number
  url: string
}

/**
 * Open a pull request adding `files` (paths inside the repository) to the parts repository, from a branch of the
 * author's fork. `onStep` says what is happening, for the dialog.
 */
export async function submitPart(
  session: GitHubSession,
  sub: { partId: string; files: { path: string; bytes: Uint8Array }[]; title: string; body: string; message: string },
  onStep: (what: string) => void = () => {},
  fetchFn: Fetch = fetch,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
): Promise<Submission> {
  const call = <T>(method: string, path: string, body?: unknown): Promise<T> => api<T>(session, method, path, body, fetchFn)
  onStep('Reading the parts repository')
  const head = await call<{ object: { sha: string } }>('GET', `${UP}/git/ref/heads/${PARTS_REPOSITORY.branch}`)
  const base = await call<{ tree: { sha: string } }>('GET', `${UP}/git/commits/${head.object.sha}`)

  onStep('Making your copy of the repository')
  const fork = await call<{ owner: { login: string }; name: string }>('POST', `${UP}/forks`, { default_branch_only: true })
  const FORK = `/repos/${fork.owner.login}/${fork.name}`
  // a new fork takes a moment to exist
  for (let i = 0; ; i++) {
    try {
      await call('GET', FORK)
      break
    } catch (e) {
      if (i >= 30 || !(e instanceof GitHubError) || e.status !== 404) throw e
      await sleep(2000)
    }
  }
  // bring an older fork up to date, so the branch starts from the repository's main (best effort: a fork whose main
  // has diverged still takes the branch, which is made from the repository's own commit)
  await call('POST', `${FORK}/merge-upstream`, { branch: PARTS_REPOSITORY.branch }).catch(() => {})

  onStep('Uploading the part')
  const tree: { path: string; mode: '100644'; type: 'blob'; sha: string }[] = []
  for (const f of sub.files) {
    const blob = await call<{ sha: string }>('POST', `${FORK}/git/blobs`, { content: bytesToBase64(f.bytes), encoding: 'base64' })
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha })
  }
  const newTree = await call<{ sha: string }>('POST', `${FORK}/git/trees`, { base_tree: base.tree.sha, tree })
  const commit = await call<{ sha: string }>('POST', `${FORK}/git/commits`, { message: sub.message, tree: newTree.sha, parents: [head.object.sha] })
  const branch = `part/${sub.partId}-${Date.now().toString(36)}`
  await call('POST', `${FORK}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha })

  onStep('Opening the pull request')
  const pr = await call<{ number: number; html_url: string }>('POST', `${UP}/pulls`, {
    title: sub.title,
    head: `${fork.owner.login}:${branch}`,
    base: PARTS_REPOSITORY.branch,
    body: sub.body,
    maintainer_can_modify: true,
  })
  return { number: pr.number, url: pr.html_url }
}

export type SubmissionState = 'inReview' | 'changesRequested' | 'listed' | 'closed'

export interface SubmissionStatus {
  state: SubmissionState
  /** reviewers' words, newest last: requested changes and comments */
  comments: { author: string; body: string }[]
}

/** Where a submission stands: in review, changes requested (with what the reviewer said), listed (merged) or closed. */
export async function submissionStatus(session: GitHubSession, number: number, fetchFn: Fetch = fetch): Promise<SubmissionStatus> {
  const pr = await api<{ state: string; merged: boolean; user: { login: string } }>(session, 'GET', `${UP}/pulls/${number}`, undefined, fetchFn)
  const reviews = await api<{ state: string; body: string; user: { login: string } }[]>(session, 'GET', `${UP}/pulls/${number}/reviews`, undefined, fetchFn)
  const comments = await api<{ body: string; user: { login: string } }[]>(session, 'GET', `/repos/${PARTS_REPOSITORY.owner}/${PARTS_REPOSITORY.repo}/issues/${number}/comments`, undefined, fetchFn)
  const decided = reviews.filter((r) => r.state === 'CHANGES_REQUESTED' || r.state === 'APPROVED')
  const state: SubmissionState = pr.merged ? 'listed' : pr.state === 'closed' ? 'closed' : decided.at(-1)?.state === 'CHANGES_REQUESTED' ? 'changesRequested' : 'inReview'
  // the reviewers' words and the checks' report (the parts repository's CI comments what failed), not the author's own
  const said = [...reviews.filter((r) => r.body.trim() !== ''), ...comments]
    .filter((c) => c.user.login !== pr.user.login)
    .map((c) => ({ author: c.user.login, body: c.body }))
  return { state, comments: said }
}
