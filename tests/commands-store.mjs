/**
 * M5 command-store + session-log self-test (commands-store.mjs).
 *
 * Bundles src/main/commands.ts for plain Node with an in-memory electron stub,
 * then verifies: history record/dedupe/cap/clear, library CRUD + ordering, and
 * session log write/read/index behavior against a temp userData dir.
 *
 * Build: npx esbuild src/main/commands.ts --bundle --platform=node --format=cjs \
 *        --outfile=tests/.commands-store.cjs --alias:electron=./tests/electron-stub.cjs
 * Run:   node tests/commands-store.mjs   (must exit 0)
 */
import { mkdtempSync, readFileSync } from 'fs'
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

// ---- 1. Bundle the store once (assumes tests/.commands-store.cjs exists) -------
let commandsMod
try {
  commandsMod = require_('./.commands-store.cjs')
} catch {
  fail('bundle not found — run: npx esbuild src/main/commands.ts --bundle --platform=node --format=cjs --outfile=tests/.commands-store.cjs --alias:electron=./tests/electron-stub.cjs')
}

// ---- 2. Temp userData; capture openDir target ----------------------------------
const userData = mkdtempSync(join(tmpdir(), 'm5-cmd-'))
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

// Re-run an OLDER command -> it is NOT the newest, so it becomes a fresh front
// entry (spec dedupes only against the newest entry) with blank-recency guard.
store.recordCommand('echo hello')
hist = store.listHistory()
ok(hist.length === 4, 'older command re-run is a new front entry (dedupe is newest-only)')
ok(hist[0].command === 'echo hello', 'older re-run lands at front')

// Cap: fill until well above 500 keeps only the newest 500.
for (let i = 0; i < 520; i++) store.recordCommand(`cmd-${i}`)
hist = store.listHistory()
ok(hist.length === 500, `history capped at 500 (got ${hist.length})`)
ok(hist[0].command === 'cmd-519', 'newest filler at front')

// Clear.
store.clearHistory()
ok(store.listHistory().length === 0, 'clearHistory empties history')

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

console.log('\n[commands] ALL CHECKS PASSED')
process.exit(0)