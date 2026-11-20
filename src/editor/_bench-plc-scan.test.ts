// Temporary diagnostic bench: the demo program's scan cost in-process (BENCH=1; PROF=<file> also writes a CPU
// profile of the scan loop). Delete when the scan work closes.
import { writeFileSync } from 'node:fs'
import { Session } from 'node:inspector/promises'
import { describe, it } from 'vitest'
import { DEMO_CONTROLLER, DEMO_PROGRAM } from './demo/demoScenes'
import { runnableSource } from '../plc/controller'
import { LocalPlcLink } from '../plc/link/plcLink'
import { SimController } from '../plc/simController'

describe.runIf(process.env.BENCH)('scan bench', () => {
  it('demo program', async () => {
    const src = runnableSource(DEMO_PROGRAM, DEMO_CONTROLLER)
    const link = new LocalPlcLink(src)
    const ctl = new SimController(link)
    const scan = () => (ctl.tasks.length ? ctl.tickTask(0, 0.01) : ctl.tick(0.01))
    for (let i = 0; i < 3000; i++) scan()
    const N = 20000
    let t = performance.now()
    for (let i = 0; i < N; i++) scan()
    const scanUs = ((performance.now() - t) * 1000) / N
    t = performance.now()
    let n = 0
    for (let i = 0; i < 2000; i++) n += Object.keys(ctl.watch).length
    const watchUs = ((performance.now() - t) * 1000) / 2000
    if (process.env.PROF) {
      const ses = new Session()
      ses.connect()
      await ses.post('Profiler.enable')
      await ses.post('Profiler.setSamplingInterval', { interval: 50 })
      await ses.post('Profiler.start')
      for (let i = 0; i < N; i++) scan()
      for (let i = 0; i < 4000; i++) void ctl.watch
      const { profile } = await ses.post('Profiler.stop')
      writeFileSync(process.env.PROF, JSON.stringify(profile))
    }
    console.log(`scan ${scanUs.toFixed(1)} us  watch ${watchUs.toFixed(1)} us (${n / 2000} entries)  outputs ${Object.keys(ctl.processImage.outputs).length}`)
  }, 120000)
})
