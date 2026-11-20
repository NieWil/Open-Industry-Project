// Opt-in CPU throttle for every page an e2e gate opens, to find the gates that pass only because something
// happened fast enough. Preload it into the gates' node processes:
//
//   OIP_E2E_CPU_THROTTLE=4 NODE_OPTIONS=--import=<repo>/e2e/_throttle.mjs npm run gates
//
// Each Chromium page and Electron window then runs `rate` times slower (DevTools Emulation.setCPUThrottlingRate).
// A gate that passes at full speed and fails here waited on the clock, or on one event happening before another,
// instead of on the state it checks: verify-desktop-file-open-electron passed for months while the app dropped a
// file that arrived before the editor was listening. A slowed failure is a lead, not a verdict: read why it failed.
// WebKit and Firefox pages have no DevTools protocol and run at full speed. Without the variable this does nothing.
/* global process */

const rate = Number(process.env.OIP_E2E_CPU_THROTTLE ?? 0)

if (rate > 1) {
  const pw = await import('playwright')
  const throttle = async (page) => {
    try {
      const session = await page.context().newCDPSession(page)
      await session.send('Emulation.setCPUThrottlingRate', { rate })
    } catch {
      // a page closed before its session opened, or a target with no DevTools protocol
    }
  }
  const watch = (context) => {
    for (const page of context.pages()) void throttle(page)
    context.on('page', (page) => void throttle(page))
    return context
  }
  const browserWatched = (browser) => {
    const newContext = browser.newContext.bind(browser)
    browser.newContext = async (...args) => watch(await newContext(...args))
    const newPage = browser.newPage.bind(browser)
    browser.newPage = async (...args) => {
      const page = await newPage(...args)
      watch(page.context())
      return page
    }
    return browser
  }
  const launch = pw.chromium.launch.bind(pw.chromium)
  pw.chromium.launch = async (...args) => browserWatched(await launch(...args))
  const launchPersistent = pw.chromium.launchPersistentContext.bind(pw.chromium)
  pw.chromium.launchPersistentContext = async (...args) => watch(await launchPersistent(...args))
  const launchElectron = pw._electron.launch.bind(pw._electron)
  pw._electron.launch = async (...args) => {
    const app = await launchElectron(...args)
    watch(app.context())
    return app
  }
}
