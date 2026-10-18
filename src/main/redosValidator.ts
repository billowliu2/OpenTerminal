/**
 * Rule-validation service (redosValidator.ts).
 *
 * The controlling side of the ReDoS probe gate: it owns a small pool of
 * `redosProbeWorker` threads, hands each rule to one of them under a hard
 * wall-clock budget, and turns the answers into stored proofs.
 *
 * Why the budget is enforced HERE rather than inside the worker: a catastrophic
 * pattern blocks V8 inside one `exec` call for seconds to minutes, so a clock
 * check in the worker's own loop is unreachable (measured: 28.4s for a single
 * `exec`). The only stop that works is `terminate()` from this side — measured
 * at ~313ms against a worker stuck in `((a|a))+$` — which is why a rule that
 * blows the budget is reported as `quarantined` and its worker is rebuilt.
 *
 * Trust boundaries:
 *   - The worker gets a pattern and a flag string and nothing else. No settings,
 *     no terminal content, no filesystem: the probes are fixed synthetic inputs
 *     (`shared/redosProbes.ts`), so nothing here can leak what a user has on
 *     screen.
 *   - A verdict is only ever `passed` / `quarantined` / "no verdict". A worker
 *     that crashed, could not be built or never started yields `pending` — it is
 *     never reported as dangerous, because "we could not measure it" and "we
 *     measured it as hostile" call for different UI.
 *   - Nothing is validated at import time. The pool is created on the first
 *     request, so an install that ships no custom rules never starts a thread —
 *     and never having needed one is not a failure: the feature-level
 *     `workerAvailable` flag starts `true` and only turns `false` once a worker
 *     creation was actually attempted and failed.
 *
 * Where results go: the editor asks over IPC and gets verdicts back for its
 * draft; the settings store's injected applier (`validateSettingsRules`) probes
 * what is actually stored and writes the proofs back through `mutateSettings`,
 * so they travel to the renderer over the existing settings broadcast. This
 * module imports the settings store, never the other way round.
 */
import { ipcMain } from 'electron'
import type { Worker } from 'node:worker_threads'
import { Ipc } from '../shared/ipc'
import type {
  RuleValidationKind,
  RuleValidationOutcome,
  RuleValidationReport,
  RuleValidationRequest,
  RuleValidationState
} from '../shared/ipc'
import { PROBE_BUDGET_MS, PROBE_VERSION } from '../shared/redosProbes'
import { DEFAULT_HIGHLIGHT_RULES, type AppSettings } from '../shared/settings'
import {
  LINK_RULE_FLAGS,
  MAX_PATTERN_LEN,
  highlightFlags,
  makeBuiltinWhitelist,
  needsRuleValidation,
  ruleKeyOf,
  ruleRunState,
  type RuleRunState,
  type RuleValidation
} from '../shared/ruleValidation'
import type { ProbeRequest, ProbeResponse } from './redosProbeWorker'
import { appLog } from './appLog'
import { broadcast } from './broadcast'
import { currentRuntimeKey } from './ruleRuntime'
import { loadSettings, mutateSettings } from './settingsStore'

/** Verdict for one rule. `pending` means "no verdict" — never "suspicious". */
export type ProbeVerdict = 'passed' | 'quarantined' | 'pending'

export interface RuleProbeRequest {
  /** pattern + flags identity; also the dedupe key */
  key: string
  pattern: string
  flags: string
}

export interface RuleProbeResult extends RuleProbeRequest {
  verdict: ProbeVerdict
  /** slowest probe, when a run actually completed */
  ms?: number
}

/**
 * Creates one worker thread. Injected: the production wiring passes the
 * electron-vite `?nodeWorker` factory (see `index.ts`), which keeps this module
 * free of a build-tool-specific import so tests can bundle and drive it with
 * their own worker — a real `node:worker_threads` Worker running an inline
 * script, or a stub for the "worker cannot be built" path.
 */
export type ProbeWorkerFactory = () => Worker

/** The factory presets, exempt from probing (proved by the test suite). */
const BUILTIN_WHITELIST = makeBuiltinWhitelist(DEFAULT_HIGHLIGHT_RULES)

const DEFAULT_MAX_WORKERS = 2
const DEFAULT_IDLE_MS = 30_000
/** How often a crashed worker's task is retried on a fresh thread, then no verdict. */
const MAX_TASK_RETRIES = 1
/** Rules per IPC batch. The renderer chunks longer lists; this is the backstop. */
export const MAX_VALIDATE_ITEMS = 100
/** One unavailability line per minute, not per attempt. */
const UNAVAILABLE_LOG_INTERVAL_MS = 60_000

interface Task {
  key: string
  pattern: string
  flags: string
  /** retries already spent on this task (a crashed worker's answer is not a verdict) */
  retries: number
  settled: boolean
  resolve: (outcome: { verdict: ProbeVerdict; ms?: number }) => void
}

interface Slot {
  worker: Worker
  busy: boolean
  /** we are tearing this worker down ourselves — its exit is not a crash */
  closing: boolean
  task?: Task
  timer?: NodeJS.Timeout
  messageId: number
}

let factory: ProbeWorkerFactory | null = null
let maxWorkers = DEFAULT_MAX_WORKERS
let ruleBudgetMs = PROBE_BUDGET_MS
let idleMs = DEFAULT_IDLE_MS

const slots: Slot[] = []
const queue: Task[] = []
const inflight = new Map<string, Promise<{ verdict: ProbeVerdict; ms?: number }>>()
/** Patterns already answered "does not compile" in this environment. */
const undecidable = new Map<string, string>()
let nextMessageId = 1
let idleTimer: NodeJS.Timeout | undefined
/**
 * Whether the probe feature is usable — the settings page warns from this, so
 * it must not confuse "nothing needed a worker yet" with "the worker is broken".
 * It starts `true`: the pool is built lazily, so an install that ships no custom
 * rules never creates a thread, which is the normal case and not a failure. Only
 * a missing factory, a worker that cannot be created, or a live worker that dies
 * on the job turns it `false`; a later successful creation turns it back.
 */
let workerAvailable = true
let lastUnavailableLogAt = 0
let factoryMissingLogged = false

/** Test seam: install the worker factory (production wiring lives in index.ts). */
export function setValidatorWorkerFactory(next: ProbeWorkerFactory | null): void {
  factory = next
}

/**
 * Test seam: shrink the budgets so a suite does not wait 500ms per hostile rule
 * or 30s for idle reclamation. Production never calls this.
 */
export function setValidatorBudgets(budgets: {
  ruleBudgetMs?: number
  idleMs?: number
  maxWorkers?: number
}): void {
  if (budgets.ruleBudgetMs !== undefined) ruleBudgetMs = budgets.ruleBudgetMs
  if (budgets.idleMs !== undefined) idleMs = budgets.idleMs
  if (budgets.maxWorkers !== undefined) maxWorkers = Math.max(1, budgets.maxWorkers)
}

/**
 * Test seam + app shutdown: drop every worker and all in-memory verdicts, settle
 * anything still in flight as "no verdict", and restore the default budgets and
 * factory. Production calls it once, at quit; a test calls it between cases so
 * one case's worker/budget cannot leak into the next.
 */
export function resetRuleValidator(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = undefined
  }
  for (const slot of [...slots]) {
    // A task sitting in a worker slot is IN FLIGHT: its worker is about to be
    // terminated, so its answer will never arrive. Take the task out, tear the
    // worker down, then settle it as "no verdict" — otherwise the caller's
    // promise hangs forever on a reset that ran while a probe was running, and
    // the quit path must never leave a dangling await behind.
    const pending = slot.task
    slot.task = undefined
    destroySlot(slot)
    if (pending !== undefined) settleTask(pending, { verdict: 'pending' })
  }
  slots.length = 0
  for (const task of queue.splice(0)) settleTask(task, { verdict: 'pending' })
  inflight.clear()
  undecidable.clear()
  workerAvailable = true
  lastUnavailableLogAt = 0
  factoryMissingLogged = false
  factory = null
  maxWorkers = DEFAULT_MAX_WORKERS
  ruleBudgetMs = PROBE_BUDGET_MS
  idleMs = DEFAULT_IDLE_MS
}

/** App shutdown hook: no worker thread may outlive the process's window phase. */
export function shutdownRuleValidator(): void {
  resetRuleValidator()
}

/** Test seam: the validator's own flags/config, so a test can assert on them. */
export function validatorConfig(): { ruleBudgetMs: number; idleMs: number; maxWorkers: number } {
  return { ruleBudgetMs, idleMs, maxWorkers }
}

// ---- the pool ---------------------------------------------------------------

function wireSlot(slot: Slot): void {
  slot.worker.on('message', (message: ProbeResponse) => onMessage(slot, message))
  slot.worker.on('error', (error: Error) => onWorkerFailure(slot, error))
  slot.worker.on('exit', (code: number) => onWorkerExit(slot, code))
}

/**
 * Create a worker, or report that none could be created. A synchronous throw
 * (missing build artifact, no thread budget) and a null factory both land in the
 * same place: the caller flushes its queue as "no verdict" and the settings page
 * shows the feature as unavailable. Merely not having needed a worker yet is not
 * that case — the flag only moves when a creation was actually attempted.
 */
function createSlot(): Slot | null {
  if (factory === null) {
    if (!factoryMissingLogged) {
      factoryMissingLogged = true
      void appLog('main', 'rule validation: no worker factory installed — custom rules stay pending')
    }
    markUnavailable()
    return null
  }
  let worker: Worker
  try {
    worker = factory()
  } catch (err) {
    reportUnavailable(err instanceof Error ? err.message : String(err))
    return null
  }
  const slot: Slot = { worker, busy: false, closing: false, messageId: 0 }
  wireSlot(slot)
  slots.push(slot)
  if (!workerAvailable) {
    workerAvailable = true
    publishState()
  }
  return slot
}

/** Flip the feature-level flag to unavailable (publishes once, not per attempt). */
function markUnavailable(): void {
  if (!workerAvailable) return
  workerAvailable = false
  publishState()
}

/** Report a reason for the unavailability and log it once per interval. */
function reportUnavailable(detail: string): void {
  markUnavailable()
  const now = Date.now()
  if (now - lastUnavailableLogAt < UNAVAILABLE_LOG_INTERVAL_MS) return
  lastUnavailableLogAt = now
  void appLog('main', `rule validation: worker unavailable (${detail.slice(0, 200)}) — custom rules stay pending`)
}

function destroySlot(slot: Slot): void {
  slot.closing = true
  if (slot.timer) {
    clearTimeout(slot.timer)
    slot.timer = undefined
  }
  const index = slots.indexOf(slot)
  if (index >= 0) slots.splice(index, 1)
  try {
    void slot.worker.terminate()
  } catch {
    /* terminating a thread that is already gone is not an error here */
  }
}

/** Outcome of trying to get a worker for the next queued task. */
type SlotOutcome =
  /** a worker is ready for the task */
  | { kind: 'slot'; slot: Slot }
  /** every worker is busy and the pool is at its cap: the task waits its turn */
  | { kind: 'wait' }
  /** no worker can be created at all: the task gets no verdict */
  | { kind: 'unavailable' }

function acquireSlot(): SlotOutcome {
  const free = slots.find((slot) => !slot.busy && !slot.closing)
  if (free) return { kind: 'slot', slot: free }
  if (slots.length >= maxWorkers) return { kind: 'wait' }
  const created = createSlot()
  return created === null ? { kind: 'unavailable' } : { kind: 'slot', slot: created }
}

/**
 * Hand queued tasks to free workers until either runs out.
 *
 * The three ways out matter: "no worker can be built" answers everything still
 * queued with `pending` immediately (a task left in the queue would hang its
 * caller's promise), while "all workers are busy" must simply wait — flushing
 * the queue there would hand out `pending` verdicts for rules that were about
 * to be probed perfectly well.
 */
function pump(): void {
  while (queue.length > 0) {
    const outcome = acquireSlot()
    if (outcome.kind === 'wait') {
      scheduleIdleReclaim()
      return
    }
    if (outcome.kind === 'unavailable') {
      for (const task of queue.splice(0)) settleTask(task, { verdict: 'pending' })
      scheduleIdleReclaim()
      return
    }
    const task = queue.shift() as Task
    dispatch(outcome.slot, task)
  }
  scheduleIdleReclaim()
}

function dispatch(slot: Slot, task: Task): void {
  const messageId = nextMessageId++
  slot.busy = true
  slot.task = task
  slot.messageId = messageId
  slot.timer = setTimeout(() => onBudgetExceeded(slot), ruleBudgetMs)
  slot.timer.unref?.()
  const request: ProbeRequest = { id: messageId, pattern: task.pattern, flags: task.flags }
  try {
    slot.worker.postMessage(request)
  } catch (err) {
    onWorkerFailure(slot, err instanceof Error ? err : new Error(String(err)))
  }
}

function clearSlotTimer(slot: Slot): void {
  if (slot.timer) {
    clearTimeout(slot.timer)
    slot.timer = undefined
  }
}

/** The worker answered in time. */
function onMessage(slot: Slot, message: ProbeResponse): void {
  if (slot.closing || !slot.busy || slot.task === undefined) return
  if (message?.id !== slot.messageId) return
  const task = slot.task
  clearSlotTimer(slot)
  slot.busy = false
  slot.task = undefined
  if (message.ok) {
    settleTask(task, { verdict: 'passed', ms: message.worstMs })
  } else {
    // A pattern that does not compile can never run anyway (the engine's own
    // try/catch drops it), so there is no verdict to store — but remember the
    // answer for this environment so the background pass does not re-probe it on
    // every settings change. The map is bounded: it is a cache of "no point
    // asking again", not a record worth growing forever.
    if (undecidable.size > 200) undecidable.clear()
    undecidable.set(task.key, currentRuntimeKey())
    settleTask(task, { verdict: 'pending' })
  }
  pump()
}

/** The budget ran out: kill the thread, rebuild it, quarantine the rule. */
function onBudgetExceeded(slot: Slot): void {
  if (slot.closing || slot.task === undefined) return
  const task = slot.task
  slot.task = undefined
  slot.busy = false
  destroySlot(slot)
  void appLog(
    'main',
    `rule validation: rule quarantined (pattern length ${task.pattern.length}, flags ${task.flags}) — budget ${ruleBudgetMs}ms exceeded, worker terminated`
  )
  settleTask(task, { verdict: 'quarantined' })
  pump()
}

/** A worker error or an unexpected exit. Retry the task once, then give up. */
function onWorkerFailure(slot: Slot, error: Error): void {
  if (slot.closing) return
  clearSlotTimer(slot)
  const task = slot.task
  slot.task = undefined
  slot.busy = false
  destroySlot(slot)
  // A worker that dies on the job is not "available": the feature is degraded
  // for the whole session, and the settings page has to say so. Creation on the
  // next request is still attempted, so a one-off crash heals itself.
  reportUnavailable(error.message)
  if (task) requeueOrAbandon(task)
  pump()
}

function onWorkerExit(slot: Slot, code: number): void {
  if (slot.closing) return
  clearSlotTimer(slot)
  const task = slot.task
  slot.task = undefined
  slot.busy = false
  destroySlot(slot)
  if (task) {
    void appLog('main', `rule validation: worker exited while probing (code ${code})`)
    requeueOrAbandon(task)
    pump()
  }
}

/**
 * One retry on a fresh thread, then "no verdict". A crashed worker says nothing
 * about the rule, so it must never turn into a quarantine.
 */
function requeueOrAbandon(task: Task): void {
  if (task.settled) return
  if (task.retries < MAX_TASK_RETRIES) {
    task.retries += 1
    queue.push(task)
    return
  }
  settleTask(task, { verdict: 'pending' })
}

function settleTask(task: Task, outcome: { verdict: ProbeVerdict; ms?: number }): void {
  if (task.settled) return
  task.settled = true
  task.resolve(outcome)
}

/** Terminate workers that have been idle for a while (the timer is unref'd). */
function scheduleIdleReclaim(): void {
  if (idleTimer || queue.length > 0) return
  idleTimer = setTimeout(() => {
    idleTimer = undefined
    if (queue.length > 0) return
    for (const slot of [...slots]) {
      if (!slot.busy) destroySlot(slot)
    }
  }, idleMs)
  idleTimer.unref?.()
}

/**
 * Probe one rule, sharing the run with every other caller asking for the same
 * pattern + flags while it is in flight.
 */
function probeOne(key: string, pattern: string, flags: string): Promise<{ verdict: ProbeVerdict; ms?: number }> {
  const running = inflight.get(key)
  if (running) return running
  const tracked = new Promise<{ verdict: ProbeVerdict; ms?: number }>((resolve) => {
    queue.push({ key, pattern, flags, retries: 0, settled: false, resolve })
  }).finally(() => {
    // Drop only OUR entry: `resetRuleValidator` clears the map outright, and a
    // caller may already have registered a fresh run under the same key by the
    // time this microtask runs.
    if (inflight.get(key) === tracked) inflight.delete(key)
  })
  inflight.set(key, tracked)
  pump()
  return tracked
}

/** Probe a batch. Per-rule budgets; no total budget, so a slow rule cannot
 *  make the rules behind it look dangerous. */
export async function validateRules(requests: readonly RuleProbeRequest[]): Promise<RuleProbeResult[]> {
  return Promise.all(
    requests.map(async (request) => {
      const outcome = await probeOne(request.key, request.pattern, request.flags)
      return { ...request, verdict: outcome.verdict, ...(outcome.ms !== undefined ? { ms: outcome.ms } : {}) }
    })
  )
}

// ---- stored rules: background pass + write-back ------------------------------

/** The proof a verdict earns, or undefined when there is nothing to store. */
function proofFor(verdict: ProbeVerdict, pattern: string, flags: string): RuleValidation | undefined {
  if (verdict === 'pending') return undefined
  return {
    status: verdict === 'passed' ? 'passed' : 'quarantined',
    pattern,
    flags,
    probeVersion: PROBE_VERSION,
    runtime: currentRuntimeKey()
  }
}

function sameValidation(a: RuleValidation | undefined, b: RuleValidation | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return (
    a.status === b.status &&
    a.pattern === b.pattern &&
    a.flags === b.flags &&
    a.probeVersion === b.probeVersion &&
    a.runtime === b.runtime
  )
}

/** Rules the background pass should spend a probe run on, deduped by pattern. */
function pendingRequests(settings: AppSettings): RuleProbeRequest[] {
  const out: RuleProbeRequest[] = []
  const seen = new Set<string>()
  const consider = (pattern: string, flags: string, validation: RuleValidation | undefined, empty: boolean): void => {
    if (empty || pattern.length > MAX_PATTERN_LEN) return
    const key = ruleKeyOf(pattern, flags)
    if (seen.has(key) || BUILTIN_WHITELIST.has(key)) return
    if (!needsRuleValidation(pattern, flags, validation, PROBE_VERSION)) return
    if (undecidable.get(key) === currentRuntimeKey()) return
    seen.add(key)
    out.push({ key, pattern, flags })
  }
  for (const rule of settings.highlightRules) {
    if (rule.enabled === false) continue
    consider(rule.pattern, highlightFlags(rule.caseInsensitive, rule.lineAnchor), rule.validation, rule.pattern.length === 0)
  }
  for (const rule of settings.linkRules ?? []) {
    if (rule.enabled === false) continue
    consider(rule.pattern, LINK_RULE_FLAGS, rule.validation, rule.pattern.trim() === '')
  }
  return out
}

/**
 * Apply verdicts to the stored rules. Returns null when nothing would change —
 * the caller must not write in that case, because a write broadcasts, which
 * runs this pass again: an unchanged write-back would be an endless loop.
 */
function applyVerdicts(settings: AppSettings, verdicts: Map<string, ProbeVerdict>): AppSettings | null {
  let changed = false
  const highlightRules = settings.highlightRules.map((rule) => {
    const flags = highlightFlags(rule.caseInsensitive, rule.lineAnchor)
    const verdict = verdicts.get(ruleKeyOf(rule.pattern, flags))
    const proof = verdict === undefined ? undefined : proofFor(verdict, rule.pattern, flags)
    if (proof === undefined || sameValidation(rule.validation, proof)) return rule
    changed = true
    return { ...rule, validation: proof }
  })
  const linkRules = (settings.linkRules ?? []).map((rule) => {
    const verdict = verdicts.get(ruleKeyOf(rule.pattern, LINK_RULE_FLAGS))
    const proof = verdict === undefined ? undefined : proofFor(verdict, rule.pattern, LINK_RULE_FLAGS)
    if (proof === undefined || sameValidation(rule.validation, proof)) return rule
    changed = true
    return { ...rule, validation: proof }
  })
  if (!changed) return null
  return { ...settings, highlightRules, linkRules }
}

/** Counts for the settings page's warning. Disabled rules are not waiting for
 *  anything: they are not probed, and enabling one re-runs the pass. */
function countStates(settings: AppSettings): { pending: number; quarantined: number } {
  let pending = 0
  let quarantined = 0
  const count = (state: RuleRunState): void => {
    if (state === 'pending') pending += 1
    else if (state === 'quarantined') quarantined += 1
  }
  for (const rule of settings.highlightRules) {
    if (rule.enabled === false) continue
    count(
      ruleRunState(rule.pattern, highlightFlags(rule.caseInsensitive, rule.lineAnchor), rule.validation, PROBE_VERSION, BUILTIN_WHITELIST)
    )
  }
  for (const rule of settings.linkRules ?? []) {
    if (rule.enabled === false) continue
    count(ruleRunState(rule.pattern, LINK_RULE_FLAGS, rule.validation, PROBE_VERSION))
  }
  return { pending, quarantined }
}

/** The state the renderer shows: aggregate, not per rule. */
export function getRuleValidationState(): RuleValidationState {
  const { pending, quarantined } = countStates(loadSettings())
  return {
    runtime: currentRuntimeKey(),
    probeVersion: PROBE_VERSION,
    workerAvailable,
    pending,
    quarantined
  }
}

/** Push the aggregate state to the renderer (called when it can have changed). */
function publishState(settings?: AppSettings): void {
  const source = settings ?? loadSettings()
  const { pending, quarantined } = countStates(source)
  const state: RuleValidationState = {
    runtime: currentRuntimeKey(),
    probeVersion: PROBE_VERSION,
    workerAvailable,
    pending,
    quarantined
  }
  broadcast(Ipc.RULE_VALIDATION_STATE, state)
}

/**
 * The settings store's applier: probe everything stored that has no current
 * verdict, then write the verdicts back through the settings pipeline. Called
 * on startup and after every settings mutation, so it must never block (the
 * write path is synchronous) and must converge — after the write-back the same
 * rules hold matching proofs and are not probed again.
 */
export function validateSettingsRules(settings: AppSettings): void {
  const requests = pendingRequests(settings)
  publishState(settings)
  if (requests.length === 0) return
  void validateRules(requests)
    .then(async (results) => {
      const verdicts = new Map<string, ProbeVerdict>()
      for (const result of results) verdicts.set(result.key, result.verdict)
      // Pre-check on the snapshot: `mutateSettings` always writes and
      // broadcasts, and a broadcast re-runs this pass.
      if (applyVerdicts(settings, verdicts) === null) return
      await mutateSettings((current) => applyVerdicts(current, verdicts) ?? current)
      publishState()
    })
    .catch((err: unknown) => {
      // A validation pass must never take the settings pipeline down with it.
      void appLog('main', `rule validation: pass failed (${err instanceof Error ? err.message : String(err)})`)
    })
}

// ---- IPC --------------------------------------------------------------------

/** One shape-cleaned IPC item, tagged with its place in the request. */
interface ReadItem {
  id: string
  /** position in the original request array — the report's sort key */
  order: number
  pattern: string
  caseInsensitive: boolean
  lineAnchor: boolean
}

/** Shape-clean one IPC item; returns null when it cannot be a rule at all. */
function readItem(value: unknown, index: number): ReadItem | null {
  if (value === null || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (typeof item.pattern !== 'string') return null
  return {
    id: typeof item.id === 'string' ? item.id : `#${index}`,
    order: index,
    pattern: item.pattern,
    caseInsensitive: item.caseInsensitive === true,
    lineAnchor: item.lineAnchor === true
  }
}

function flagsFor(kind: RuleValidationKind, item: { caseInsensitive: boolean; lineAnchor: boolean }): string {
  return kind === 'link' ? LINK_RULE_FLAGS : highlightFlags(item.caseInsensitive, item.lineAnchor)
}

/**
 * Answer one `RULE_VALIDATE` batch. Drafts are never stored: the renderer gets
 * verdicts to show and to preview with, and the proof only becomes durable once
 * the rule itself is saved (which runs the background pass above).
 */
export async function handleRuleValidationRequest(raw: unknown): Promise<RuleValidationReport> {
  const request = (raw ?? {}) as Partial<RuleValidationRequest>
  const kind: RuleValidationKind = request.kind === 'link' ? 'link' : 'highlight'
  const rawItems = Array.isArray(request.items) ? request.items : []
  const items = rawItems
    .slice(0, MAX_VALIDATE_ITEMS)
    .map((value, index) => readItem(value, index))
    .filter((item): item is NonNullable<ReturnType<typeof readItem>> => item !== null)

  const results: { order: number; outcome: RuleValidationOutcome }[] = []
  const probes: RuleProbeRequest[] = []
  const byKey = new Map<string, ReadItem[]>()
  for (const item of items) {
    const flags = flagsFor(kind, item)
    const empty = kind === 'link' ? item.pattern.trim() === '' : item.pattern.length === 0
    const key = ruleKeyOf(item.pattern, flags)
    // A pattern the engine would refuse anyway gets no verdict: there is
    // nothing to run, and a probe run would only waste a worker slot.
    if (empty || item.pattern.length > MAX_PATTERN_LEN) {
      results.push({ order: item.order, outcome: { id: item.id, state: 'pending' } })
      continue
    }
    const state = ruleRunState(item.pattern, flags, undefined, PROBE_VERSION, kind === 'link' ? undefined : BUILTIN_WHITELIST)
    if (state === 'builtin') {
      results.push({ order: item.order, outcome: { id: item.id, state: 'builtin' } })
      continue
    }
    const same = byKey.get(key)
    if (same) same.push(item)
    else {
      byKey.set(key, [item])
      probes.push({ key, pattern: item.pattern, flags })
    }
  }

  const outcomes = await validateRules(probes)
  const verdicts = new Map<string, RuleProbeResult>()
  for (const outcome of outcomes) verdicts.set(outcome.key, outcome)
  for (const [key, same] of byKey) {
    const outcome = verdicts.get(key)
    const state: RuleRunState = outcome === undefined || outcome.verdict === 'pending' ? 'pending' : outcome.verdict
    for (const item of same) {
      results.push({
        order: item.order,
        outcome: { id: item.id, state, ...(outcome?.ms !== undefined ? { ms: outcome.ms } : {}) }
      })
    }
  }

  // Keep the reported order aligned with the request, so a caller can zip them.
  // The key is the request INDEX, not the id: two items may legitimately share
  // an id (the caller echoes back whatever it was handed), and an id-keyed map
  // would collapse both onto one rank.
  results.sort((a, b) => a.order - b.order)

  return {
    runtime: currentRuntimeKey(),
    probeVersion: PROBE_VERSION,
    workerAvailable,
    truncated: rawItems.length > MAX_VALIDATE_ITEMS,
    results: results.map((entry) => entry.outcome)
  }
}

export function registerRuleValidationIpc(): void {
  ipcMain.handle(Ipc.RULE_VALIDATE, (_event, request: unknown) => handleRuleValidationRequest(request))
  ipcMain.handle(Ipc.RULE_VALIDATION_STATE_GET, () => getRuleValidationState())
}
