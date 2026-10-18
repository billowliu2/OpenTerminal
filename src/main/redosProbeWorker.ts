/**
 * Probe worker (redosProbeWorker.ts).
 *
 * Runs one rule over the fixed synthetic corpus from `shared/redosProbes.ts`
 * and reports how long its worst probe took. Nothing else: no self-imposed
 * timeout, no access to settings, no electron import.
 *
 * The budget deliberately lives on the controlling side (`redosValidator.ts`),
 * not here. A catastrophic pattern blocks the regex engine inside a single
 * `exec` for seconds to minutes — a clock check inside this loop would never be
 * reached (measured: one `exec` of `(?:a|a)+$` on 26 characters blocks for
 * 7.5s), so the only way to stop it is to terminate the worker thread from
 * outside. This file's job is to be killable.
 *
 * What a clean reply does NOT mean: the corpus is a fixed set of shapes, not a
 * proof of safety. A pattern nobody thought of passes it — which is why the
 * verdict is reported as "passed the current probes" everywhere it surfaces.
 */
import { parentPort } from 'node:worker_threads'
import { PROBE_VERSION, REDOS_PROBES } from '../shared/redosProbes'

/** One rule to probe: the pattern plus the exact flags the engine runs it with. */
export interface ProbeRequest {
  id: number
  pattern: string
  flags: string
}

/** The worker's answer for one request. */
export type ProbeResponse =
  | {
      id: number
      ok: true
      probeVersion: number
      /** slowest single probe, in ms — the number the budget is compared against */
      worstMs: number
      /** whole corpus, in ms */
      totalMs: number
      probes: number
    }
  | {
      id: number
      ok: false
      probeVersion: number
      /** `invalid-regex` = it does not compile; `failed` = anything unexpected */
      reason: 'invalid-regex' | 'failed'
      ms: number
    }

/**
 * Match-loop step cap per probe, mirroring the corpus test's reference
 * implementation. A rule that matches on almost every index (`a*`, lookaheads)
 * would otherwise spend its whole budget walking positions, and a zero-width
 * match would spin forever on one index — stepping past it is the same guard
 * the reference loop uses.
 */
const MAX_STEPS = 20000

/**
 * Run the whole corpus against one rule. Mirrors the reference loop in
 * `tests/redos-probes.mjs`: fresh `lastIndex` per probe (the flags carry `g`),
 * a step past a zero-width match, and per-probe timing whose worst value is
 * what the caller's budget is compared against.
 */
function runCorpus(id: number, pattern: string, flags: string): ProbeResponse {
  let regex: RegExp
  try {
    regex = new RegExp(pattern, flags)
  } catch {
    return { id, ok: false, probeVersion: PROBE_VERSION, reason: 'invalid-regex', ms: 0 }
  }
  const started = performance.now()
  let worst = 0
  for (const probe of REDOS_PROBES) {
    regex.lastIndex = 0
    const probeStart = performance.now()
    let match: RegExpExecArray | null
    let steps = 0
    while ((match = regex.exec(probe.text)) !== null) {
      if (match[0] === '') regex.lastIndex = match.index + 1
      if (++steps > MAX_STEPS) break
    }
    const ms = performance.now() - probeStart
    if (ms > worst) worst = ms
  }
  return {
    id,
    ok: true,
    probeVersion: PROBE_VERSION,
    worstMs: worst,
    totalMs: performance.now() - started,
    probes: REDOS_PROBES.length
  }
}

/** Probe one request and answer it. Never throws: a reply always goes back. */
function handle(request: ProbeRequest): void {
  const port = parentPort
  if (!port) return
  let response: ProbeResponse
  try {
    response = runCorpus(request.id, request.pattern, request.flags)
  } catch {
    response = { id: request.id, ok: false, probeVersion: PROBE_VERSION, reason: 'failed', ms: 0 }
  }
  port.postMessage(response)
}

parentPort?.on('message', (message: ProbeRequest) => handle(message))
