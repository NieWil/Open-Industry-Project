// Publish to Part Library (docs/part-libraries.md, "Publishing"): send a part from this project's library to the
// listed library, as a pull request to the parts repository under the author's own GitHub account.
//
// The checks that need no network run first, on this machine, from the same rules the parts repository's CI applies
// (core/parts/partSubmission.ts): the id's namespace, every asset inside the part, models and textures in the limits. CI then
// runs the part at each of its settings in a capped process (scripts/check-submission.mjs), and a person reviews it.
// The dialog then shows where the submission stands: in review, changes requested with what was said, or listed.
//
// A part the app made has an id like `user.lift-table`, which no one may publish under. Signed in, the dialog offers
// the author's own namespace, `u.<login>.lift-table`, and renames the part in the project (store.renameUserPackage:
// placed copies follow).

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { partToOippartBytes } from '../../core/parts/partArchive'
import type { PartPackage } from '../../core/parts/partPackage'
import { partFingerprint } from '../../core/parts/partOrigin'
import { namespaceProblem, RIGHTS_LINE, SUBMISSION_LIMITS, submissionProblems } from '../../core/parts/partSubmission'
import { dialogHost } from '../dialogHost'
import type { EditorStore } from '../store/store'
import { finishSignIn, publicOrgs, readNamespaces, savedSession, signOut, startSignIn, submissionStatus, submitPart } from '../publish/github'
import type { DeviceCode, GitHubSession, SubmissionStatus } from '../publish/github'
import { changedSince, pullRequestText, saveSubmissionRecord, submissionFiles, submissionRecord } from '../publish/submission'
import type { SubmissionRecord } from '../publish/submission'
import { trapTab, useModalKeys } from './inspector/menu'
import { CloseIcon } from './toolbarIcons'
import { defineMessages, t, type MessageId } from '../../core/i18n'
import { tNodes } from '../i18nNodes'

const M = defineMessages('publishPart', {
  inReview: 'In review',
  changesRequested: 'Changes requested',
  listed: 'Listed',
  closed: 'Closed without listing',
  dialog: 'Publish to Part Library',
  title: 'Publish “{name}”',
  close: 'Close',
  intro:
    'Sends this part to the listed part library as a pull request from your GitHub account. Its checks run again there, at each of its settings, and a reviewer looks at where its models came from before it is listed. Once listed, it is public under the MIT License for its code and CC BY 4.0 for its models, which allow any use, training AI models included. {link}',
  privacyLink: 'What is kept and what becomes public',
  yourSubmission: 'Your submission',
  pullRequest: 'Pull request #{number}',
  reading: 'Reading…',
  signInToSee: 'Sign in to see where it stands',
  changedSince: 'this part has changed since',
  checks: 'Checks',
  checking: 'Checking…',
  withinLimits: 'Its models, textures and size are within the limits, and everything it uses is inside it',
  checkingNamespace: 'Checking the namespace…',
  mayPublish: 'You may publish “{id}”',
  publishAs: 'Publish as “{id}”',
  ownNamespace: "Your own namespace. This changes the part's id in this project; placed copies follow.",
  listing: 'Listing',
  descriptionLabel: 'What it is and what it is for',
  descriptionPlaceholder: 'A paragraph Get parts shows beside it: what the part is, what it does in a line, and anything to set.',
  signedInAs: 'Signed in as {login}.',
  signOut: 'Sign out',
  enterCode: 'Enter {code} at {uri}. Waiting for GitHub…',
  cancel: 'Cancel',
  needsAccount: 'Publishing needs a GitHub account: the pull request is opened under it, so your name is on your part.',
  signIn: 'Sign in with GitHub',
  alreadyInReview: 'This version is already in review',
  submitVersion: 'Submit this version',
  submit: 'Submit',
})

interface Props {
  store: EditorStore
  pkg: PartPackage
  /** the part's card picture (a data URL), sent as its listing picture */
  thumbnail?: string
  onClose: () => void
  /** the part was given a new id here (its own namespace): the dialog goes on with the part under that id */
  onRenamed: (id: string) => void
}

const STATE_LABEL: Record<SubmissionStatus['state'], MessageId> = {
  inReview: M.inReview,
  changesRequested: M.changesRequested,
  listed: M.listed,
  closed: M.closed,
}

/** The id `partId` would have in the author's own namespace: `user.lift-table` as `u.<login>.lift-table`. */
export function ownNamespaceId(partId: string, login: string): string {
  const rest = partId.split('.').slice(partId.startsWith('u.') ? 2 : 1).join('.')
  return `u.${login.toLowerCase()}.${rest || 'part'}`
}

export function PublishPartDialog({ store, pkg, thumbnail, onClose, onRenamed }: Props): ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null)
  const [host] = useState(dialogHost)
  const [record, setRecord] = useState<SubmissionRecord | null>(() => submissionRecord(pkg.id))
  const [description, setDescription] = useState(record?.description ?? '')
  const [rights, setRights] = useState(false)
  const [local, setLocal] = useState<string[] | null>(null)
  const [session, setSession] = useState<GitHubSession | null>(savedSession)
  const [code, setCode] = useState<DeviceCode | null>(null)
  const [nsProblem, setNsProblem] = useState<string | null>(null)
  const [status, setStatus] = useState<SubmissionStatus | null>(null)
  const [step, setStep] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [renameError, setRenameError] = useState('')
  const signIn = useRef<AbortController | null>(null)
  useModalKeys(onClose, (e) => {
    if (dialogRef.current) trapTab(dialogRef.current, e)
  })
  useEffect(() => () => signIn.current?.abort(), [])

  // the checks that need no network
  useEffect(() => {
    let live = true
    void partToOippartBytes(pkg)
      .then((bytes) => {
        if (live) setLocal(submissionProblems(pkg, { partFileBytes: bytes.length }).map((p) => p.message))
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [pkg])

  // signed in: may this account publish under the part's namespace, and where does an earlier submission stand
  useEffect(() => {
    if (!session) return
    let live = true
    setNsProblem(null)
    void Promise.all([readNamespaces(session), publicOrgs(session)])
      .then(([ns, orgs]) => {
        if (live) setNsProblem(namespaceProblem(pkg.id, session.login, orgs, ns))
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
    if (record) {
      void submissionStatus(session, record.number)
        .then((s) => live && setStatus(s))
        .catch(() => {})
    }
    return () => {
      live = false
    }
  }, [session, pkg.id, record])

  const beginSignIn = async (): Promise<void> => {
    setError('')
    try {
      const c = await startSignIn()
      setCode(c)
      const abort = new AbortController()
      signIn.current = abort
      const s = await finishSignIn(c, abort.signal)
      setSession(s)
      setCode(null)
    } catch (e) {
      setCode(null)
      if (!signIn.current?.signal.aborted) setError(e instanceof Error ? e.message : String(e))
    }
  }

  const changed = record ? changedSince(pkg, record) : true
  const open = status === null || status.state === 'inReview' || status.state === 'changesRequested'
  // an open submission of this same version needs nothing sent; a changed part is sent as a new pull request
  const sameVersionOpen = record !== null && !changed && open
  const descriptionText = description.trim()
  const ready =
    session !== null &&
    local !== null &&
    local.length === 0 &&
    nsProblem === '' &&
    rights &&
    descriptionText !== '' &&
    descriptionText.length <= SUBMISSION_LIMITS.descriptionChars &&
    !sameVersionOpen &&
    !busy

  const submit = async (): Promise<void> => {
    if (!session || !ready) return
    setBusy(true)
    setError('')
    try {
      const text = pullRequestText(pkg, { description: descriptionText, update: record !== null && status?.state === 'listed' })
      const pr = await submitPart(session, { partId: pkg.id, files: submissionFiles(pkg, { description: descriptionText, ...(thumbnail ? { thumbnailDataUrl: thumbnail } : {}) }), ...text }, setStep)
      const next = { number: pr.number, url: pr.url, fingerprint: partFingerprint(pkg), description: descriptionText }
      saveSubmissionRecord(pkg.id, next)
      setRecord(next)
      setStatus({ state: 'inReview', comments: [] })
      setStep('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStep('')
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div className="author-backdrop" onPointerDown={onClose}>
      <div ref={dialogRef} className="author-dialog publish-dialog" role="dialog" aria-label={t(M.dialog)} data-testid="publish-part" onPointerDown={(e) => e.stopPropagation()}>
        <div className="author-head">
          <h2>{t(M.title, { name: pkg.name })}</h2>
          <button className="author-close" title={t(M.close)} aria-label={t(M.close)} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <p className="author-intro">
          {tNodes(M.intro, {
            link: (
              <a href="https://www.openindustryproject.org/privacy/" target="_blank" rel="noreferrer">
                {t(M.privacyLink)}
              </a>
            ),
          })}
        </p>

        {record && (
          <section className="publish-section" data-testid="publish-status">
            <h3>{t(M.yourSubmission)}</h3>
            <p>
              <a href={record.url} target="_blank" rel="noreferrer">
                {t(M.pullRequest, { number: record.number })}
              </a>
              {' · '}
              <span data-testid="publish-state" data-state={status?.state ?? ''}>
                {status ? t(STATE_LABEL[status.state]) : session ? t(M.reading) : t(M.signInToSee)}
              </span>
              {changed && <>{' · '}{t(M.changedSince)}</>}
            </p>
            {status && status.comments.length > 0 && (
              <ul className="publish-comments">
                {status.comments.slice(-5).map((c, i) => (
                  <li key={i}>
                    <strong>{c.author}</strong>: {c.body}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <section className="publish-section">
          <h3>{t(M.checks)}</h3>
          <ul className="publish-checks" data-testid="publish-checks">
            {local === null ? (
              <li>{t(M.checking)}</li>
            ) : local.length === 0 ? (
              <li className="ok">{t(M.withinLimits)}</li>
            ) : (
              local.map((p) => (
                <li key={p} className="bad">
                  {p}
                </li>
              ))
            )}
            {session && nsProblem === null && <li>{t(M.checkingNamespace)}</li>}
            {session && nsProblem === '' && <li className="ok">{t(M.mayPublish, { id: pkg.id })}</li>}
            {session && nsProblem && <li className="bad">{nsProblem}</li>}
          </ul>
          {session && nsProblem && !pkg.id.startsWith(`u.${session.login.toLowerCase()}.`) && (
            <p className="publish-rename">
              <button
                type="button"
                data-testid="publish-rename"
                onClick={() => {
                  const to = ownNamespaceId(pkg.id, session.login)
                  const refused = store.renameUserPackage(pkg.id, to)
                  if (refused) setRenameError(refused)
                  else {
                    setRenameError('')
                    onRenamed(to)
                  }
                }}
              >
                {t(M.publishAs, { id: ownNamespaceId(pkg.id, session.login) })}
              </button>{' '}
              <span className="publish-hint">{t(M.ownNamespace)}</span>
              {renameError && <span className="publish-error-inline">{renameError}</span>}
            </p>
          )}
        </section>

        <section className="publish-section">
          <h3>{t(M.listing)}</h3>
          <label className="publish-field">
            {t(M.descriptionLabel)}
            <textarea
              data-testid="publish-description"
              rows={4}
              maxLength={SUBMISSION_LIMITS.descriptionChars}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t(M.descriptionPlaceholder)}
            />
          </label>
          <label className="publish-check">
            <input type="checkbox" data-testid="publish-rights" checked={rights} onChange={(e) => setRights(e.target.checked)} />
            {RIGHTS_LINE}
          </label>
        </section>

        <section className="publish-section">
          {/* i18n-ok: a product name */}
          <h3>GitHub</h3>
          {session ? (
            <p data-testid="publish-signed-in">
              {tNodes(M.signedInAs, { login: <strong>{session.login}</strong> })}{' '}
              <button
                type="button"
                className="publish-link"
                onClick={() => {
                  signOut()
                  setSession(null)
                  setNsProblem(null)
                  setStatus(null)
                }}
              >
                {t(M.signOut)}
              </button>
            </p>
          ) : code ? (
            <p data-testid="publish-device-code">
              {tNodes(M.enterCode, {
                code: <strong className="publish-code">{code.userCode}</strong>,
                uri: (
                  <a href={code.verificationUri} target="_blank" rel="noreferrer">
                    {code.verificationUri}
                  </a>
                ),
              })}{' '}
              <button
                type="button"
                className="publish-link"
                onClick={() => {
                  signIn.current?.abort()
                  setCode(null)
                }}
              >
                {t(M.cancel)}
              </button>
            </p>
          ) : (
            <p>
              {t(M.needsAccount)}{' '}
              <button type="button" data-testid="publish-sign-in" onClick={() => void beginSignIn()}>
                {t(M.signIn)}
              </button>
            </p>
          )}
        </section>

        {error && (
          <p className="publish-error" data-testid="publish-error">
            {error}
          </p>
        )}
        {step && <p className="publish-step">{step}…</p>}
        <div className="export-dialog-actions">
          <button onClick={onClose}>{t(M.close)}</button>
          <button data-testid="publish-submit" disabled={!ready} title={sameVersionOpen ? t(M.alreadyInReview) : undefined} onClick={() => void submit()}>
            {record && changed && status?.state !== 'closed' ? t(M.submitVersion) : t(M.submit)}
          </button>
        </div>
      </div>
    </div>,
    host,
  )
}
