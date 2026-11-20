import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { declareTagIn, deleteTag, editTag, scopeOfPou, tagNameError, tagTypeOptions, type TagRow, type TagScope } from '../../../plc/tags'
import type { VarSection } from '../../../plc/types'
import { ComboBox, type ComboOption } from '../ComboBox'
import { TrashIcon } from '../toolbarIcons'
import { defineMessages, t, type MessageId } from '../../../core/i18n'

const M = defineMessages('ladderVariables', {
  usageInput: 'Input',
  usageOutput: 'Output',
  usageInOut: 'In/out',
  usageLocal: 'Local',
  usageTemp: 'Temp',
  usageGlobal: 'Global',
  titleInput: 'An input: written by a part in the scene, or by whoever calls the block',
  titleOutput: 'An output: read by a part in the scene, or by whoever calls the block',
  titleInOut: 'Passed in by reference: the caller\'s own variable',
  titleLocal: 'A local variable: kept from one scan to the next',
  titleTemp: 'A temporary: starts over every scan',
  needsType: '{name} needs a type.',
  typeRequired: 'A type is required.',
  colName: 'Name',
  colType: 'Type',
  colUsage: 'Usage',
  colInitial: 'Initial',
  colComment: 'Comment',
  colCommands: 'Commands',
  nameOf: 'Name of {name}',
  showInText: 'Show {name} in the text',
  showDeclaration: 'Show the declaration in the text',
  typeOf: 'Type of {name}',
  constant: ' (constant)',
  usageOf: 'Usage of {name}',
  commentOn: 'Comment on {name}',
  deleteName: 'Delete {name}',
  deleteHint: 'Delete the declaration. Rungs that still use it are then marked, until it is declared again',
  noVariables: 'No variables yet',
  newNameLabel: 'Name of a new variable',
  newNamePlaceholder: 'New variable',
  newTypeLabel: 'Type of the new variable',
  newUsageLabel: 'Usage of the new variable',
  newCommentLabel: 'Comment on the new variable',
  add: 'Add',
})

// The declaration pane over a ladder section: the variables of the POU the rungs stand in, as rows (the POU's
// declaration part, shown above its rungs). A ladder program has no VAR block on screen, so this is where its
// variables are read and changed without switching to the text.
//
// Every change is a text edit of the declaration (plc/tags.ts - the same doors the tag editing uses, because a
// variable and a tag are one thing in this engine), handed to the Ladder view's `onEdit`, so it is one step of the
// same undo history as a rung edit. Variables and tags
// share those edits because a tag rename follows scope, as a variable rename must.
//
// A rename is the exception: it moves the scene's wiring with it in the same commit (tags.ts `tagRenamesForScene`,
// editor/program/controllerCommit.ts), which `onEdit(next: string)` cannot make, so it goes through `onRenameTag` - the
// panel's rename (plcPanelParts.tsx `renameDeclaration`).

/** What a POU can declare, and what each section means to it. The code outside every POU holds the top-level
 *  variables: its inputs are written by the scene's parts and its outputs read by them. */
const USAGES: Record<'top' | 'program' | 'block', readonly VarSection[]> = {
  top: ['VAR_INPUT', 'VAR_OUTPUT', 'VAR'],
  program: ['VAR_INPUT', 'VAR_OUTPUT', 'VAR', 'VAR_TEMP'],
  block: ['VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR', 'VAR_TEMP'],
}
/** A section's name and tooltip, as message ids (`usageLabel` / `usageTitle` resolve them). */
const USAGE_LABEL: Record<string, MessageId> = { VAR_INPUT: M.usageInput, VAR_OUTPUT: M.usageOutput, VAR_IN_OUT: M.usageInOut, VAR: M.usageLocal, VAR_TEMP: M.usageTemp, VAR_GLOBAL: M.usageGlobal }
const USAGE_TITLE: Record<string, MessageId> = {
  VAR_INPUT: M.titleInput,
  VAR_OUTPUT: M.titleOutput,
  VAR_IN_OUT: M.titleInOut,
  VAR: M.titleLocal,
  VAR_TEMP: M.titleTemp,
}
const usageLabel = (section: string): string | undefined => {
  const id = USAGE_LABEL[section]
  return id === undefined ? undefined : t(id)
}
const usageTitle = (section: string): string | undefined => {
  const id = USAGE_TITLE[section]
  return id === undefined ? undefined : t(id)
}

interface LadderVariablesProps {
  source: string
  /** the POU the section stands in ('' for the code outside every POU) and its kind */
  pou: string
  kind: 'top' | 'program' | 'block'
  rows: readonly TagRow[]
  readOnly: boolean
  onEdit: (next: string) => void
  /** show a declaration in the text */
  onShowText?: (offset: number) => void
  /** rename a declaration, carrying the scene's wiring with it in the same commit; absent = the names are read-only
   *  here (the pane cannot make that commit itself - see the header) */
  onRenameTag?: (scope: TagScope, from: string, to: string) => Promise<string | null>
}

/** A text cell that commits on Enter and on blur, and snaps back on Escape. */
function Cell({ value, label, testid, disabled, placeholder, onCommit }: { value: string; label: string; testid: string; disabled: boolean; placeholder?: string; onCommit: (v: string) => void }): ReactElement {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = (): void => {
    if (draft.trim() !== value) onCommit(draft)
  }
  return (
    <input
      className="ld-vars-field"
      data-testid={testid}
      aria-label={label}
      spellCheck={false}
      disabled={disabled}
      placeholder={placeholder}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          setDraft(value)
        }
      }}
    />
  )
}

export function LadderVariables({ source, pou, kind, rows, readOnly, onEdit, onShowText, onRenameTag }: LadderVariablesProps): ReactElement {
  const usages = USAGES[kind]
  const scope = scopeOfPou(pou)
  const [adding, setAdding] = useState({ name: '', type: 'BOOL', section: usages.includes('VAR') ? ('VAR' as VarSection) : usages[0]!, description: '' })
  const [error, setError] = useState<string | null>(null)
  // The types a variable can be (a ComboBox over plc/tags.ts `tagTypeOptions`): picked from the list or typed, and
  // anything the list does not hold (`ARRAY[1..5] OF INT`, `STRING[20]`) typed as it is. One array per program
  // text, shared by every row: ComboBox builds its <option>s once per array.
  const typeOptions = useMemo((): readonly ComboOption[] => tagTypeOptions(source).flatMap((g) => g.types.map((type) => ({ value: type, label: type, group: g.group }))), [source])
  const edit = (next: string): void => {
    setError(null)
    if (next !== source) onEdit(next)
  }
  const change = (r: TagRow, patch: Partial<{ type: string; section: VarSection; description: string }>): void => {
    // (the name is handed back unchanged, so this is never `editTag`'s rename path)
    const next = { name: r.name, type: r.type, section: r.section, description: r.description, ...patch }
    if (next.type.trim() === '') return setError(t(M.needsType, { name: r.name }))
    const out = editTag(source, scope, r.name, next)
    if (out.source === null) return setError(out.error)
    edit(out.source)
  }
  /** A new name for a declaration. Not an `edit`: the owner commits it, with the scene's wiring, and says why not. */
  const rename = (r: TagRow, to: string): void => {
    const name = to.trim()
    if (!onRenameTag || name === '' || name === r.name) return
    void onRenameTag(scope, r.name, name)
      .then(setError)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }
  const add = (): void => {
    const why = tagNameError(source, scope, adding.name)
    if (why) return setError(why)
    if (adding.type.trim() === '') return setError(t(M.typeRequired))
    edit(declareTagIn(source, scope, adding))
    setAdding({ ...adding, name: '', description: '' })
  }
  return (
    <div className="ld-vars" data-testid="ld-vars" data-pou={pou}>
      <table className="ld-vars-table">
        <thead>
          <tr>
            <th>{t(M.colName)}</th>
            <th>{t(M.colType)}</th>
            <th>{t(M.colUsage)}</th>
            <th>{t(M.colInitial)}</th>
            <th>{t(M.colComment)}</th>
            {!readOnly && <th aria-label={t(M.colCommands)} />}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            // what a pane cannot change without changing what it is: a constant, or an external's view of a global
            const fixed = readOnly || r.constant
            return (
              <tr key={`${r.name}:${r.offset}`} data-testid="ld-var" data-name={r.name}>
                <td>
                  {onRenameTag && !fixed ? (
                    <span className="ld-vars-namecell">
                      <Cell value={r.name} label={t(M.nameOf, { name: r.name })} testid="ld-var-name" disabled={false} onCommit={(to) => rename(r, to)} />
                      {onShowText && (
                        <button type="button" className="ld-vars-btn" data-testid="ld-var-show" aria-label={t(M.showInText, { name: r.name })} title={t(M.showDeclaration)} onClick={() => onShowText(r.offset)}>
                          ↗
                        </button>
                      )}
                    </span>
                  ) : (
                    <button type="button" className="ld-vars-name" title={onShowText ? t(M.showDeclaration) : undefined} disabled={!onShowText} onClick={() => onShowText?.(r.offset)}>
                      {r.name}
                    </button>
                  )}
                  {/* i18n-ok: IEC keyword AT, and a direct address */}
                  {r.location && <span className="ld-vars-dim"> AT {r.location}</span>}
                </td>
                <td>
                  <ComboBox value={r.type} label={t(M.typeOf, { name: r.name })} testid="ld-var-type" disabled={fixed} allowCustom options={typeOptions} onChange={(type) => change(r, { type })} />
                </td>
                <td>
                  {fixed || !usages.includes(r.section as VarSection) ? (
                    <span className="ld-vars-dim" title={usageTitle(r.section)}>
                      {usageLabel(r.section) ?? r.section}
                      {r.constant ? t(M.constant) : ''}
                    </span>
                  ) : (
                    <select className="ld-vars-field" data-testid="ld-var-usage" aria-label={t(M.usageOf, { name: r.name })} value={r.section} title={usageTitle(r.section)} onChange={(e) => change(r, { section: e.target.value as VarSection })}>
                      {usages.map((u) => (
                        <option key={u} value={u} title={usageTitle(u)}>
                          {usageLabel(u)}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td className="ld-vars-dim">{r.init}</td>
                <td>
                  <Cell value={r.description} label={t(M.commentOn, { name: r.name })} testid="ld-var-comment" disabled={fixed} onCommit={(description) => change(r, { description })} />
                </td>
                {!readOnly && (
                  <td>
                    <button
                      type="button"
                      className="ld-vars-btn"
                      data-testid="ld-var-delete"
                      aria-label={t(M.deleteName, { name: r.name })}
                      title={t(M.deleteHint)}
                      onClick={() => edit(deleteTag(source, scope, r.name))}
                    >
                      <TrashIcon size="1em" />
                    </button>
                  </td>
                )}
              </tr>
            )
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={readOnly ? 5 : 6} className="ld-vars-dim">
                {t(M.noVariables)}
              </td>
            </tr>
          )}
          {!readOnly && (
            <tr className="ld-vars-add">
              <td>
                <input
                  className="ld-vars-field"
                  data-testid="ld-var-new-name"
                  aria-label={t(M.newNameLabel)}
                  placeholder={t(M.newNamePlaceholder)}
                  spellCheck={false}
                  value={adding.name}
                  onChange={(e) => {
                    setError(null)
                    setAdding({ ...adding, name: e.target.value })
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      add()
                    }
                  }}
                />
              </td>
              {/* Enter adds the row, as in the name box - once the box is not being typed in: while it is, the combo
                  box takes Enter for the completion and stops it there, so picking and adding are two presses */}
              <td
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    add()
                  }
                }}
              >
                <ComboBox value={adding.type} label={t(M.newTypeLabel)} testid="ld-var-new-type" allowCustom options={typeOptions} onChange={(type) => setAdding({ ...adding, type })} />
              </td>
              <td>
                <select className="ld-vars-field" data-testid="ld-var-new-usage" aria-label={t(M.newUsageLabel)} value={adding.section} onChange={(e) => setAdding({ ...adding, section: e.target.value as VarSection })}>
                  {usages.map((u) => (
                    <option key={u} value={u} title={usageTitle(u)}>
                      {usageLabel(u)}
                    </option>
                  ))}
                </select>
              </td>
              <td />
              <td>
                <input
                  className="ld-vars-field"
                  aria-label={t(M.newCommentLabel)}
                  value={adding.description}
                  onChange={(e) => setAdding({ ...adding, description: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      add()
                    }
                  }}
                />
              </td>
              <td>
                <button type="button" className="ld-vars-btn" data-testid="ld-var-add" disabled={adding.name.trim() === ''} onClick={add}>
                  {t(M.add)}
                </button>
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {error && (
        <div className="ld-vars-error" role="alert" data-testid="ld-var-error">
          ⚠ {error}
        </div>
      )}
    </div>
  )
}
