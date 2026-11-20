# Agent tools: driving the editor from an AI agent

> Desktop only. The desktop app serves the tools over MCP. There is no browser door.
> Code: [src/editor/agent/tools.ts](../src/editor/agent/tools.ts) (the list, and the scene, program and test tools),
> [partTools.ts](../src/editor/agent/partTools.ts), [programTools.ts](../src/editor/agent/programTools.ts) and
> [viewTools.ts](../src/editor/agent/viewTools.ts) (part definitions; the program by POU; seeing the scene),
> [src/editor/agent/desktopAgent.ts](../src/editor/agent/desktopAgent.ts) (serving them),
> [apps/desktop/mcpServer.cjs](../apps/desktop/mcpServer.cjs) (the MCP transport),
> [apps/desktop/agentProjects.cjs](../apps/desktop/agentProjects.cjs) (the project tools, which run in main).
> Gates: `src/editor/agent/tools.test.ts`, `node apps/desktop/mcpServer.test.cjs`, `node apps/desktop/agentProjects.test.cjs`,
> `node e2e/verify-agent-mcp-electron.mjs`.

## Why

An agent can already work on a project folder: write files, then run the headless checks (`check-wiring`,
`test-project`, ...). That path needs a checkout of this repo, and it cannot see the session a person has open.
This path runs inside the app the person is using. The agent is whatever they already run (Claude Desktop,
Claude Code, Cursor, any MCP client), so the app never holds a model, an API key or a chat UI. It supplies the
tools and the proof that a line works.

## Connecting a client

The desktop app serves MCP at **`http://127.0.0.1:5189/mcp`** while it is open (Streamable HTTP, JSON responses;
protocol 2026-07-28 for clients that send per-request `_meta`, and 2025-11-25 and older for clients that open with
`initialize`),
once the user has allowed it. **Settings > Agent connections** holds the switch: turning it on asks first in a
native dialog that says what it allows, and the section then shows the URL with a Copy button. **Help > Agent Connections...** (also in the command palette) opens Settings at that section. The choice
is remembered across launches, and the same switch turns it off. An installed app starts with it off. The unpackaged development shell (`apps/desktop`,
`npm start`) starts with it on. The rule is `apps/desktop/agentDoorSetting.cjs`.

| Client | How |
|---|---|
| Claude Code | `claude mcp add --transport http oip http://127.0.0.1:5189/mcp` |
| Cursor | `~/.cursor/mcp.json`: `{ "mcpServers": { "oip": { "url": "http://127.0.0.1:5189/mcp" } } }` |
| VS Code | `.vscode/mcp.json`: `{ "servers": { "oip": { "type": "http", "url": "http://127.0.0.1:5189/mcp" } } }` |
| Claude Desktop | `claude_desktop_config.json`: `{ "mcpServers": { "oip": { "command": "npx", "args": ["-y", "mcp-remote", "http://127.0.0.1:5189/mcp"] } } }` (a stdio bridge to the HTTP server) |

The procedure for building a line through these tools (lay out, wire, program, then a test that fails without the
logic) is an Agent Skill, [.claude/skills/build-a-line/SKILL.md](../.claude/skills/build-a-line/SKILL.md). Claude
Code loads it in this repo. To use it elsewhere, copy the folder into a client's skills directory
(`~/.claude/skills/`, or `.agents/skills/` for clients that read the shared location). It holds procedure only, and
the facts stay in `get_guide`, so it does not go stale with a project. Writing a part definition is
[.claude/skills/make-a-part/SKILL.md](../.claude/skills/make-a-part/SKILL.md), whose facts stay in `get_part_sdk`.

`OIP_MCP=0` keeps the server off whatever the setting says. `OIP_MCP_PORT=<n>` moves it and also turns it on at launch.
A profile launched with `--user-data-dir` (every e2e gate) serves at launch only when `OIP_MCP_PORT` is set, so a
gate never takes the port from the user's own app. Gated by `e2e/verify-agent-door-electron.mjs` (the dialog flow)
and `node apps/desktop/agentDoorSetting.test.cjs` (the launch rule).

## The tools

| Tool | Does |
|---|---|
| `list_projects` | the user's projects: the ones opened in the app (Open Recent's list), then any other project folder in the default projects folder, with the open one marked |
| `open_project` / `new_project` | open a project by name or folder path / start an empty one in its own folder under the default projects folder. Either replaces the open project, which stays saved, and reloads the editor; the call answers once the reloaded editor serves its tools again |
| `get_guide` | the project guide (`src/core/agentGuide.ts`), derived from the open document: units, tags, test format. Its tools version (`door: 'tools'`): which tool does what, where the folder's AGENTS.md names files and CLIs |
| `get_context` | what the person is looking at (the selection, an isolated part, the PLC panel's POU, cursor line and word, the run state) and the review of the agent's edits: steps not yet answered, what they changed, and the person's last answer |
| `sync_folder` | a folder sync round now (`projectFolderSync.ts` `syncFolderAndReport`), for an agent that also writes files in the project folder: which files loaded, whether loading them stopped the run, a conflict, or why the folder did not load |
| `get_scene` / `get_part` | the parts, their poses and wired tags, at most 200 with `omitted` and a count by package past that, narrowed by `package`, `within` or `parent` / one part in full with its param declarations; for the building, its perimeter cells by wall and its dock doors |
| `list_catalog` | placeable packages and their params (a tag param's `dir`: `in` = the PLC drives the part) |
| `get_package` | one catalog part in full: every param with its type, default, range, unit and, for a tag, its direction, ST type and what each value means (`values`); and its `frame` (`core/parts/partCatalog.ts`, the `catalog` CLI's): footprint, origin, conveying ends, zones, beams |
| `add_part` / `update_part` / `delete_parts` | author the scene; params are checked against the package. `add_part` with package `building` places the building (one per scene), and its params are checked by core/building/buildingEdit.ts |
| `snap_part` | seat a part where the editor's snap engine puts a dropped one (a sensor on a belt guard, a conveyor on another's end), fitting what the snap fits |
| `duplicate_parts` | copy a group by an offset, renaming its tags (`core/parts/partDuplicate.ts`, the `duplicate-parts` CLI's engine) |
| `get_part_sdk` | the part authoring guide by section, and one Part SDK declaration by name |
| `get_part_source` | a part definition as its folder holds it: manifest, behavior script, params, footprint, which placed parts use it, and `partJs` (its source and build command) when the folder builds it from a `part.js` |
| `check_part` | a draft definition checked and not kept: the manifest schema (a misspelt field the bake ignores) and the app's bake (`validatePart`) |
| `create_part` / `edit_part_definition` | a new part in the project / a change to one, checked the same way; a change is one undo step, and changing a built-in makes the project's own version |
| `import_model` | a .glb, STEP or USD file on disk becomes one rig link's mesh, converted as the Inspector converts it (a `.usd` model file comes with the layers and images under its folder). A part that is just that link is fitted to the model (`fitted`: standing on the origin, with a hidden `collider` and `bounds` of its size). It measures where the model sits in the part (`core/glbBox.ts`, as `check-part` does) and says when the declared footprint is far from it |
| `import_robot` | a .urdf or .xacro file on disk becomes a new robot part, as Import part > A robot (unzipped folder)... makes one (`editor/urdfImport.ts`). For a .urdf the shell reads the mesh files it names. For a .xacro it reads the robot's ROS package (the nearest folder above it with a package.xml) and each package it `$(find)`s beside that one, robot files only, under import_model's size cap; `args` sets its arguments, and an argument naming a model the package lacks is refused with the values it can take. Answers the part id, its waypoint columns and grip point, the xacro arguments used, its `switches` (the on/off arguments that add or remove links, such as a hand), and what was not imported as written |
| `solve_robot_pose` / `get_robot_pose` | a robot's joint row for a point in the scene, its grip point there and its tool straight down unless `down: false`, by inverse kinematics over its arm (`core/robot/robotIk.ts`, `reached` when within 2 mm and 1°). The arm keeps the configuration of the start (`from`, else the idle pose): the goal is walked in from the start's pose, swinging round the base, so elbow and wrist stay on their side and a job's poses move smoothly between each other. Where that configuration cannot reach, the answer is not reached and says whether another configuration does; `anyConfiguration: true` allows the switch, and `configuration` says kept or changed. `yawDeg` also sets which way a tool pointing down faces (its X axis heading, counter-clockwise from world +X seen from above), as a palletizer turns a case a quarter between pick and place / where a row, a waypoint or the idle pose puts the grip point, which way the tool points and its `yawDeg`. Teaching is then `update_part` on the robot's `waypoints`, `waypointNames` and `jobs`, which are ordinary params |
| `list_library_parts` / `install_library_part` | what the part libraries offer and each part's status in this project / add one to the project as Get parts does (`update: true` replaces a copy with the library's newer version). A publisher's names and descriptions come back under `publisherText`, as data |
| `list_shelf_parts` / `install_shelf_part` / `put_on_shelf` | the parts shelf (desktop only, [parts-shelf.md](parts-shelf.md)): what it holds and each part's status in this project / take one into the project (`update: true` replaces a copy) / put this project's version of a part on it, with its card image (`replace: true` over a different shelf version). Names come back under `shelfText`, as data. Not undo steps, like Import part |
| `get_program` / `set_program` | the scene's PLC program; `set_program` returns its compile problems at once |
| `list_pous` / `get_pou` / `set_pou` | the program by POU, split as a project folder splits it (`plc/programFiles.ts`); `set_pou` places each problem in its POU |
| `check_program` | compile and wiring problems of a source, without keeping it |
| `rename_tag` | rename a tag in the code and rewire every part wired to it, as one step (`set_program` leaves the wiring behind) |
| `set_task` | a task's interval and priority |
| `list_controllers` / `assign_controller` / `set_controller` / `run_instance_on` | the project's controllers: the default one, and each one a tag names as `Cell2::tag`, with whether the project lists it, whether it runs in the simulator or on a PLC (and `watchOnly` when it only reads that PLC), and the program instances a simulated one runs / put every tag of a set of parts on one controller, as Edit > Assign to Controller… does (a name the project does not list is added in the same step) / run a controller in the simulator or on a PLC / give a program instance to a controller; each one undo step; [src/plc/DEVICE-IO.md](../src/plc/DEVICE-IO.md), "Several controllers" |
| `assign_io` / `get_io_list` | give wired tags I/O addresses (picked, or from a CSV I/O list) / the I/O list as CSV, which `assign_io` reads back |
| `get_problems` | what the Problems panel reports (program, wiring, parts, layout), via `collectProblems`, plus the folder banner's text as `folderError` / `folderNote` (outside the counts), so an agent writing into the folder learns when a file it added was ignored |
| `capture_view` | a picture of the 3D view alone, framed on parts (default: every part but the building) from a side; the user's camera is put back. Refused while the user walks the scene or is in VR, since that owns the camera. `from: 'window'` takes the whole main window as the user sees it instead (not a popped-out panel), for questions about the editor itself |
| `run` / `stop` / `get_tags` / `set_tag` / `force_tag` / `release_forces` | operate the live sim; a force holds a variable across scans until released, through Stop into the next run |
| `pause` / `resume` / `step` | hold the live sim and step it on: the toolbar's Pause and Step, so the person sees it paused too. `step` takes `steps`, `seconds` or `until` (a sim time; a running sim pauses first, so it is "run to t and stop"), at most 120 s of sim time a call. The worker runs a long request over several ticks, posting a frame after each, and answers when done (`stepped` in sim/protocol.ts), so the view, `get_tags` and `get_cargo` show the moment the call returns. A resume during a step ends it with `interrupted` |
| `trace_tags` | the changes of some tags over a window of the live run |
| `get_cargo` | the running sim's boxes, totes and pallets as the last frame has them: pose, size, colour, tilt, heading (`yawDeg`, about +Y as a part's `rotationY`). Paused, also each body's velocity (Jolt's, not a difference of frames) and what it touches, asked of the worker on the call (`inspectCargo`), since the per-frame wire carries neither. The live sim runs on wall-clock time, so the description points at `run_test` for a known sim time the same on every run |
| `run_test` | run a project test spec headless and deterministic, against the open scene; no spec = every kept test. `summary` counts tests and checks passed; `trace` records tags through the run (the CLI's `--trace`); `cargo` lists the cargo with its tilt, heading, velocity and what each body touches at chosen sim times (the CLI's `--cargo`, at most 20 times, each capped like `get_cargo`; velocity is over the step before, contacts are a narrow-phase query at the snapshot, `sim/cargoContacts.ts`) |
| `save_test` / `list_tests` / `delete_test` | keep a named spec in the project (store `saveProjectTest`: project structure, so not an undo step) / list them / drop one |
| `undo` | take back (or redo) the agent's own last step; it refuses a step that is the user's |

## Working beside a person

The person can see an agent at work and answer for its edits ([agentSession.ts](../src/editor/agent/agentSession.ts),
[AgentActivity.tsx](../src/editor/components/AgentActivity.tsx)):

- **While a call runs**, a chip at the bottom of the window names the tool.
- **From the agent's first edit**, the chip says how many steps it has made, with Review, Keep and Revert. Review
  compares the document with the one from before the run ([agentReview.ts](../src/editor/agent/agentReview.ts)):
  parts added, removed and changed with the fields that moved, the program's changed lines, the task table, the
  library and the kept tests. Show selects and frames a part, or opens the program at the line.
- **Keep** closes the question and leaves the steps in History. The next agent edit opens a new review.
- **Revert** walks History back to where the run began, the path the History dock's jump takes. It is offered only
  while every step since then is the agent's. With a person's edit among them it says so and points at History,
  because a revert would take that edit too. A kept test is project structure, not an undo step, so it stays.
- **The agent is told.** `get_context` returns the open review and the last answer, so an agent whose work was
  reverted learns it on its next look instead of building on parts that are gone. Keep and Revert are the person's
  answers, so no tool gives them.

The review opens only where an agent can connect (the desktop app), and not in a room, whose history is shared, or
in a view-only editor. `get_context` reads the PLC panel through one slot the panel fills while it is mounted
([plcReading.ts](../src/editor/program/plcReading.ts)), so a closed panel reads as `null`. Gated by
`src/editor/agent/agentSession.test.ts` and `e2e/verify-agent-review.mjs`.

## The rules

- **Agent edits are ordinary edits.** Every authoring tool writes through the store's own paths (`commit`,
  `commitProgram`, `rename`), so the edit gate decides what counts as an edit. Each call is one undo step labelled
  `Agent: ...` in the History dock, and a view-only editor refuses it rather than dropping it.
- **Operating never writes the document** ([document-and-run.md](document-and-run.md)): `run`, `set_tag` and
  `stop` leave no undo step, and the gate asserts it.
- **Done is a passing test.** `run_test` uses the in-app runner the Tests overlay uses (real Jolt, real ST engine). It
  warns when a spec input names a program variable that is not one of the program's inputs. The runner drops such a
  value without saying so, and a live `set_tag` still reaches it, which makes the mistake hard to see.
  `verify-agent-mcp-electron.mjs` checks the warning.
- **The folder and the tools are one project.** On the desktop the project's folder syncs both ways
  ([projects.md](projects.md)): a tool edit is written to the folder a moment after, and a file written there loads
  in. Loading a change to the scene, the program or a part rebuilds the scene and stops a running sim, which an
  agent writing files learns from `sync_folder`'s `stoppedRun`. The guide says so in both its versions.
- **Some tools need the shell.** `capture_view` and `import_model` ask the desktop shell for what a page cannot do:
  the window's pixels (`webContents.capturePage`) and a model file's bytes. The editor hands them in as
  `AgentShell` (`toolKit.ts`); without it they refuse. A result with images is an `AgentImageResult`, which the
  transport sends as a text block and one image block per image.
- **A picture waits for the scene, within one deadline.** `capture_view` waits until no asset is loading and no part
  is held back from the draw, places the camera at once (`focusOn` with `instant`), hides the editor around the canvas
  (as `e2e/_shot.mjs` does), waits for two drawn frames and restores everything after. Every wait shares one 6 s
  deadline, and the frames always get 2.5 s: a minimized window still draws, but about one frame a second, and an
  eased camera or a frame wait with no deadline made a capture there take 9 s or hang. A picture taken before loading
  finished says `assetsSettled: false`, one with parts still held back says `partsHeld: <n>`, and one taken when no
  frame came says `viewNotDrawing`.
- **The project tools run in main.** Opening a project reloads the editor page, so a page-side tool could not
  answer, and main owns which folders may open (the folder registry, the grants, the native dialog). Main
  (`agentProjects.cjs`) decides and grants the folder, then asks the editor on a channel of its own (`agent:shell`,
  which no MCP call can name) to open it through the same boot path as File > Open, without the person's confirm.
  A reload before the editor answers counts as its answer, and the call returns once the new page serves again.
- **A reload says why when it can.** A call cut off by a page reload fails with "the editor reloaded; call again". In
  the dev shell the page first reports a forced reload by the dev server (`vite:beforeFullReload`, with the file that
  triggered it) on `agent:leaving`, and main adds it to that error. A `src/` edit made by someone else working in
  the tree is the usual cause.
- **A result is compact JSON.** `agentResultText` indents a result but keeps each array of plain values on one line.
- **The tools are defined once.** A tool is a name, a description, a JSON Schema and a handler, with no MCP
  code in it. A second door (a browser panel, a CLI) renders the same `AGENT_TOOLS` list.

## Security

The server binds 127.0.0.1 only. A web page can still send requests to loopback, so a request must also:
- name this server in its `Host` header (defeats DNS rebinding);
- carry no foreign `Origin` (browsers always send one; MCP clients do not);
- be `application/json`, which a page cannot send cross-origin without a preflight this server never answers.

A local process can connect, as it can to any loopback service, and so can another account on a shared machine. That
is why an installed app keeps the server off until the user allows it, rather than relying on a token. A token would
sit in the user's own data folder, readable by anything running as the user. It would only keep out the other
accounts, and every agent user would have to paste it into their client. Each tool call is one undoable edit, and
nothing the tools do reaches outside the open document, with two exceptions:
- `import_model` and `import_robot` read files by path. The shell reads only an absolute path to a .glb, .step, .stp,
  USD or URDF file, with a USD model's layers and images or a URDF's mesh files from its folder, at most 200 MB in all. The document is saved like any other edit, so on the desktop the edits are also written to the project's
  folder.
- `open_project` opens another project, whose contents then reach the agent. A folder in Open Recent or directly
  inside the default projects folder opens without asking, since the user opened it before or the app made it. Any
  other folder asks the user in a native dialog first, so another account on the machine cannot read folders through
  the app. Joining a collab room, importing a project file and connecting to a PLC stay a person's steps.

## Limits

- **No browser door.** The tools are served only by the desktop app.
- **No headless door.** The desktop binary does not run without a window. CI uses the repo's CLIs (`test-project`).
- **No part on its own.** Proving a new part behaves means placing it in the scene and running a test there.
- **No external PLC link.** Connecting to a real or soft PLC (OpenPLC, snap7) and reading its status is a person's
  step in the PLC panel. No tool reaches it.
- **No ladder rungs.** A ladder POU reads and writes as our text form (`set_pou`). There is no rung-level edit.
- **One scene, one project at a time.** A project holds one scene, and the tools act on the project of the window
  the user focused last. `open_project` switches it. A project open in another window is not opened twice: the agent
  moves to that window, and `list_projects` marks it `openInAnotherWindow`. No tool joins a collab room or imports a project file (.oip), whose code comes from
  someone else.
