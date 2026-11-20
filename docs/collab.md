# Collaborative editing & invite links

Live multi-user editing: several people edit one scene at once, and each can hand out an invite
link. It is built on **Yjs** (a CRDT) with a self-hosted **Hocuspocus** WebSocket backend. Every
piece is open source and can be self-hosted.

> Access model: **capability links, no accounts.** A room's **edit link** carries an
> unguessable edit secret (`?room=e-<uuid>`). Its **view link** carries only the derived
> document name (`?room=r-<sha256(secret)>`). The server (`onAuthenticate`) grants write
> access only to connections whose token hashes to the doc name, so view-only is
> **enforced at the protocol level**. Stripping `?view` from a view link changes nothing,
> and the server drops a viewer's writes (`e2e/verify-collab-auth.mjs` tests the
> matrix). Viewers watch the live design and can run their own private sim. Nothing else
> is a room. An unprefixed `?room=<id>`, whose id would be both name and credential, opens
> the editor solo with a short notice, and the server refuses any document name that is not
> `r-<64 hex>`. See `src/collab/rooms.ts`.

## How it works

- The editor is a static SPA. Solo (no `?room`), the project's working copy lives in `localStorage`. The
  collaboration code is **dynamically imported only when a room is open**, so the solo
  bundle doesn't include it.
- A room is a URL: `/app/?room=e-<secret>` (or `r-<hash>` to view). Opening one connects a
  `Y.Doc` to the Hocuspocus server (document name = `r-<sha256(secret)>`) and to IndexedDB (offline cache + instant load).
- The `Y.Doc` mirrors `SceneJSON`: `parts` (a `Y.Map` of per-part `Y.Map`s),
  `order` (a `Y.Array<string>`), and `meta`. See `src/collab/schema.ts` for the exact
  mapping and the rationale (per-part field-level merge, per-axis position, JSON-atom list
  params).
- `src/collab/bridge.ts` is the two-way binding to the `EditorStore`. Local commits diff
  into minimal Yjs ops (`src/collab/diff.ts`). Remote changes rebuild the scene and apply
  via `store.applyRemote()`, with no undo entries and no echo (origin + re-entrancy guards).
- Sharing: the **Share** button mints an edit secret, marks this tab as the room's seeder,
  copies the link, and reloads into room mode. Only the minting tab seeds the empty room
  from the user's current scene, so a mistyped or stale link can never upload your private
  solo scene into a foreign room. **Invite** (already in a room) just copies the URL.
- **Sharing the untouched demo shares the demo itself, not a copy of it** (`src/collab/demoRoom.ts`).
  A copy would freeze the demo on the day of the Share, and an old link would keep opening an old
  demo. The room records which demo it holds (`meta.demoSeed`, a fingerprint of the content it
  wrote). An editor whose build has a different demo, joining a room that still matches its
  fingerprint, replaces it with its own. The first edit breaks the match, and from then on it is an
  ordinary room no build touches. The replacement never happens from an offline cache
  (`serverSynced`) or over a newer build's claim. It is written under a client id derived from what
  it replaces and what it writes, so two editors refreshing at once make the same Yjs write instead
  of merging two demos. Sharing from the demo doesn't fork it into the sharer's projects either. Gated
  by `e2e/verify-collab-demo-room.mjs`. Rooms that hold a plain copy of an older demo stay as they are.
  **View link** copies the derived `r-` doc-name URL, which holds no edit secret.
- View-only enforcement has three layers. The **server** refuses writes from secret-less
  connections (protocol-level, the real boundary). The store drops every authoring `commit`
  and `loadScene` (`EditorStore.setReadOnly`). The bridge is constructed read-only, so it
  never pushes to the doc and installs no undo writer (`CollabBridge(..., readOnly=true)`).
  A viewer also never seeds the room. doc → store and presence still flow, so the view
  stays live.
- Presence identity is a per-tab random animal + color; the Share popover has a **"Your
  name"** field (persisted in `localStorage`, still no accounts) that overrides it live.

### What's shared vs. local

- **Shared:** the scene (field-level part merge), part order, custom-part **packages**
  (an authored part travels with the room), and the **ST program** (co-edited `Y.Text`
  via y-codemirror). Undo inside a room is a `Y.UndoManager` scoped to local edits, so
  your Ctrl+Z never reverts a peer's work.
- **The Part Editor works in a room.** It shows the part alone by swapping the store's scene for
  one holding only that part, with the line parked in `packageEdit.document`. The bridge syncs the
  line, not the store's scene: while the editor is open it writes nothing from the scene side, and
  a peer's edit lands in the parked line (`store.applyRemote`). Opening and closing the editor
  each re-assert the room's scene instead of diffing, so a peer's drag on screen at that moment is
  never written as an edit. The editor's own changes are package edits, which the package sink
  carries. A run in the editor tests the part and is not streamed to a live audience. Gated by
  `verify-shared-part-editor.mjs`.
- **Deleting a part reaches everyone.** The room's entry is removed, or for a built-in's edited
  copy still placed, written back as a snapshot of the app's version. Either way the id stops being
  an edit (`edited`), which is how each peer's bridge tells a delete (`removed` in
  `applyRemotePackages`). A peer whose line places the part, because it was placed as it was
  deleted, keeps it and sends it back, since the room must hold every placed part's definition.
- **The program's controller table and scan time go to the room only when you change them.**
  The store hands the bridge the whole program on every program commit, so the bridge compares
  each with the room's value as this client adopted it (`bridge.ts`, the program sink) and leaves
  an unchanged one alone. A table this client cannot read (a newer build's) is never replaced
  from here. Writing both back on every commit would lose data whenever two builds share a room.
  An Assign I/O or a rename on the older client would delete the newer one's table for everyone,
  a readable table would lose the fields the older build drops, and a 2.5 ms scan time would come
  back as 3.
- **A room remembers the newest build that has edited it, and an older build only watches.**
  Two builds in one room is normal after a deploy (a tab left open keeps the old one). An older
  build loses what it cannot represent on every path it writes back by. A part's params come back
  normalized, a package's mesh blob is re-written from what it parsed, and the part order is
  rewritten without what it could not decode. So each editor claims the room for its build on
  joining (`meta.build`, the commit time of its source: `__BUILD_TIME__` in vite.config.ts). A
  client older than the claim is view-only, at join or the moment a newer tab arrives, with a
  banner whose Reload loads the newer build (`schema.ts` ROOM_BUILD_META, `bridge.ts`
  checkBuild / stopWriting, `NewerBuildBanner.tsx`). The claim is stored, not presence-based,
  because what the newer build wrote stays in the doc after it leaves. This has two consequences.
  Rolling a deploy back to an older commit leaves the rooms the newer one touched view-only until
  a build at least as new ships. A dev build (committed ahead of production) joining a production
  room would do the same to it, which is one reason dev builds default to a local collab server.
  The one path a live switch cannot close is a mounted ST editor. It writes its text into the
  shared `Y.Text` directly and reads view-only only when it mounts. Text is the one thing an older
  build cannot damage.
- **Shared, but gated:** the code in those packages. A part's behavior is JavaScript, and it runs
  in the part sandbox (SES lockdown + Compartments, [part-sandbox.md](./part-sandbox.md)). The
  code-trust gate (`src/collab/codeTrust.ts`, applied in `bridge.ts` and the room boot in
  `main.tsx`) decides whether a room's code runs at all. A package reaches the store only in an
  admitted form: its data as the room holds it, and its code only if that code is trusted or the
  room's code is allowed to run. Trusted without asking: any shipped version of this app's own
  parts (matched by SHA-256 against every released version, `src/editor/parts/shippedBehaviors.ts`), and
  code this browser wrote into a room (remembered by fingerprint). Held code keeps its params and
  rig but runs a stand-in (its earlier version, else the built-in of the same id, else nothing).
  The stand-in is in both the registry and the scene's embedded copies, which the sim falls back
  to. What happens to the rest depends on where the editor runs
  ([part-sandbox.md, Rooms](./part-sandbox.md#rooms)):
  - **Where the part sandbox is on** (lockdown succeeded, in a browser or the desktop): the room's
    code runs by default, with nothing shown.
  - **Where lockdown failed:** the code is held until allowed. The
    prompt asks once per room. Allowing it is remembered per server doc name and covers the
    room's later code too.
  - **Safe opens** hold the foreign code for one open even where it would run. That happens with
    `&nocode` in the link, or automatically when the last open of this room never finished (it
    froze or crashed the page; `codeTrust.ts` `markRoomOpening`), so a room with a hostile part
    stays openable.

  Viewers are gated the same as editors. Writes from a client never publish a stand-in as a part's code
  (`PackageGate.docForm`). **A file exported while code is held carries the stand-in**, because
  nothing downstream is ever handed the author's source, and an export is downstream. The
  stand-in explains itself in a comment (`INERT_BEHAVIOR`), and the export names the parts that went
  out without their code (`noticeHeldCodeInExport`, on Export Project, the only export).
  Putting the real code in the file instead would defeat the gate. A scene file opened solo has no
  room and no prompt, so it would run the code that was refused here. Allow the room's code first if
  you want a file that runs. Gated by `e2e/verify-collab-code-trust.mjs`, which uses a real escape
  from the part guards and checks that it fires only after "Allow".
- **Presence (ephemeral, not persisted):** cursors, selections, live drag poses, pilot-mode
  avatars, "running a preview" state, and the behavior-editor soft lock.
- **Local:** the **running simulation**. Each user runs their own sim from the shared scene.
  Structural edits propagate live; sim runtime (spawned boxes, button pulses) does not. The exception is a run an
  editor chooses to share: the others draw it without running it, over stateless messages that never enter the
  document ([live-share.md](./live-share.md)).

  Most sim runtime stays local with no extra code, because it never leaves the transient stream,
  which the bridge ignores. **Cargo is the exception and needs an explicit mask** (`authoredCargoView`
  / `withRunLocalCargo` in `bridge.ts`). Handling a live box goes through `store.commit` like
  real authoring. A pilot pick-up or a click/band-select promotes a spawner box into a part,
  a gizmo drag commits the pose physics gave it, and a mid-run drop or duplicate creates more.
  Unmasked, every one of those would reach the doc, and a peer who never pressed Play would get
  our physics as an authored edit (phantom boxes, or their boxes teleported down the line). So
  while a client runs, its run-scoped boxes are held back from the doc (and merged back onto every
  remote rebuild). A box the doc holds keeps the doc's pose, since physics owns where a box is
  mid-run. Stop re-asserts the doc's cargo. A box's settings still propagate (they are
  authoring), and so does a box carried by a group moved mid-run, which follows its group.
  Everything non-cargo propagates live too: moving a conveyor mid-run is a real edit. The solo
  store draws the same line; see [document-and-run.md](./document-and-run.md).

## Running the server locally

```sh
cd server
npm install
npm start            # listens on :1234, persists to server/collab.sqlite
```

The frontend defaults to `ws://localhost:1234` in dev, so `npm run dev` + the server above
is all you need. Open `/app/?room=e-test` in two browser windows to try it. A shared project opened while that server
is down says so: past a 10 s blip, the people button reads Offline, and its list names the server it cannot reach, says
the changes are kept, and offers Retry ([PresenceStack.tsx](../src/editor/components/PresenceStack.tsx); gated by
`verify-collab-offline.mjs`). The same message is what a user sees when the production server is unreachable.

## Configuration

The frontend reads the server URL from the `VITE_COLLAB_URL` env var (see `.env.example`).
Unset, a production build talks to `wss://collab.openindustryproject.org` and a dev build to
`ws://localhost:1234` (`collabUrl()` in `src/collab/provider.ts`), so set it only to point a build
at a different server, e.g.:

```
VITE_COLLAB_URL=wss://collab.example.org
```

A tab can also use another server without a build of its own: a room link may name its server (`&server=wss://...`),
and Settings > Live editing > Collaboration server sets this computer's. `collabUrl()` in
`src/collab/collabServer.ts` picks between them, and [live-share.md](./live-share.md#self-hosting) says how.

Server env vars: `PORT` (default `1234`), `HOST` (default `127.0.0.1`: loopback, behind Caddy on
the same box) and `DB_PATH` (default `collab.sqlite`), plus
the hardening settings (doc-size cap, per-IP connection/room-creation limits, idle-room GC
TTL, snapshot cadence). See the constants at the top of `server/index.mjs` and the
tuning table in [`server/DEPLOY.md`](../server/DEPLOY.md). The server also snapshots
every active room periodically (single-room restore = one `UPDATE`, runbook in
DEPLOY.md), backs itself up nightly via a systemd timer, and serves `GET /healthz`
for uptime monitors.

## Deploying the server

It is a small Node WebSocket server. Deploy `server/` anywhere that gives you a persistent
disk for the SQLite file and a public `wss://` endpoint. Because it's an always-on WebSocket
server that writes SQLite, it needs a **real block-device disk** (not a network/SMB share,
where SQLite locking is unreliable) and **a single always-on instance** (the Yjs docs are
per-process in memory).

- **Azure VM (B-series) + Caddy** is the production setup, with a full runbook and
  `cloud-init.yaml` in **[`server/DEPLOY.md`](../server/DEPLOY.md)**. Azure Container Apps and
  App Service don't fit, because they only offer SMB-backed storage for the DB.

The frontend is Cloudflare Pages, deployed by `.github/workflows/deploy-pages.yml`, which sets
`VITE_COLLAB_URL` at build time.

## Limitations

- There are no accounts, so an edit link cannot be revoked. Rotating a leaked edit link means
  re-sharing into a fresh room.
- There is no "leave session" command. A viewer who wants their own copy downloads the scene.
