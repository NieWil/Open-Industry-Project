// Getting a program onto a real OpenPLC Runtime v4, the way OpenPLC's own editor does it: shared by
// scripts/openplc-loop.mjs and scripts/openplc-cells-loop.mjs (the conveyor case) and e2e/guide-modbus.mjs (the
// published guide's program).
//
//   remoteDevice      the simulator's Modbus table as the editor's remote device
//   buildProgramZip   IEC text + a Modbus remote device -> the editor's project, its compile chain, and the
//                     program.zip its upload sends (STruC++ output, runtime headers, conf/modbus_master.json)
//   openRuntime       OPENPLC_URL, a runtime already up on :8443, or the per-user Windows install started
//                     for the run
//
// The text must hold a PROGRAM and a CONFIGURATION (a task and an instance), which is what an OpenPLC
// project holds; projectFolder lays it out where the editor keeps each block.
/* global process, performance */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { compileChain, HarnessError, projectFolder, strucppRuntimeHeaders } from './openplc-editor.mjs'
import { findWindowsInstall, isUp, RuntimeClient, startWindowsRuntime } from './openplc-runtime.mjs'

/**
 * Build `text` with OpenPLC's editor, with `device` (devices/remote/<name>.json, the editor's
 * PLCRemoteDeviceSchema) as its Modbus master's one remote device. `locations` are I/O addresses some
 * variable must be located at once the editor has read the project, so a dropped AT clause is a harness
 * error instead of a PLC that silently drives nothing. Writes what it built to `outDir`.
 */
export function buildProgramZip(ours, editor, { text, device, locations = [], outDir }) {
  const folder = projectFolder(ours, editor, text)
  const deviceFile = { relativePath: `devices/remote/${device.name}.json`, content: `${JSON.stringify(device, null, 2)}\n` }
  const parsed = editor.parseProjectFiles('/oip-openplc', folder.projectJson, '', '', folder.pouFiles, [], [deviceFile], '', folder.dataTypeFiles)
  const problems = [...folder.loadErrors, ...(parsed.warnings ?? []), ...(parsed.fatalErrors ?? [])]
  if (problems.length > 0) throw new HarnessError(`OpenPLC's editor did not load the program cleanly:\n  ${problems.join('\n  ')}`)
  const data = parsed.projectData
  if ((data.remoteDevices ?? []).length !== 1) throw new HarnessError("OpenPLC's editor dropped the remote device")

  const vars = data.pous.flatMap((p) => p.interface?.variables ?? p.data?.variables ?? [])
  for (const at of locations) {
    if (!vars.some((x) => String(x.location ?? '').toUpperCase() === at.toUpperCase())) {
      throw new HarnessError(`OpenPLC's editor read no variable located at ${at}; the program's AT clause did not survive its reader`)
    }
  }

  const chain = compileChain(editor, data, { md5: (st) => createHash('md5').update(st).digest('hex') })
  if (chain.stage) throw new HarnessError(`OpenPLC's editor could not build the program (${chain.stage}): ${chain.detail}`)
  if (!chain.built) throw new HarnessError(`STruC++ refused the program: ${chain.compileErrors.join('; ')}`)

  const strucppFiles = Object.fromEntries(chain.files.map((f) => [f.name, f.content]))
  const logs = []
  const confs = editor.generateRuntimeConfs({
    servers: chain.processed.servers,
    remoteDevices: chain.processed.remoteDevices,
    instances: (chain.processed.configuration ?? chain.processed.configurations).resource.instances.map((i) => ({ name: i.name, task: i.task, program: i.program })),
    debugMapContent: strucppFiles['debug-map.json'] ?? '',
    log: (message, level) => logs.push(`${level}: ${message}`),
  })
  if (!confs.modbusMaster) throw new HarnessError(`the editor generated no Modbus master config${logs.length ? `:\n  ${logs.join('\n  ')}` : ''}`)
  const cBlocks = editor.buildCBlocksFromPous([], [])
  const bundle = editor.composeRuntimeV4Bundle({
    programSt: chain.programSt,
    md5: chain.md5,
    strucppFiles,
    cBlocks: { header: cBlocks.header, code: cBlocks.code },
    strucppRuntimeHeaders: strucppRuntimeHeaders(),
    confs: { ...confs, ethercat: confs.ethercat ?? '' },
  })

  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'export.st'), text, 'utf8')
  writeFileSync(join(outDir, 'program.st'), chain.programSt, 'utf8')
  writeFileSync(join(outDir, 'modbus_master.json'), confs.modbusMaster, 'utf8')
  const zip = zipSync(Object.fromEntries(Object.entries(bundle).map(([k, v]) => [k, strToU8(v)])))
  writeFileSync(join(outDir, 'program.zip'), zip)
  return { zip, files: Object.keys(bundle).length, programSt: chain.programSt }
}

const FUNCTION_CODE = { discreteInput: '2', coil: '15', inputRegister: '4', holdingRegister: '16' }

/**
 * The simulator as an OpenPLC "remote device" (devices/remote/<name>.json, the editor's
 * PLCRemoteDeviceSchema). The editor's generator takes a group's start from its first point's IEC
 * location and maps the rest in order, which is the rule the simulator's table was derived by
 * (addressForModbusPoint), so a group must hold points of ONE width: the runtime walks a 32-bit group
 * two registers at a time and a 16-bit one register at a time.
 *
 * Bits span their whole range with spares, which is what proves the mapping rule rather than a list of
 * hand-placed points; registers are grouped into runs of equal width. `cycleMs` is how often the master polls each group.
 */
export function remoteDevice(ours, io, host, cycleMs) {
  const ioGroups = []
  const group = (area, offset, length, ioPoints) =>
    ioGroups.push({ id: `${area}-${offset}`, name: `${area}-${offset}`, functionCode: FUNCTION_CODE[area], cycleTime: cycleMs, offset: String(offset), length, errorHandling: 'keep-last-value', ioPoints })

  for (const area of ['discreteInput', 'coil', 'inputRegister', 'holdingRegister']) {
    const points = io.points.filter((p) => p.area === area).sort((a, b) => a.address - b.address)
    if (points.length === 0) continue
    if (ours.isBitArea(area)) {
      const lo = points[0].address
      const hi = points[points.length - 1].address
      const ioPoints = []
      for (let a = lo; a <= hi; a++) {
        const p = points.find((q) => q.address === a)
        ioPoints.push({ id: `${area}-${a}`, name: p ? p.tag : `spare_${area}_${a}`, type: 'BOOL', iecLocation: ours.addressForModbusPoint(area, a) })
      }
      group(area, lo, hi - lo + 1, ioPoints)
      continue
    }
    let run = []
    const flush = () => {
      if (run.length === 0) return
      const words = ours.registerWords(run[0].type)
      const ioPoints = run.map((p) => ({ id: `${area}-${p.address}`, name: p.tag, type: p.type ?? 'INT', iecLocation: ours.addressForModbusPoint(area, p.address, words) }))
      group(area, run[0].address, run.length * words, ioPoints)
      run = []
    }
    for (const p of points) {
      const last = run[run.length - 1]
      if (last && (ours.registerWords(last.type) !== ours.registerWords(p.type) || last.address + ours.registerWords(last.type) !== p.address)) flush()
      run.push(p)
    }
    flush()
  }
  return { name: 'oip_sim', protocol: 'modbus-tcp', modbusTcpConfig: { transport: 'tcp', host, port: io.port, timeout: 1000, slaveId: 1, ioGroups } }
}

/** The runtime to deploy to, and how to put it back the way it was found. */
export async function openRuntime({ outDir, keepRunning = false }) {
  if (process.env.OPENPLC_URL) return { client: new RuntimeClient(process.env.OPENPLC_URL), stop: () => {}, source: process.env.OPENPLC_URL }
  const url = 'https://127.0.0.1:8443'
  if (await isUp(url)) return { client: new RuntimeClient(url), stop: () => {}, source: `${url} (already running)` }
  const dir = findWindowsInstall()
  if (!dir) {
    throw new HarnessError(
      'no OpenPLC runtime: set OPENPLC_URL, or on Windows install OpenPLC_Runtime_<version>_Setup.exe from ' +
        'https://github.com/Autonomy-Logic/openplc-runtime/releases (a per-user install, no admin needed)',
    )
  }
  mkdirSync(outDir, { recursive: true })
  const started = startWindowsRuntime(dir, join(outDir, 'runtime.log'))
  return { client: new RuntimeClient(url), stop: keepRunning ? () => {} : started.stop, source: `${dir} (started for this run${keepRunning ? ', left running' : ''})` }
}

/** Log in (creating the first admin account on a fresh runtime), stop it, and upload `zip` without starting it. */
export async function deployStopped(runtime, zip) {
  const version = await runtime.client.waitReady(120000) // a container's first start takes a while
  const user = process.env.OPENPLC_USER ?? 'openplc'
  const { created } = await runtime.client.login(user, process.env.OPENPLC_PASSWORD ?? 'openplc')
  await runtime.client.stop()
  const t = performance.now()
  await runtime.client.deploy(zip)
  return { version, user, created, seconds: (performance.now() - t) / 1000 }
}
