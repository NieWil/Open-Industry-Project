// Links that open the desktop app (deepLink.cjs). Plain Node: `node apps/desktop/deepLink.test.cjs`.

const assert = require('node:assert/strict')
const { deepLinkFromArgv, isDeepLinkArg, linkUrl, parseDeepLink, roomOf, roomUrl } = require('./deepLink.cjs')

const EDIT = 'e-0f8fad5b-d9cb-469f-a165-70867728950e'
const VIEW = 'r-' + 'a'.repeat(64)

// 1. the two things a link can say
assert.deepEqual(parseDeepLink('openindustry://open'), { room: null })
assert.deepEqual(parseDeepLink('openindustry://open/'), { room: null })
assert.deepEqual(parseDeepLink(`openindustry://open?room=${EDIT}`), { room: EDIT, view: false })
assert.deepEqual(parseDeepLink(`openindustry://open/?room=${VIEW}&view=1`), { room: VIEW, view: true })
assert.deepEqual(parseDeepLink(`OpenIndustry://Open?room=${EDIT}`), { room: EDIT, view: false }, 'case of scheme and host')

// 2. anything else is ignored: other actions, other paths, rooms Share never minted, other schemes
assert.equal(parseDeepLink(`openindustry://folder?room=${EDIT}`), null)
assert.equal(parseDeepLink(`openindustry://open/../x?room=${EDIT}`), null)
assert.equal(parseDeepLink('openindustry://open?room=legacy-room'), null)
assert.equal(parseDeepLink('openindustry://open?room=e-'), null)
assert.equal(parseDeepLink(`openindustry://open?room=${EDIT.toUpperCase()}`), null)
assert.equal(parseDeepLink('openindustry://open?room=r-abc'), null)
assert.equal(parseDeepLink(`https://open?room=${EDIT}`), null)
assert.equal(parseDeepLink(`openindustry://open?room=${EDIT}&x=${'y'.repeat(600)}`), null, 'oversized')
assert.equal(parseDeepLink(undefined), null)

// 3. found on a command line wherever Windows / Linux put it, and never mistaken for a folder argument
assert.deepEqual(deepLinkFromArgv(['app.exe', '--flag', `openindustry://open?room=${EDIT}`]), { room: EDIT, view: false })
assert.equal(deepLinkFromArgv(['app.exe', 'C:\\Projects\\Line A']), null)
assert.equal(deepLinkFromArgv(['openindustry://open']), null, 'argv[0] is the executable')
assert.equal(isDeepLinkArg('openindustry:/../../Users/x/project'), true, 'a crafted path is still a link, so the folder reader skips it')

// 4. the URL the window loads: the room set, the previous entry params dropped, the rest kept
assert.equal(roomUrl('oip://app/app/', { room: EDIT, view: false }), `oip://app/app/?room=${EDIT}`)
assert.equal(
  roomUrl(`http://localhost:5173/app/?webgpu&scene=demo&room=${VIEW}&view=1#x`, { room: EDIT, view: false }),
  `http://localhost:5173/app/?webgpu=&room=${EDIT}`,
)
assert.equal(roomUrl('http://localhost:5173/app/', { room: VIEW, view: true }), `http://localhost:5173/app/?room=${VIEW}&view=1`)
assert.equal(roomOf(`oip://app/app/?room=${EDIT}`), EDIT)
assert.equal(roomOf('oip://app/app/'), null)

// 5. a hand-over: only an edit secret's shape, never beside a room, and it boots the window to receive it
assert.deepEqual(parseDeepLink(`openindustry://open?handoff=${EDIT}`), { room: null, handoff: EDIT })
assert.equal(parseDeepLink(`openindustry://open?handoff=${VIEW}`), null, 'a view name cannot be taken')
assert.equal(parseDeepLink(`openindustry://open?handoff=${EDIT}&room=${EDIT}`), null)
assert.equal(parseDeepLink('openindustry://open?handoff='), null)
assert.equal(
  linkUrl(`http://localhost:5173/app/?room=${VIEW}&view=1&scene=demo`, { room: null, handoff: EDIT }),
  `http://localhost:5173/app/?handoff=${EDIT}`,
)
assert.equal(linkUrl('oip://app/app/', { room: EDIT, view: false }), `oip://app/app/?room=${EDIT}`)
assert.equal(linkUrl('oip://app/app/?x=1', { room: null }), 'oip://app/app/?x=1', 'a bare open changes nothing')
assert.equal(roomUrl(`oip://app/app/?handoff=${EDIT}`, { room: VIEW, view: true }), `oip://app/app/?room=${VIEW}&view=1`)

console.log('deepLink: ok')

// a room on a self-hosted server keeps its server through the shell, and a bare link drops any server it had
assert.equal(
  roomUrl('oip://app/app/?server=wss%3A%2F%2Fold.example', { room: EDIT, view: false, server: 'wss://collab.example.org' }),
  `oip://app/app/?room=${EDIT}&server=wss%3A%2F%2Fcollab.example.org`,
)
assert.equal(roomUrl('oip://app/app/?server=wss%3A%2F%2Fold.example', { room: EDIT, view: false }), `oip://app/app/?room=${EDIT}`)
assert.equal(
  linkUrl('oip://app/app/', { room: null, handoff: EDIT, server: 'ws://10.0.0.5:1234' }),
  `oip://app/app/?handoff=${EDIT}&server=ws%3A%2F%2F10.0.0.5%3A1234`,
)
