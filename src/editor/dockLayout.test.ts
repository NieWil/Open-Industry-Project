import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  activateDockPanel,
  ALL_PANELS,
  BOTTOM_MIN,
  bottomDockHeight,
  buildDockGrid,
  clearMaximized,
  clickBottomDockTab,
  clickDockTab,
  clickSideDockTab,
  DEFAULT_BOTTOM_HEIGHT,
  defaultDockLayout,
  DOCK_SIZES_VERSION,
  dockGridCorners,
  dockSizeVar,
  floatDockPanel,
  isColumnCollapsed,
  isFloating,
  isPoppedOut,
  locate,
  tabShowsPanel,
  MAXIMIZABLE_PANELS,
  migrateDockLayout,
  migrateDockSizes,
  moveDockPanel,
  normalizeDockLayout,
  parseBottomHeights,
  popoutDockPanel,
  POPOUT_PANELS,
  readDockLayout,
  revealDockPanel,
  revealNeedsDocks,
  saveDockLayout,
  toggleMaximizePanel,
  type DockLayout,
  type DockSizes,
} from './dockLayout'

const SIZES: DockSizes = { left: 220, right: 280, left2: 200, right2: 200, dock: '240px' }

/** the default layout with the PLC editor as the bottom dock's front tab (it docks behind Parts) */
function plcFront(): DockLayout {
  return activateDockPanel(defaultDockLayout(), 'st')
}

/** the default layout with the PLC editor detached into its floating window */
function plcFloating(): DockLayout {
  return floatDockPanel(defaultDockLayout(), 'st')
}

describe('tabShowsPanel (a tab click that leaves the PLC panel open focuses its code)', () => {
  it('is true for the open front tab only', () => {
    expect(tabShowsPanel(plcFront(), 'st')).toBe(true)
    expect(tabShowsPanel(defaultDockLayout(), 'st')).toBe(false) // behind Parts
  })

  it('is false once the click rolls the bottom dock up, and true when the next click opens it', () => {
    const collapsed = clickBottomDockTab(plcFront(), 'st')
    expect(tabShowsPanel(collapsed, 'st')).toBe(false)
    expect(tabShowsPanel(clickBottomDockTab(collapsed, 'st'), 'st')).toBe(true)
  })

  it('is false for a floating panel (it has no tab)', () => {
    expect(tabShowsPanel(plcFloating(), 'st')).toBe(false)
  })
})

describe('bottom dock collapse (bottom-panel toggle)', () => {
  it('starts expanded', () => {
    expect(defaultDockLayout().bottomCollapsed).toBe(false)
  })

  it('clicking the front tab collapses, clicking it again re-opens', () => {
    const l = defaultDockLayout()
    const collapsed = clickBottomDockTab(l, 'catalog')
    expect(collapsed.bottomCollapsed).toBe(true)
    expect(collapsed.active.bottom).toBe('catalog')

    const reopened = clickBottomDockTab(collapsed, 'catalog')
    expect(reopened.bottomCollapsed).toBe(false)
    expect(reopened.active.bottom).toBe('catalog')
  })

  it('clicking a background tab switches without collapsing', () => {
    const l = plcFront() // front = 'st'
    expect(l.active.bottom).toBe('st')
    const next = clickBottomDockTab(l, 'catalog')
    expect(next.active.bottom).toBe('catalog')
    expect(next.bottomCollapsed).toBe(false)
  })

  it('clicking a background tab while collapsed switches and re-opens', () => {
    const collapsed = clickBottomDockTab(plcFront(), 'st')
    expect(collapsed.bottomCollapsed).toBe(true)
    const next = clickBottomDockTab(collapsed, 'catalog')
    expect(next.bottomCollapsed).toBe(false)
    expect(next.active.bottom).toBe('catalog')
  })

  it('leaves side-dock tabs alone: re-clicking an active one is a no-op', () => {
    const l = defaultDockLayout() // 'tree' is front of leftTop
    expect(clickBottomDockTab(l, 'tree')).toBe(l)
    expect(clickBottomDockTab(l, 'history').active.leftTop).toBe('history')
    expect(clickBottomDockTab(l, 'history').bottomCollapsed).toBe(false)
  })

  it('clickDockTab sends each tab to its own dock toggle', () => {
    const l = defaultDockLayout()
    expect(clickDockTab(l, 'catalog').bottomCollapsed).toBe(true)
    expect(clickDockTab(l, 'catalog').collapsedColumns).toEqual([])
    expect(clickDockTab(l, 'inspector').collapsedColumns).toEqual(['right'])
    expect(clickDockTab(l, 'inspector').bottomCollapsed).toBe(false)
  })

  it('docking a panel into a collapsed bottom dock re-opens it', () => {
    const collapsed = clickBottomDockTab(plcFloating(), 'catalog')
    const next = moveDockPanel(collapsed, 'st', 'bottom')
    expect(next.bottomCollapsed).toBe(false)
  })

  it('emptying a collapsed bottom dock clears the flag', () => {
    const collapsed = clickBottomDockTab(defaultDockLayout(), 'catalog')
    // the bottom dock ships with four tabs (Parts, PLC, Problems, Watch); the flag survives losing all but the last
    let oneLeft = collapsed
    for (const panel of ['catalog', 'st', 'problems'] as const) oneLeft = moveDockPanel(oneLeft, panel, 'leftBottom')
    expect(oneLeft.bottom).toEqual(['watch'])
    expect(oneLeft.bottomCollapsed).toBe(true)
    const emptied = moveDockPanel(oneLeft, 'watch', 'leftBottom')
    expect(emptied.bottom).toEqual([])
    expect(emptied.bottomCollapsed).toBe(false)
  })
})

describe('side column fold (a rail of vertical tabs)', () => {
  it('starts with every column open', () => {
    expect(defaultDockLayout().collapsedColumns).toEqual([])
  })

  it('clicking the front tab folds the column, clicking any rail tab opens it with that tab in front', () => {
    const folded = clickSideDockTab(defaultDockLayout(), 'tree')
    expect(isColumnCollapsed(folded, 'left')).toBe(true)
    expect(isColumnCollapsed(folded, 'right')).toBe(false)
    const opened = clickSideDockTab(folded, 'history')
    expect(opened.collapsedColumns).toEqual([])
    expect(opened.active.leftTop).toBe('history')
  })

  it('clicking a background tab switches without folding', () => {
    const next = clickSideDockTab(defaultDockLayout(), 'history')
    expect(next.active.leftTop).toBe('history')
    expect(next.collapsedColumns).toEqual([])
  })

  it('folds the whole column from either sub-slot', () => {
    const l = moveDockPanel(defaultDockLayout(), 'history', 'leftBottom')
    const folded = clickSideDockTab(l, 'history')
    expect(folded.collapsedColumns).toEqual(['left'])
    expect(tabShowsPanel(folded, 'tree')).toBe(false)
    expect(tabShowsPanel(folded, 'history')).toBe(false)
  })

  it('leaves the bottom dock to its own toggle', () => {
    const l = defaultDockLayout() // Parts is the bottom dock's front tab
    expect(clickSideDockTab(l, 'catalog')).toBe(l)
    expect(clickSideDockTab(l, 'st').active.bottom).toBe('st')
  })

  it('docking a panel into a folded column opens it, and emptying one drops it from the list', () => {
    const folded = clickSideDockTab(defaultDockLayout(), 'inspector')
    expect(folded.collapsedColumns).toEqual(['right'])
    expect(moveDockPanel(folded, 'history', 'rightBottom').collapsedColumns).toEqual([])
    expect(moveDockPanel(folded, 'inspector', 'leftTop').collapsedColumns).toEqual([])
  })

  it('reveal opens the folded column', () => {
    const folded = clickSideDockTab(defaultDockLayout(), 'tree')
    const shown = revealDockPanel(folded, 'history')
    expect(shown.collapsedColumns).toEqual([])
    expect(shown.active.leftTop).toBe('history')
    expect(revealDockPanel(folded, 'inspector')).toBe(folded) // another column, already showing
  })

  it('round-trips through storage, and normalize drops junk and empty columns', () => {
    const folded = clickSideDockTab(defaultDockLayout(), 'tree')
    expect(normalizeDockLayout(JSON.parse(JSON.stringify(folded))).collapsedColumns).toEqual(['left'])
    expect(normalizeDockLayout({}).collapsedColumns).toEqual([])
    expect(normalizeDockLayout({ ...defaultDockLayout(), collapsedColumns: 'left' }).collapsedColumns).toEqual([])
    expect(normalizeDockLayout({ ...defaultDockLayout(), collapsedColumns: ['left', 'left2', 'up'] }).collapsedColumns).toEqual(['left'])
  })

  it('gives a folded column an auto track and no gutter', () => {
    const grid = buildDockGrid(clickSideDockTab(defaultDockLayout(), 'tree'), SIZES)
    expect(grid.gridTemplateColumns.startsWith('auto minmax(0, 1fr)')).toBe(true)
    expect(grid.gridTemplateAreas).not.toContain('gutlA')
    expect(grid.gridTemplateAreas).toContain('leftA')
  })

  it('has no corner where a folded column has no gutter', () => {
    const leftFolded = clickSideDockTab(defaultDockLayout(), 'tree')
    expect(dockGridCorners(leftFolded).map((c) => c.widthKey)).toEqual(['right'])
    // the right corner sits one track in: the rail, then the viewport, then the right gutter
    expect(dockGridCorners(leftFolded)[0]!.column).toBe(3)
    const rightFolded = clickSideDockTab(defaultDockLayout(), 'inspector')
    expect(dockGridCorners(rightFolded).map((c) => c.widthKey)).toEqual(['left'])
  })
})

describe('normalizeDockLayout / bottomCollapsed', () => {
  it('round-trips a collapsed layout', () => {
    const collapsed = clickBottomDockTab(defaultDockLayout(), 'catalog')
    expect(normalizeDockLayout(JSON.parse(JSON.stringify(collapsed))).bottomCollapsed).toBe(true)
  })

  it('coerces junk and defaults to expanded', () => {
    expect(normalizeDockLayout({}).bottomCollapsed).toBe(false)
    expect(normalizeDockLayout({ bottomCollapsed: 'yes' }).bottomCollapsed).toBe(false)
  })

  it('drops a collapsed flag on an empty bottom dock', () => {
    const raw = { ...defaultDockLayout(), bottom: [], bottomCollapsed: true }
    const out = normalizeDockLayout(raw)
    // the bottom-dock panels are restored to their default slot, and must not arrive rolled up
    expect(out.bottom).toEqual(['catalog', 'st', 'problems', 'watch'])
    expect(out.bottomCollapsed).toBe(false)
  })

  it('restores a missing panel at its place in the default tab order, not at the end', () => {
    const out = normalizeDockLayout({ ...defaultDockLayout(), bottom: ['problems', 'catalog', 'watch'] })
    // placed after the panel it follows by default (Parts); the user's own order is kept
    expect(out.bottom).toEqual(['problems', 'catalog', 'st', 'watch'])
    // with that neighbour gone too, it goes before the panel it precedes (Problems)
    const noParts = normalizeDockLayout({ ...defaultDockLayout(), bottom: ['problems', 'watch'], leftBottom: ['catalog'] })
    expect(noParts.bottom).toEqual(['st', 'problems', 'watch'])
    // a layout stored before Watch existed gets it after Problems, where it stands by default
    expect(normalizeDockLayout({ ...defaultDockLayout(), bottom: ['catalog', 'st', 'problems'] }).bottom).toEqual(['catalog', 'st', 'problems', 'watch'])
  })
})

describe('the PLC editor docks by default', () => {
  it('as a background tab behind Parts', () => {
    const l = defaultDockLayout()
    expect(l.bottom).toEqual(['catalog', 'st', 'problems', 'watch'])
    expect(l.active.bottom).toBe('catalog')
    expect(l.floating).toEqual([])
    expect(locate(l, 'st')).toBe('bottom')
  })

  // App writes the layout on mount, so every browser that opened a v1 build stored the old
  // default whether or not anyone chose it. Without the step, the new default would only ever
  // reach browsers that had never opened the app.
  const v1Default = {
    ...defaultDockLayout(),
    bottom: ['catalog', 'problems', 'controller'],
    floating: ['st'],
  }

  it('moves an unstamped (v1) floating PLC editor into its docked default', () => {
    const out = normalizeDockLayout(migrateDockLayout(JSON.parse(JSON.stringify(v1Default))))
    expect(out.floating).toEqual([])
    expect(out.bottom).toEqual(['catalog', 'st', 'problems', 'watch'])
    expect(out.active.bottom).toBe('catalog') // arrives behind Parts, not in front of it
  })

  it('keeps everything else a v1 blob arranged', () => {
    const arranged = { ...v1Default, leftTop: ['tree'], rightBottom: ['history'], active: { ...v1Default.active, bottom: 'problems' } }
    const out = normalizeDockLayout(migrateDockLayout(JSON.parse(JSON.stringify(arranged))))
    expect(out.leftTop).toEqual(['tree'])
    expect(out.rightBottom).toEqual(['history'])
    expect(out.active.bottom).toBe('problems')
  })

  it('leaves a v1 blob that had docked the PLC editor alone', () => {
    const docked = { ...v1Default, floating: [], rightBottom: ['st'] }
    // the only change is the untouched strip it left behind, which takes today's order
    expect(migrateDockLayout(docked)).toEqual({ ...docked, bottom: ['catalog', 'problems'] })
    expect(normalizeDockLayout(migrateDockLayout(docked)).rightBottom).toEqual(['st'])
  })

  it('honours a floating PLC editor stamped v2: that one was chosen', () => {
    const chosen = { ...plcFloating(), version: 2 }
    expect(migrateDockLayout(chosen)).toBe(chosen)
    expect(isFloating(normalizeDockLayout(migrateDockLayout(chosen)), 'st')).toBe(true)
  })

  it('passes junk through for normalize to coerce', () => {
    expect(migrateDockLayout(null)).toBe(null)
    expect(migrateDockLayout('x')).toBe('x')
    expect(normalizeDockLayout(migrateDockLayout({ version: 1, floating: 'st' })).floating).toEqual([])
  })
})

describe('a stored layout from before the Controller dock went (layouts v2 and v3)', () => {
  // v2 and v3 builds shipped a Controller dock in the bottom strip; its settings are Controller Properties now, and its
  // tasks the organizer's. normalize drops the id, so a stored strip loses the tab and keeps the rest in its order.
  const v2Default = { ...defaultDockLayout(), bottom: ['catalog', 'st', 'problems', 'controller'], version: 2 }

  it('reads an untouched v2 strip as today\'s default', () => {
    const out = normalizeDockLayout(migrateDockLayout(JSON.parse(JSON.stringify(v2Default))))
    expect(out.bottom).toEqual(['catalog', 'st', 'problems', 'watch'])
    expect(out.active.bottom).toBe('catalog')
  })

  it('reads an untouched v3 strip as today\'s default too, and moves the front tab off the Controller', () => {
    const v3 = { ...defaultDockLayout(), bottom: ['catalog', 'st', 'controller', 'problems'], active: { ...defaultDockLayout().active, bottom: 'controller' }, version: 3 }
    const out = normalizeDockLayout(migrateDockLayout(JSON.parse(JSON.stringify(v3))))
    expect(out.bottom).toEqual(['catalog', 'st', 'problems', 'watch'])
    expect(out.bottom).toContain(out.active.bottom)
  })

  it('drops a Controller dock someone moved to a side column, and the column with it', () => {
    const moved = { ...defaultDockLayout(), rightTop2: ['controller'], version: 3 }
    const out = normalizeDockLayout(migrateDockLayout(JSON.parse(JSON.stringify(moved))))
    expect(out.rightTop2).toEqual([])
    expect(Object.values(out).flat()).not.toContain('controller')
  })

  it('keeps which tab was in front', () => {
    const blob = { ...v2Default, active: { ...v2Default.active, bottom: 'problems' } }
    expect(normalizeDockLayout(migrateDockLayout(blob)).active.bottom).toBe('problems')
  })

  it('keeps a strip someone arranged', () => {
    const arranged = { ...v2Default, bottom: ['st', 'catalog', 'problems', 'controller'] }
    expect(migrateDockLayout(arranged)).toBe(arranged)
    expect(normalizeDockLayout(migrateDockLayout(arranged)).bottom).toEqual(['st', 'catalog', 'problems', 'watch'])
  })
})

describe('readDockLayout / saveDockLayout', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubStorage(): Map<string, string> {
    const data = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
    })
    return data
  }

  it('reads the docked default when nothing is stored', () => {
    stubStorage()
    expect(readDockLayout()).toEqual(defaultDockLayout())
  })

  it('stamps the version, so a panel floated today survives the next load', () => {
    const data = stubStorage()
    saveDockLayout(plcFloating())
    expect(JSON.parse(data.get('oip-web/dock-layout')!).version).toBe(3)
    expect(isFloating(readDockLayout(), 'st')).toBe(true)
  })

  it('docks the PLC editor from a stored v1 default', () => {
    const data = stubStorage()
    data.set('oip-web/dock-layout', JSON.stringify(v1DefaultBlob()))
    const l = readDockLayout()
    expect(isFloating(l, 'st')).toBe(false)
    expect(l.bottom).toEqual(['catalog', 'st', 'problems', 'watch'])
  })

  /** what a v1 build wrote on first load: its default, unstamped, maximized/popout stripped */
  function v1DefaultBlob(): unknown {
    return { ...defaultDockLayout(), bottom: ['catalog', 'problems', 'controller'], floating: ['st'], maximized: null, popout: [] }
  }
})

describe('buildDockGrid / collapsed bottom dock', () => {
  it('keeps the bottom row but drops the resize gutter', () => {
    const open = buildDockGrid(defaultDockLayout(), SIZES)
    expect(open.gridTemplateRows).toContain('240px')
    expect(open.gridTemplateAreas).toContain('gutd')

    const shut = buildDockGrid(clickBottomDockTab(defaultDockLayout(), 'catalog'), SIZES)
    expect(shut.gridTemplateAreas).toContain('bottom')
    expect(shut.gridTemplateAreas).not.toContain('gutd')
    expect(shut.gridTemplateRows).not.toContain('240px')
    expect(shut.gridTemplateRows.endsWith('auto')).toBe(true)
  })

  it('re-expanding restores the stored dock height', () => {
    const collapsed = clickBottomDockTab(defaultDockLayout(), 'catalog')
    const reopened = clickBottomDockTab(collapsed, 'catalog')
    expect(buildDockGrid(reopened, SIZES).gridTemplateRows).toContain('240px')
  })
})

describe('dockGridCorners', () => {
  const cellAt = (layout: DockLayout, row: number, column: number): string => {
    const rows = [...buildDockGrid(layout, SIZES).gridTemplateAreas.matchAll(/"([^"]+)"/g)].map((m) => m[1]!.split(' '))
    return rows[row - 1]![column - 1]!
  }

  it('crosses the height gutter at each left gutter, and ends it at the innermost right one', () => {
    const l: DockLayout = { ...defaultDockLayout(), leftTop: ['tree'], leftTop2: ['history'], rightTop2: ['problems'] }
    const corners = dockGridCorners(l)
    expect(corners.map((c) => c.widthKey)).toEqual(['left', 'left2', 'right2'])
    const gutter = { left: 'gutlA', left2: 'gutlB', right: 'gutrA', right2: 'gutrB' } as const
    for (const c of corners) {
      // the width gutter runs through the cell's track, one row up
      expect(cellAt(l, c.row - 1, c.column)).toBe(gutter[c.widthKey])
      if (c.side === 'left') expect(cellAt(l, c.row, c.column)).toBe('gutd')
      else {
        // the right gutter carries on down, and the height gutter stops against it
        expect(cellAt(l, c.row, c.column)).toBe(gutter[c.widthKey])
        expect(cellAt(l, c.row, c.column - 1)).toBe('gutd')
      }
    }
  })

  it('uses the outer right gutter when the inner right column is empty', () => {
    expect(dockGridCorners(defaultDockLayout()).map((c) => c.widthKey)).toEqual(['left', 'right'])
  })

  it('needs an open bottom dock', () => {
    expect(dockGridCorners(clickBottomDockTab(defaultDockLayout(), 'catalog'))).toEqual([])
    const noLeft: DockLayout = { ...defaultDockLayout(), leftTop: [], leftBottom: [] }
    expect(dockGridCorners(noLeft).map((c) => c.widthKey)).toEqual(['right'])
  })
})

describe('buildDockGrid / live-drag custom properties', () => {
  // Every sized track has to read its custom property: that indirection is what lets a gutter
  // drag resize a track by writing one property per frame instead of re-rendering the editor
  // (ResizeGutter's cssVar). Committed px stays as the inline fallback so the template is
  // valid before any drag - losing either half breaks a different thing, hence both asserts.
  it('sizes every track from its var, with the committed px as fallback', () => {
    const layout: DockLayout = { ...defaultDockLayout(), leftTop: ['tree'], rightTop: ['inspector'] }
    const grid = buildDockGrid(layout, SIZES)
    expect(grid.gridTemplateColumns).toContain(`var(${dockSizeVar('left')}, 220px)`)
    expect(grid.gridTemplateColumns).toContain(`var(${dockSizeVar('right')}, 280px)`)
    expect(grid.gridTemplateRows).toContain(`var(${dockSizeVar('dock')}, 240px)`)
    // fixed tracks (toolbar, gutters, viewport) stay literal - nothing drags them
    expect(grid.gridTemplateColumns).toContain('minmax(0, 1fr)')
    expect(grid.gridTemplateRows.startsWith('48px ')).toBe(true)
  })

  it('names a property per size key', () => {
    expect(dockSizeVar('left')).toBe('--dk-left')
    expect(dockSizeVar('leftTop2')).toBe('--dk-leftTop2')
  })
})

describe('buildDockGrid / the bottom dock stops at the right columns', () => {
  const rowsOf = (grid: { gridTemplateAreas: string }): string[][] =>
    [...grid.gridTemplateAreas.matchAll(/"([^"]+)"/g)].map((m) => m[1]!.split(' '))

  it('runs under the left column and the viewport, beside a full-height Inspector column', () => {
    expect(rowsOf(buildDockGrid(defaultDockLayout(), SIZES))).toEqual([
      ['toolbar', 'toolbar', 'toolbar', 'toolbar', 'toolbar'],
      ['leftA', 'gutlA', 'viewport', 'gutrA', 'rightA'],
      ['gutd', 'gutd', 'gutd', 'gutrA', 'rightA'],
      ['bottom', 'bottom', 'bottom', 'gutrA', 'rightA'],
    ])
  })

  it('carries both right columns down, and spans every left one', () => {
    const l: DockLayout = {
      ...defaultDockLayout(),
      leftTop: ['tree'],
      leftTop2: ['history'],
      rightTop2: ['problems'],
      bottom: ['catalog', 'st'],
    }
    const last = rowsOf(buildDockGrid(normalizeDockLayout(l), SIZES)).at(-1)!
    expect(last).toEqual(['bottom', 'bottom', 'bottom', 'bottom', 'bottom', 'gutrB', 'rightB', 'gutrA', 'rightA'])
  })

  it('spans the whole width when nothing is docked on the right', () => {
    const l = normalizeDockLayout({ ...defaultDockLayout(), rightTop: [], leftBottom: ['inspector'] })
    expect(rowsOf(buildDockGrid(l, SIZES)).at(-1)).toEqual(['bottom', 'bottom', 'bottom'])
  })

  it('a rolled-up bottom dock keeps the right column beside it', () => {
    const shut = buildDockGrid(clickBottomDockTab(defaultDockLayout(), 'catalog'), SIZES)
    expect(rowsOf(shut).at(-1)).toEqual(['bottom', 'bottom', 'bottom', 'gutrA', 'rightA'])
  })
})

describe('bottom dock height per panel', () => {
  it('stands at the front panel’s own height, else its default', () => {
    expect(bottomDockHeight('catalog', {})).toBe(`${DEFAULT_BOTTOM_HEIGHT.catalog}px`)
    expect(bottomDockHeight('problems', { catalog: 300 })).toBe(`${DEFAULT_BOTTOM_HEIGHT.problems}px`)
    expect(bottomDockHeight('catalog', { catalog: 300 })).toBe('300px')
    // an empty strip has no front panel; it stands at the Parts height, as a fresh layout does
    expect(bottomDockHeight(null, {})).toBe(`${DEFAULT_BOTTOM_HEIGHT.catalog}px`)
  })

  it('gives the PLC editor a share of the shell, so a bigger screen shows more program', () => {
    const share = DEFAULT_BOTTOM_HEIGHT.st
    expect(typeof share).toBe('object')
    // a percentage in a grid track is of the whole shell, so the toolbar row comes off first, and it never drops below
    // the drag minimum on a short window
    expect(bottomDockHeight('st', {})).toBe(`max(${BOTTOM_MIN}px, calc((100% - 48px) * ${(share as { share: number }).share}))`)
    expect(bottomDockHeight('st', { st: 410 })).toBe('410px')
  })

  it('every panel has a default, so any one moved into the strip has a height', () => {
    for (const id of ALL_PANELS) expect(DEFAULT_BOTTOM_HEIGHT[id]).toBeDefined()
  })

  it('reads the heights back from the stored blob, dropping anything that is not a known panel’s number', () => {
    const blob = { version: DOCK_SIZES_VERSION, bottom: { st: 400, catalog: 'tall', bogus: 300, problems: 10 } }
    expect(parseBottomHeights(migrateDockSizes(blob))).toEqual({ st: 400, problems: BOTTOM_MIN })
    expect(parseBottomHeights({})).toEqual({})
  })
})

describe('migrateDockSizes', () => {
  it('v1: drops the untouched defaults, so the new ones apply', () => {
    // App wrote the sizes on every first load, so 280 and 230 say nothing about what anyone chose
    const out = migrateDockSizes({ left: 250, right: 280, dock: 230, leftTop: 300 })
    expect(out).toEqual({ left: 250, leftTop: 300 })
    expect(parseBottomHeights(out)).toEqual({})
  })

  it('v1: keeps a dragged width, and a dragged strip height as the Parts height', () => {
    const out = migrateDockSizes({ right: 410, dock: 317 })
    expect(out.right).toBe(410)
    expect(parseBottomHeights(out)).toEqual({ catalog: 317 })
  })

  it('v2: drops a left column still at the old default, and keeps a dragged one', () => {
    expect(migrateDockSizes({ left: 220, right: 360, bottom: { st: 500 }, version: 2 })).toEqual({ right: 360, bottom: { st: 500 }, version: 2 })
    expect(migrateDockSizes({ left: 240, version: 2 }).left).toBe(240)
  })

  it('v1: runs every step, so a left column at 220 goes as well as the old right and strip defaults', () => {
    expect(migrateDockSizes({ left: 220, right: 280, dock: 230 })).toEqual({})
  })

  it('leaves a current blob alone, and reads garbage as nothing', () => {
    // a left column at 220 in a current blob was dragged there after the default moved, so it stays
    const current = { left: 220, right: 280, bottom: { st: 500 }, version: DOCK_SIZES_VERSION }
    expect(migrateDockSizes(current)).toEqual(current)
    expect(migrateDockSizes(null)).toEqual({})
    expect(migrateDockSizes('x')).toEqual({})
  })
})

describe('panel maximize (any panel, wherever it is docked)', () => {
  it('starts restored, and toggles the same panel back off', () => {
    const l = defaultDockLayout()
    expect(l.maximized).toBe(null)
    const big = toggleMaximizePanel(l, 'st')
    expect(big.maximized).toBe('st')
    expect(toggleMaximizePanel(big, 'st').maximized).toBe(null)
  })

  it('refuses a panel that is not maximizable', () => {
    // the rule lives in the model, not only in whichever UI draws the button - a side dock
    // is already full height, so maximizing the tree/Inspector only adds width neither one uses
    expect(MAXIMIZABLE_PANELS).toEqual(['st'])
    const l = defaultDockLayout()
    for (const panel of ['tree', 'inspector', 'catalog', 'history'] as const) {
      expect(toggleMaximizePanel(l, panel)).toBe(l)
    }
  })


  it('is orthogonal to where the panel lives - a floating panel maximizes in place', () => {
    // the PLC editor is the panel that most wants the room, in either form, so maximizing a
    // floating one must not have to dock it first (and restoring must not relocate it)
    const l = plcFloating()
    expect(isFloating(l, 'st')).toBe(true)
    const big = toggleMaximizePanel(l, 'st')
    expect(isFloating(big, 'st')).toBe(true)
    expect(clearMaximized(big).floating).toEqual(l.floating)
  })

  it('clearMaximized is a no-op (identity) when nothing is maximized', () => {
    const l = defaultDockLayout()
    expect(clearMaximized(l)).toBe(l)
  })

  it('leaves the docked arrangement untouched, so restoring puts everything back', () => {
    const l = plcFront()
    const restored = clearMaximized(toggleMaximizePanel(l, 'st'))
    expect(restored).toEqual(l)
  })

  it('is not persisted: a stored layout always loads restored', () => {
    // transient "give me room", not an arrangement - reloading into a shell with no 3D
    // viewport would read as a broken editor rather than a remembered preference
    const big = toggleMaximizePanel(plcFloating(), 'st')
    expect(normalizeDockLayout(JSON.parse(JSON.stringify(big))).maximized).toBe(null)
    // …while everything else about that layout still round-trips
    expect(normalizeDockLayout(JSON.parse(JSON.stringify(big))).floating).toEqual(['st'])
  })
})

describe('buildDockGrid / maximized panel', () => {
  it('collapses to toolbar + one full-bleed cell', () => {
    const grid = buildDockGrid(toggleMaximizePanel(defaultDockLayout(), 'st'), SIZES)
    expect(grid.gridTemplateAreas).toBe('"toolbar" "viewport"')
    expect(grid.gridTemplateColumns).toBe('minmax(0, 1fr)')
    // no dock tracks, no gutters, and the bottom dock's row is gone with it
    expect(grid.gridTemplateAreas).not.toContain('leftA')
    expect(grid.gridTemplateAreas).not.toContain('bottom')
    expect(grid.gridTemplateAreas).not.toContain('gut')
  })

  it('keeps the cell named `viewport` - the canvas stays mounted in it', () => {
    // App paints the maximized panel over the live viewport element (hidden with
    // `visibility`) instead of unmounting it, so a UI toggle never tears down the
    // WebGL/WebGPU context. Renaming this cell would silently break that.
    const grid = buildDockGrid(toggleMaximizePanel(plcFront(), 'st'), SIZES)
    expect(grid.gridTemplateAreas).toContain('viewport')
  })

  it('restores the full dock grid on the way back', () => {
    const l = defaultDockLayout()
    expect(buildDockGrid(clearMaximized(toggleMaximizePanel(l, 'st')), SIZES)).toEqual(buildDockGrid(l, SIZES))
  })
})

describe('revealDockPanel', () => {
  // The PLC panel is only mounted while it's the front tab of an open slot (DockSlot renders one
  // panel, none at all when the bottom dock is rolled up). Anything that wants the user to see a
  // panel - the tutorial writing its program into the PLC editor - has to fix both, not just the
  // front tab: a front tab in a collapsed dock still renders nothing.
  it('brings a background tab to the front', () => {
    const behindCatalog = clickBottomDockTab(plcFront(), 'catalog')
    expect(behindCatalog.active.bottom).toBe('catalog')
    expect(revealDockPanel(behindCatalog, 'st').active.bottom).toBe('st')
  })

  it('rolls the bottom dock back open', () => {
    // st docked at the front, then the dock collapsed by clicking that same tab
    const collapsed = clickBottomDockTab(plcFront(), 'st')
    expect(collapsed.bottomCollapsed).toBe(true)
    const shown = revealDockPanel(collapsed, 'st')
    expect(shown.bottomCollapsed).toBe(false)
    expect(shown.active.bottom).toBe('st')
  })

  it('leaves a floating panel (and an already-visible one) alone', () => {
    const floating = plcFloating()
    expect(revealDockPanel(floating, 'st')).toBe(floating)
    const alreadyFront = plcFront() // docking made st the front tab
    expect(revealDockPanel(alreadyFront, 'st')).toBe(alreadyFront)
  })

  it('restores a different maximized panel first, or the reveal happens behind it', () => {
    // the tutorial surfacing the Parts catalog while the PLC editor holds the whole
    // screen: bringing the tab forward isn't enough, nobody can see it
    const big = toggleMaximizePanel(plcFront(), 'st')
    const shown = revealDockPanel(big, 'catalog')
    expect(shown.maximized).toBe(null)
    expect(shown.active.bottom).toBe('catalog')
  })

  it('leaves the maximized panel alone when it is the one being revealed', () => {
    const big = toggleMaximizePanel(defaultDockLayout(), 'st')
    expect(revealDockPanel(big, 'st')).toBe(big)
  })

  it('does not disturb the bottom dock when revealing a side panel', () => {
    const collapsed = clickBottomDockTab(defaultDockLayout(), 'catalog')
    const shown = revealDockPanel(collapsed, 'history') // history is a background tab in leftTop
    expect(shown.active.leftTop).toBe('history')
    expect(shown.bottomCollapsed).toBe(true)
  })

  // Distraction-free drops the dock slots and nothing else, and it is store state the layout can't
  // see, so App asks this before a reveal and leaves df when the answer is yes. Without it the
  // palette's Problems command would bring a tab forward inside a dock nobody can see.
  it('says which reveals land in a dock slot (the ones distraction-free would hide)', () => {
    expect(revealNeedsDocks(defaultDockLayout(), 'problems')).toBe(true) // a background tab in the bottom dock
    expect(revealNeedsDocks(defaultDockLayout(), 'st')).toBe(true) // st docks behind Parts by default
    expect(revealNeedsDocks(plcFloating(), 'st')).toBe(false) // a floating window is always up
    expect(revealNeedsDocks(popoutDockPanel(defaultDockLayout(), 'st'), 'st')).toBe(false)
    const big = toggleMaximizePanel(plcFront(), 'st')
    expect(revealNeedsDocks(big, 'st')).toBe(false) // the maximized panel paints over df as well
    expect(revealNeedsDocks(big, 'catalog')).toBe(true) // revealing another restores it into its slot
  })
})

describe('pop out to an OS window', () => {
  it('takes the panel out of its slot and reports it as popped out', () => {
    const docked = plcFront()
    expect(docked.active.bottom).toBe('st')
    const out = popoutDockPanel(docked, 'st')
    expect(isPoppedOut(out, 'st')).toBe(true)
    expect(locate(out, 'st')).toBe('popout')
    expect(out.bottom).not.toContain('st')
    expect(out.active.bottom).toBe('catalog') // the slot promotes its remaining tab
  })

  it('takes the panel out of the floating window too (float -> popout is a promotion)', () => {
    const out = popoutDockPanel(plcFloating(), 'st')
    expect(isFloating(out, 'st')).toBe(false)
    expect(isPoppedOut(out, 'st')).toBe(true)
  })

  it('leaves a panel in exactly one place', () => {
    const out = popoutDockPanel(defaultDockLayout(), 'st')
    const everywhere = [...out.bottom, ...out.leftTop, ...out.rightTop, ...out.floating]
    expect(everywhere).not.toContain('st')
    expect(out.popout).toEqual(['st'])
  })

  it('refuses a panel outside POPOUT_PANELS, so the policy cannot be bypassed by the UI', () => {
    const l = defaultDockLayout()
    for (const panel of ['tree', 'inspector', 'catalog', 'history'] as const) {
      expect(POPOUT_PANELS).not.toContain(panel)
      expect(popoutDockPanel(l, panel)).toBe(l)
    }
  })

  it('is idempotent', () => {
    const out = popoutDockPanel(defaultDockLayout(), 'st')
    expect(popoutDockPanel(out, 'st')).toBe(out)
  })

  it('docking or floating it again clears the popout', () => {
    const out = popoutDockPanel(defaultDockLayout(), 'st')
    expect(isPoppedOut(moveDockPanel(out, 'st', 'bottom'), 'st')).toBe(false)
    expect(isPoppedOut(floatDockPanel(out, 'st'), 'st')).toBe(false)
    expect(floatDockPanel(out, 'st').popout).toEqual([])
  })

  // A panel that has left this window cannot hold this window's screen: leaving `maximized` set
  // would blank the viewport on behalf of something that is no longer here to paint over it.
  it('clears maximized when the maximized panel pops out', () => {
    const big = toggleMaximizePanel(defaultDockLayout(), 'st')
    expect(big.maximized).toBe('st')
    expect(popoutDockPanel(big, 'st').maximized).toBe(null)
  })

  it('refuses to maximize a popped-out panel', () => {
    const out = popoutDockPanel(defaultDockLayout(), 'st')
    expect(toggleMaximizePanel(out, 'st')).toBe(out)
  })

  it('activate and reveal are no-ops for it (and never index a slot that does not exist)', () => {
    const out = popoutDockPanel(defaultDockLayout(), 'st')
    expect(activateDockPanel(out, 'st')).toBe(out)
    expect(revealDockPanel(out, 'st')).toBe(out)
  })

  // The window is the feature, and a window can only be opened from a user gesture. A remembered
  // popout would reload into a panel that is in the layout but on no screen, so it is dropped and
  // the panel goes home, the same rule as `maximized`.
  it('is never restored from storage: the panel comes back at its default location', () => {
    const blob = JSON.parse(JSON.stringify({ ...popoutDockPanel(defaultDockLayout(), 'st'), popout: ['st'] }))
    const restored = normalizeDockLayout(blob)
    expect(restored.popout).toEqual([])
    expect(isPoppedOut(restored, 'st')).toBe(false)
    expect(locate(restored, 'st')).toBe('bottom') // st's default location
    expect(restored.bottom).toEqual(defaultDockLayout().bottom) // back in its own tab position
  })

  it('drops a popout claim for a panel that cannot pop out at all', () => {
    const restored = normalizeDockLayout({ ...defaultDockLayout(), popout: ['tree', 'catalog'] })
    expect(restored.popout).toEqual([])
    expect(restored.leftTop).toContain('tree')
    expect(restored.bottom).toContain('catalog')
  })

  it('collapses the column it left, like any other way of emptying a slot', () => {
    const docked = moveDockPanel(defaultDockLayout(), 'st', 'leftTop2')
    const grid = buildDockGrid(popoutDockPanel(docked, 'st'), SIZES)
    expect(grid.gridTemplateAreas).not.toContain('leftB')
  })
})
