// In-browser behavior-script editor for custom parts - the web peer of the desktop "eject to VS Code" loop.
//
// A part = geometry (rig links/joints, edited in the Inspector) + a behavior script run every sim tick. On
// the desktop the script ejects to a watched folder and opens in VS Code; this is the browser's way to author
// it (docs/architecture.md). It mounts Monaco with the Part SDK `.d.ts` loaded, so `definePart`/`ctx.*`
// autocomplete and type-check with no import in the script. Every Apply goes through the same validatePart()
// the disk-import path uses, so the two surfaces can't drift.
//
// Lazy-loaded (React.lazy from the Inspector) so Monaco + its TS worker stay out of the main editor bundle and
// only download when someone actually opens the editor.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import * as monaco from 'monaco-editor'
// monaco 0.54+ ships an exports map that rewrites every subpath as ./* -> ./esm/vs/*.js, so
// 'monaco-editor/esm/vs/...' specifiers resolve to esm/vs/esm/vs/... and silently fail to load:
// no worker, no editor, no error you would recognise. Address the files by their mapped paths.
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import tsWorker from 'monaco-editor/languages/features/typescript/ts.worker.js?worker'
// The generated Part SDK types - the same surface an external author installs as `@oip/part-sdk`. Loaded as
// raw text and handed to Monaco's TS service so the script gets real IntelliSense against ctx/definePart.
import partSdkIndexDts from '../../../packages/part-sdk/index.d.ts?raw'
import partSdkGlobalDts from '../../../packages/part-sdk/global.d.ts?raw'
import partSdkManifestDts from '../../../packages/part-sdk/manifest.d.ts?raw'
import { getPackage } from '../../core/parts/partRegistry'
import { getRoomCodeGate, peersEditingPart, setLocalEditingPart, subscribePeers, type RemotePeer } from '../../collab/session'
import type { PartDiagnostic } from '../../sim/validatePart'
import type { EditorController } from '../controller'
import { CloseIcon } from './toolbarIcons'
import { appearanceRev, resolvedAppearance, subscribeAppearance } from '../appearance'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('behaviorEditor', {
  applied: 'Applied. Press Play to run the new behavior.',
  problemsToFix: {
    one: '{count} problem to fix before this applies.',
    other: '{count} problems to fix before this applies.',
  },
  confirmClose: 'Close without applying? Your changes to this behavior will be lost.',
  dialogLabel: 'Edit behavior',
  title: 'Behavior:',
  close: 'Close',
  codeHeld:
    "This part's code comes from someone else in this shared project and is blocked on your computer, so this shows the stand-in it runs instead. Allow its part code to see and edit the real script.",
  othersEditingReadOnly: {
    one: '{names} is editing this part (opened read-only).',
    other: '{names} are editing this part (opened read-only).',
  },
  takeOver: 'Take over',
  othersEditing: {
    one: '{names} also has this part open. Your changes may overwrite theirs.',
    other: '{names} also have this part open. Your changes may overwrite theirs.',
  },
  noProblems: 'No problems. The script is valid.',
  lineN: 'line {line}',
  goToLine: 'Go to line {line}',
  apply: 'Apply',
})

// One-time Monaco wiring: register only the editor + TypeScript workers (not css/html/json - they'd just bloat
// the chunk), turn on JS type-checking, and load the SDK types as ambient libs so `definePart` is a typed
// global. Guarded so re-opening the editor doesn't re-register.
let configured = false
function configureMonaco(): void {
  if (configured) return
  configured = true
  ;(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
    getWorker(_id, label) {
      return label === 'typescript' || label === 'javascript' ? new tsWorker() : new editorWorker()
    },
  }
  const js = monaco.typescript.javascriptDefaults
  js.setCompilerOptions({
    target: monaco.typescript.ScriptTarget.ESNext,
    allowJs: true,
    checkJs: true,
    moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
    allowNonTsExtensions: true,
    noEmit: true,
  })
  js.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false })
  // Same directory + relative paths as the published package, so global.d.ts's `import './index'` resolves and
  // its `declare global { function definePart }` augmentation applies to the (import-free) behavior script.
  js.addExtraLib(partSdkIndexDts, 'file:///node_modules/@oip/part-sdk/index.d.ts')
  js.addExtraLib(partSdkGlobalDts, 'file:///node_modules/@oip/part-sdk/global.d.ts')
  // index.d.ts re-exports the manifest types, so the file it names has to be there too
  js.addExtraLib(partSdkManifestDts, 'file:///node_modules/@oip/part-sdk/manifest.d.ts')
}

interface Props {
  packageId: string
  controller: EditorController | null
  onClose: () => void
}

const noSubscribe = (): (() => void) => () => {}

/**
 * Modal Monaco editor for a custom part's behavior script. Live-validates while typing (squiggles + a problem
 * list, validate-only - no commit) and applies the script to the live package on Apply, which is what keeps it:
 * the edit lands in the project's parts, stored with the project. Closing with unapplied changes asks first.
 * Default-exported for React.lazy.
 */
export default function BehaviorEditor({ packageId, controller, onClose }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  // the script as last applied (or as opened): closing with anything else in the editor asks first
  const appliedRef = useRef('')
  const [diags, setDiags] = useState<PartDiagnostic[]>([])
  const [status, setStatus] = useState<string | null>(null)
  // Soft lock: who else has this part open. If a peer already holds it we open read-only and offer
  // "Take over"; otherwise we claim it over awareness. Last-write-wins on a behavior script means
  // concurrent saves silently clobber, so this turns that into a visible, opt-in choice rather than
  // an enforced mutex (a hard lock can't be arbitrated on this CRDT transport and would strand a
  // crashed holder's lock). See store.commitPackage / schema.writePackage.
  const [othersEditing, setOthersEditing] = useState<RemotePeer[]>(() => peersEditingPart(packageId))
  const [readOnly, setReadOnly] = useState<boolean>(() => peersEditingPart(packageId).length > 0)
  const claimedRef = useRef(false)
  // A part whose room code is held back here (collab/codeTrust.ts) carries a stand-in script, not its author's:
  // editing it would be editing the wrong code, so it opens read-only until the user allows the room's code, and
  // the editor reloads with the real script the moment they do.
  const gate = getRoomCodeGate()
  const codeHeld = useSyncExternalStore(gate?.subscribe ?? noSubscribe, () => gate?.isHeld(packageId) ?? false)
  const locked = readOnly || codeHeld
  const pkg = getPackage(packageId)
  const pkgName = pkg?.name ?? packageId

  // Push validatePart's typed/located diagnostics onto the model as markers (squiggles) and into the panel list.
  const applyDiagnostics = (model: monaco.editor.ITextModel, d: PartDiagnostic[]): void => {
    setDiags(d)
    monaco.editor.setModelMarkers(
      model,
      'oip-part',
      d
        .filter((x) => x.line !== undefined)
        .map((x) => ({
          severity: monaco.MarkerSeverity.Error,
          message: `[${x.kind}] ${x.message}`,
          startLineNumber: x.line!,
          startColumn: x.column ?? 1,
          endLineNumber: x.line!,
          endColumn: (x.column ?? 1) + 1,
        })),
    )
  }

  useEffect(() => {
    configureMonaco()
    const host = hostRef.current
    if (!host) return
    const model = monaco.editor.createModel(pkg?.behavior ?? '', 'javascript', monaco.Uri.parse(`file:///behavior-${packageId}.js`))
    appliedRef.current = model.getValue()
    const editor = monaco.editor.create(host, {
      model,
      theme: resolvedAppearance() === 'light' ? 'vs' : 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      tabSize: 2,
      scrollBeyondLastLine: false,
      renderWhitespace: 'none',
      readOnly: locked,
    })
    editorRef.current = editor

    // Debounced live validate (validate-only; no package commit) so squiggles track the script as you type.
    let timer: ReturnType<typeof setTimeout> | undefined
    const sub = model.onDidChangeContent(() => {
      clearTimeout(timer)
      timer = setTimeout(() => applyDiagnostics(model, controller?.validateBehavior(packageId, model.getValue()) ?? []), 500)
    })
    // initial pass
    applyDiagnostics(model, controller?.validateBehavior(packageId, model.getValue()) ?? [])

    return () => {
      clearTimeout(timer)
      sub.dispose()
      editor.dispose()
      model.dispose()
      editorRef.current = null
    }
    // packageId is the identity of the part being edited; controller is stable for the session. codeHeld flips
    // once, when the room's code is allowed, and the model must then show the real script instead of the stand-in.
  }, [packageId, codeHeld])

  // Soft lock over awareness. Claim the part whenever nobody else holds it (on open, or when the
  // current holder leaves - presence is ephemeral, so a disconnect releases it), and release on close.
  useEffect(() => {
    const refresh = (): void => {
      const others = peersEditingPart(packageId)
      setOthersEditing(others)
      if (others.length === 0 && !claimedRef.current) {
        setLocalEditingPart(packageId)
        claimedRef.current = true
        setReadOnly(false)
      }
    }
    refresh()
    const unsub = subscribePeers(refresh)
    return () => {
      unsub()
      if (claimedRef.current) {
        setLocalEditingPart(null)
        claimedRef.current = false
      }
    }
  }, [packageId])

  // Monaco takes a theme name, not CSS, so it follows the app's light / dark by hand (appearance.ts).
  // setTheme is global to Monaco, which is right: there is one app theme.
  const appearance = useSyncExternalStore(subscribeAppearance, appearanceRev)
  useEffect(() => {
    monaco.editor.setTheme(resolvedAppearance() === 'light' ? 'vs' : 'vs-dark')
  }, [appearance])

  // Keep Monaco's editability in sync with the lock (e.g. after "Take over").
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly: locked })
  }, [locked])

  // Grab the lock even though a peer holds it (soft, not enforced): both then see the warn banner.
  const takeOver = (): void => {
    setLocalEditingPart(packageId)
    claimedRef.current = true
    setReadOnly(false)
  }

  // Commit the script to the live package (registerPackage → instances pick it up on the next sim run).
  const apply = (): boolean => {
    if (locked) return false
    const model = editorRef.current?.getModel()
    if (!model) return false
    const d = controller?.editBehavior(packageId, model.getValue()) ?? []
    applyDiagnostics(model, d)
    if (d.length === 0) {
      appliedRef.current = model.getValue()
      setStatus(t(M.applied))
      return true
    }
    setStatus(t(M.problemsToFix, { count: d.length }))
    return false
  }

  // A problem's line: put the cursor there, scroll it into view and hand the keyboard back to the editor.
  const goTo = (line: number, column = 1): void => {
    const editor = editorRef.current
    if (!editor) return
    editor.setPosition({ lineNumber: line, column })
    editor.revealLineInCenterIfOutsideViewport(line)
    editor.focus()
  }

  // Close, but never silently drop an edit that hasn't been applied: the backdrop is one stray click away.
  const requestClose = (): void => {
    const current = editorRef.current?.getModel()?.getValue()
    if (!locked && current !== undefined && current !== appliedRef.current && !window.confirm(t(M.confirmClose))) return
    onClose()
  }


  return createPortal(
    <div className="behavior-backdrop" onClick={requestClose}>
      <div className="behavior-dialog" role="dialog" aria-label={t(M.dialogLabel)} onClick={(e) => e.stopPropagation()}>
        <div className="behavior-head">
          <h2>
            {t(M.title)} <span className="behavior-pkg">{pkgName}</span>
          </h2>
          <button className="behavior-close" title={t(M.close)} onClick={requestClose}>
            <CloseIcon />
          </button>
        </div>
        {codeHeld && (
          <div className="behavior-lock behavior-lock-warn" data-testid="behavior-code-held">
            <span>{t(M.codeHeld)}</span>
          </div>
        )}
        {othersEditing.length > 0 && (
          <div className={`behavior-lock${readOnly ? '' : ' behavior-lock-warn'}`}>
            {readOnly ? (
              <>
                <span>
                  {t(M.othersEditingReadOnly, { count: othersEditing.length, names: othersEditing.map((p) => p.name).join(', ') })}
                </span>
                <button className="behavior-btn" onClick={takeOver}>
                  {t(M.takeOver)}
                </button>
              </>
            ) : (
              <span>
                ⚠ {t(M.othersEditing, { count: othersEditing.length, names: othersEditing.map((p) => p.name).join(', ') })}
              </span>
            )}
          </div>
        )}
        <div ref={hostRef} className="behavior-monaco" />
        <div className="behavior-problems">
          {diags.length === 0 ? (
            <span className="behavior-ok">{t(M.noProblems)}</span>
          ) : (
            diags.map((d, i) => {
              const body = (
                <>
                  <span className="behavior-problem-kind">{d.kind}</span>
                  {d.line !== undefined ? <span className="behavior-problem-loc">{t(M.lineN, { line: d.line })}</span> : null}
                  <span className="behavior-problem-msg">{d.message}</span>
                </>
              )
              // a located problem is a link to its line, as a problems list is everywhere else
              return d.line !== undefined ? (
                <button key={i} type="button" className="behavior-problem behavior-problem-link" title={t(M.goToLine, { line: d.line })} onClick={() => goTo(d.line!, d.column)}>
                  {body}
                </button>
              ) : (
                <div key={i} className="behavior-problem">
                  {body}
                </div>
              )
            })
          )}
        </div>
        <div className="behavior-foot">
          <span className="behavior-status">{status}</span>
          <div className="behavior-actions">
            {/* Apply is all there is: the edit lands in the project's parts, which are stored with the project (on the
                desktop in its folder, by the folder sync) - nothing separate to save */}
            <button className="behavior-btn behavior-btn-primary" onClick={apply} disabled={!controller || locked}>
              {t(M.apply)}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
