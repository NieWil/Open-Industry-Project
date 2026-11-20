/* global document, navigator, window, setTimeout, clearTimeout */
// A Copy button on every listing a guide marks `<pre class="code" data-copy>`: a program or script the reader pastes
// into the app. A quoted message has no data-copy and gets none. The button sits in a wrapper, not in the <pre>,
// because the <pre> scrolls sideways and would carry the button out of view.

for (const pre of document.querySelectorAll('pre.code[data-copy]')) {
  const wrap = document.createElement('div')
  wrap.className = 'code-wrap'
  pre.replaceWith(wrap)
  wrap.append(pre)
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'code-copy'
  button.textContent = 'Copy'
  let reset = 0
  button.addEventListener('click', async () => {
    const text = pre.textContent ?? ''
    try {
      await navigator.clipboard.writeText(text)
      button.textContent = 'Copied'
    } catch {
      // no clipboard (an insecure origin, or the permission refused): select the text for Ctrl+C instead
      const range = document.createRange()
      range.selectNodeContents(pre)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
      button.textContent = 'Press Ctrl+C'
    }
    clearTimeout(reset)
    reset = setTimeout(() => (button.textContent = 'Copy'), 2000)
  })
  wrap.append(button)
}
