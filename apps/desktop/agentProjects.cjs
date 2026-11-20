// The agent door's project tools (docs/agent-tools.md): list the user's projects, open one, start a new one.
//
// They run here in main, not in the renderer with the other tools, for two reasons. Opening a project reloads the
// editor page, so a page-side tool would never send its answer. And main owns what decides whether a folder may
// open: the folder registry (Open Recent), the folder grants and the native dialog. The editor still does the
// opening, through the same boot path as File > Open (the 'openFolder' and 'newProject' shell requests,
// desktopAgent.ts), so an agent's open is a person's open.
//
// What opens without asking: a folder in Open Recent, or one directly inside the default projects folder. Either the
// user opened it before or the app made it. Any other folder asks the user first. The door is open to every account
// on the machine, and an open project's contents reach the agent, so this keeps another account from reading
// folders through the app. Plain Node - testable with `node apps/desktop/agentProjects.test.cjs`.

const { existsSync, readdirSync, readFileSync } = require('node:fs')
const { basename, dirname, isAbsolute, join } = require('node:path')
const { samePath } = require('./folderRegistry.cjs')

const MANIFEST = 'project.json'
/** How long an open or a new project may take to boot and serve its tools again. */
const RELOAD_WAIT_MS = 60_000

/** A project folder's name as its manifest gives it, else the folder's own name. */
function projectName(root) {
  try {
    const name = JSON.parse(readFileSync(join(root, MANIFEST), 'utf8'))?.name
    if (typeof name === 'string' && name.trim() !== '') return name
  } catch {
    /* unreadable or not JSON: the folder name stands in */
  }
  return basename(root)
}

/**
 * The tools, as the agent host (mcpServer.cjs) serves them beside the renderer's.
 * `deps`:
 *   registry      folderRegistry.cjs: the folders the app has opened, most recent first
 *   grants        folderGrants.cjs: a folder that opens is granted first, since the editor reads it through readAt
 *   projectsRoot  () => the default projects folder (main.cjs defaultProjectsRoot)
 *   currentRoot   () => the folder the editor window the agent drives is working in, or null
 *   canonical     (path) => the folder's long, real path (main.cjs canonicalRoot)
 *   askToOpen     (root, name) => Promise<boolean>: the native "open this folder?" question
 *   openElsewhere (root) => whether another editor window has that folder open (optional)
 *   driveWindowWith (root) => move the agent to the window that has that folder open; false when none has (optional)
 */
function createProjectTools(deps) {
  const { registry, grants, projectsRoot, currentRoot, canonical, askToOpen } = deps
  const openElsewhere = deps.openElsewhere ?? (() => false)
  const driveWindowWith = deps.driveWindowWith ?? (() => false)
  const reloadWaitMs = deps.reloadWaitMs ?? RELOAD_WAIT_MS

  /** Open Recent's folders, then the default projects folder's other project folders. */
  function listProjects() {
    const current = currentRoot()
    const out = []
    for (const row of registry.list()) {
      if (!existsSync(join(row.path, MANIFEST))) continue // moved or deleted since; Open Recent still shows it
      out.push({ name: row.name || basename(row.path), path: row.path, openedAt: row.openedAt ? new Date(row.openedAt).toISOString() : null })
    }
    // canonical, as the registry's paths are: a Windows short-name root (PROGRA~1) would list every project twice
    const root = canonical(projectsRoot())
    let entries = []
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      /* no projects folder yet */
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const dir = join(root, e.name)
      if (!existsSync(join(dir, MANIFEST)) || out.some((p) => samePath(p.path, dir))) continue
      out.push({ name: projectName(dir), path: dir, openedAt: null })
    }
    return out.map((p) => {
      const open = current !== null && samePath(p.path, current)
      return { ...p, open, ...(!open && openElsewhere(p.path) ? { openInAnotherWindow: true } : {}) }
    })
  }

  /** Opens without asking: a folder in Open Recent, or one directly inside the default projects folder. */
  function opensUnasked(root) {
    return registry.byPath(root) !== null || samePath(canonical(dirname(root)), canonical(projectsRoot()))
  }

  /** `project` is a path or a name from list_projects: the folder it means, or why not. */
  function resolveProject(project) {
    if (isAbsolute(project)) {
      const root = canonical(project)
      if (!existsSync(join(root, MANIFEST))) return { error: `${project} is not a project folder (it has no ${MANIFEST})` }
      return { root }
    }
    const want = project.trim().toLowerCase()
    const hits = listProjects().filter((p) => p.name.toLowerCase() === want)
    if (hits.length === 1) return { root: hits[0].path }
    if (hits.length > 1) return { error: `${hits.length} projects are named '${project}'; give one by path:\n${hits.map((p) => p.path).join('\n')}` }
    return { error: `no project named '${project}' (list_projects lists them; a folder elsewhere is given by its absolute path)` }
  }

  /** Ask the editor to boot into something, then wait for it to serve its tools again. */
  async function reloadInto(host, op, args) {
    const reply = await host.request(op, args)
    if (!reply.ok) return reply
    if (reply.text === 'already') return { ok: true, already: true }
    // the editor answered 'reloading' as it started to reload (or reloaded before it could answer, which
    // AgentHost.request also reads as 'reloading'); it is ready once the new page serves its tools
    const served = await host.nextServe(reloadWaitMs)
    if (!served) return { ok: false, error: `the editor did not come back within ${Math.round(reloadWaitMs / 1000)} s` }
    return { ok: true }
  }

  const text = (value) => ({ ok: true, text: JSON.stringify(value, null, 2) })

  return [
    {
      definition: {
        name: 'list_projects',
        description:
          "The user's projects: the ones opened in this app (most recent first), then any other project folder in the " +
          "default projects folder. `open` marks the one the editor you drive has open, and `openInAnotherWindow` one another " +
          'editor window has open. open_project takes a name or a path from here.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      run: async () => text({ projects: listProjects(), projectsFolder: projectsRoot() }),
    },
    {
      definition: {
        name: 'open_project',
        description:
          'Open a project in the editor, in place of the open one (which stays saved in its folder and in list_projects). ' +
          'Give `project` as a name from list_projects or the absolute path of a project folder. A project from that list ' +
          'opens at once; a folder anywhere else asks the user first. The editor reloads, and every later call acts on ' +
          'the opened project. The agent review of the previous project closes with it. A project open in another ' +
          'editor window is not opened twice: later calls go to that window instead, and this one keeps its project.',
        inputSchema: {
          type: 'object',
          properties: { project: { type: 'string', description: 'a name from list_projects, or an absolute folder path' } },
          required: ['project'],
          additionalProperties: false,
        },
      },
      run: async (host, args) => {
        const project = args?.project
        if (typeof project !== 'string' || project.trim() === '') return { ok: false, error: "'project' must be a name or a folder path" }
        const found = resolveProject(project)
        if (found.error) return { ok: false, error: found.error }
        const { root } = found
        const name = projectName(root)
        if (!opensUnasked(root) && !(await askToOpen(root, name))) return { ok: false, error: `the user declined to open ${root}` }
        grants.grant(root)
        if (driveWindowWith(root)) return text({ opened: name, path: root, note: 'it was open in another window, which later calls now act on' })
        const done = await reloadInto(host, 'openFolder', { root })
        if (!done.ok) return done
        return text({ opened: name, path: root, ...(done.already ? { note: 'it was already the open project' } : {}) })
      },
    },
    {
      definition: {
        name: 'new_project',
        description:
          'Start a new, empty project in its own folder under the default projects folder, and open it in place of the ' +
          'open one (which stays saved). The editor reloads, and every later call acts on the new project.',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string', description: "the project's name; the folder is named after it" } },
          required: ['name'],
          additionalProperties: false,
        },
      },
      run: async (host, args) => {
        const name = args?.name
        if (typeof name !== 'string' || name.trim() === '') return { ok: false, error: "'name' must be a non-empty string" }
        const done = await reloadInto(host, 'newProject', { name: name.trim() })
        if (!done.ok) return done
        // the editor made the folder through project:createFolder and recorded it with touch, so it is the newest row
        const made = registry.list()[0]
        return text({ created: name.trim(), path: made?.path ?? null })
      },
    },
  ]
}

module.exports = { createProjectTools, projectName }
