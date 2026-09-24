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
  // Known-hosts store: TOFU / changed / unreadable fail-closed behavior.
  { entry: 'src/main/knownHosts.ts', out: 'tests/.known-hosts.cjs' },
  { entry: 'src/main/settingsStore.ts', out: 'tests/.settings-store.cjs' },
  // Lock-password store: scrypt verifier, round trip, damaged-file handling.
  { entry: 'src/main/lockStore.ts', out: 'tests/.lock-store.cjs' },
  // Lock controller: cooldown ladder, serialized attempts, persisted flags.
  // Pulls in settingsStore + broadcast, which is why the electron stub needs
  // powerMonitor as well.
  { entry: 'src/main/lockController.ts', out: 'tests/.lock-controller.cjs' },
  // zmodem.js stays bundled (NOT external) — the test drives a second in-process
  // Sentry from the same library.
  { entry: 'src/main/zmodem.ts', out: 'tests/.zmodem-e2e.cjs', external: ['ssh2'] },
  // The smoke test imports the renderer engine (.ts), so it needs bundling too.
  { entry: 'tests/hl-split-smoke.mjs', out: 'tests/.hl-split-smoke.cjs' },
  // Preset-rule assertions (word boundaries, case flag) over the same engine.
  { entry: 'tests/hl-rules.mjs', out: 'tests/.hl-rules.cjs' }
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
