/**
 * Diagnostic app log self-test (app-log.mjs).
 *
 * `src/main/appLog.ts` persists the freeze watchdogs (`[main]` / `[renderer]
 * stalled`) that a packaged build's console can never show. What is pinned:
 *
 *   - daily naming is local-date (`app-YYYY-MM-DD.log`) and round-trips
 *     through the parser; foreign names parse to null;
 *   - retention keeps today plus the previous N days: a file exactly N days
 *     old stays, N+1 days is removed, foreign files in the directory are
 *     never touched;
 *   - `sweepAppLogs` on a real temp dir removes exactly the expired set and
 *     reports it;
 *   - `appLog` appends one `[stamp] [source] line` per call, serializes
 *     concurrent appends (order preserved), flattens embedded newlines, and
 *     truncates runaway payloads;
 *   - before `initAppLog` a line is dropped, not written anywhere.
 *
 * Build: node tests/build-bundles.cjs
 * Run:   node tests/app-log.mjs   (must exit 0)
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const { appLog, appLogName, initAppLog, isExpiredAppLog, parseAppLogName, setAppLogEnabled, sweepAppLogs, APP_LOG_RETENTION_DAYS } =
  require('./.app-log.cjs')

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}

const DAY = 24 * 60 * 60 * 1000
// A fixed LOCAL timestamp: 2026-10-11 12:00 local time.
const now = new Date(2026, 9, 11, 12, 0, 0)
const daysAgo = (n) => appLogName(new Date(now.getTime() - n * DAY))

console.log('daily naming is local-date and round-trips')
ok(appLogName(now) === 'app-2026-10-11.log', `name is app-2026-10-11.log (got ${appLogName(now)})`)
ok(parseAppLogName('app-2026-10-11.log') === new Date(2026, 9, 11).getTime(), 'name parses to local midnight')
ok(parseAppLogName(appLogName(now)) === new Date(2026, 9, 11).getTime(), 'name round-trips')
ok(appLogName(new Date(2026, 0, 5, 23, 59)) === 'app-2026-01-05.log', 'month/day are zero-padded')

console.log('foreign names never parse and never expire')
for (const name of ['app.log', 'app-2026-1-1.log', 'notes.txt', 'app-2026-13-01.log.log', 'app-2026-10-11.log.bak']) {
  ok(parseAppLogName(name) === null, `${name} parses to null`)
  ok(!isExpiredAppLog(name, now), `${name} never expires`)
}

console.log('retention keeps today plus the previous N days')
ok(!isExpiredAppLog(daysAgo(0), now), 'today is kept')
ok(!isExpiredAppLog(daysAgo(APP_LOG_RETENTION_DAYS), now), `exactly ${APP_LOG_RETENTION_DAYS} days old is kept`)
ok(isExpiredAppLog(daysAgo(APP_LOG_RETENTION_DAYS + 1), now), `${APP_LOG_RETENTION_DAYS + 1} days old expires`)
ok(isExpiredAppLog(daysAgo(365), now), 'a year-old file expires')

console.log('sweep removes exactly the expired set on a real directory')
{
  const dir = mkdtempSync(join(tmpdir(), 'ot-applog-'))
  try {
    for (const n of [daysAgo(0), daysAgo(3), daysAgo(APP_LOG_RETENTION_DAYS), daysAgo(APP_LOG_RETENTION_DAYS + 1), daysAgo(60)]) {
      writeFileSync(join(dir, n), 'x')
    }
    writeFileSync(join(dir, 'keep-me.txt'), 'x')
    const removed = await sweepAppLogs(dir, now)
    const left = readdirSync(dir).sort()
    ok(removed.length === 2, `two files removed (got ${removed.length})`)
    ok(removed.includes(daysAgo(APP_LOG_RETENTION_DAYS + 1)) && removed.includes(daysAgo(60)), 'the expired set is exactly right')
    ok(left.length === 4 && left.includes('keep-me.txt') && left.includes(daysAgo(APP_LOG_RETENTION_DAYS)), 'today, boundary and foreign files survive')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('appLog appends serialized, single-line entries')
{
  const dir = mkdtempSync(join(tmpdir(), 'ot-applog-'))
  try {
    initAppLog(dir)
    await Promise.all([appLog('main', 'first'), appLog('renderer', 'second\nwith newline'), appLog('main', 'third')])
    const content = readFileSync(join(dir, appLogName(new Date())), 'utf8')
    const lines = content.trimEnd().split('\n')
    ok(lines.length === 3, `three appends -> three lines (got ${lines.length})`)
    ok(/\[main\s*\] first$/.test(lines[0]), 'order is preserved (1)')
    ok(/\[renderer\] second with newline$/.test(lines[1]), 'embedded newlines are flattened (2)')
    ok(/\[main\s*\] third$/.test(lines[2]), 'order is preserved (3)')
    ok(lines.every((l) => /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] \[(?:main|renderer)\s*\] /.test(l)), 'every line carries a local timestamp and source')
    ok(lines[0].includes('[main    ]') && lines[1].includes('[renderer]'), 'the source column is padded to a fixed width for readability')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('the settings gate drops lines while off and resumes when on')
{
  const dir = mkdtempSync(join(tmpdir(), 'ot-applog-'))
  try {
    initAppLog(dir)
    await appLog('main', 'before off')
    setAppLogEnabled(false)
    await appLog('main', 'while off')
    setAppLogEnabled(true)
    await appLog('main', 'back on')
    const content = readFileSync(join(dir, appLogName(new Date())), 'utf8')
    ok(content.includes('before off'), 'on: line recorded')
    ok(!content.includes('while off'), 'off: line dropped, nothing recorded')
    ok(content.includes('back on'), 're-enabled: recording resumes')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('runaway payloads are truncated to one bounded line')
{
  const dir = mkdtempSync(join(tmpdir(), 'ot-applog-'))
  try {
    initAppLog(dir)
    await appLog('main', 'x'.repeat(10000))
    const content = readFileSync(join(dir, appLogName(new Date())), 'utf8')
    ok(content.length < 3000, `the line is bounded (got ${content.length} bytes)`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('init sweeps expired files on the way up')
{
  const dir = mkdtempSync(join(tmpdir(), 'ot-applog-'))
  try {
    // Relative to the REAL today: init sweeps with the wall clock.
    writeFileSync(join(dir, 'app-2020-01-01.log'), 'x')
    writeFileSync(join(dir, appLogName(new Date())), 'x')
    initAppLog(dir)
    await appLog('main', 'after init') // drains behind the init sweep in the same queue
    const left = readdirSync(dir)
    ok(!left.includes('app-2020-01-01.log'), 'expired file is gone after init')
    ok(left.includes(appLogName(new Date())), "today's file survives init")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (failed > 0) {
  console.error(`\n[app-log] ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('\n[app-log] ALL CHECKS PASSED')
