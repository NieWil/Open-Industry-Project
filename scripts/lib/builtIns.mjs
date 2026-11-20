// The app's built-in parts, declared in a CLI's module graph the way the editor declares them at boot
// (src/editor/parts/bundledExamples.ts registerBundledPackages): built from the same committed folders by the same loader
// (src/editor/parts/bundledPackageData.ts, examples/parts/<dir>/{rig.json, behavior.ts}), registered as the live copy of
// their ids, and declared as built-ins (core/parts/partRegistry.ts setBuiltInPackages).
//
// A project saved in format 3 (core/project/project.ts) names a built-in by id and keeps no copy, so a tool that reads one
// must call this BEFORE it validates the project: an undeclared built-in is "neither in the project's part library
// nor a built-in part of this app", and the load fails.
//
//   const { packages } = await declareBuiltIns(vite)   // vite = the CLI's createServer() instance

/** Build, register and declare every built-in part. A folder that fails to build is reported, not fatal. */
export async function declareBuiltIns(vite) {
  const { bundledPartData } = await vite.ssrLoadModule('/src/editor/parts/bundledPackageData.ts')
  const { buildPackage } = await vite.ssrLoadModule('/src/sim/buildPackage.ts')
  const { registerPackage, setBuiltInPackages } = await vite.ssrLoadModule('/src/core/parts/partRegistry.ts')
  const packages = []
  const failures = []
  for (const item of bundledPartData()) {
    try {
      packages.push(buildPackage(item.manifest, item.behavior))
    } catch (e) {
      failures.push({ id: item.manifest?.id ?? '?', error: e instanceof Error ? e.message : String(e) })
    }
  }
  for (const pkg of packages) registerPackage(pkg, true)
  setBuiltInPackages(packages)
  return { packages, failures }
}
