/**
 * M5 command-store + session-log self-test (commands-store.mjs).
 *
 * Bundles src/main/commands.ts for plain Node with an in-memory electron stub,
 * then verifies: history record/dedupe/cap/clear, library CRUD + ordering, and
 * session log write/read/index behavior against a temp userData dir.
 *
 * Build: npx esbuild src/main/commands.ts --bundle --platform=node --format=cjs \
 *        --outfile=tests/.commands-store.cjs --alias:electron=./tests/electron-stub.cjs \
 *        --alias:@shared=./src/shared
 * Run:   node tests/commands-store.mjs   (must exit 0)
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'module'
const require_ = createRequire(import.meta.url)

const fail = (msg) => {
  console.error(`FAIL: ${msg}`)
  process.exit(1)
}
const ok = (cond, msg) => {
  if (!cond) fail(msg)
  console.log(`  ok: ${msg}`)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 1. Temp userData must exist before the bundle loads ------------------------
// The settings store resolves its own path via app.getPath('userData'). The stub
// is bundled *into* the module under test, so requiring it here gives a different
// instance — `__setUserData` would not reach the bundle. The env var is read when
// the stub loads, so it has to be set before the bundle is required below.
const userData = mkdtempSync(join(tmpdir(), 'm5-cmd-'))
process.env.OT_STUB_USERDATA = userData

// ---- 1b. Bundle the store once (assumes tests/.commands-store.cjs exists) ------
let commandsMod
try {
  commandsMod = require_('./.commands-store.cjs')
} catch {
  fail('bundle not found — run: npx esbuild src/main/commands.ts --bundle --platform=node --format=cjs --outfile=tests/.commands-store.cjs --alias:electron=./tests/electron-stub.cjs --alias:@shared=./src/shared')
}

// ---- 2. Store over the temp userData; capture openDir target -------------------
let openedPath = null
const store = new commandsMod.CommandsStore(userData, async (p) => {
  openedPath = p
})

// ---- 3. History record / dedupe / cap ------------------------------------------
store.recordCommand('  echo hello  ')     // trims to 'echo hello'
store.recordCommand('ls -la')
store.recordCommand('ps aux')
let hist = store.listHistory()
ok(hist.length === 3, 'history records 3 distinct commands')
ok(hist[0].command === 'ps aux', 'newest first by lastUsedAt')

// Re-run the newest command -> no new entry, recency refreshed, still length 3.
store.recordCommand('ps aux')
hist = store.listHistory()
ok(hist.length === 3, 're-run of newest command is deduped (no new entry)')

// Re-run an OLDER command -> dedupe is over the whole history, so it moves the
// existing entry to the front instead of adding a copy.
store.recordCommand('echo hello')
hist = store.listHistory()
ok(hist.length === 3, 'older command re-run does NOT add a copy (whole-history dedupe)')
ok(hist[0].command === 'echo hello', 'older re-run is hoisted to the front')
// The hoisted entry keeps its original createdAt (it is the same command, not a new one).
ok(new Set(hist.map((h) => h.command)).size === 3, 'history holds 3 distinct commands')

// A command used long ago stays single even after many others in between.
for (let i = 0; i < 20; i++) store.recordCommand(`noise-${i}`)
store.recordCommand('ls -la')
hist = store.listHistory()
ok(hist.filter((h) => h.command === 'ls -la').length === 1, 'a command seen 20 entries ago is not duplicated')
ok(hist[0].command === 'ls -la', 'and it is hoisted to the front')

// Clear before the cap test so the assertions below are exact.
store.clearHistory()
ok(store.listHistory().length === 0, 'clearHistory empties history')

// ---- 3b. History limit + the recording switch -----------------------------------
const writeSettings = (terminal) =>
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ terminal, system: {} }), 'utf8')
const DEFAULT_LIMIT = 100

// The bundled default raises past the old hard cap of 500 only when configured;
// out of the box the list is trimmed to the default limit.
for (let i = 0; i < 150; i++) store.recordCommand(`filler-${i}`)
hist = store.listHistory()
ok(hist.length === DEFAULT_LIMIT, `history trimmed to the default limit of ${DEFAULT_LIMIT} (got ${hist.length})`)
ok(hist[0].command === 'filler-149', 'newest filler at front')

// Lower the limit -> takes effect immediately, without needing a new command.
writeSettings({ historyLimit: 20 })
hist = store.listHistory()
ok(hist.length === 20, `lowered limit applies on read (got ${hist.length})`)

// Raise it -> entries that survived the *disk* cap (the configured limit at write
// time) become visible again, up to the new limit. Nothing was resurrected from
// beyond the write-time cap; the write cap is the real bound on disk growth.
writeSettings({ historyLimit: 50 })
store.recordCommand('after-raise')
hist = store.listHistory()
ok(hist.length === 50, `raising the limit reveals still-stored entries (got ${hist.length})`)
ok(hist[0].command === 'after-raise', 'new command recorded after raising the limit')

// Nonsense / out-of-range limits fall back to something sane instead of throwing.
writeSettings({ historyLimit: 0 })
ok(store.listHistory().length === 1, 'limit 0 clamps to 1 rather than emptying history')
writeSettings({ historyLimit: 99999 })
ok(store.listHistory().length === 50, 'absurd limit is clamped to the hard ceiling')

// The switch: recording stops, and existing history is preserved (not cleared).
writeSettings({ historyLimit: 50, historyEnabled: false })
const before = store.listHistory()
store.recordCommand('must-not-be-recorded')
store.recordCommand('must-not-be-recorded')
hist = store.listHistory()
ok(!hist.some((h) => h.command === 'must-not-be-recorded'), 'historyEnabled=false records nothing')
ok(hist.length === before.length, 'turning the switch off keeps existing history intact')

// Turning it back on resumes recording.
writeSettings({ historyLimit: 50, historyEnabled: true })
store.recordCommand('recorded-again')
ok(store.listHistory()[0].command === 'recorded-again', 'historyEnabled=true resumes recording')

// Default (keys absent from settings.json) records, matching a fresh install.
writeSettings({})
store.recordCommand('default-on')
ok(store.listHistory()[0].command === 'default-on', 'absent switch defaults to recording')
store.clearHistory()

// ---- 4. Library CRUD + ordering ------------------------------------------------
const a = store.saveLibraryItem({ command: 'ps aux', name: 'procs', note: 'show processes' })
await wait(2) // createdAt has ms resolution; avoid a timestamp tie breaking the order assertion
const b = store.saveLibraryItem({ command: 'df -h', name: 'disk', group: 'ops' })
ok(typeof a.id === 'string' && a.id.length > 0, 'saveLibraryItem assigns an id + createdAt')
let lib = store.listLibrary()
ok(lib.length === 2, 'library has 2 items')
ok(lib[0].id === b.id, 'library newest first by createdAt')

// Update existing by id.
const updated = store.saveLibraryItem({ ...b, command: 'df -hT', note: 'human + type' })
lib = store.listLibrary()
ok(lib.length === 2, 'update keeps count at 2')
ok(lib.find((x) => x.id === b.id).command === 'df -hT', 'update applied fields')
ok(lib.find((x) => x.id === b.id).createdAt === b.createdAt, 'update preserves createdAt')

// Delete.
store.deleteLibraryItem(a.id)
lib = store.listLibrary()
ok(lib.length === 1 && lib[0].id === b.id, 'deleteLibraryItem removes the item')

// ---- 5. Session logs ------------------------------------------------------------
const sid = '11111111-2222-3333-4444-555555555555'
const start = store.logStart(sid)
ok(!!start.fileName && start.fileName.startsWith('20') && start.file.endsWith('11111111.log'), 'logStart names file <stamp>-<id8>.log')
ok(start.endedAt === undefined, 'logStart has no endedAt yet')
ok(store.listSessionLogs().length === 1, 'listSessionLogs sees the active log')

// Writes land asynchronously in the file.
store.logWrite(sid, 'hello line one\n')
store.logWrite(sid, 'hello line two\n')
await wait(100)
const content = readFileSync(start.file, 'utf8')
ok(content === 'hello line one\nhello line two\n', 'async appends are written in order')

// Stop -> endedAt stamped + stays in list.
store.logStop(sid)
let logs = store.listSessionLogs()
ok(logs[0].endedAt !== undefined && logs[0].endedAt >= start.startedAt, 'logStop stamps endedAt')
ok(logs.length === 1, 'stopped log still listed')

// Writes after stop are ignored (no reopen, no throw).
store.logWrite(sid, 'after stop\n')
await wait(100)
ok(readFileSync(start.file, 'utf8') === 'hello line one\nhello line two\n', 'writes after stop are ignored')

// A fresh store (same userData) restores the log from the index file.
const store2 = new commandsMod.CommandsStore(userData)
logs = store2.listSessionLogs()
ok(logs.length === 1, 'new store hydrates log list from index.json')
ok(logs[0].sessionId === sid && logs[0].endedAt !== undefined, 'hydrated meta intact')

// Re-logStart same id stops the previous and creates a new file (delay so the
// <HHmmss> stamp differs).
await wait(1100)
const start2 = store.logStart(sid)
ok(start2.file !== start.file, 're-logStart creates a new file')
logs = store.listSessionLogs()
ok(logs.length === 2, 're-logStart yields 2 (old is stopped, new is active)')
ok(logs.find((x) => x.file === start.file).endedAt !== undefined, 'old log finalized on re-start')

// ---- 6. openLogsDir ------------------------------------------------------------
store.openLogsDir()
ok(openedPath === join(userData, 'logs'), 'openLogsDir resolves to the logs dir')

// ---- 6. Burst ordering + stop tail (per-file buffer + single drain) -------------
const sid2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const startB = store.logStart(sid2)
// Burst 1: 300 writes in one tick must coalesce into ordered appends.
for (let i = 0; i < 300; i++) store.logWrite(sid2, `a${String(i).padStart(3, '0')}\n`)
await wait(10)
// Burst 2 after a gap: may land while burst 1's drain is still in flight.
for (let i = 0; i < 100; i++) store.logWrite(sid2, `b${String(i).padStart(3, '0')}\n`)
// Trailing partial line must ride the same buffer via logStop.
store.logWrite(sid2, 'partial-tail')
store.logStop(sid2)
await wait(200)
const expected =
  Array.from({ length: 300 }, (_, i) => `a${String(i).padStart(3, '0')}\n`).join('') +
  Array.from({ length: 100 }, (_, i) => `b${String(i).padStart(3, '0')}\n`).join('') +
  'partial-tail'
ok(readFileSync(startB.file, 'utf8') === expected, 'burst writes + stop tail land in order')

console.log('\n[commands] ALL CHECKS PASSED')
process.exit(0)