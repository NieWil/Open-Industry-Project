// The find/replace panel for the ST editor, in place of @codemirror/search's stock one. One row: the
// query with its match-case / whole-word / regexp toggles inside the field, a match count, previous /
// next / select-all and close. The replace row opens from the chevron and stays open for the session.
// The stock panel's words were English-only and lowercase; these go through i18n.

import { closeSearchPanel, findNext, findPrevious, getSearchQuery, replaceAll, replaceNext, SearchQuery, selectMatches, setSearchQuery } from '@codemirror/search'
import { runScopeHandlers, type EditorView, type Panel, type ViewUpdate } from '@codemirror/view'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('stSearch', {
  find: 'Find',
  replace: 'Replace',
  replaceAll: 'Replace all',
  toggleReplace: 'Show replace',
  matchCase: 'Match case',
  wholeWord: 'Whole word',
  regexp: 'Regular expression',
  previous: 'Previous match',
  next: 'Next match',
  selectAll: 'Select all matches',
  close: 'Close',
  noResults: 'No results',
  badPattern: 'Invalid pattern',
  current: '{at} of {count}',
  count: { one: '{count} match', other: '{count} matches' },
  countCapped: '{count}+ matches',
})

// counting every match on each keystroke is cheap for a program; the cap keeps a one-letter regexp over
// a large one from scanning past what anyone reads
const COUNT_CAP = 1000

// the replace row's open state outlives one panel, so Ctrl-F after a replace reopens it
let replaceOpen = false

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string }, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  Object.assign(node, props)
  node.append(...children)
  return node
}

// 16px stroke icons drawn in currentColor. Unicode arrows fall back to a colour emoji font on Windows.
const ICONS = {
  up: 'M8 13V3M3.5 7.5 8 3l4.5 4.5',
  down: 'M8 3v10M3.5 8.5 8 13l4.5-4.5',
  all: 'M3 4.5h10M3 8h10M3 11.5h10',
  chevron: 'M6 3.5 10.5 8 6 12.5',
  close: 'M4 4l8 8M12 4l-8 8',
} as const

function icon(name: keyof typeof ICONS): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(ns, 'path')
  path.setAttribute('d', ICONS[name])
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '1.5')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  svg.append(path)
  return svg
}

function iconButton(name: string, label: string, content: string | Node, onClick: () => void): HTMLButtonElement {
  const b = el('button', { type: 'button', name, title: label, className: 'cm-st-search-btn', onclick: onClick }, content)
  b.setAttribute('aria-label', label)
  return b
}

function toggle(name: string, label: string, text: string, on: boolean, onChange: () => void): HTMLButtonElement {
  const b = iconButton(name, label, text, () => {
    b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'))
    onChange()
  })
  b.classList.add('cm-st-search-toggle')
  b.setAttribute('aria-pressed', String(on))
  return b
}

class StSearchPanel implements Panel {
  readonly dom: HTMLElement
  readonly top = true
  private query: SearchQuery
  private readonly searchField: HTMLInputElement
  private readonly replaceField: HTMLInputElement
  private readonly caseToggle: HTMLButtonElement
  private readonly wordToggle: HTMLButtonElement
  private readonly reToggle: HTMLButtonElement
  private readonly countEl: HTMLElement
  private readonly replaceRow: HTMLElement | null
  private readonly chevron: HTMLButtonElement | null

  constructor(private readonly view: EditorView) {
    const query = (this.query = getSearchQuery(view.state))
    const commit = () => this.commit()
    const field = (name: string, label: string, value: string) => {
      const f = el('input', { name, value, placeholder: label, className: 'cm-textfield', onchange: commit, onkeyup: commit, oninput: commit })
      f.setAttribute('aria-label', label)
      f.setAttribute('form', '')
      return f
    }
    this.searchField = field('search', t(M.find), query.search)
    // openSearchPanel focuses the field carrying this attribute
    this.searchField.setAttribute('main-field', 'true')
    this.replaceField = field('replace', t(M.replace), query.replace)
    this.caseToggle = toggle('case', t(M.matchCase), 'Aa', query.caseSensitive, commit) // i18n-ok: glyph
    this.wordToggle = toggle('word', t(M.wholeWord), 'W', query.wholeWord, commit) // i18n-ok: glyph
    this.reToggle = toggle('re', t(M.regexp), '.*', query.regexp, commit) // i18n-ok: glyph
    this.countEl = el('span', { className: 'cm-st-search-count' })
    this.countEl.setAttribute('aria-live', 'polite')

    const findRow = el(
      'div',
      { className: 'cm-st-search-row' },
      el('span', { className: 'cm-st-search-field' }, this.searchField, this.caseToggle, this.wordToggle, this.reToggle),
      this.countEl,
      iconButton('prev', t(M.previous), icon('up'), () => findPrevious(view)),
      iconButton('next', t(M.next), icon('down'), () => findNext(view)),
      iconButton('select', t(M.selectAll), icon('all'), () => selectMatches(view)),
      iconButton('close', t(M.close), icon('close'), () => closeSearchPanel(view)),
    )
    if (view.state.readOnly) {
      this.replaceRow = this.chevron = null
      this.dom = el('div', { className: 'cm-search cm-st-search' }, findRow)
    } else {
      this.chevron = iconButton('toggleReplace', t(M.toggleReplace), icon('chevron'), () => this.showReplace(!replaceOpen))
      this.chevron.classList.add('cm-st-search-chevron')
      this.replaceRow = el(
        'div',
        { className: 'cm-st-search-row' },
        el('span', { className: 'cm-st-search-field' }, this.replaceField),
        el('button', { type: 'button', name: 'replace', className: 'cm-button', onclick: () => replaceNext(view) }, t(M.replace)),
        el('button', { type: 'button', name: 'replaceAll', className: 'cm-button', onclick: () => replaceAll(view) }, t(M.replaceAll)),
      )
      this.dom = el('div', { className: 'cm-search cm-st-search' }, this.chevron, el('div', { className: 'cm-st-search-rows' }, findRow, this.replaceRow))
      this.showReplace(replaceOpen || query.replace !== '')
    }
    this.dom.addEventListener('keydown', (e) => this.keydown(e))
    this.recount()
  }

  private showReplace(open: boolean): void {
    if (!this.replaceRow || !this.chevron) return
    replaceOpen = open
    this.replaceRow.hidden = !open
    this.chevron.setAttribute('aria-expanded', String(open))
  }

  private commit(): void {
    const query = new SearchQuery({
      search: this.searchField.value,
      replace: this.replaceField.value,
      caseSensitive: this.caseToggle.getAttribute('aria-pressed') === 'true',
      wholeWord: this.wordToggle.getAttribute('aria-pressed') === 'true',
      regexp: this.reToggle.getAttribute('aria-pressed') === 'true',
    })
    if (query.eq(this.query)) return
    this.query = query
    this.view.dispatch({ effects: setSearchQuery.of(query) })
  }

  private keydown(e: KeyboardEvent): void {
    // the search-panel scope carries Escape, Mod-f and the rest of searchKeymap. A key it ran is the panel's alone:
    // Escape removes the panel before the event reaches the window, so the app's own region check cannot see where
    // the key came from, and its window-level Escape would also clear the 3D selection
    if (runScopeHandlers(this.view, e, 'search-panel')) {
      e.preventDefault()
      e.stopPropagation()
    } else if (e.key === 'Enter' && e.target === this.searchField) {
      e.preventDefault()
      ;(e.shiftKey ? findPrevious : findNext)(this.view)
    } else if (e.key === 'Enter' && e.target === this.replaceField) {
      e.preventDefault()
      ;(e.ctrlKey || e.metaKey ? replaceAll : replaceNext)(this.view)
    }
  }

  private recount(): void {
    const { query, view } = this
    const empty = query.search === ''
    this.searchField.classList.toggle('cm-st-search-invalid', !empty && !query.valid)
    if (empty) {
      this.countEl.textContent = ''
      return
    }
    if (!query.valid) {
      this.countEl.textContent = t(M.badPattern)
      return
    }
    const sel = view.state.selection.main
    let count = 0
    let at = 0
    const cursor = query.getCursor(view.state)
    for (let r = cursor.next(); !r.done && count < COUNT_CAP; r = cursor.next()) {
      count++
      if (r.value.from === sel.from && r.value.to === sel.to) at = count
    }
    this.countEl.textContent =
      count === 0 ? t(M.noResults)
        : count >= COUNT_CAP ? t(M.countCapped, { count: COUNT_CAP })
          : at > 0 ? t(M.current, { at, count })
            : t(M.count, { count })
    this.countEl.classList.toggle('cm-st-search-none', count === 0)
  }

  private setQuery(query: SearchQuery): void {
    this.query = query
    this.searchField.value = query.search
    this.replaceField.value = query.replace
    this.caseToggle.setAttribute('aria-pressed', String(query.caseSensitive))
    this.wordToggle.setAttribute('aria-pressed', String(query.wholeWord))
    this.reToggle.setAttribute('aria-pressed', String(query.regexp))
  }

  update(update: ViewUpdate): void {
    let changed = update.docChanged || update.selectionSet
    for (const tr of update.transactions) {
      for (const e of tr.effects) {
        if (!e.is(setSearchQuery)) continue
        changed = true
        if (!e.value.eq(this.query)) this.setQuery(e.value)
      }
    }
    if (changed) this.recount()
  }

  mount(): void {
    this.searchField.select()
  }
}

/** The `createPanel` for `search()`. */
export function stSearchPanel(view: EditorView): Panel {
  return new StSearchPanel(view)
}
