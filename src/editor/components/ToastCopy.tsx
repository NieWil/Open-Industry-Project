import { useEffect, useState } from 'react'
import { activeClipboard } from '../dialogHost'
import { CheckIcon, CopyIcon } from './toolbarIcons'
import { defineMessages, t } from '../../core/i18n'

const M = defineMessages('toastCopy', {
  copy: 'Copy this message',
  copied: 'Copied',
})

// how long the button shows the tick after a copy
const COPIED_MS = 1500

/**
 * Copies a toast's text, so an error can be pasted into a report or handed to an assistant before the toast
 * dismisses itself. Renders nothing where the page has no clipboard (an http origin).
 */
export function ToastCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])
  if (!activeClipboard()) return null
  return (
    <button
      type="button"
      className="part-build-toast-close"
      data-testid="toast-copy"
      title={t(copied ? M.copied : M.copy)}
      onClick={() => {
        // asked for at the click: the clipboard belongs to the window that has the focus now
        void activeClipboard()
          ?.writeText(text)
          .then(
            () => setCopied(true),
            (e) => console.warn('[oip] copying a notice failed:', e),
          )
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  )
}
