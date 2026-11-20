// The editor's icons, inlined as SVG so every glyph recolors via its button's currentColor. Buttons use
// these rather than Unicode characters (+ ✎ × ⤓ ⤒), which would put a font-dependent glyph at a
// font-dependent weight beside every other control's SVG. One style throughout: filled shapes,
// secondary parts at half opacity, never a stroked outline.
//
// Toolbar icons are 16px. The ones that replaced a glyph inside a text button take `size="1em"`, so
// they keep the size that button's CSS already gave the character, and sit on the text baseline.

type IconSize = { size?: number | string }
const INLINE = { verticalAlign: '-0.125em' } as const
/** width/height + the baseline nudge an em-sized icon needs to sit centred in a line of text */
function dims(size: number | string) {
  return { width: size, height: size, style: typeof size === 'string' ? INLINE : undefined }
}

// ── transport ─────────────────────────────────────────────────────────────────────────────────────
export function PlayIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M4 12a1 1 0 0 0 1.555.832l6-4a1 1 0 0 0 0-1.664l-6-4A1 1 0 0 0 4 4z" />
    </svg>
  )
}

export function PauseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M4 3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1zm6 0a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1z" />
    </svg>
  )
}

export function StopIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect width="10" height="10" x="3" y="3" rx="1" />
    </svg>
  )
}

// ── modes ─────────────────────────────────────────────────────────────────────────────────────────
export function PilotIcon() {
  // a figure mid-stride: enter first-person walk-around. A standing figure reads as "user" or "account"
  // rather than "walk the floor".
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="9.5" cy="2.4" r="1.7" fill="currentColor" />
      <path
        d="M9 5.4 7.6 9.6M7.6 9.6 5 14.2M7.6 9.6l2.6 1.9.6 3M8.8 6.2 5.6 7.8M8.8 6.2l1.6 2 2.4.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function VRIcon() {
  // a VR headset (goggles with a nose notch) - enter the WebXR walkthrough
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M2.5 4A1.5 1.5 0 0 0 1 5.5v5A1.5 1.5 0 0 0 2.5 12h2.55c.4 0 .78-.2 1-.53l1.12-1.67a1 1 0 0 1 1.66 0l1.12 1.67c.22.33.6.53 1 .53h2.55A1.5 1.5 0 0 0 15 10.5v-5A1.5 1.5 0 0 0 13.5 4z" />
    </svg>
  )
}

export function DistractionFreeIcon() {
  // a window with its side panels: the mode hides the panels. Not the
  // fullscreen arrows: the button only goes fullscreen with Shift held.
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.2 3.2h2.8v9.6H2.2zM11 3.2h2.8v9.6H11z" fill="currentColor" fillOpacity="0.45" />
    </svg>
  )
}

export function SettingsIcon() {
  // a cog - the Settings dialog (preferences, project, keyboard)
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" fillRule="evenodd" aria-hidden="true">
      <path d="M7 1 6.7 2.6a5.4 5.4 0 0 0-1.2.5L4.1 2.2 2.2 4.1l.9 1.4a5.4 5.4 0 0 0-.5 1.2L1 7v2l1.6.3c.1.4.3.8.5 1.2l-.9 1.4 1.9 1.9 1.4-.9c.4.2.8.4 1.2.5L7 15h2l.3-1.6c.4-.1.8-.3 1.2-.5l1.4.9 1.9-1.9-.9-1.4c.2-.4.4-.8.5-1.2L15 9V7l-1.6-.3a5.4 5.4 0 0 0-.5-1.2l.9-1.4-1.9-1.9-1.4.9a5.4 5.4 0 0 0-1.2-.5L9 1zm1 4.6a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8z" />
    </svg>
  )
}

// ── menus ─────────────────────────────────────────────────────────────────────────────────────────
export function OverflowIcon() {
  // three dots - the "more actions" overflow menu
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3" cy="8" r="1.5" />
      <circle cx="8" cy="8" r="1.5" />
      <circle cx="13" cy="8" r="1.5" />
    </svg>
  )
}

export function HelpIcon() {
  // a question mark knocked out of a disc - the Help menu (shortcuts, the tour, the project's home)
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" fillRule="evenodd" aria-hidden="true">
      <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zM5.4 6a2.6 2.6 0 1 1 3.3 2.5v1.3H7.3V7.2H8A1.2 1.2 0 1 0 6.8 6zm1.7 5.7a.9.9 0 1 0 1.8 0 .9.9 0 1 0-1.8 0z" />
    </svg>
  )
}

export function GitHubIcon() {
  // GitHub's own 16px mark (octicons mark-github), recolored via currentColor
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

export function ExternalLinkIcon({ size = 12 }: IconSize) {
  // a box with an arrow leaving it - the menu entry that opens another site, a panel popping out to a window
  return (
    <svg {...dims(size)} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M9 2h5v5h-2V5.4L7.7 9.7 6.3 8.3 10.6 4H9z" />
      <path d="M3 4h4v2H4v6h6V9h2v5H2V4z" />
    </svg>
  )
}

// ── sharing ───────────────────────────────────────────────────────────────────────────────────────
export function ShareIcon() {
  // three nodes joined by links - the standard "share" glyph
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="3.5" r="2.5" />
      <circle cx="4" cy="8" r="2.5" />
      <circle cx="12" cy="12.5" r="2.5" />
      <path d="M12 3.5 4 8l8 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

export function PencilIcon({ size = 16 }: IconSize) {
  // edit - a pencil (Share's "can edit", rename, "edit this" on a row)
  return (
    <svg {...dims(size)} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M11.5 1.5a1.7 1.7 0 0 1 2.4 2.4l-.9.9-2.4-2.4zM9.5 3.5l2.4 2.4-6.5 6.5-2.9.5.5-2.9z" />
    </svg>
  )
}

export function EyeIcon({ size = 16 }: IconSize) {
  // view access / visible - an eye
  return (
    <svg {...dims(size)} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 3C4.5 3 1.7 5.1 0.5 8c1.2 2.9 4 5 7.5 5s6.3-2.1 7.5-5C14.3 5.1 11.5 3 8 3zm0 8a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0-1.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" />
    </svg>
  )
}

export function DisplayIcon({ size = 16 }: IconSize) {
  // a screen on a stand (Share's "for a display")
  return (
    <svg {...dims(size)} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M2.5 2.5h11A1.5 1.5 0 0 1 15 4v6.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 10.5V4a1.5 1.5 0 0 1 1.5-1.5zm0 1.3a.2.2 0 0 0-.2.2v6.5c0 .1.1.2.2.2h11c.1 0 .2-.1.2-.2V4a.2.2 0 0 0-.2-.2zM6 13h4l.5 1.5h-5z" />
    </svg>
  )
}

export function PeopleIcon({ size = 14 }: IconSize) {
  // shared with others - two people
  return (
    <svg {...dims(size)} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="5.5" cy="5" r="2.4" />
      <circle cx="11" cy="5.6" r="2" />
      <path d="M1 13.5c0-2.5 2-4.3 4.5-4.3s4.5 1.8 4.5 4.3v.5H1zM10.6 14v-.5c0-1.5-.5-2.8-1.4-3.7.5-.2 1.1-.3 1.8-.3 2.2 0 3.9 1.5 3.9 3.6v.9z" />
    </svg>
  )
}

export function TrashIcon({ size = 16 }: IconSize) {
  // delete - a bin, rather than the × that means "close" (CloseIcon)
  return (
    <svg {...dims(size)} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M6 1h4l.8 1.2H14v1.6H2V2.2h3.2zM3.2 5h9.6l-.7 8.9a1.2 1.2 0 0 1-1.2 1.1H5.1a1.2 1.2 0 0 1-1.2-1.1zm2.6 1.8.3 6.4h1.3L7.2 6.8zm3 0-.2 6.4h1.3l.3-6.4z" />
    </svg>
  )
}

export function ExportIcon({ size = 16 }: IconSize) {
  // an arrow down into a tray - the project (or a part) leaves as a file
  return (
    <svg {...dims(size)} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M7 1.5h2v6.1l2.3-2.3 1.4 1.4L8 11.4 3.3 6.7l1.4-1.4L7 7.6z" />
      <path d="M2 11h2v2h8v-2h2v4H2z" />
    </svg>
  )
}

export function ImportIcon({ size = 16 }: IconSize) {
  // an arrow up out of a tray - a file comes in as a project (or a part)
  return (
    <svg {...dims(size)} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 1.6l4.7 4.7-1.4 1.4L9 5.4V11.5H7V5.4L4.7 7.7 3.3 6.3z" />
      <path d="M2 11h2v2h8v-2h2v4H2z" />
    </svg>
  )
}

// ── dialogs, rows and cards ───────────────────────────────────────────────────────────────────────
export function CloseIcon({ size = '1em' }: IconSize) {
  // close / dismiss / take off: a × (delete is TrashIcon). The cross spans about half the box, the
  // size the × character it replaced drew at, so a dialog's close button didn't grow
  return (
    <svg {...dims(size)} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M5.3 4.1 8 6.8l2.7-2.7 1.2 1.2L9.2 8l2.7 2.7-1.2 1.2L8 9.2l-2.7 2.7-1.2-1.2L6.8 8 4.1 5.3z" />
    </svg>
  )
}

const CHEVRON = {
  right: 'M6 3.5 11 8l-5 4.5z',
  left: 'M10 3.5 5 8l5 4.5z',
  down: 'M3.5 6 8 11l4.5-5z',
  up: 'M3.5 10 8 5l4.5 5z',
} as const

export function ChevronIcon({ dir = 'right', size = '1em' }: IconSize & { dir?: keyof typeof CHEVRON }) {
  // a small solid triangle - a breadcrumb's back and separator, a menu button's "opens down", a sort order
  return (
    <svg {...dims(size)} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d={CHEVRON[dir]} />
    </svg>
  )
}

/** a tree fold: points right when closed, down when open (the scene tree draws its own, animated) */
export function FoldIcon({ closed }: { closed: boolean }) {
  return <ChevronIcon dir={closed ? 'right' : 'down'} />
}

export function PartGlyph() {
  // a catalog card with no thumbnail: a part is a box (sized by the card's font-size)
  return (
    <svg {...dims('1em')} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 1.5 14 4.5 8 7.5 2 4.5z" fillOpacity="0.5" />
      <path d="M2 5.6 7.4 8.3v6.2L2 11.8zm12 0v6.2l-5.4 2.7V8.3z" />
    </svg>
  )
}

// ── panels ────────────────────────────────────────────────────────────────────────────────────────
export function MaximizeIcon({ size = '1em' }: IconSize) {
  // four corners pushed out - fill the window with this panel
  return (
    <svg {...dims(size)} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M2 2h5v2H4v3H2zm7 0h5v5h-2V4H9zM2 9h2v3h3v2H2zm10 0h2v5H9v-2h3z" />
    </svg>
  )
}

export function RestoreIcon({ size = '1em' }: IconSize) {
  // a window in front of another - back to the docked layout
  return (
    <svg {...dims(size)} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M5 2h9v9h-2V4H5z" fillOpacity="0.5" />
      <rect x="2" y="5" width="9" height="9" rx="1" />
    </svg>
  )
}

export function DockIcon({ size = '1em' }: IconSize) {
  // an arrow into a box - put a popped-out panel back in the main window
  return (
    <svg {...dims(size)} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M3 3h4v2H5v6h6V9h2v4H3z" />
      <path d="M14 3.4 12.6 2 8.5 6.1V4h-2v5.5H12v-2H9.9z" />
    </svg>
  )
}

export function CopyIcon({ size = '1em' }: IconSize) {
  // a sheet in front of another - copy to the clipboard
  return (
    <svg {...dims(size)} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M2 2h8v2H4v6H2z" fillOpacity="0.5" />
      <rect x="5" y="5" width="9" height="9" rx="1" />
    </svg>
  )
}

export function CheckIcon({ size = '1em' }: IconSize) {
  // done - a copy landed
  return (
    <svg {...dims(size)} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M6.2 11.2 2.8 7.8 1.4 9.2l4.8 4.8 8.4-8.4-1.4-1.4z" />
    </svg>
  )
}

// ── tree rows ─────────────────────────────────────────────────────────────────────────────────────
// A row's leading glyph: a part's category, or a rig link's joint. Rows carry the key, not an element, so
// the scene tree's memoized row still compares its props by value.
const TREE_GLYPHS = {
  // a conveyor: the direction of travel over a belt
  equipment: (
    <>
      <path d="M2 4.2h7.5V1.8L14 5.5l-4.5 3.7V6.8H2z" />
      <path d="M3.5 10h9a2 2 0 0 1 0 4h-9a2 2 0 0 1 0-4z" fillOpacity="0.5" />
    </>
  ),
  // a sensor: a lens in its housing
  devices: <path fillRule="evenodd" d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zm0 2a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zM8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z" />,
  // a product: a carton, its lid half-tone
  products: (
    <>
      <path d="M2 2h12v3H2z" fillOpacity="0.5" />
      <rect x="2.5" y="6" width="11" height="8" />
    </>
  ),
  // structure: an I-beam
  structure: <path d="M2 2h12v2.5H9.5v7H14V14H2v-2.5h4.5v-7H2z" />,
  // a revolute joint: turning
  revolute: <path d="M12.91 4.96A6 6 0 1 1 5.46 2.96L4.62 1.15 8.92 2.56 7.24 6.77 6.39 4.96A3.8 3.8 0 1 0 11.11 6.22z" />,
  // a prismatic joint: sliding both ways
  prismatic: <path d="M1 8l3.5-3.5V7h7V4.5L15 8l-3.5 3.5V9h-7v2.5z" />,
  // a rig node with no joint: a plain ring
  node: <path fillRule="evenodd" d="M8 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM8 6.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" />,
} as const
export type TreeGlyphKind = keyof typeof TREE_GLYPHS

export function TreeGlyph({ kind }: { kind: TreeGlyphKind }) {
  return (
    <svg {...dims('1em')} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      {TREE_GLYPHS[kind]}
    </svg>
  )
}

// ── a custom part's own actions (the Scene dock row, the Inspector header, the catalog card) ──────────
/** "Open Part Editor": a clapperboard, on a custom part's Scene dock row and in the Inspector header. */
export function SceneIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true" focusable="false">
      <rect x="2" y="7" width="12" height="7" rx="0.8" />
      <path d="M2 6.6 L4.2 4.2 L6.4 4.2 L4.2 6.6 Z M6.4 6.6 L8.6 4.2 L10.8 4.2 L8.6 6.6 Z M10.8 6.6 L13 4.2 L14 4.2 L14 6.6 Z" />
    </svg>
  )
}

/** "Edit behavior": a </> glyph, on parts that carry a behavior script (Scene dock row, Inspector header, catalog card). */
export function ScriptIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M5.3 4.2 1.5 8l3.8 3.8 1.1-1.1L3.7 8l2.7-2.7zm5.4 0L14.5 8l-3.8 3.8-1.1-1.1L12.3 8 9.6 5.3z" />
    </svg>
  )
}

/** "Reveal in folder": a folder, its flap at half opacity. */
export function FolderIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M1.5 3.5h5l1.5 1.5h6.5v1.5h-13z" opacity="0.5" />
      <path d="M1.5 6.5h13v6.5h-13z" />
    </svg>
  )
}
