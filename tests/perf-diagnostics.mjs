/**
 * perf-diagnostics self-test (perf-diagnostics.mjs).
 *
 * The observation-only first phase of the stall timeline
 * (docs/PLAN-2026-10-17-font-highlight.md, 独立方案 B §B2) is observation only, so
 * the thing worth pinning is the *decision* logic that turns raw ticks into log
 * lines:
 *
 *   - `classifyWatchdogLag`: a late tick is only a "renderer long task" when an
 *     observed long task actually overlaps the window; otherwise it is
 *     "scheduler delay/unclassified" with the unexplained remainder (`uncovered`)
 *     carried explicitly. Below the lag threshold nothing is reported at all.
 *   - `fitTriggerFor`: the fit label comes from the font group's FIELD VALUES, so
 *     a group object rebuilt for a non-metric member (cursor blink/style) is not
 *     mislabelled as a scrollback reflow.
 *   - `intervalLogDecision`: per-pane fit lines — one per window, the next one
 *     carrying `suppressed=N`.
 *   - `perfLogDecision`: the 5/minute global PERF cap, which urgent (severe
 *     watchdog) lines bypass without resetting the normal budget.
 *   - the pane registry: per-bind counters, aggregate snapshot, and the rule that
 *     a dropped (unmounted/rebound) pane id stops receiving notes so an in-flight
 *     write callback cannot pollute the next bind's numbers.
 *   - `WriteBatcher.pendingChars`: a JS string length (NOT bytes) that tracks
 *     the buffer and clears on flush/dispose.
 *
 * Direct .ts import (no esbuild bundle needed): perfDiagnostics.ts has no
 * imports and writeBatcher.ts has none either, and Node >= 22.18 strips types
 * itself.
 * Run: node tests/perf-diagnostics.mjs   (must exit 0)
 */
import {
  classifyWatchdogLag,
  clearPanes,
  currentPerfLogGate,
  emitPerfLog,
  FIT_LOG_INTERVAL_MS,
  fitTriggerFor,
  formatFitReport,
  formatWatchdogReport,
  intervalLogDecision,
  LongTaskRing,
  MAX_LONG_TASKS,
  newIntervalGate,
  newPerfLogGate,
  noteFit,
  notePaneRenderer,
  noteWebgl,
  noteWriteDone,
  noteWriteEnqueue,
  noteWriteStart,
  overlapLongTasks,
  PERF_LOG_MAX_PER_WINDOW,
  PERF_LOG_WINDOW_MS,
  perfLogDecision,
  registerPane,
  resetPerfLogSink,
  setPerfLogSink,
  snapshotPanes,
  unregisterPane,
  WATCHDOG_LAG_LOG_MS,
  sanitizePerfDetail
} from '../src/renderer/src/terminal/perfDiagnostics.ts'
import { WriteBatcher } from '../src/renderer/src/terminal/writeBatcher.ts'

const DELAY = 10
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}
const eq = (actual, expected, msg) =>
  ok(actual === expected, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`)

// ---- watchdog classification (table driven) --------------------------------

console.log('watchdog: lag below the threshold is not reported at all')
{
  const rows = [
    { lag: 0, minLag: undefined, want: null },
    { lag: 2999, minLag: undefined, want: null },
    { lag: WATCHDOG_LAG_LOG_MS, minLag: undefined, want: null }, // strictly greater
    { lag: 3001, minLag: undefined, want: true },
    { lag: -5000, minLag: undefined, want: null }
  ]
  for (const row of rows) {
    const got = classifyWatchdogLag({
      lagMs: row.lag,
      windowStart: 1000,
      windowEnd: 1000 + 2000 + row.lag,
      minLagMs: row.minLag
    })
    eq(got === null, row.want === null, `lag ${row.lag}ms is ${row.want === null ? 'silent' : 'reported'}`)
  }
}

console.log('watchdog: classification follows long-task overlap, not the lag alone')
{
  // window [1000, 9000]; lag 6000
  const rows = [
    {
      name: 'no long tasks -> scheduler delay',
      tasks: [],
      kind: 'scheduler-delay',
      count: 0,
      overlap: 0,
      uncovered: 6000
    },
    {
      name: 'one long task fully inside -> renderer long task',
      tasks: [{ startTime: 3000, duration: 4000 }],
      kind: 'renderer-long-task',
      count: 1,
      overlap: 4000,
      uncovered: 2000
    },
    {
      name: 'long task straddling the start is clamped',
      tasks: [{ startTime: 0, duration: 2500 }],
      kind: 'renderer-long-task',
      count: 1,
      overlap: 1500,
      uncovered: 4500
    },
    {
      name: 'task ending exactly at the window start does not overlap',
      tasks: [{ startTime: 0, duration: 1000 }],
      kind: 'scheduler-delay',
      count: 0,
      overlap: 0,
      uncovered: 6000
    },
    {
      name: 'task starting exactly at the window end does not overlap',
      tasks: [{ startTime: 9000, duration: 500 }],
      kind: 'scheduler-delay',
      count: 0,
      overlap: 0,
      uncovered: 6000
    },
    {
      name: 'two adjacent tasks sum their overlap',
      tasks: [
        { startTime: 2000, duration: 2000 },
        { startTime: 4000, duration: 3000 }
      ],
      kind: 'renderer-long-task',
      count: 2,
      overlap: 5000,
      uncovered: 1000
    },
    {
      name: 'a long task outside the window is ignored',
      tasks: [{ startTime: 20000, duration: 9000 }],
      kind: 'scheduler-delay',
      count: 0,
      overlap: 0,
      uncovered: 6000
    }
  ]
  for (const row of rows) {
    const got = classifyWatchdogLag({
      lagMs: 6000,
      windowStart: 1000,
      windowEnd: 9000,
      longTasks: row.tasks
    })
    ok(got !== null, `${row.name}: reported`)
    if (got === null) continue
    eq(got.kind, row.kind, `${row.name}: kind`)
    eq(got.taskCount, row.count, `${row.name}: taskCount`)
    eq(got.overlapMs, row.overlap, `${row.name}: overlapMs`)
    eq(got.uncoveredMs, row.uncovered, `${row.name}: uncoveredMs`)
  }
}

console.log('watchdog: maxTaskMs reports the real long-task size, not the clamp')
{
  const got = classifyWatchdogLag({
    lagMs: 5000,
    windowStart: 1000,
    windowEnd: 7000,
    longTasks: [{ startTime: 900, duration: 3000 }]
  })
  ok(got !== null, 'reported')
  eq(got.overlapMs, 2900, 'overlap is clamped to the 1000..3900 intersection')
  eq(got.maxTaskMs, 3000, 'maxTaskMs keeps the full task duration')
}

console.log('overlapLongTasks: degenerate windows report nothing')
{
  for (const [start, end] of [[1000, 1000], [2000, 1000]]) {
    const got = overlapLongTasks([{ startTime: 500, duration: 5000 }], start, end)
    eq(got.count, 0, `window [${start}, ${end}] is empty`)
  }
}

console.log('LongTaskRing: bounded FIFO, newest last')
{
  const ring = new LongTaskRing(3)
  for (let i = 0; i < 5; i += 1) ring.push({ startTime: i * 10, duration: 50 })
  eq(ring.size, 3, 'capacity is enforced')
  const all = ring.all()
  eq(all[0].startTime, 20, 'oldest surviving entry is the 3rd push')
  eq(all[2].startTime, 40, 'newest entry is last')
  eq(ring.latest()?.startTime, 40, 'latest() returns the newest')
  const copy = ring.all()
  copy.push({ startTime: 999, duration: 1 })
  eq(ring.size, 3, 'all() returns a copy, not the live array')
  ring.clear()
  eq(ring.size, 0, 'clear empties the ring')
  eq(ring.latest(), null, 'latest() is null when empty')

  const big = new LongTaskRing()
  for (let i = 0; i < MAX_LONG_TASKS + 20; i += 1) big.push({ startTime: i, duration: 60 })
  eq(big.size, MAX_LONG_TASKS, 'default capacity is MAX_LONG_TASKS')
}

// ---- fit trigger labelling -------------------------------------------------

console.log('fit trigger: labelled from field values, not from object identity')
{
  const base = {
    fontSize: 14,
    fontFamily: 'Consolas',
    cjkFontFamily: '',
    fontWeight: 400,
    boldFontWeight: 700,
    letterSpacing: 0,
    lineHeight: 1,
    scrollback: 5000
  }
  const rows = [
    { name: 'the first fit after construction', next: base, want: 'mount' },
    { name: 'a group object rebuilt with identical values', next: { ...base }, want: 'unknown' },
    { name: 'font size', next: { ...base, fontSize: 15 }, want: 'font' },
    { name: 'font family', next: { ...base, fontFamily: 'Fira Code' }, want: 'font' },
    { name: 'the CJK fallback slot', next: { ...base, cjkFontFamily: 'Sarasa Mono SC' }, want: 'font' },
    { name: 'font weight', next: { ...base, fontWeight: 500 }, want: 'font' },
    { name: 'bold font weight', next: { ...base, boldFontWeight: 800 }, want: 'font' },
    { name: 'letter spacing', next: { ...base, letterSpacing: 1 }, want: 'font' },
    { name: 'line height', next: { ...base, lineHeight: 1.2 }, want: 'font' },
    { name: 'only the scrollback cap', next: { ...base, scrollback: 10000 }, want: 'scrollback' },
    {
      name: 'scrollback and a font metric together',
      next: { ...base, scrollback: 10000, fontSize: 16 },
      want: 'font'
    }
  ]
  for (const row of rows) {
    const got = fitTriggerFor(row.name.startsWith('the first') ? null : base, row.next)
    eq(got, row.want, row.name)
  }

  // The point of the value comparison: a member of the font group that changes
  // neither a metric nor the scrollback cap must NOT be reported as a scrollback
  // reflow. The caller's snapshot simply has no cursor field, so this is the same
  // call it would make.
  eq(fitTriggerFor(base, { ...base }), 'unknown', 'a non-metric group change is not called a scrollback reflow')
}

// ---- log rate limiters -----------------------------------------------------

console.log('fit log gate: one line per window, next line carries suppressed=N')
{
  const rows = [
    { now: 1000, emit: true, suppressed: 0, note: 'first line always passes' },
    { now: 1000 + 1, emit: false, suppressed: 0, note: 'just after: swallowed' },
    { now: 1000 + 5000, emit: false, suppressed: 0, note: 'mid-window: swallowed' },
    { now: 1000 + FIT_LOG_INTERVAL_MS, emit: true, suppressed: 2, note: 'window elapsed: emits with the 2 swallowed' },
    { now: 1000 + FIT_LOG_INTERVAL_MS + 1, emit: false, suppressed: 0, note: 'new window: counter reset' }
  ]
  let gate = newIntervalGate()
  for (const row of rows) {
    const decision = intervalLogDecision(gate, row.now, FIT_LOG_INTERVAL_MS)
    eq(decision.emit, row.emit, row.note)
    eq(decision.suppressed, row.suppressed, `${row.note}: suppressed`)
    gate = decision.next
  }
}

console.log('fit log gate: the decision is pure (input gate is not mutated)')
{
  const gate = newIntervalGate()
  const before = { ...gate }
  const first = intervalLogDecision(gate, 5000, FIT_LOG_INTERVAL_MS)
  eq(gate.lastEmitAt, before.lastEmitAt, 'input gate untouched')
  eq(gate.suppressed, before.suppressed, 'input suppressed untouched')
  eq(first.next.lastEmitAt, 5000, 'returned gate carries the new timestamp')
}

console.log('PERF budget: max 5 lines per minute, urgent lines bypass it')
{
  let gate = newPerfLogGate()
  const decisions = []
  for (let i = 0; i < PERF_LOG_MAX_PER_WINDOW + 2; i += 1) {
    const d = perfLogDecision(gate, 10_000, {})
    decisions.push(d.emit)
    gate = d.next
  }
  eq(decisions.filter(Boolean).length, PERF_LOG_MAX_PER_WINDOW, 'exactly 5 normal lines pass')
  eq(decisions.at(-1), false, 'the 6th and 7th are dropped')
  eq(gate.suppressed, 2, 'the dropped count is carried')

  const urgent = perfLogDecision(gate, 10_000, { urgent: true })
  eq(urgent.emit, true, 'an urgent line passes a spent budget')
  eq(urgent.suppressed, 2, 'and still reports what was dropped before it')

  const afterWindow = perfLogDecision(urgent.next, 10_000 + PERF_LOG_WINDOW_MS, {})
  eq(afterWindow.emit, true, 'a new window restores the budget')
  eq(afterWindow.suppressed, 0, 'and clears the dropped count')
}

console.log('PERF budget: emitPerfLog drops silently once the cap is spent')
{
  const lines = []
  resetPerfLogSink()
  setPerfLogSink((line) => lines.push(line))
  for (let i = 0; i < PERF_LOG_MAX_PER_WINDOW + 3; i += 1) emitPerfLog(`line-${i}`, { now: 5000 })
  eq(lines.length, PERF_LOG_MAX_PER_WINDOW, 'only the budgeted lines reach the sink')
  ok(lines.every((l) => !l.includes('suppressed=')), 'no suppressed trailer while nothing was dropped')
  // The dropped count rides on the next accepted line, once the window rolls.
  const emitted = emitPerfLog('after-window', { now: 5000 + PERF_LOG_WINDOW_MS })
  eq(emitted, true, 'the first line of the next window is accepted')
  eq(lines.length, PERF_LOG_MAX_PER_WINDOW + 1, 'and it reached the sink')

  const urgent = emitPerfLog('urgent-line', { urgent: true, now: 5000 + PERF_LOG_WINDOW_MS })
  eq(urgent, true, 'urgent lines bypass the budget through emitPerfLog')
  resetPerfLogSink()
}

console.log('PERF budget: a thrown sink never propagates')
{
  resetPerfLogSink()
  setPerfLogSink(() => {
    throw new Error('sink exploded')
  })
  let threw = false
  try {
    emitPerfLog('boom', { now: 1 })
  } catch {
    threw = true
  }
  ok(!threw, 'emitPerfLog swallows a failing sink')
  resetPerfLogSink()
}

// ---- pane registry ---------------------------------------------------------

console.log('pane registry: counters aggregate across panes')
{
  clearPanes()
  const a = registerPane('pane-a', { rendererMode: 'webgl', registeredAt: 0 })
  const b = registerPane('pane-b', { rendererMode: 'dom', registeredAt: 0 })
  registerPane('pane-c', { registeredAt: 0 }) // unknown mode on purpose

  noteWriteStart('pane-a', 120)
  noteWriteEnqueue('pane-a', 4)
  noteWriteDone('pane-a', 120, 45)
  noteWriteStart('pane-b', 30)
  noteWriteEnqueue('pane-b', 9)
  // pane-b's write is deliberately left in flight
  noteFit('pane-a', {
    trigger: 'resize',
    startedAt: 1000,
    durationMs: 240,
    cols: 120,
    rows: 40,
    bufferLines: 5120,
    scrollback: 5000
  })
  noteFit('pane-b', {
    trigger: 'mount',
    startedAt: 500,
    durationMs: 12,
    cols: 80,
    rows: 24,
    bufferLines: 24,
    scrollback: 5000
  })
  noteWebgl('pane-a', 'init')
  noteWebgl('pane-a', 'context-loss')
  noteWebgl('pane-b', 'init-failed')
  a.pendingCharsProbe = () => 77

  const snap = snapshotPanes(3000)
  eq(snap.paneCount, 3, 'all three panes are counted')
  eq(snap.webglPanes, 1, 'one webgl pane')
  eq(snap.domPanes, 1, 'one dom pane')
  eq(snap.unknownModePanes, 1, 'one pane with no renderer recorded yet')
  eq(snap.writeCount, 2, 'write count sums across panes')
  eq(snap.writeInflight, 1, 'the unfinished write is still counted')
  eq(snap.queuedChars, 30, 'queued characters are what is left unconsumed')
  eq(snap.batcherPendingChars, 77, 'the batcher probe contributes its pendingChars')
  eq(snap.ackMsLast, 45, 'ack latency aggregates')
  eq(snap.ackMsMax, 45, 'ack max aggregates')
  eq(snap.enqueueMsMax, 9, 'enqueue max aggregates')
  eq(snap.fitCount, 2, 'fit count sums')
  eq(snap.lastFitPaneId, 'pane-a', 'the newest fit wins')
  eq(snap.lastFit?.trigger, 'resize', 'and carries its trigger')
  eq(snap.lastFitAgeMs, 2000, 'fit age is measured from the sample start')
  eq(snap.webglContextLosses, 1, 'context losses are counted')
  eq(b.writes.inflight, 1, 'per-pane counters stay intact')

  // A probe that throws must not take the snapshot down.
  b.pendingCharsProbe = () => {
    throw new Error('probe exploded')
  }
  const safe = snapshotPanes(3000)
  eq(safe.batcherPendingChars, 77, 'a throwing probe contributes 0')
  clearPanes()
}

console.log('pane registry: counters are per BIND — a dropped id stops receiving notes')
{
  clearPanes()
  registerPane('bind-1', { rendererMode: 'webgl', registeredAt: 0 })
  noteWriteStart('bind-1', 500)
  noteWriteDone('bind-1', 500, 20)
  eq(snapshotPanes(100).writeCount, 1, 'the first bind counted its write')

  // Rebind: the old terminal is disposed, its in-flight callback still fires.
  unregisterPane('bind-1')
  registerPane('bind-2', { rendererMode: 'webgl', registeredAt: 100 })
  noteWriteDone('bind-1', 500, 9999)
  noteFit('bind-1', {
    trigger: 'resize',
    startedAt: 50,
    durationMs: 5000,
    cols: 1,
    rows: 1,
    bufferLines: 1,
    scrollback: 1
  })
  noteWebgl('bind-1', 'context-loss')

  const snap = snapshotPanes(200)
  eq(snap.writeCount, 0, "the new bind did not inherit the old bind's writes")
  eq(snap.fitCount, 0, 'nor its fits')
  eq(snap.webglContextLosses, 0, 'nor its webgl events')
  eq(snap.ackMsMax, 0, 'nor its ack latency')
  eq(snap.paneCount, 1, 'only the live bind is registered')
  clearPanes()
}

console.log('pane registry: write completion cannot drive the counters negative')
{
  clearPanes()
  registerPane('p', { registeredAt: 0 })
  noteWriteDone('p', 100, 5) // completion with no matching start
  noteWriteDone('p', 0, -100) // a negative/zero measurement
  const stats = snapshotPanes(1)
  eq(stats.writeInflight, 0, 'inflight floors at 0')
  eq(stats.queuedChars, 0, 'queued chars floor at 0')
  eq(stats.ackMsMax, 5, 'the max ack is unaffected by a clamp')
  clearPanes()
}

console.log('pane registry: renderer mode re-records in place')
{
  clearPanes()
  registerPane('p', { rendererMode: 'webgl', registeredAt: 0 })
  notePaneRenderer('p', 'dom')
  eq(snapshotPanes(1).domPanes, 1, 'the pane moved to the dom bucket')
  eq(snapshotPanes(1).webglPanes, 0, 'and left the webgl bucket')
  clearPanes()
}

// ---- log line formatting ---------------------------------------------------

console.log('fit report: metadata only, with a suppressed trailer when needed')
{
  const sample = {
    trigger: 'resize',
    startedAt: 12345.6,
    durationMs: 240.4,
    cols: 120,
    rows: 40,
    bufferLines: 5120,
    scrollback: 5000
  }
  const plain = formatFitReport(sample, 0, 'abcdef123456')
  ok(plain.startsWith('PERF fit pane abcdef '), 'pane id is shortened to 6 chars')
  ok(plain.includes('trigger=resize'), 'trigger is present')
  ok(plain.includes('240ms'), 'duration is rounded')
  ok(plain.includes('120x40'), 'grid is present')
  ok(plain.includes('bufferLines=5120'), 'real buffer length is present')
  ok(plain.includes('scrollback=5000'), 'scrollback cap is present')
  ok(!plain.includes('suppressed='), 'no trailer when nothing was swallowed')

  const gated = formatFitReport(sample, 7, 'abcdef123456')
  ok(gated.endsWith('suppressed=7'), 'the swallowed count is the last field')

  const noPane = formatFitReport(sample, 0, '')
  ok(!noPane.includes(' pane '), 'an empty pane id is omitted')
}

console.log('watchdog report: names the kind, the window and the estimate')
{
  const snap = snapshotPanes(0)
  const verdict = classifyWatchdogLag({
    lagMs: 5000,
    windowStart: 1000,
    windowEnd: 8000,
    longTasks: [{ startTime: 2000, duration: 3000 }]
  })
  ok(verdict !== null, 'verdict built')
  const line = formatWatchdogReport(verdict, snap, {
    now: 8000,
    wallNow: 1_700_000_000_000,
    recentLongTasks: [{ startTime: 2000, duration: 3000 }]
  })
  ok(line.includes('renderer long task'), 'the kind is spelled out')
  ok(line.includes('panes 0'), 'pane count is present')
  ok(line.includes('no fit recorded'), 'a missing fit says so instead of printing zeros')
  ok(line.includes('after recovery'), 'the log-time caveat is present')
  ok(!/[\r\n]/.test(line), 'and the whole report is one line')

  const noTask = classifyWatchdogLag({ lagMs: 5000, windowStart: 1000, windowEnd: 8000, longTasks: [] })
  ok(noTask !== null, 'verdict built without long tasks')
  const schedulerLine = formatWatchdogReport(noTask, snap, {
    now: 8000,
    wallNow: 1_700_000_000_000,
    recentLongTasks: []
  })
  ok(schedulerLine.includes('scheduler delay/unclassified'), 'unexplained lag is not called a stall')
  ok(schedulerLine.includes('none observed'), 'and says no long task was seen')
}

console.log('sanitizePerfDetail: one line, capped')
{
  eq(sanitizePerfDetail('a\nb\tc'), 'a b c', 'newlines and tabs are flattened')
  eq(sanitizePerfDetail('   '), '', 'whitespace-only detail becomes empty')
  const long = sanitizePerfDetail('x'.repeat(200), 10)
  eq(long.length, 13, 'long text is truncated with an ellipsis')
}

// ---- WriteBatcher.pendingChars --------------------------------------------

console.log('WriteBatcher: pendingChars is a string length, not bytes')
{
  const calls = []
  const b = new WriteBatcher((text) => calls.push(text), DELAY)
  eq(b.pendingChars, 0, 'an empty batcher reports 0')
  b.push('abc')
  eq(b.pendingChars, 3, 'three ASCII chars = 3')
  b.push('中文')
  eq(b.pendingChars, 5, 'two CJK chars add 2 code units (NOT 6 bytes)')
  ok(b.hasPending(), 'hasPending agrees with the count')
  b.push('')
  eq(b.pendingChars, 5, 'an empty push changes nothing')
  await sleep(DELAY * 4)
  eq(calls.length, 1, 'one flush')
  eq(b.pendingChars, 0, 'pendingChars clears after the flush')
  b.dispose()
}

console.log('WriteBatcher: dispose drops pendingChars')
{
  const calls = []
  const b = new WriteBatcher((text) => calls.push(text), DELAY)
  b.push('dropped')
  eq(b.pendingChars, 7, 'the buffer is counted before dispose')
  b.dispose()
  eq(b.pendingChars, 0, 'dispose clears the count')
  await sleep(DELAY * 4)
  eq(calls.length, 0, 'and nothing is written')
}

console.log('WriteBatcher: flushNow clears pendingChars synchronously')
{
  const calls = []
  const b = new WriteBatcher((text) => calls.push(text), DELAY)
  b.push('tail')
  b.flushNow()
  eq(b.pendingChars, 0, 'flushNow empties the count before returning')
  eq(calls[0], 'tail', 'and handed the text over')
  await sleep(DELAY * 4)
  eq(calls.length, 1, 'the cancelled timer never fires again')
  b.dispose()
}

// ---- global budget sanity --------------------------------------------------

console.log('the shared gate starts fresh')
{
  resetPerfLogSink()
  const gate = currentPerfLogGate()
  eq(gate.windowStart, 0, 'no window is open yet')
  eq(gate.count, 0, 'and no lines have been counted')
}

if (failed > 0) {
  console.error(`\n[perf-diagnostics] ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('\n[perf-diagnostics] ALL CHECKS PASSED')
