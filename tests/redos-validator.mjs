/**
 * Rule-validation service self-test (redos-validator.mjs).
 *
 * `src/main/redosValidator.ts` is the controlling half of the ReDoS gate: it
 * owns the probe worker pool and decides what a rule's verdict is. The corpus
 * itself is pinned in `tests/redos-probes.mjs`, and the gate the engines apply
 * in `tests/rule-validation.mjs` — this file covers the service in between, and
 * the properties that make the gate trustworthy rather than decorative:
 *
 *   - a legal rule finishes the corpus and comes back `passed`; the 22 shipped
 *     presets are never quarantined (a corpus that failed one would disable a
 *     built-in rule for every user);
 *   - a rule that blows the wall-clock budget is terminated from the OUTSIDE and
 *     reported `quarantined` — the worker cannot stop itself, which is the whole
 *     reason the budget lives here;
 *   - the main thread keeps ticking while a hostile pattern blocks its worker
 *     (a timer that fired late would mean the pool had blocked the process);
 *   - a worker that cannot be created, crashes, or exits yields `pending` and
 *     never `quarantined` — "we could not measure it" must not read as "we
 *     measured it as dangerous";
 *   - the pool stays at its concurrency cap, reuses one run for two rules with
 *     the same pattern, rebuilds a terminated worker and reclaims idle ones;
 *   - "no worker was needed yet" is not "the worker is broken": a fresh
 *     validator reports the feature as available, and only an attempted-and-
 *     failed creation (or a worker that dies on the job) marks it unavailable;
 *   - a reset (the test seam / the app's quit path) settles whatever was in
 *     flight in a worker slot as `pending`, so no caller is left awaiting an
 *     answer that can never arrive;
 *   - the background pass over stored rules writes proofs back through the
 *     settings pipeline, and a proof from another environment is normalized to
 *     `pending` instead of being trusted.
 *
 * Build: node tests/build-bundles.cjs
 * Run:   node tests/redos-validator.mjs   (must exit 0; ~2s)
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { DEFAULT_HIGHLIGHT_RULES } from '../src/shared/settings.ts'
import { PROBE_VERSION, PROBE_BUDGET_MS } from '../src/shared/redosProbes.ts'
import { runtimeKeyOf } from '../src/shared/ruleValidation.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

const userData = mkdtempSync(join(tmpdir(), 'ot-redos-validator-'))
process.env.OT_STUB_USERDATA = userData

const validator = require('./.redos-validator.cjs')
const settingsStore = require('./.settings-store.cjs')
const PROBE_WORKER_PATH = join(__dirname, '.redos-probe-worker.cjs')

let failed = 0
let passed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
  else passed += 1
}

/** The fingerprint the bundled modules installed (same inputs, same function). */
const RUNTIME = runtimeKeyOf({
  app: '0.0.0-stub',
  electron: process.versions.electron ?? '',
  v8: process.versions.v8 ?? ''
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll until `check()` is truthy or the deadline passes. */
const waitFor = async (check, timeoutMs = 4000, stepMs = 20) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await sleep(stepMs)
  }
  return check()
}

const request = (pattern, flags = 'g') => ({ key: `${pattern}\u0000${flags}`, pattern, flags })

/** The shipped probe worker, in a real thread. */
const realWorkerFactory = () => {
  const worker = new Worker(PROBE_WORKER_PATH)
  worker.unref?.()
  return worker
}

/**
 * A scriptable stand-in for the worker thread: the test decides what happens
 * (reply, stay silent, crash, exit) and can count what the pool did to it.
 * `postMessage`/`on`/`terminate` are the only surface the pool uses.
 */
function makeStubWorker(options = {}) {
  const listeners = { message: [], error: [], exit: [] }
  const stub = {
    created: true,
    posts: [],
    terminated: false,
    on(event, listener) {
      listeners[event]?.push(listener)
    },
    postMessage(message) {
      stub.posts.push(message)
      if (options.reply === false) return
      const delay = options.delayMs ?? 0
      const answer =
        options.answer ??
        ((request) => ({ id: request.id, ok: true, probeVersion: PROBE_VERSION, worstMs: 1, totalMs: 1, probes: 24 }))
      setTimeout(() => {
        if (stub.terminated) return
        for (const listener of listeners.message) listener(answer(message))
      }, delay)
    },
    terminate() {
      stub.terminated = true
    },
    emitError(message = 'stub worker failed') {
      for (const listener of listeners.error) listener(new Error(message))
    },
    emitExit(code = 1) {
      for (const listener of listeners.exit) listener(code)
    }
  }
  return stub
}

/** A factory that hands out stubs and keeps them for assertions. */
const stubFactory = (options = {}) => {
  const made = []
  const factory = () => {
    const stub = makeStubWorker(options)
    made.push(stub)
    return stub
  }
  factory.made = made
  return factory
}

// ---- 1. no worker at all ----------------------------------------------------
console.log('[unavailable]')
{
  // The other half of the flag: a validator that simply has not needed a worker
  // yet must NOT report the feature as broken. A default install ships no custom
  // rules, so the pool is never created — if that read as "unavailable", every
  // user would see a red error for a feature that is working perfectly.
  validator.resetRuleValidator()
  validator.setValidatorWorkerFactory(realWorkerFactory)
  const fresh = validator.getRuleValidationState()
  ok(fresh.workerAvailable === true, 'a fresh validator with a factory reports the worker as available')
  ok(fresh.pending === 0, `and no shipped preset is waiting for a verdict (pending ${fresh.pending})`)

  validator.resetRuleValidator()
  validator.setValidatorWorkerFactory(null)
  const results = await validator.validateRules([request('\\bOK\\b')])
  ok(results[0].verdict === 'pending', `no factory → pending, never quarantined (got ${results[0].verdict})`)
  ok(validator.getRuleValidationState().workerAvailable === false, 'the state reports the worker as unavailable')

  // A factory that throws is the "build artifact missing" path: the pool must
  // report it, not crash the settings pipeline.
  validator.resetRuleValidator()
  validator.setValidatorWorkerFactory(() => {
    throw new Error('probe worker chunk not found')
  })
  const report = await validator.handleRuleValidationRequest({
    kind: 'highlight',
    items: [{ id: 'a', pattern: '\\bOK\\b' }]
  })
  ok(report.results[0].state === 'pending', `an unbuildable worker leaves rules pending (got ${report.results[0].state})`)
  ok(report.workerAvailable === false, 'the report says the worker is unavailable')
  ok(report.probeVersion === PROBE_VERSION, `the report carries the probe version (${report.probeVersion})`)
  ok(report.runtime === RUNTIME, `the report carries the runtime fingerprint (${report.runtime})`)
}

// ---- 1b. a reset settles in-flight work -------------------------------------
console.log('[reset with a probe in flight]')
{
  validator.resetRuleValidator()
  const factory = stubFactory({ reply: false })
  validator.setValidatorWorkerFactory(factory)
  validator.setValidatorBudgets({ ruleBudgetMs: 30_000 })
  const promise = validator.validateRules([request('\\bOK\\b')])
  await waitFor(() => factory.made.length > 0 && factory.made[0].posts.length > 0, 500)
  // The worker is holding the task; the reset tears the thread down under it.
  // The caller's promise must still settle: a dangling await is exactly the
  // shape of a hung shutdown path.
  validator.resetRuleValidator()
  const settled = await Promise.race([promise, sleep(500).then(() => 'timeout')])
  ok(settled !== 'timeout', 'a reset with a probe in flight does not hang the caller')
  ok(
    Array.isArray(settled) && settled[0].verdict === 'pending',
    `the in-flight task is settled as pending (got ${JSON.stringify(settled)})`
  )
  ok(factory.made[0].terminated, 'and its worker was terminated')
  ok(validator.getRuleValidationState().workerAvailable === true, 'the reset returns the feature flag to its default (available)')
}

// ---- 2. the real worker: legal rules pass -----------------------------------
console.log('[legit rules through the real worker]')
{
  validator.resetRuleValidator()
  validator.setValidatorWorkerFactory(realWorkerFactory)
  const requests = DEFAULT_HIGHLIGHT_RULES.map((rule) => request(rule.pattern, `g${rule.caseInsensitive ? 'i' : ''}${rule.lineAnchor ? 'm' : ''}`))
  const started = Date.now()
  const results = await validator.validateRules(requests)
  const elapsed = Date.now() - started
  const bad = results.filter((result) => result.verdict !== 'passed')
  ok(bad.length === 0, `every shipped preset passes the corpus (${bad.map((r) => r.pattern).join(' | ') || 'none'} failed)`)
  const worst = Math.max(...results.map((result) => result.ms ?? 0))
  ok(worst < PROBE_BUDGET_MS / 2, `the slowest preset stays well inside the budget (${worst.toFixed(2)}ms < ${PROBE_BUDGET_MS / 2}ms)`)
  ok(elapsed < 3000, `the whole preset set finishes quickly (${elapsed}ms for ${results.length} rules)`)

  const user = await validator.validateRules([request('BUG-(\\d+)'), request('(?<!not\\s)\\b(?:SUCCESS|PASS|OK)\\b'), request('\\b\\d{1,3}(\\.\\d{1,3}){3}\\b')])
  ok(user.every((result) => result.verdict === 'passed'), 'ordinary user patterns pass too')
}

// ---- 3. a hostile rule is terminated from the outside ------------------------
console.log('[hard budget]')
{
  validator.resetRuleValidator()
  validator.setValidatorWorkerFactory(realWorkerFactory)
  validator.setValidatorBudgets({ ruleBudgetMs: 150 })

  // Main-thread responsiveness while the worker is stuck: a hostile pattern
  // blocks its own thread for seconds, and the pool must not block this one.
  let ticks = 0
  const ticker = setInterval(() => {
    ticks += 1
  }, 10)
  const started = Date.now()
  const results = await validator.validateRules([request('(a|a)+$')])
  const elapsed = Date.now() - started
  clearInterval(ticker)
  ok(results[0].verdict === 'quarantined', `a pattern that blows the budget is quarantined (got ${results[0].verdict})`)
  ok(elapsed < 1500, `the verdict lands near the budget, not after the pattern finishes (${elapsed}ms)`)
  ok(ticks > 0, `the main thread kept ticking while the worker was blocked (${ticks} ticks in ${elapsed}ms)`)
  ok(validator.getRuleValidationState().workerAvailable === true, 'a terminated worker does not mark the feature unavailable')

  // The terminated worker is gone: the next rule gets a fresh thread.
  const after = await validator.validateRules([request('\\bOK\\b')])
  ok(after[0].verdict === 'passed', 'the pool rebuilds a terminated worker and keeps serving')
}

// ---- 4. crashes and exits never look like a hostile rule ---------------------
console.log('[worker failures]')
{
  validator.resetRuleValidator()
  const factory = stubFactory({ reply: false })
  validator.setValidatorWorkerFactory(factory)
  validator.setValidatorBudgets({ ruleBudgetMs: 5000 })
  const promise = validator.validateRules([request('\\bOK\\b')])
  // Let the pool dispatch, then kill the initial try and its retry: the task gets
  // one retry on a fresh worker and then gives up.
  await waitFor(() => factory.made.length > 0, 500)
  factory.made[0].emitError('boom')
  await waitFor(() => factory.made.length > 1, 500)
  factory.made[1].emitError('boom again')
  const results = await promise
  ok(results[0].verdict === 'pending', `a twice-crashed worker yields pending, not quarantined (got ${results[0].verdict})`)
  ok(factory.made.length === 2, `the task was retried exactly once (${factory.made.length} workers created)`)
  ok(validator.getRuleValidationState().workerAvailable === false, 'a crashing worker marks the feature unavailable')

  // The unavailable flag is not sticky: a reset (which is also the app's quit
  // path) restores the default, so a later run does not inherit the verdict.
  validator.resetRuleValidator()
  ok(validator.getRuleValidationState().workerAvailable === true, 'a reset clears the unavailable flag back to its default')

  // Same for an exit while busy (a thread that dies without an error event).
  validator.resetRuleValidator()
  const exits = stubFactory({ reply: false })
  validator.setValidatorWorkerFactory(exits)
  const exitPromise = validator.validateRules([request('\\bOK\\b')])
  await waitFor(() => exits.made.length > 0, 500)
  exits.made[0].emitExit(1)
  await waitFor(() => exits.made.length > 1, 500)
  exits.made[1].emitExit(1)
  const exitResults = await exitPromise
  ok(exitResults[0].verdict === 'pending', `an exiting worker yields pending (got ${exitResults[0].verdict})`)
}

// ---- 5. dedupe, concurrency cap, idle reclamation ---------------------------
console.log('[pool behaviour]')
{
  validator.resetRuleValidator()
  const factory = stubFactory({ delayMs: 60 })
  validator.setValidatorWorkerFactory(factory)
  validator.setValidatorBudgets({ ruleBudgetMs: 5000, idleMs: 40 })

  const [a, b] = await Promise.all([
    validator.validateRules([request('\\bOK\\b')]),
    validator.validateRules([request('\\bOK\\b')])
  ])
  ok(a[0].verdict === 'passed' && b[0].verdict === 'passed', 'two callers asking for the same rule both get an answer')
  ok(factory.made.length === 1, `the second caller shares the in-flight run (${factory.made.length} worker(s) created)`)
  ok(factory.made[0].posts.length === 1, `the rule was probed once, not twice (${factory.made[0].posts.length} request(s))`)

  // Concurrency: three rules at once may not open more than two threads.
  validator.resetRuleValidator()
  const capped = stubFactory({ reply: false })
  validator.setValidatorWorkerFactory(capped)
  validator.setValidatorBudgets({ ruleBudgetMs: 4000, maxWorkers: 2 })
  const pending = validator.validateRules([request('A'), request('B'), request('C')])
  await waitFor(() => capped.made.length >= 2, 500)
  await sleep(60)
  ok(capped.made.length === 2, `the pool stops at its concurrency cap (${capped.made.length} workers for 3 rules)`)
  ok(validator.validatorConfig().maxWorkers === 2, 'the cap is the configured one')
  for (const stub of capped.made) stub.emitError('done')
  await pending

  // Idle reclamation: a worker that has nothing to do is terminated.
  validator.resetRuleValidator()
  const idler = stubFactory({ delayMs: 0 })
  validator.setValidatorWorkerFactory(idler)
  validator.setValidatorBudgets({ idleMs: 40 })
  await validator.validateRules([request('\\bOK\\b')])
  ok(idler.made.length === 1, 'a worker was created for the run')
  const reclaimed = await waitFor(() => idler.made[0].terminated, 1000)
  ok(reclaimed, 'the idle worker is terminated instead of sitting on a thread')
  ok(validator.validatorConfig().ruleBudgetMs === PROBE_BUDGET_MS, `reset restores the production budget (${validator.validatorConfig().ruleBudgetMs}ms)`)
}

// ---- 6. IPC batch semantics -------------------------------------------------
console.log('[batch]')
{
  validator.resetRuleValidator()
  validator.setValidatorWorkerFactory(realWorkerFactory)
  const builtin = DEFAULT_HIGHLIGHT_RULES[0]
  const report = await validator.handleRuleValidationRequest({
    kind: 'highlight',
    items: [
      { id: 'builtin', pattern: builtin.pattern, caseInsensitive: builtin.caseInsensitive, lineAnchor: builtin.lineAnchor },
      { id: 'custom', pattern: 'BUG-(\\d+)' },
      { id: 'dupe', pattern: 'BUG-(\\d+)' },
      { id: 'empty', pattern: '' },
      { id: 'long', pattern: 'a'.repeat(600) }
    ]
  })
  const byId = new Map(report.results.map((result) => [result.id, result]))
  ok(byId.get('builtin').state === 'builtin', 'a factory preset is reported as built-in, not probed')
  ok(byId.get('custom').state === 'passed', 'a custom pattern comes back passed')
  ok(byId.get('dupe').state === 'passed', 'a duplicate pattern in the same batch gets the same verdict')
  ok(byId.get('empty').state === 'pending', 'an empty pattern gets no verdict')
  ok(byId.get('long').state === 'pending', 'a pattern past the length bound gets no verdict')
  ok(report.truncated === false, 'a batch inside the cap is not reported as truncated')
  ok(
    report.results.map((result) => result.id).join(',') === 'builtin,custom,dupe,empty,long',
    `results come back in request order (${report.results.map((result) => result.id).join(',')})`
  )

  // The order key is the request INDEX, not the id: two items may legitimately
  // share an id (the caller echoes back whatever it was handed), and an
  // id-keyed map collapses both onto one rank and reorders the report.
  const sameIds = await validator.handleRuleValidationRequest({
    kind: 'highlight',
    items: [
      { id: 'same', pattern: '\\bOK\\b' },
      { id: 'other', pattern: '' },
      { id: 'same', pattern: 'BUG-(\\d+)' }
    ]
  })
  ok(
    sameIds.results.map((result) => result.id).join(',') === 'same,other,same',
    `repeated ids keep their request positions (${sameIds.results.map((result) => result.id).join(',')})`
  )

  const linkReport = await validator.handleRuleValidationRequest({
    kind: 'link',
    items: [{ id: 'link', pattern: 'BUG-(\\d+)' }]
  })
  ok(linkReport.results[0].state === 'passed', 'a link rule is probed with the link flag string')

  const hostile = await validator.handleRuleValidationRequest({
    kind: 'highlight',
    items: [{ id: 'hostile', pattern: '((a|a))+$' }]
  })
  ok(hostile.results[0].state === 'quarantined', `a hostile draft is quarantined over IPC (got ${hostile.results[0].state})`)

  validator.setValidatorBudgets({ ruleBudgetMs: 60 })
  const big = await validator.handleRuleValidationRequest({
    kind: 'highlight',
    items: Array.from({ length: validator.MAX_VALIDATE_ITEMS + 5 }, (_v, index) => ({
      id: `#${index}`,
      pattern: 'x'
    }))
  })
  ok(big.truncated === true, 'a batch past the cap is reported as truncated')
  ok(big.results.length <= validator.MAX_VALIDATE_ITEMS, `the tail is dropped (${big.results.length} results)`)
  ok(
    validator.MAX_VALIDATE_ITEMS <= 200,
    `the batch cap stays small enough to bound memory (${validator.MAX_VALIDATE_ITEMS})`
  )
}

// ---- 7. the background pass writes proofs back ------------------------------
console.log('[settings pass]')
{
  validator.resetRuleValidator()
  validator.setValidatorWorkerFactory(realWorkerFactory)
  const rule = {
    id: 'custom',
    pattern: 'BUG-(\\d+)',
    enabled: true,
    priority: 5,
    color: { fg: '#ff0000' }
  }
  // Written straight to the file: this is the "rules already on disk" path the
  // applier runs at startup.
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({ ...settingsStore.loadSettings(), highlightRules: [rule] }, null, 2),
    'utf8'
  )
  const stored = settingsStore.loadSettings()
  ok(stored.highlightRules[0].validation === undefined, 'a rule without a proof starts unproven')

  validator.validateSettingsRules(stored)
  const proved = await waitFor(() => {
    const reloaded = settingsStore.loadSettings()
    return reloaded.highlightRules[0].validation?.status === 'passed'
  }, 4000)
  const reloaded = settingsStore.loadSettings()
  const proof = reloaded.highlightRules[0].validation
  ok(proved, `the background pass writes a passed proof back to settings (${JSON.stringify(proof)})`)
  ok(proof?.pattern === rule.pattern, 'the proof names the exact pattern it was obtained for')
  ok(proof?.flags === 'g', `the proof carries the engine's flag string (${proof?.flags})`)
  ok(proof?.probeVersion === PROBE_VERSION, 'the proof carries the current probe version')
  ok(proof?.runtime === RUNTIME, `the proof carries the runtime it was measured in (${proof?.runtime})`)

  // Idempotence: a second pass over the same rules finds nothing to do, so the
  // write-back cannot loop through the settings broadcast.
  const before = readFileSync(join(userData, 'settings.json'), 'utf8')
  validator.validateSettingsRules(reloaded)
  await sleep(200)
  ok(readFileSync(join(userData, 'settings.json'), 'utf8') === before, 'a second pass over proved rules writes nothing')

  // A proof from another environment is not trusted: the store normalizes it to
  // pending, and the pass then re-proves it.
  const foreign = {
    ...reloaded,
    highlightRules: [{ ...rule, validation: { ...proof, runtime: 'other-app|other-electron|other-v8' } }]
  }
  writeFileSync(join(userData, 'settings.json'), JSON.stringify(foreign, null, 2), 'utf8')
  const normalized = settingsStore.loadSettings()
  ok(
    normalized.highlightRules[0].validation?.status === 'pending',
    `a proof from another build is normalized to pending (got ${normalized.highlightRules[0].validation?.status})`
  )
  validator.validateSettingsRules(normalized)
  const reproved = await waitFor(() => settingsStore.loadSettings().highlightRules[0].validation?.runtime === RUNTIME, 4000)
  ok(reproved, 'the pass re-proves a rule whose verdict no longer applies')

  // A hostile stored rule ends up quarantined, and stays that way: the stored
  // status settles the question, so a settings save does not re-run a 500ms
  // probe over and over.
  validator.setValidatorBudgets({ ruleBudgetMs: 150 })
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({ ...settingsStore.loadSettings(), highlightRules: [{ ...rule, pattern: '(a|a)+$' }] }, null, 2),
    'utf8'
  )
  const hostile = settingsStore.loadSettings()
  validator.validateSettingsRules(hostile)
  const quarantined = await waitFor(() => settingsStore.loadSettings().highlightRules[0].validation?.status === 'quarantined', 4000)
  ok(quarantined, 'a stored hostile rule is quarantined by the background pass')
  const state = validator.getRuleValidationState()
  ok(state.quarantined >= 1, `the aggregate state counts the quarantined rule (${state.quarantined})`)
  validator.validateSettingsRules(settingsStore.loadSettings())
  await sleep(200)
  ok(
    settingsStore.loadSettings().highlightRules[0].validation?.status === 'quarantined',
    'a quarantined rule is not re-probed on the next pass'
  )
}

validator.shutdownRuleValidator()
rmSync(userData, { recursive: true, force: true })

console.log(`\n[redos-validator] ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.error(`\n[redos-validator] ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('\n[redos-validator] ALL CHECKS PASSED')
