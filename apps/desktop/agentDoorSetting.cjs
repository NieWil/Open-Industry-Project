// Whether the agent door (mcpServer.cjs) is open: the user's choice, remembered, and the rule for a first launch.
//
// The door lets any program on this machine drive the open editor - author, run, edit PLC programs, and through
// the folder sync, write the project's files. Its Host/Origin checks keep web pages and the network out, but not
// another local program, nor another Windows account on a shared machine. So an installed app starts with it
// shut and the user opens it on purpose (Settings > Agent connections, main.cjs setAgentDoor). A token would
// protect little more, since anything running as the user can read a token from this same folder. The
// unpackaged development shell starts with it open, so a developer's agent works without a setting.
//
// Pure apart from the file, so `node apps/desktop/agentDoorSetting.test.cjs` pins the rule.

const { readFileSync, writeFileSync } = require('node:fs')

/** The remembered choice: true / false, or undefined when the user has never made one. */
function readDoorSetting(file) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'))?.enabled
    return typeof v === 'boolean' ? v : undefined
  } catch {
    return undefined
  }
}

/** Remember the choice. Best-effort: a failed write only loses the choice on the next launch. */
function writeDoorSetting(file, enabled) {
  try {
    writeFileSync(file, JSON.stringify({ enabled }))
  } catch {
    /* best-effort */
  }
}

/**
 * Open the door at launch? In order:
 *   OIP_MCP=0          never (an explicit off)
 *   OIP_MCP_PORT=<n>   yes, on that port (what every e2e gate that needs the door sets)
 *   an isolated profile (--user-data-dir: every e2e gate) - no, so a gate never takes the user's port
 *   the user's remembered choice
 *   otherwise: shut in an installed app, open in the development shell
 */
function doorAtStartup({ env, packaged, isolated, saved, defaultPort }) {
  if (env.OIP_MCP === '0') return { serve: false, port: defaultPort, why: 'OIP_MCP=0' }
  if (env.OIP_MCP_PORT) return { serve: true, port: Number(env.OIP_MCP_PORT), why: 'OIP_MCP_PORT' }
  if (isolated) return { serve: false, port: defaultPort, why: 'isolated profile' }
  if (saved !== undefined) return { serve: saved, port: defaultPort, why: 'remembered' }
  return { serve: !packaged, port: defaultPort, why: packaged ? 'installed: off until allowed' : 'development shell' }
}

module.exports = { doorAtStartup, readDoorSetting, writeDoorSetting }
