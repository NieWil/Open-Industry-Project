## What this changes

<!-- One or two sentences. What behaviour is different after this PR? -->

## Why

<!-- The reasoning, not just the mechanics. Link the issue: Fixes #123.
     If a budget moved (assets, eager JS, draw calls), say why here. -->

## How it was verified

<!-- What you ran and what you drove: which gates, which scene or project, numbers before and
     after. CI runs lint, typecheck, unit tests, the build and the --check commands, so don't
     list those. "Tests pass" on its own is not verification for a rendering, physics, or
     timing change. If part of this is untested or you're unsure of it, say which. -->

- [ ] `npm run gates` (rendering, physics, or editor-shell changes)

## Evidence

<!-- Required for any change you can see in the app: UI, rendering, physics, parts, editor
     behaviour. Show before and after in the same scene: screenshots, or a short video or GIF
     for anything that moves. Take scene shots with cleanShot() (see CONTRIBUTING.md). Name the
     scene or attach the project so a reviewer can reproduce it.
     For a headless change (ST engine, CLI, core), paste the command and its output instead.
     Write "N/A: <reason>" only for docs, CI, or a refactor with no change in behaviour. -->

## AI assistance

<!-- None, or which tools you used and for what (see "AI-Assisted Contributions" in
     CONTRIBUTING.md). -->

---

- [ ] No `dispose()` on a geometry, mesh, or texture in `src/render/` (use `retire*` instead).
- [ ] No inline `e.key` comparison (new bindings go in `src/core/keymap.ts`).
- [ ] Docs under `docs/` or `AGENTS.md` are updated if this changes a documented area or adds a trap.

<!-- PRs that leave these sections empty may be closed. -->
