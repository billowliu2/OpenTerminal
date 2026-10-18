/**
 * Renderer performance diagnostics — the observation-only first phase of the
 * stall-timeline plan (docs/PLAN-2026-10-17-font-highlight.md, 独立方案 B §B2
 * 「第一阶段：低成本统一时间线」).
 *
 * This phase only *observes*: nothing here changes when a fit runs, how output is
 * written, or which renderer is used. The module is deliberately pure — plain
 * counters, monotonic timestamps and trigger labels — so it never touches the
 * DOM, never grows React state (a diagnostic that re-renders panes would pollute
 * the very measurement it takes), and never stores terminal content. Both of
 * those properties are also what let `tests/perf-diagnostics.mjs` import the
 * `.ts` file directly through Node's type stripping.
 *
 * Five layers, all of them metadata:
 *
 *   1. `LongTaskRing` / `overlapLongTasks` / `classifyWatchdogLag` — turns a
 *      watchdog tick into "a real renderer long task" vs "scheduler delay", with
 *      the window and estimated start/end, instead of the old blanket "stall".
 *   2. Per-pane registry (`registerPane` … `snapshotPanes`) — the watchdog reads
 *      one aggregate; panes never call back into React.
 *   3. Fit samples (`noteFit`) — trigger, start, duration, grid and real buffer
 *      length, which is what lets reflow cost be tied to history size.
 *   4. Write-chain counters (`noteWriteStart` / `noteWriteDone`) — how long the
 *      `term.write` call itself took (enqueue) and how long xterm took to
 *      consume it (callback), plus unfinished writes and queued characters.
 *   5. Rate limiters (`intervalLogDecision`, `perfLogDecision`) — per-pane fit
 *      lines at most once per 30s with a `suppressed=N` trailer, and at most 5
 *      PERF lines a minute globally. Severe watchdog reports bypass that cap:
 *      they are the one line worth having.
 *
 * Characters are JS string lengths (UTF-16 code units), never claimed as bytes.
 */

/** Why a fit was requested. The trailing (settled-size) fit keeps its origin. */
export type FitTrigger = 'mount' | 'resize' | 'font' | 'scrollback' | 'renderer-switch' | 'unknown'

/** Renderer actually installed on a pane at the time of the sample. */
export type PaneRendererMode = 'webgl' | 'dom' | 'unknown'

/** WebGL lifecycle events worth one log line each (no pixels, no content). */
export type WebglEvent = 'init' | 'init-failed' | 'context-loss' | 'dispose'

/** How many long-task entries the watchdog keeps (≈ the last few seconds). */
export const MAX_LONG_TASKS = 50
/** Per-pane minimum gap between two fit log lines. */
export const FIT_LOG_INTERVAL_MS = 30_000
/** Global PERF line budget window and size (disk writes, not console). */
export const PERF_LOG_WINDOW_MS = 60_000
export const PERF_LOG_MAX_PER_WINDOW = 5
/** Watchdog lag (over and above the interval) that is worth classifying. */
export const WATCHDOG_LAG_LOG_MS = 3000
/** A `term.write` whose parser callback took longer than this is logged once. */
export const SLOW_WRITE_ACK_MS = 1000

export interface FitSample {
  trigger: FitTrigger
  /** `performance.now()` when the fit started. */
  startedAt: number
  durationMs: number
  cols: number
  rows: number
  /** `term.buffer.active.length` after the fit — the real reflowed line count. */
  bufferLines: number
  /** Configured scrollback cap, for context against `bufferLines`. */
  scrollback: number
}

/**
 * The font-group values a fit trigger is derived from. Only these are compared:
 * font metrics and the scrollback cap decide how much history a fit has to
 * rewrap, while the rest of the group (cursor blink / style) changes rendering
 * without changing the reflow size.
 */
export interface FitTriggerInput {
  fontSize: number
  fontFamily: string
  /** normalized by the caller: an absent CJK fallback reads as the empty string */
  cjkFontFamily: string
  fontWeight: number
  boldFontWeight: number
  letterSpacing: number
  lineHeight: number
  scrollback: number
}

/**
 * Why a fit gets the label it gets — diagnostics only; it never decides whether
 * a fit runs. `prev === null` means this is the first fit after construction.
 *
 * The comparison is over FIELD VALUES, not object identity. The settings store
 * hands out a new group object whenever ANY field in the group changes, so an
 * identity-based comparison reports a cursor-blink change as a scrollback
 * reflow — and calls every unrelated churn a scrollback change too, which is the
 * one label that would make a stall report point at history size for no reason.
 * No difference in any compared field is `unknown`: nothing here changed, so
 * nothing here explains the fit.
 */
export function fitTriggerFor(prev: FitTriggerInput | null, next: FitTriggerInput): FitTrigger {
  if (prev === null) return 'mount'
  if (
    prev.fontSize !== next.fontSize ||
    prev.fontFamily !== next.fontFamily ||
    prev.cjkFontFamily !== next.cjkFontFamily ||
    prev.fontWeight !== next.fontWeight ||
    prev.boldFontWeight !== next.boldFontWeight ||
    prev.letterSpacing !== next.letterSpacing ||
    prev.lineHeight !== next.lineHeight
  ) {
    return 'font'
  }
  return prev.scrollback === next.scrollback ? 'unknown' : 'scrollback'
}

export interface PaneWriteMetrics {
  /** `term.write` calls made for this pane. */
  count: number
  /** Writes whose parser callback has not fired yet. */
  inflight: number
  /** Characters handed to xterm but not yet consumed (string length). */
  queuedChars: number
  enqueueMsLast: number
  enqueueMsMax: number
  ackMsLast: number
  ackMsMax: number
}

export interface PaneFitMetrics {
  count: number
  last: FitSample | null
}

export interface PaneWebglMetrics {
  initCount: number
  initFailedCount: number
  contextLossCount: number
  disposeCount: number
}

export interface PaneStats {
  paneId: string
  rendererMode: PaneRendererMode
  registeredAt: number
  /** Live Batcher backlog for this pane, read lazily at snapshot time. */
  pendingCharsProbe?: () => number | undefined
  pendingChars: number
  writes: PaneWriteMetrics
  fits: PaneFitMetrics
  webgl: PaneWebglMetrics
}

export interface PanesSnapshot {
  paneCount: number
  webglPanes: number
  domPanes: number
  unknownModePanes: number
  writeCount: number
  /** Sum of unfinished `term.write` calls across panes. */
  writeInflight: number
  /** Sum of characters queued inside xterm across panes (string length). */
  queuedChars: number
  /** Sum of `WriteBatcher.pendingChars` across panes (string length). */
  batcherPendingChars: number
  ackMsMax: number
  ackMsLast: number
  enqueueMsMax: number
  fitCount: number
  lastFitPaneId: string
  lastFit: FitSample | null
  lastFitAgeMs: number
  webglContextLosses: number
}

const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())

// ---- per-pane registry -----------------------------------------------------

/** Opaque per-bind id → that bind's counters. Cleared on unmount/rebind. */
const panes = new Map<string, PaneStats>()

function emptyStats(paneId: string, rendererMode: PaneRendererMode, registeredAt: number): PaneStats {
  return {
    paneId,
    rendererMode,
    registeredAt,
    pendingChars: 0,
    writes: {
      count: 0,
      inflight: 0,
      queuedChars: 0,
      enqueueMsLast: 0,
      enqueueMsMax: 0,
      ackMsLast: 0,
      ackMsMax: 0
    },
    fits: { count: 0, last: null },
    webgl: { initCount: 0, initFailedCount: 0, contextLossCount: 0, disposeCount: 0 }
  }
}

/**
 * Register one pane bind and return its live counters.
 *
 * The id must be unique per *bind*, not per React component: a rebind tears the
 * terminal down while the pane lives on, and a write callback still in flight
 * from the old terminal must land on a dead entry instead of the new pane's.
 */
export function registerPane(
  paneId: string,
  init: {
    rendererMode?: PaneRendererMode
    registeredAt?: number
    pendingCharsProbe?: () => number | undefined
  } = {}
): PaneStats {
  const stats = emptyStats(paneId, init.rendererMode ?? 'unknown', init.registeredAt ?? nowMs())
  if (init.pendingCharsProbe !== undefined) stats.pendingCharsProbe = init.pendingCharsProbe
  panes.set(paneId, stats)
  return stats
}

/** Drop a pane's counters (unmount / rebind). Later notes for it are ignored. */
export function unregisterPane(paneId: string): boolean {
  return panes.delete(paneId)
}

export function getPaneStats(paneId: string): PaneStats | undefined {
  return panes.get(paneId)
}

export function registeredPaneCount(): number {
  return panes.size
}

/** Test/teardown helper: forget every pane. */
export function clearPanes(): void {
  panes.clear()
}

/** Record a finished fit. Ignored for an unregistered (stale) pane id. */
export function noteFit(paneId: string, sample: FitSample): void {
  const stats = panes.get(paneId)
  if (stats === undefined) return
  stats.fits.count += 1
  stats.fits.last = sample
}

/** Record a `term.write` that has just been handed to xterm. */
export function noteWriteStart(paneId: string, chars: number): void {
  const stats = panes.get(paneId)
  if (stats === undefined) return
  const w = stats.writes
  w.count += 1
  w.inflight += 1
  w.queuedChars += Math.max(0, chars)
}

/**
 * How long the `term.write(...)` call itself took (enqueue cost, not parsing).
 *
 * Separate from `noteWriteStart` because xterm may invoke the parser callback
 * synchronously for trivial input: the enqueue duration is only known after the
 * call returns, while the completion has to be bookkept before it can be
 * measured. Keeping them apart means a synchronous callback cannot drive
 * `inflight` negative or lose its queued-character decrement.
 */
export function noteWriteEnqueue(paneId: string, enqueueMs: number): void {
  const stats = panes.get(paneId)
  if (stats === undefined) return
  const w = stats.writes
  w.enqueueMsLast = enqueueMs
  if (enqueueMs > w.enqueueMsMax) w.enqueueMsMax = enqueueMs
}

/**
 * Record xterm's parser callback for one write: consumption latency plus the
 * dequeue. Clamped at zero because a (pathological) synchronous callback would
 * otherwise drive the counters negative.
 */
export function noteWriteDone(paneId: string, chars: number, ackMs: number): void {
  const stats = panes.get(paneId)
  if (stats === undefined) return
  const w = stats.writes
  w.inflight = Math.max(0, w.inflight - 1)
  w.queuedChars = Math.max(0, w.queuedChars - Math.max(0, chars))
  w.ackMsLast = ackMs
  if (ackMs > w.ackMsMax) w.ackMsMax = ackMs
}

export function notePaneRenderer(paneId: string, mode: PaneRendererMode): void {
  const stats = panes.get(paneId)
  if (stats === undefined) return
  stats.rendererMode = mode
}

export function noteWebgl(paneId: string, event: WebglEvent): void {
  const stats = panes.get(paneId)
  if (stats === undefined) return
  const w = stats.webgl
  if (event === 'init') w.initCount += 1
  else if (event === 'init-failed') w.initFailedCount += 1
  else if (event === 'context-loss') w.contextLossCount += 1
  else w.disposeCount += 1
}

/**
 * One read-only aggregate for the watchdog report. Probes are called defensively
 * — a probe belongs to a pane that may be mid-teardown.
 */
export function snapshotPanes(now: number = nowMs()): PanesSnapshot {
  const snap: PanesSnapshot = {
    paneCount: panes.size,
    webglPanes: 0,
    domPanes: 0,
    unknownModePanes: 0,
    writeCount: 0,
    writeInflight: 0,
    queuedChars: 0,
    batcherPendingChars: 0,
    ackMsMax: 0,
    ackMsLast: 0,
    enqueueMsMax: 0,
    fitCount: 0,
    lastFitPaneId: '',
    lastFit: null,
    lastFitAgeMs: 0,
    webglContextLosses: 0
  }
  let lastFitStartedAt = -Infinity
  for (const stats of panes.values()) {
    if (stats.rendererMode === 'webgl') snap.webglPanes += 1
    else if (stats.rendererMode === 'dom') snap.domPanes += 1
    else snap.unknownModePanes += 1
    snap.writeCount += stats.writes.count
    snap.writeInflight += stats.writes.inflight
    snap.queuedChars += stats.writes.queuedChars
    snap.enqueueMsMax = Math.max(snap.enqueueMsMax, stats.writes.enqueueMsMax)
    snap.ackMsMax = Math.max(snap.ackMsMax, stats.writes.ackMsMax)
    snap.ackMsLast = Math.max(snap.ackMsLast, stats.writes.ackMsLast)
    snap.fitCount += stats.fits.count
    snap.webglContextLosses += stats.webgl.contextLossCount
    if (stats.pendingCharsProbe !== undefined) {
      try {
        const pending = stats.pendingCharsProbe()
        stats.pendingChars = typeof pending === 'number' && pending > 0 ? pending : 0
      } catch {
        stats.pendingChars = 0
      }
    }
    snap.batcherPendingChars += stats.pendingChars
    const last = stats.fits.last
    if (last !== null && last.startedAt > lastFitStartedAt) {
      lastFitStartedAt = last.startedAt
      snap.lastFitPaneId = stats.paneId
      snap.lastFit = last
      snap.lastFitAgeMs = Math.max(0, now - last.startedAt)
    }
  }
  return snap
}

// ---- long tasks & watchdog classification ----------------------------------

export interface LongTaskEntry {
  /** `performance.now()` origin, as PerformanceEntry.startTime. */
  startTime: number
  duration: number
}

/** Fixed-size FIFO of recent long tasks (newest last). */
export class LongTaskRing {
  private readonly items: LongTaskEntry[] = []
  private readonly capacity: number

  constructor(capacity: number = MAX_LONG_TASKS) {
    this.capacity = capacity > 0 ? capacity : MAX_LONG_TASKS
  }

  push(entry: LongTaskEntry): void {
    this.items.push({ startTime: entry.startTime, duration: entry.duration })
    while (this.items.length > this.capacity) this.items.shift()
  }

  get size(): number {
    return this.items.length
  }

  /** Copy of the buffer, oldest first — never the live array. */
  all(): LongTaskEntry[] {
    return this.items.slice()
  }

  latest(): LongTaskEntry | null {
    return this.items.length > 0 ? this.items[this.items.length - 1] : null
  }

  clear(): void {
    this.items.length = 0
  }
}

export interface LongTaskOverlap {
  count: number
  /** Overlap of every matching task with the window, summed and clamped. */
  overlapMs: number
  /** Longest overlapping task's full duration (the real long-task size). */
  maxTaskMs: number
  firstStart: number | null
  lastEnd: number | null
}

/**
 * Long tasks intersecting `[start, end]`. A task that began before the window or
 * ends after it contributes only its clamped overlap, so a tick that catches the
 * tail of a long task still counts.
 */
export function overlapLongTasks(
  tasks: readonly LongTaskEntry[],
  start: number,
  end: number
): LongTaskOverlap {
  const out: LongTaskOverlap = { count: 0, overlapMs: 0, maxTaskMs: 0, firstStart: null, lastEnd: null }
  if (end <= start) return out
  for (const task of tasks) {
    const taskEnd = task.startTime + task.duration
    const from = Math.max(task.startTime, start)
    const to = Math.min(taskEnd, end)
    if (to <= from) continue
    out.count += 1
    out.overlapMs += to - from
    if (task.duration > out.maxTaskMs) out.maxTaskMs = task.duration
    if (out.firstStart === null || task.startTime < out.firstStart) out.firstStart = task.startTime
    if (out.lastEnd === null || taskEnd > out.lastEnd) out.lastEnd = taskEnd
  }
  return out
}

/**
 * What the missed timer ticks actually were.
 *
 * The old watchdog called every late tick a stall, which conflated a real
 * main-thread long task with the browser throttling the timer (system sleep,
 * hidden page, OS scheduling). Only an observed long task may be called a long
 * task; everything else is reported as `scheduler-delay` with the unexplained
 * part spelled out.
 */
export type WatchdogKind = 'renderer-long-task' | 'scheduler-delay'

export interface WatchdogVerdict {
  kind: WatchdogKind
  /** Missed time: elapsed minus the watchdog interval, i.e. the old "lag". */
  lagMs: number
  windowStart: number
  windowEnd: number
  taskCount: number
  overlapMs: number
  /** Lag not covered by any observed long task. */
  uncoveredMs: number
  maxTaskMs: number
  firstTaskStart: number | null
  lastTaskEnd: number | null
}

export interface WatchdogInput {
  lagMs: number
  windowStart: number
  windowEnd: number
  longTasks?: readonly LongTaskEntry[]
  minLagMs?: number
}

/** Null when the lag is below the threshold (nothing worth logging). */
export function classifyWatchdogLag(input: WatchdogInput): WatchdogVerdict | null {
  const minLagMs = input.minLagMs ?? WATCHDOG_LAG_LOG_MS
  if (!(input.lagMs > minLagMs)) return null
  const overlap = overlapLongTasks(input.longTasks ?? [], input.windowStart, input.windowEnd)
  return {
    kind: overlap.count > 0 ? 'renderer-long-task' : 'scheduler-delay',
    lagMs: input.lagMs,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    taskCount: overlap.count,
    overlapMs: overlap.overlapMs,
    uncoveredMs: Math.max(0, input.lagMs - overlap.overlapMs),
    maxTaskMs: overlap.maxTaskMs,
    firstTaskStart: overlap.firstStart,
    lastTaskEnd: overlap.lastEnd
  }
}

// ---- log rate limiters -----------------------------------------------------

/** "At most one line per `intervalMs`, carrying the count it swallowed". */
export interface IntervalGate {
  /** Monotonic timestamp of the last emitted line; <= 0 means "none yet". */
  lastEmitAt: number
  suppressed: number
}

export function newIntervalGate(): IntervalGate {
  return { lastEmitAt: 0, suppressed: 0 }
}

export interface IntervalLogDecision {
  emit: boolean
  /** Lines swallowed since the previous emit — the `suppressed=N` trailer. */
  suppressed: number
  next: IntervalGate
}

/** Pure: returns the gate to store, never mutates the one passed in. */
export function intervalLogDecision(
  gate: IntervalGate,
  now: number,
  intervalMs: number
): IntervalLogDecision {
  if (gate.lastEmitAt <= 0 || now - gate.lastEmitAt >= intervalMs) {
    return { emit: true, suppressed: gate.suppressed, next: { lastEmitAt: now, suppressed: 0 } }
  }
  return { emit: false, suppressed: 0, next: { lastEmitAt: gate.lastEmitAt, suppressed: gate.suppressed + 1 } }
}

/** Sliding-budget gate for the global PERF line cap. */
export interface PerfLogGate {
  windowStart: number
  count: number
  suppressed: number
}

export function newPerfLogGate(): PerfLogGate {
  return { windowStart: 0, count: 0, suppressed: 0 }
}

export interface PerfLogDecision {
  emit: boolean
  suppressed: number
  next: PerfLogGate
}

/**
 * At most `max` lines per `windowMs`, EXCEPT urgent lines (a severe watchdog
 * report), which always pass: they are rare by construction and are the reason
 * the budget exists. Urgent lines still count against the window, so a burst of
 * them cannot hide how much normal traffic was dropped.
 */
export function perfLogDecision(
  gate: PerfLogGate,
  now: number,
  opts: { urgent?: boolean; windowMs?: number; max?: number } = {}
): PerfLogDecision {
  const windowMs = opts.windowMs ?? PERF_LOG_WINDOW_MS
  const max = opts.max ?? PERF_LOG_MAX_PER_WINDOW
  const rolled = gate.windowStart <= 0 || now - gate.windowStart >= windowMs
  const windowStart = rolled ? now : gate.windowStart
  const count = rolled ? 0 : gate.count
  const suppressed = rolled ? 0 : gate.suppressed
  if (opts.urgent === true) {
    return { emit: true, suppressed, next: { windowStart, count: count + 1, suppressed } }
  }
  if (count >= max) {
    return {
      emit: false,
      suppressed: suppressed + 1,
      next: { windowStart, count, suppressed: suppressed + 1 }
    }
  }
  return { emit: true, suppressed, next: { windowStart, count: count + 1, suppressed } }
}

// ---- formatting ------------------------------------------------------------

const KIND_LABEL: Record<WatchdogKind, string> = {
  'renderer-long-task': 'renderer long task',
  'scheduler-delay': 'scheduler delay/unclassified'
}

const WEBGL_LABEL: Record<WebglEvent, string> = {
  init: 'webgl-init',
  'init-failed': 'webgl-init-failed',
  'context-loss': 'webgl-context-loss',
  dispose: 'webgl-dispose'
}

/** First 6 chars of a pane id: enough to correlate lines, short enough to read. */
export function shortPaneId(paneId: string): string {
  const id = paneId.trim()
  if (id === '') return '?'
  return id.length <= 6 ? id : id.slice(0, 6)
}

/** One-line, length-capped detail text (never a terminal buffer, but be safe). */
export function sanitizePerfDetail(text: string, max = 80): string {
  const flat = text.replace(/[\r\n\t]+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}...` : flat
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** Local wall clock with milliseconds — log lines must be readable next to them. */
export function clockLabel(epochMs: number): string {
  const d = new Date(epochMs)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(
    d.getMilliseconds()
  ).padStart(3, '0')}`
}

const round = (n: number): number => Math.round(n)

/** `PERF fit pane 3f2a1c trigger=resize 240ms 120x40 bufferLines=5120 ...` */
export function formatFitReport(sample: FitSample, suppressed: number, paneId = ''): string {
  const pane = paneId === '' ? '' : ` pane ${shortPaneId(paneId)}`
  const tail = suppressed > 0 ? ` suppressed=${suppressed}` : ''
  return (
    `PERF fit${pane} trigger=${sample.trigger} ${round(sample.durationMs)}ms ` +
    `${sample.cols}x${sample.rows} bufferLines=${sample.bufferLines} ` +
    `scrollback=${sample.scrollback} started=${round(sample.startedAt)}ms${tail}`
  )
}

/** `PERF renderer webgl-context-loss pane 3f2a1c mode=webgl` */
export function formatWebglReport(
  event: WebglEvent,
  paneId: string,
  mode: PaneRendererMode,
  detail?: string
): string {
  const extra = detail === undefined || detail === '' ? '' : ` detail=${sanitizePerfDetail(detail)}`
  return `PERF renderer ${WEBGL_LABEL[event]} pane ${shortPaneId(paneId)} mode=${mode}${extra}`
}

/** `PERF write xterm ack 1450ms pane 3f2a1c inflight=2 queuedChars=9216` */
export function formatSlowWriteReport(
  paneId: string,
  ackMs: number,
  inflight: number,
  queuedChars: number
): string {
  return (
    `PERF write xterm ack ${round(ackMs)}ms pane ${shortPaneId(paneId)} ` +
    `inflight=${inflight} queuedChars=${queuedChars}`
  )
}

export interface WatchdogReportContext {
  /** `performance.now()` at report time (the renderer already recovered). */
  now: number
  /** `Date.now()` at report time, for the wall clock labels. */
  wallNow: number
  /** Newest entries first or last, either is fine; only the latest is used. */
  recentLongTasks?: readonly LongTaskEntry[]
}

/**
 * The one line the watchdog writes. Every field is metadata; the timestamps are
 * the watchdog's *estimate* of when the freeze happened, reconstructed after the
 * fact — the line is written during recovery, so the log's own timestamp is the
 * end of the incident, not its start.
 */
export function formatWatchdogReport(
  verdict: WatchdogVerdict,
  snap: PanesSnapshot,
  ctx: WatchdogReportContext
): string {
  const windowStartWall = ctx.wallNow - (ctx.now - verdict.windowStart)
  const windowEndWall = ctx.wallNow - (ctx.now - verdict.windowEnd)
  const estStart = verdict.firstTaskStart ?? verdict.windowStart
  const estEnd = verdict.lastTaskEnd ?? verdict.windowEnd
  const parts: string[] = []
  parts.push(
    `main thread lag ~${round(verdict.lagMs)}ms: ${KIND_LABEL[verdict.kind]}`
  )
  parts.push(
    `window ${clockLabel(windowStartWall)}-${clockLabel(windowEndWall)} ` +
      `(est ${clockLabel(ctx.wallNow - (ctx.now - estStart))}-${clockLabel(
        ctx.wallNow - (ctx.now - estEnd)
      )})`
  )
  if (verdict.taskCount > 0) {
    parts.push(
      `longtasks ${verdict.taskCount} overlap ${round(verdict.overlapMs)}ms ` +
        `uncovered ${round(verdict.uncoveredMs)}ms latest ${round(verdict.maxTaskMs)}ms`
    )
  } else {
    const recent = ctx.recentLongTasks
    const newest = recent !== undefined && recent.length > 0 ? recent[recent.length - 1] : null
    parts.push(
      `no longtask in window (${newest === null
        ? 'none observed'
        : `newest ${round(newest.duration)}ms @${round(newest.startTime)}ms`})`
    )
  }
  const modes = `webgl ${snap.webglPanes}, dom ${snap.domPanes}`
  const unknown = snap.unknownModePanes > 0 ? `, unknown ${snap.unknownModePanes}` : ''
  parts.push(`panes ${snap.paneCount} (${modes}${unknown}) renderer ${dominantMode(snap)}`)
  const fit = snap.lastFit
  if (fit === null) {
    parts.push('no fit recorded')
  } else {
    parts.push(
      `last fit pane ${shortPaneId(snap.lastFitPaneId)} trigger=${fit.trigger} ` +
        `${round(fit.durationMs)}ms ${round(snap.lastFitAgeMs)}ms ago ` +
        `${fit.cols}x${fit.rows} bufferLines=${fit.bufferLines} scrollback=${fit.scrollback}`
    )
  }
  parts.push(
    `xterm writes ${snap.writeCount} inflight ${snap.writeInflight} ` +
      `queuedChars ${snap.queuedChars} ackMax ${round(snap.ackMsMax)}ms ` +
      `enqueueMax ${round(snap.enqueueMsMax)}ms`
  )
  parts.push(`batcher pendingChars ${snap.batcherPendingChars}`)
  parts.push(
    `logged ${clockLabel(ctx.wallNow)} after recovery (log time != fault start)`
  )
  return parts.join(' | ')
}

/** Which renderer most panes are on — the closest thing to a global mode. */
function dominantMode(snap: PanesSnapshot): PaneRendererMode {
  if (snap.paneCount === 0) return 'unknown'
  if (snap.webglPanes >= snap.domPanes) return snap.webglPanes > 0 ? 'webgl' : 'unknown'
  return 'dom'
}

// ---- shared emit path (one global budget for every producer) ---------------

export interface PerfLogContext {
  urgent: boolean
  /** PERF lines this emit dropped from the budget since the previous accept. */
  suppressed: number
}

export type PerfLogSink = (line: string, ctx: PerfLogContext) => void

let sink: PerfLogSink | null = null
let globalGate: PerfLogGate = newPerfLogGate()

/**
 * Install the disk sink once, at renderer entry. The sink owns the
 * `settings.system.diagnosticLog` check; this module never reads settings.
 */
export function setPerfLogSink(next: PerfLogSink | null): void {
  sink = next
}

/** Test helper: forget the sink and the budget. */
export function resetPerfLogSink(): void {
  sink = null
  globalGate = newPerfLogGate()
}

export function currentPerfLogGate(): PerfLogGate {
  return globalGate
}

/**
 * Emit one PERF line through the shared minute budget. Returns whether the sink
 * actually ran. `urgent` (severe watchdog reports) always passes the budget;
 * everything else is dropped silently once the 5/minute cap is spent, and the
 * next accepted line reports how many were dropped as `suppressed=N`.
 */
export function emitPerfLog(
  line: string,
  opts: { urgent?: boolean; now?: number } = {}
): boolean {
  const now = opts.now ?? nowMs()
  const decision = perfLogDecision(globalGate, now, { urgent: opts.urgent === true })
  globalGate = decision.next
  if (!decision.emit || sink === null) return false
  const text = decision.suppressed > 0 ? `${line} suppressed=${decision.suppressed}` : line
  try {
    sink(text, { urgent: opts.urgent === true, suppressed: decision.suppressed })
  } catch {
    /* diagnostics must never break the caller */
  }
  return true
}
