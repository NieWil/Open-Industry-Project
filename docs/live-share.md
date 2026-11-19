# Live share and Watch only

Live share lets anyone in a shared project watch someone else's run as it happens, with nothing installed and nothing
to control. Every run in a shared project can be watched; there is nothing to switch on. Watch only lets a controller connect to a PLC that
runs real equipment without ever writing to it. Together they give a live view of a real line: the desktop app
watches the PLCs, and a view link shows the result to anyone with a browser.

## What a viewer sees, and what it runs

A follower draws the runner's frames and runs nothing of its own. It has no worker, no PLC program and no part code.
The store stays stopped, so Use, cargo promotion, the PLC panels and every other run-owned control are idle, and the
document is never written. Only the view is put in its running state, because that is what draws cargo and run poses
([controller/liveView.ts](../src/editor/controller/liveView.ts)).

So a follower sees exactly what the runner sees, whatever drives the run: the program here, a real PLC, or a mix of
both. That includes the boxes, and the runner's PLC variables: a follower's watch table is the runner's (`plcWatch`
answers from the stream while following), so a note's counter, the Watch panel and the Inspector's tag values read what
the runner's do. The room already holds the program's text, so its values reveal nothing more.

The UI never says "room": a shared project is named everywhere, by its own name for its owner and by the name its room
carries for everyone else (`PROJECT_NAME_META` in collab/schema.ts; a room from before names reads as "Shared project").
Share keeps its label once shared, and who is here shows as avatars beside it (components/PresenceStack.tsx): a circle
per person in their presence colour, anyone running ringed. A click lists everyone with what they are doing ("running",
"watching Falcon"), a Watch beside anyone running, and the name field, which is how a view-link visitor names
themselves.

## Watching

Whose run a tab draws is one rule ([live/followTarget.ts](../src/editor/live/followTarget.ts)):

- Running one's own copy draws nothing else.
- Someone picked, with Watch in the people list or the chip beside Play, is followed until unpicked. If they stop
  running, the chip says "Waiting for Falcon to run" and their next run shows there.
- The owner's spotlight (below) is followed by everyone else until they dismiss it. A new spotlight asks again.
- A view link, which exists to watch, follows the owner while the owner is here, waiting between their runs, so a
  display never jumps to someone else's test run. With no owner here, it follows the only run going.
- An editor otherwise follows nobody, because a run taking over the view of someone editing would be an interruption.
  The chip offers it instead: "Falcon is running · Watch", or with several running, "3 running · Watch", which opens
  the people list.

A follower's chip names whose run it is, with a × to stop (a view link's own default has none: Play is its way out).
While following, Play is drawn outlined and reads "Run my own copy": it runs a private copy, and Stop goes back to
following. Editors keep editing while they follow, and an edit reaches the run the way any live edit does. The runner's
chip counts the audience, "2 watching", from presence (`watching` in collab/session.ts names whose run each person
draws). On a phone each chip shrinks to its dot and a word.

### Spotlight

The owner of a shared project (the person who shared it, as the server vouches for it: see below) can ask everyone in
it to watch their run: Spotlight on the chip beside Play while they run, Spotlight me on their own row of the people
list, or Simulation > Spotlight Me. Everyone else follows at once, with a chip saying "Watching Robert (spotlight)", and
can leave with its ×, which holds until the next spotlight. Someone dragging a part switches when they let go. Stop
spotlight, on the owner's chip, the list or the palette, lets everyone go back. The spotlight ends when the owner
leaves. Only the owner can turn it on: an editor holds the edit secret, so the server checks the owner token instead
([server/roomOwners.mjs](../server/roomOwners.mjs) `spotlight`).

### Following a view

Following someone follows their view too: their camera, eased between the poses they publish ten times a second while
anyone follows them (presence `view`, [controller/liveCamera.ts](../src/editor/controller/liveCamera.ts)). Moving one's
own camera, by an orbit, pan or zoom, detaches it: the run is still followed, the view is one's own, and the chip offers
Follow view to go back. Following someone new or a new spotlight attaches it again. In pilot or VR a tab drives its own
camera, so nothing is applied there. Someone followed while walking in pilot mode publishes where they really look
(`lookPose` in render/api.ts): pilot turns the camera and leaves the orbit target behind, so the target would point a
follower the wrong way.

### The view a link opens on

A copied link carries the camera it was copied at (`cam`, [controller/linkCamera.ts](../src/editor/controller/linkCamera.ts)):
position, look point, and whether it is orthographic. A visitor opens on it, over a camera remembered from an earlier
visit to the room. It is read once, filed as the visitor's camera for the room, and taken off the address, so a reload
reopens where the visitor left off. It is never in the room's document. A link copied from part focus carries none.
Following still applies after it: a view link with the owner present eases to the owner's live view.

### PLC values: Watch and displays

The Watch panel ([components/plc/WatchPanel.tsx](../src/editor/components/plc/WatchPanel.tsx)) watches whichever
controller runs: the program here, a PLC outside the app, or the run a tab follows. Its values are one image
(`plcWatch`): the program's own variables, joined by what the links to outside PLCs carry under the scene's tag names,
both what the parts send and what the PLC drives back ([controller/plcLinks.ts](../src/editor/controller/plcLinks.ts)
`plcImage`). The same image feeds a note's counter, and it travels with a shared run, so a follower's Watch and notes read
the runner's values, an outside PLC's included. Only a program running here is written or forced from Watch: an outside
PLC runs real equipment, and a followed run is someone else's. With an outside PLC set up, the empty list offers Add all
wired tags, each with the type its part's field declares.

Watch is each person's own list, kept in their browser. What displays list beside the scene is the presenter's, one
list for the project (`SceneJSON.display`, [core/scene/sceneDisplay.ts](../src/core/scene/sceneDisplay.ts)): saved,
undoable, and in a shared project carried in the room's `meta` (`DISPLAY_META`). It is chosen where it shows: Share >
For a display > Preview and edit opens one's own Present with the values panel open for editing
([components/PresentValues.tsx](../src/editor/components/PresentValues.tsx)): a search over the tags wired to parts, the
program's variables and an outside PLC's tags, a cross to take a value off, and a row dragged to reorder, each one undo
step ([program/displayValues.ts](../src/editor/program/displayValues.ts)). A right-click Show on displays on a Watch row
or a variable in the PLC panel hands one value over. Present lists the values live, from the image of the run it shows,
each with its type. Gated by `verify-external-plc-electron.mjs` (an outside PLC's tags in Watch, read only, typed, and
on a display), `verify-present.mjs` (choosing the list) and `verify-live-share.mjs` (a follower's Watch).

### Presenting

View > Present shows only the scene, for a projector or a display
([components/PresentOverlay.tsx](../src/editor/components/PresentOverlay.tsx)): no toolbar, docks, viewport toolbar,
orbit gizmo, other people's cursors or the editor's own overlays (the stats panel, Follow's badge, hints), and the
browser goes fullscreen. Loading progress still shows. Notes and their counters stay, being part of the
design. A chip says whose run and view are shown, and a bar at the top has Exit; both fade when the mouse is still.
Escape, or leaving fullscreen, ends it.

Share > Can view > For a display copies the same view link with `&present=1`, which opens straight into Present, locked
(main.tsx): no bar, and the way out is the browser's own. A visitor may move the camera (orbit, pan, zoom, and right-drag
flight, whose keys pass only while flying) but not act on the design: no selecting, no Use, no menus, no other key (one
listener added before the app mounts stops them). Once moved, a button goes back to the followed view, and the screen
goes back by itself after half a minute untouched. The cursor hides while the mouse is still. The chip says whose view it
is, "Watching Lynx", run or not, since between runs a display still shows that person's view live. A browser goes fullscreen only on a click, so an unattended screen runs the browser in kiosk mode
(Chrome: `--kiosk <link>`). A display is a view link, so it follows the owner's run and view, spotlight included. It is
not a third access level: anyone with it has what Can view gives.

## Sharing

The Share popover's links decide who gets in: Can edit (build and run) and Can view (watch), under which For a display
copies the same view link opening locked in Present. From a solo tab, either
link first makes a room, seeded from what is on screen, and the tab enters it in place: no reload, and the popover
stays open on the links ([roomEntry.ts](../src/editor/roomEntry.ts), main.tsx `registerRoomEntry`). The solo saves stand
down once the store is in collab mode, so nothing done in the room is written over the project. Until the room's
document has synced and its bridge is up, the editor is held read-only, because an edit made in between would land in
a store the room's document then replaces. A surface that cannot enter in place reloads into the room instead.

### Sharing a project

Sharing one of the user's projects keeps it their project, as a shared document is elsewhere
([project/sharedProject.ts](../src/editor/project/sharedProject.ts)). There is no second copy to keep track of:

- The project keeps its name and its place in the Projects list, where a small people icon marks it shared. The
  project menu shows its name, as always: that it is shared shows where sharing is controlled (Invite, and who is in
  beside it). Rename Project works on it as on any project of the user's.
- While it is shared its room is where everyone edits it, and this browser, which owns it, writes the room's document
  back into the project a moment after each change, its own edits and collaborators' alike. The project never falls
  behind the room. A room carries the scene, the program and the parts, not the project's tests, so the write-back keeps
  whatever the room does not carry from the project as last saved (sharedProject.ts `projectNow`). The desktop folder
  sync writes the same merge, so a project's `tests/` files are not deleted.
- The project's tests stay the owner's: in its room the owner's tab loads them from the project, runs them, and keeps a
  test it adds or deletes, which the write-back saves (`startWriteBack`, store `saveProjectTest`). A collaborator's
  browser has no project to keep tests in, so it has none.
- Opening another project, a new one, or an imported file leaves the shared project, in the browser and on the desktop
  alike. Its room stays open for the others.
- Opening the project again, from the Projects list or by opening the app, opens it in its room (main.tsx
  `roomToOpen`). If the server has lost the room, the owner seeds it again from the project.
- **Stop sharing** (the popover, or File > Stop Sharing This Project) makes the project the user's alone again: it is
  already up to date, the room is closed, so the links handed out stop working, and the tab opens the project solo.
  Anyone still in the room is sent back to the app and told it was closed; a link opened later is refused, and a copy
  of the room a browser had cached is dropped rather than shown.
- On the desktop, a shared project's folder keeps following it, from the room
  ([projectFolderSync.ts](../src/editor/project/projectFolderSync.ts)): git, backups and agents see every change. It
  is one way while shared. A change made to the folder meanwhile is not loaded, because a load replaces the project
  under the room rather than editing it: the sync waits, with a banner saying why, moving nothing, and when the project
  stops being shared it takes the change, or asks about it, as it always does.

Which projects are shared, and with which room, is this browser's record (`oip-web/shared-projects`). Closing a room
cannot rest on the edit secret, since every editor holds it, so the browser that shares a project mints an owner token,
registers it with the room on every connection, and closes the room with it ([server/roomOwners.mjs](../server/roomOwners.mjs):
the server keeps only its hash, deletes a closed room and refuses it from then on). The registration names the owner
tab's presence id, so the server can tell everyone who the owner is (`o` below), for the spotlight and a view link's
default. Someone who joins with the edit link
edits the owner's project but cannot close it; to have a project of their own they make a copy (File > Make a Copy).
The demo, shared, stays the current demo until someone edits it (collab/demoRoom.ts), so it is not written back into a
project, but it is owned like any share: whoever shared it can stop sharing it, which closes it and takes them back to the
demo on their own, and nobody else can claim it. Until then, opening the demo again in that browser opens its room, as
opening a shared project does (main.tsx `roomToOpen`), so the sharer can always get back to it to stop sharing.

A room nobody has claimed (one from before owner tokens) is claimed by the first writer that asks. The app only asks for a project of the user's own, but a writer could ask by hand. Where the server cannot close
a room (one claimed by someone else, or an older server), Stop sharing says the links would still open it and asks
before going on.

Both kinds of link can watch a run. An editor's changes are document edits, and a running sim takes live edits, so they
show in the run: a class can build a line together and watch it react. To keep an audience to watching, give it only
the view link.

## The stream

[core/live/liveFrameWire.ts](../src/core/live/liveFrameWire.ts) encodes the sim worker's frame (`BoxFrame`) as compact
binary. A worker frame is about 330 KB as JSON on the demo, but only 15 to 20 of its 1,100 bodies move in a frame. So
each message carries only what changed since the previous one:

- bodies added, changed or gone, each with its size, colour, kind and owning part sent once
- the poses that moved, with position rounded to 0.1 mm and rotation as the smallest three quaternion components in
  16 bits, sent when a body moved more than 0.5 mm
- per-part records (joints, lamps, displays, tags, belt speeds, mobile bases) whose value changed
- dressings as patches, and each cargo shape once

Measured on the demo with the line running: 0.8 KB a frame on average, 16 KB/s per viewer at 20 Hz before the
WebSocket's own compression, and a worst position error of 0.44 mm. A snapshot for a late joiner is about 150 KB.

A runner sends 20 frames a second, and only while someone follows its run, plus 10 s after the last one leaves so
someone who looks away and back starts at once ([collab/liveShare.ts](../src/collab/liveShare.ts)). A snapshot goes out
only when the server asks for one. While more than 32 KB is still queued on the socket, a frame is skipped and the next
carries every change since: on a slow upload a follower gets fewer frames instead of falling further behind. A follower
plays about 0.12 s behind the newest frame and blends the two either side of its play time
([core/live/livePlayback.ts](../src/core/live/livePlayback.ts)). Its play clock runs at the runner's rate, so a
fast-forwarded run plays fast and a paused one holds.

## The relay

Messages travel as Hocuspocus stateless strings, `live2|<kind>|<stream>|<body>`, and the collab server sends each run
only to its followers ([server/liveRelay.mjs](../server/liveRelay.mjs)). They never enter the room's document.

| Kind | Sent by | The server |
|---|---|---|
| `a` announce | a runner, as its run starts (its stream id is in its presence, `stream`) | registers the run |
| `f` / `u` follow, unfollow | anyone | adds or drops the follower, tells the runner the count (`w`), asks it for a snapshot (`q`) when it has none current |
| `s` snapshot | a runner, when asked | sends it to followers waiting for one, keeps it for later ones |
| `d` delta | a runner, 20 a second while followed | sends it to the run's followers, and keeps it after the snapshot |
| `e` end | a runner, at Stop | tells the followers and drops the run |
| `r` resync | a follower that missed a delta | answers that follower alone with the snapshot and the deltas after it |
| `o` owner | the server, on joining and on a change | who owns the room (a presence id) and whether the spotlight is on |

A kept snapshot is current only while deltas keep coming; a runner that went quiet is asked for a fresh one. A snapshot
request goes to a runner at most every 2 s, so following and unfollowing cannot make it upload, and past 1 MB of deltas
after the snapshot the runner is asked for a new one, which keeps a joiner's catch-up small. Only a connection holding
the edit secret may run (`a`, `s`, `d`, `e`); a view-only one may follow and ask to be caught up. BroadcastStateless
stays refused, because it would let any viewer relay text to everyone in the room. A runner that disconnects ends its
run for its followers, and after a reconnect, which the server sees as a new connection, the tab announces its run and
follows again, and the owner registers again.

Deploy the collab server before a web or desktop build that uses `live2`. An older server closes a connection that sends
a message it does not know. The new server ignores an old build's `live1` messages instead of closing, so a tab left
open on the old build keeps editing; it neither streams nor watches until it reloads.

## Watch only

A controller set to Watch only (Controller Properties, or the named controller's settings) reads every tag from its
PLC, including the ones parts write, and writes nothing to it. It is a project setting (`ScenePlc.watch`), saved with
the scene and undone like any edit.

Every point of the link becomes "read from the PLC" ([links/externalPlc.ts](../src/editor/links/externalPlc.ts)
`watchedPoints`). A sensor's tag is then driven by the PLC, so a part that shows what drives its tag shows the real
value. The first-party photo eye, push button, light curtain and safety gate do this: while `ctx.tagDriven(tag)` holds
they show `ctx.readTag(tag)` and not what they sense. A custom part can follow the same pattern.

Watch only does not work over Modbus. In serve mode the PLC reads its inputs from the simulator, and in poll mode the
simulator reads only input registers. Over Modbus a watched controller connects nothing, and the PLC panel says why.

Without Watch only, a link writes the simulator's sensor values into the PLC. Never connect one to a PLC that runs real
equipment.

## Self-hosting

A room lives on one collab server. The server a tab uses is, in order:

1. the one its room link names (`&server=wss://...`)
2. this computer's choice (Settings > Live editing > Collaboration server)
3. the build's default

The links Share copies name the server when it is not the build's. So a team that runs its own collab server sets it
once in the desktop app, and its view links open on the public site but connect to its server. Their data never
passes through ours. A link that names another server shows a notice saying where the room is kept, because anyone
can write such a link. Desktop links (`openindustry://open?room=...&server=...`) carry the server too
([apps/desktop/deepLink.cjs](../apps/desktop/deepLink.cjs)), and the shell accepts only a ws:// or wss:// address.

## Gates

- `e2e/verify-collab-auth.mjs`: against the real server, a run nobody follows reaches nobody; following asks the runner
  for a snapshot and counts the follower; a follower starts from the snapshot and a later one from the kept one; an old
  build's message is ignored; a viewer that tries to stream is cut off; the owner's claim and spotlight reach everyone,
  and another token's spotlight is refused.
- `e2e/verify-shared-project.mjs`: Share shares a solo project in place, tagged Shared under its name; an edit in the
  room, the owner's or a collaborator's, reaches the project by itself; opening the app again opens it in its room; Stop
  sharing makes it solo with everything kept and closes the room, so its links stop working.
- `e2e/verify-live-share.mjs`: the demo shared against a real collab server, with no Live switch. A view link waits for
  the owner's run and follows it without running anything; an editor joining mid-run is offered it, starts at the
  same point and follows the owner's view, which its own camera move detaches and Follow view attaches again; the owner's spotlight takes the editor, who can dismiss it; with two running, the view link stays on the
  owner and can pick the other; the viewer's own Play and Stop take over and give back; Stop ends the run for its
  followers.
- `e2e/verify-present.mjs`: Present hides the editor and fills the window with the scene, its bar fades and comes back,
  Escape and Exit bring the editor back, and `&present=1` opens straight into it.
- Unit tests: `core/live/*.test.ts`, `collab/liveShare.test.ts`, `live/followTarget.test.ts`, `server/liveRelay.test.mjs`,
  `server/roomOwners.test.mjs`, and Watch only in
  `links/externalPlc.test.ts` and `store/storePlcs.test.ts`.
