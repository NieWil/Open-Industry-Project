// Desktop only: serve the agent tools (tools.ts) to the shell's MCP server (apps/desktop/mcpServer.cjs), so any
// MCP client the user runs can drive this editor. The shell owns the
// transport and knows nothing of the tools; this side announces the list and answers each call.
//
// A no-op in the browser (no `window.oipAgent`). The tools module is imported lazily because it pulls in the
// problems checker and the part registry's readers, which the first frame doesn't need.

import type { AgentController, AgentImage, AgentShell } from './tools'
import type { EditorStore } from '../store/store'
import type { AgentSession } from './agentSession'
import { openFolderForAgent } from '../desktop/desktopProjectBridge'
import { canCreateProject, createNewProject } from '../project/newProject'

/** One call the shell forwards: an id to answer by, the tool, its arguments. */
interface AgentCall {
  id: number
  name: string
  args: unknown
}

/** One request from main's own tools: open a folder it has decided may open, or start a new project. */
interface ShellRequest {
  id: number
  op: string
  args: { root?: unknown; name?: unknown } | null
}

/** What a call answers: the result as text (JSON unless the tool returned a string) and any images, or the error. */
export type AgentReply = { ok: true; text: string; images?: AgentImage[] } | { ok: false; error: string }

/** preload.cjs `window.oipAgent` */
interface OipAgentApi {
  /** announce the tool list (null withdraws it: this window no longer serves) */
  serve(tools: unknown[] | null): void
  onCall(cb: (call: AgentCall) => void): () => void
  reply(id: number, reply: AgentReply): void
  /** the page is about to reload for a reason main cannot see; main tells an agent whose call it cuts off */
  leaving?(why: string): void
  /** main's project tools (apps/desktop/agentProjects.cjs) asking the editor to open or start a project */
  onShell?(cb: (req: ShellRequest) => void): () => void
  /** capture_view: this window's pixels inside a CSS-px rectangle */
  capture?: AgentShell['capture']
  /** import_model: a model file's bytes by absolute path */
  readModel?: AgentShell['readModel']
  /** Settings > Agent connections: whether the door is open (agentDoorSetting.cjs) */
  doorState?(): Promise<AgentDoorState>
  /** turn the door on (main asks the person first) or off */
  setDoor?(on: boolean): Promise<AgentDoorState & { error?: string }>
  /** the door opened or shut, from this window or another */
  onDoorChange?(cb: (state: AgentDoorState) => void): () => void
}

/** The agent door as Settings shows it: open or shut, and the URL a client is given (fixed, so shown either way). */
export interface AgentDoorState {
  enabled: boolean
  url: string
}

/** What Settings > Agent connections drives: present only in the desktop app. */
export type AgentDoorApi = Required<Pick<OipAgentApi, 'doorState' | 'setDoor' | 'onDoorChange'>>

function agentApi(): OipAgentApi | null {
  return (globalThis as { oipAgent?: OipAgentApi }).oipAgent ?? null
}

/**
 * Serve the tools while the editor is mounted. Returns the disconnect. `onSession` receives the session the editor
 * shows the agent's work through (agentSession.ts), once the tools chunk has loaded and before the first call: it is
 * in that chunk, so the first frame carries none of it, and the browser, which has no door, never loads it.
 */
export function connectDesktopAgent(store: EditorStore, controller: AgentController, onSession?: (session: AgentSession) => void): () => void {
  const api = agentApi()
  if (!api) return () => {}
  let cancelled = false
  let off: (() => void) | null = null
  let offShell: (() => void) | null = null
  const shell: AgentShell = { capture: api.capture, readModel: api.readModel }
  void Promise.all([import('./tools'), import('./agentSession')]).then(([{ AgentImageResult, agentResultText: text, agentToolDefinitions, callAgentTool }, { AgentSession }]) => {
    if (cancelled) return
    const agentSession = new AgentSession(store)
    onSession?.(agentSession)
    off = api.onCall(({ id, name, args }) => {
      void callAgentTool({ store, controller, shell, session: agentSession }, name, args)
        .then((r) => {
          if (!r.ok) api.reply(id, r)
          else if (r.value instanceof AgentImageResult) api.reply(id, { ok: true, text: text(r.value.info), images: r.value.images })
          else api.reply(id, { ok: true, text: text(r.value) })
        })
        // a throw answers as a failed call does, so main isn't left waiting out its timeout
        .catch((e: unknown) => api.reply(id, { ok: false, error: e instanceof Error ? e.message : String(e) }))
    })
    offShell =
      api.onShell?.((req) => {
        // a throw answers as a failed call does, so main isn't left waiting out its timeout
        void shellRequest(store, req)
          .catch((e: unknown): AgentReply => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
          .then((reply) => api.reply(req.id, reply))
          .catch((e: unknown) => console.warn('[oip] agent shell reply failed', e))
      }) ?? null
    api.serve(agentToolDefinitions())
  }).catch((e: unknown) => console.warn('[oip] the agent door failed to load', e))
  // In the dev shell the dev server reloads the page when a source file changes that hot updates cannot take (any
  // file under src/render/, vite.config.ts oip-render-full-reload) or when it re-bundles its dependencies. An agent
  // whose call that cut off saw only "the editor reloaded", often caused by another agent editing the tree.
  const onFullReload = (p: { triggeredBy?: string }): void => {
    const file = p.triggeredBy?.replace(/\\/g, '/').replace(/^.*?\/((?:src|examples|packages|app|public)\/)/, '$1')
    api.leaving?.(file ? `the dev server reloaded the page after ${file} changed` : 'the dev server reloaded the page, after re-bundling its dependencies or a restart')
  }
  import.meta.hot?.on('vite:beforeFullReload', onFullReload)
  return () => {
    cancelled = true
    off?.()
    offShell?.()
    import.meta.hot?.off('vite:beforeFullReload', onFullReload)
    api.serve(null)
  }
}

/**
 * Answer main's 'openFolder' / 'newProject'. Both reload the editor on success, so the answer is 'reloading' (or
 * 'already': the folder is the open project), sent before the page goes; main waits for the reloaded page to serve.
 */
async function shellRequest(store: EditorStore, { op, args }: ShellRequest): Promise<AgentReply> {
  if (op === 'openFolder' && typeof args?.root === 'string') {
    const r = await openFolderForAgent(store, args.root)
    return typeof r === 'string' ? { ok: true, text: r } : { ok: false, error: r.error }
  }
  if (op === 'newProject' && typeof args?.name === 'string') {
    if (!canCreateProject(store)) return { ok: false, error: 'a project cannot be started here (a view-only editor is open)' }
    const error = await createNewProject(store, args.name)
    return error === null ? { ok: true, text: 'reloading' } : { ok: false, error }
  }
  return { ok: false, error: `the editor does not know the request '${op}'` }
}

/** The door's controls, or null in the browser and in a shell too old to offer them. */
export function agentDoorApi(): AgentDoorApi | null {
  const api = agentApi()
  return api?.doorState && api.setDoor && api.onDoorChange ? (api as AgentDoorApi) : null
}

let revealDoorSection = false
const revealListeners = new Set<() => void>()

/** Help > Agent Connections... (commands.ts) opens Settings: this asks its Agent connections section to scroll into
 *  view. A Settings dialog already open hears it through `onAgentDoorReveal`, since it doesn't mount again. */
export function requestAgentDoorReveal(): void {
  revealDoorSection = true
  for (const l of revealListeners) l()
}

/** call `l` on each later request; returns the unsubscribe */
export function onAgentDoorReveal(l: () => void): () => void {
  revealListeners.add(l)
  return () => revealListeners.delete(l)
}

/** Settings' section reads this as it mounts, and on each request while mounted: true when asked to show it. */
export function takeAgentDoorReveal(): boolean {
  const r = revealDoorSection
  revealDoorSection = false
  return r
}
