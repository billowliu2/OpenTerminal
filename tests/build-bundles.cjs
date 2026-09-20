/* Rebuild every esbuild bundle the tests load, so a test run can never exercise
   a stale bundle. `npm test` calls this first; run it standalone when you only
   want fresh bundles.

   The aliases live here (and nowhere else) so every bundle resolves `electron`
   and `@shared` the same way. A bundle built without
   `--alias:@shared=./src/shared` does not even compile: pty.ts reaches
   @shared/theme through settingsStore.ts -> windowChrome.ts.

   Usage: node tests/build-bundles.cjs */
const path = require('node:path')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')

const BUNDLES = [
  // Real session layer: pty.ts also re-exports the ssh + sysinfo engines.
  { entry: 'src/main/pty.ts', out: 'tests/.session-e2e.cjs', external: ['@lydell/node-pty', 'ssh2'] },
  // ESM (`.mjs`): tests/sftp-*.mjs load it with `await import()`.
  { entry: 'src/main/sftp.ts', out: 'tests/.sftp-svc.mjs', format: 'esm', external: ['ssh2'] },
  { entry: 'src/main/commands.ts', out: 'tests/.commands-store.cjs' },
  { entry: 'src/main/settingsStore.ts', out: 'tests/.settings-store.cjs' },
  // zmodem.js stays bundled (NOT external) — the test drives a second in-process
  // Sentry from the same library.
  { entry: 'src/main/zmodem.ts', out: 'tests/.zmodem-e2e.cjs', external: ['ssh2'] },
  // The smoke test imports the renderer engine (.ts), so it needs bundling too.
  { entry: 'tests/hl-split-smoke.mjs', out: 'tests/.hl-split-smoke.cjs' }
]

for (const { entry, out, format = 'cjs', external = [] } of BUNDLES) {
  esbuild.buildSync({
    absWorkingDir: ROOT,
    entryPoints: [path.join(ROOT, entry)],
    outfile: path.join(ROOT, out),
    bundle: true,
    platform: 'node',
    format,
    external,
    alias: { electron: './tests/electron-stub.cjs', '@shared': './src/shared' },
    logLevel: 'warning'
  })
  console.log(`built ${out}`)
}
