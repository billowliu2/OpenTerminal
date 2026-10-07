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

/** Loader tweaks every bundle shares: `?asset` imports land on text loaders. */
const LOADERS = { '.png': 'text' }

const BUNDLES = [
  // Real session layer: pty.ts also re-exports the ssh + sysinfo engines.
  { entry: 'src/main/pty.ts', out: 'tests/.session-e2e.cjs', external: ['@lydell/node-pty', 'ssh2'] },
  // The real SSH service on its own (no electron surface at all), so the
  // loopback harness can exercise the shipped connect/verify/shell code
  // instead of a hand-copied ConnectConfig.
  { entry: 'src/main/ssh.ts', out: 'tests/.ssh.cjs', external: ['ssh2'] },
  // ESM (`.mjs`): tests/sftp-*.mjs load it with `await import()`.
  { entry: 'src/main/sftp.ts', out: 'tests/.sftp-svc.mjs', format: 'esm', external: ['ssh2'] },
  { entry: 'src/main/commands.ts', out: 'tests/.commands-store.cjs' },
  // SSH bookmarks store: CRUD, the public/secret split, corrupt-file backup.
  // Its electron surface is `safeStorage` (already in the stub, unavailable ->
  // the store's `plain:` dev fallback).
  { entry: 'src/main/connectionsStore.ts', out: 'tests/.connections-store.cjs' },
  // Known-hosts store: TOFU / changed / unreadable fail-closed behavior.
  { entry: 'src/main/knownHosts.ts', out: 'tests/.known-hosts.cjs' },
  { entry: 'src/main/settingsStore.ts', out: 'tests/.settings-store.cjs' },
  // Local-path admission (grants): pure fs/path, no electron surface at all.
  { entry: 'src/main/localPathGrants.ts', out: 'tests/.local-path-grants.cjs' },
  // Lock-password store: scrypt verifier, round trip, damaged-file handling.
  { entry: 'src/main/lockStore.ts', out: 'tests/.lock-store.cjs' },
  // Lock controller: cooldown ladder, serialized attempts, persisted flags.
  // Pulls in settingsStore + broadcast, which is why the electron stub needs
  // powerMonitor as well.
  { entry: 'src/main/lockController.ts', out: 'tests/.lock-controller.cjs' },
  // Lock keyboard classifier: pure, so the bundle needs no electron surface.
  { entry: 'src/main/lockShortcuts.ts', out: 'tests/.lock-shortcuts.cjs' },
  // Reserved-accelerator table shared by the settings recorder and main's
  // registration guard: pure, table-tested.
  { entry: 'src/shared/reservedAccelerators.ts', out: 'tests/.reserved-accelerators.cjs' },
  // Update service: feed probe/fallback. `electron-updater` is aliased to a
  // stub (the real package boots Electron), and the shell half (tray.ts) pulls
  // a `?asset` import, hence LOADERS.
  { entry: 'src/main/updater.ts', out: 'tests/.updater.cjs', alias: { 'electron-updater': './tests/electron-updater-stub.cjs' } },
  // IPC sender-frame guard: driven through the real registerIpc registration
  // path (the stub records handlers instead of dropping them).
  {
    entry: 'src/main/ipc.ts',
    out: 'tests/.ipc.cjs',
    external: ['ssh2', '@lydell/node-pty', 'font-list', 'cpu-features']
  },
  // Session-log plain-text transformer: ANSI state machine + alt-screen folding.
  { entry: 'src/main/logSanitizer.ts', out: 'tests/.log-sanitizer.cjs' },
  // Channel-name constants, so a test can name channels instead of inlining
  // string literals that would silently drift from src/shared/ipc.ts.
  { entry: 'src/shared/ipc.ts', out: 'tests/.ipc-channels.cjs' },
  // zmodem.js stays bundled (NOT external) — the test drives a second in-process
  // Sentry from the same library.
  { entry: 'src/main/zmodem.ts', out: 'tests/.zmodem-e2e.cjs', external: ['ssh2'] },
  // The smoke test imports the renderer engine (.ts), so it needs bundling too.
  { entry: 'tests/hl-split-smoke.mjs', out: 'tests/.hl-split-smoke.cjs' },
  // Preset-rule assertions (word boundaries, case flag) over the same engine.
  { entry: 'tests/hl-rules.mjs', out: 'tests/.hl-rules.cjs' }
]

for (const { entry, out, format = 'cjs', external = [], alias = {} } of BUNDLES) {
  esbuild.buildSync({
    absWorkingDir: ROOT,
    entryPoints: [path.join(ROOT, entry)],
    outfile: path.join(ROOT, out),
    bundle: true,
    platform: 'node',
    format,
    external,
    loader: LOADERS,
    alias: { electron: './tests/electron-stub.cjs', '@shared': './src/shared', ...alias },
    logLevel: 'warning'
  })
  console.log(`built ${out}`)
}
