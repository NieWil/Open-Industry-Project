---
name: build-a-line
description: Build or change a simulated production line in Open Industry Project (conveyors, sensors, spawners, a PLC program in IEC 61131-3 Structured Text) and prove it works with project tests. Use when asked to lay out a line from a spec, wire parts to a PLC program, add a lane or station, or write tests for a line, whether through the desktop app's MCP tools (oip) or the repo's headless CLIs.
---

# Building a line that is proven to work

A line is done when a test that would fail without your logic passes. A program that compiles is not that, and
neither is a line that loads. Work in the order below. Each step has a check, so a mistake shows up at the step
that made it.

The facts about this project (its tags and their direction, the extents of its parts, the manifest and test format)
are in its generated guide: `get_guide` over MCP, or the project folder's `AGENTS.md`. Read the guide first. This
skill is the procedure only.

## MCP or CLI: the same steps

| Step | MCP (desktop app open) | CLI (repo checkout, project folder) |
|---|---|---|
| What the person means | `get_context` (their selection, the POU and line they are on, and whether they kept or reverted your last edits) | (none: a folder has no person in it) |
| Learn the parts | `list_catalog`, `get_package` | `npm run catalog`, `npm run catalog -- <id>` |
| Place | `add_part`, `snap_part` | `npm run add-part -- <folder> <id> --params ... [--scaffold]`, `npm run snap-part -- ... --project <folder> --write` |
| Retune | `update_part` | `npm run edit-part -- <folder> <partId> --params ...` |
| Copy a station | `duplicate_parts` (offset + tag renames) | `npm run duplicate-parts -- <folder> <ids> --offset x,y,z --rename Old=New` |
| Program | `set_program`, or one POU with `set_pou`; `check_program` checks without keeping | write `plc/*.st`, list it in `project.json`, then `npm run check-st -- <folder>` |
| Rename a tag | `rename_tag` (moves the wiring too; `set_program` does not) | `npm run rename-tag -- <folder> <from> <to>` |
| Scan timing | `set_task` | edit `controller` in `project.json` |
| Hand off to a real PLC | `assign_io`, `get_io_list` | `npm run assign-io -- <folder>`, `-- <folder> --export` |
| Check | `get_problems` | `npm run check-wiring -- <folder> --strict`, `npm run check-layout -- <folder> --strict` |
| Test | `run_test`, `save_test` | `npm run test-project -- <folder>` (exit 1 = a check failed, 3 = could not run) |
| See what happened | `capture_view`, `run` + `trace_tags` / `get_cargo` (live, wall-clock); at a known sim time, `run_test` with `cargo` and `trace` | `npm run check-flow -- <folder>`, `test-project --cargo 5,10` |
| Files written in the folder | `sync_folder` (loads them now, says what loaded and whether that stopped the run) | (none: the CLIs read the folder) |

A line needs a part the catalog lacks: that is the `make-a-part` skill. Look at what you built (`capture_view`)
before you call it done: a test cannot see a sensor mounted on the wrong side or a model floating above its stand.

Never hand-edit a scene file. Placement goes through the snap engine and the parameter checks, and a hand-written
pose or param skips both.

## 1. Lay out

- Start from `--scaffold` (CLI) when the line is a straight run. It seats eyes, buttons and a spawner the way the
  editor does, and writes a starter program and test you can extend.
- Seat a device on a host with `snap_part` / `snap-part --write`, never by computing coordinates. A part is a
  volume, and its origin is not always its centre: a belt's origin is its tail, a roller conveyor's is its centre.
- Set sizes through the params the catalog lists. A belt has no `length`; it is shaped by `segments`. A param
  that does not exist changes nothing and reports nothing.
- A spawner over a belt the program starts and stops must be held with it (`conveyorId` + `keepSpacing`), or
  boxes stack on the stopped belt. `check-layout --strict` catches it.

## 2. Wire and program

- Name every tag once, by function (`InfeedRun`, `DischargeEye`), and set it on the part's tag param.
- Declare each signal with its direction: `VAR_INPUT` for what the program reads (sensors, buttons), `VAR_OUTPUT`
  for what it commands. Then `check-wiring` catches a tag wired the wrong way round, the most common mistake.
- A test's `inputs` reach only a `VAR_INPUT` or a variable wired to a part. A plain `VAR Start : BOOL` cannot be
  pressed by a test, and `run_test` warns about it.
- A program that is one `PROGRAM Main ... END_PROGRAM` also answers to bare names. With two or more `PROGRAM`
  instances, a part wires to `Instance.Name`. The guide explains this.
- The first scan runs after the parts' first step, so a normally closed input (an E-stop, a Stop button) already
  reads TRUE on scan 1. Write the latch so it starts stopped.

## 3. Test so that a wrong program fails

- Assert what happened physically, not only the tags. Use `passed` probes with a `color` filter for "boxes went
  down this lane", and `count` with `always` + `max: 0` for "nothing ever reached the floor". On a divert or a turn,
  a `square` probe with `always` + `max` on the middle of each spur checks the cases ride it square, not skewed.
- Prefer windows (`from` / `until`), tag-against-tag checks (`"max": {"tag": "Sorted1"}`) and `notEquals` over an
  exact count at an exact time. An exact count breaks when an unrelated change moves an arrival by a tenth of
  a second.
- **Prove the test is not vacuous.** Withhold the stimulus your logic depends on (the Start press, a colour), or
  break one rung, and confirm the test fails. Pick a stimulus that really gates the behaviour: if the program
  starts on its own, withholding Start proves nothing.
- Keep the passing spec in the project (`save_test`, or `tests/<name>.test.json` listed in the manifest's `tests`).

## 4. A change request

Run the kept tests before you edit, so you know they pass. Make the change, add a test for the new behaviour,
prove that test fails on the old program, and run every test again. A lane added to a sort must not change where
the other colours go. Keep a `passed` + `color` check per lane.

## When a check fails

- `tag ... never appeared` usually means the program was never loaded (a file not listed in `project.json`) or
  the name is wired under an instance prefix. It is rarely a typo.
- A box that never reaches an eye: run `check-flow`. It reports drops, tips, stalls and eye flicker as facts.
  A row former's stall is normal accumulation, not a fault.
- Flow facts are facts, not problems. Don't add workarounds to make them go away.
