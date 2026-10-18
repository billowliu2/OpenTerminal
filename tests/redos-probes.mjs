/**
 * ReDoS probe corpus self-test (redos-probes.mjs).
 *
 * `src/shared/redosProbes.ts` is the corpus a stored rule is executed against
 * before it may run in the terminal. It is data, so the test has to prove the
 * data does its job:
 *
 *   - the set is versioned, bounded (every probe ≤ the engine's 4KB line limit,
 *     no more than the plan's ~24 entries) and synthetic — printable ASCII with
 *     a handful of distinct characters, so nothing here can be recorded
 *     terminal output or user data;
 *   - all five backtracking families are present with several fillers, because
 *     a pattern can be immune to one filler and helpless against the next;
 *   - every shipped preset and ordinary user rule stays FAR inside the budget
 *     on the whole corpus (a corpus that false-fails a preset would disable a
 *     built-in rule for every user);
 *   - the shapes measured as catastrophic in the plan — including the four the
 *     static heuristic missed — do NOT finish inside the budget. Those run in a
 *     child process with a hard timeout: a single `exec` on a hostile pattern
 *     blocks for seconds to minutes and cannot be interrupted from inside, so
 *     running them in-process would hang the suite instead of failing it.
 *
 * Direct .ts import (no esbuild bundle): redosProbes.ts and settings.ts have no
 * runtime imports, and Node >= 22.18 strips types itself.
 * Run: node tests/redos-probes.mjs   (must exit 0; takes a few seconds)
 */
import { spawnSync } from 'node:child_process'
import { PROBE_BUDGET_MS, PROBE_MAX_LEN, PROBE_VERSION, REDOS_PROBES } from '../src/shared/redosProbes.ts'
import { DEFAULT_HIGHLIGHT_RULES } from '../src/shared/settings.ts'

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}

const SHAPES = ['repeat', 'failing-terminator', 'alternation', 'overlap-class', 'literal-prefix']

// ---- 1. the corpus itself ---------------------------------------------------
console.log('[corpus]')
{
  ok(Number.isInteger(PROBE_VERSION) && PROBE_VERSION >= 1, `PROBE_VERSION is a positive integer (${PROBE_VERSION})`)
  ok(PROBE_BUDGET_MS === 500, `the single-rule budget is the planned 500ms (${PROBE_BUDGET_MS})`)
  ok(PROBE_MAX_LEN === 4096, `the input cap is the engine's 4KB line limit (${PROBE_MAX_LEN})`)
  ok(Array.isArray(REDOS_PROBES) && REDOS_PROBES.length > 0, `the corpus is a non-empty array (${REDOS_PROBES.length})`)
  ok(REDOS_PROBES.length <= 24, `the corpus stays within the plan's ~24-probe budget (${REDOS_PROBES.length})`)

  const overCap = REDOS_PROBES.filter((p) => p.text.length > PROBE_MAX_LEN)
  ok(overCap.length === 0, `no probe exceeds the cap (${overCap.map((p) => p.text.length).join(', ') || 'none'})`)
  const atCap = REDOS_PROBES.filter((p) => p.text.length === PROBE_MAX_LEN).length
  ok(atCap >= 3, `several probes run at the cap, so a hostile shape cannot finish early (${atCap} at ${PROBE_MAX_LEN})`)
  const short = REDOS_PROBES.filter((p) => p.text.length < 1024)
  ok(short.length === 0, `every probe is long enough to expose exponential growth (${short.length} under 1KB)`)

  // Synthetic, not recorded: printable ASCII plus a tab head, with a single LF
  // allowed only as the FINAL character (the `.`-family probe). No ESC, no CR,
  // no non-ASCII — nothing here could be recorded terminal output.
  const noisy = REDOS_PROBES.filter((p) => !/^[\x20-\x7e\t]*\n?$/.test(p.text))
  ok(noisy.length === 0, `every probe is printable ASCII with at most a trailing LF (${noisy.length} offending)`)
  const wide = REDOS_PROBES.filter((p) => new Set(p.text).size > 8)
  ok(wide.length === 0, `no probe carries a rich character mix (max ${Math.max(...REDOS_PROBES.map((p) => new Set(p.text).size))} distinct)`)

  const texts = REDOS_PROBES.map((p) => p.text)
  ok(new Set(texts).size === texts.length, 'no probe text is repeated')

  const present = new Set(REDOS_PROBES.map((p) => p.shape))
  for (const shape of SHAPES) {
    const n = REDOS_PROBES.filter((p) => p.shape === shape).length
    ok(n >= 2, `the ${shape} family is covered by several variants (${n})`)
  }
  ok(present.size === SHAPES.length, `no probe uses an unknown shape (${[...present].join(', ')})`)

  // The measured `[(](a+)+$` regression only backtracks when the input actually
  // contains the literal `(`: without it the pattern fails at offset 0 and looks
  // perfectly healthy. The corpus has to carry that head.
  const literalHeads = REDOS_PROBES.filter((p) => p.shape === 'literal-prefix' && p.text.startsWith('('))
  ok(literalHeads.length > 0, 'a literal-prefix probe starts with `(`, so `[(](a+)+$` can backtrack')
}

// ---- 2. legitimate rules stay far inside the budget -------------------------
console.log('[legit rules]')

/** Worst single-probe time for one rule over the whole corpus, in ms. Mirrors
 *  what the future worker does: fresh lastIndex per probe, and a step past a
 *  zero-width match so an `a*`-style rule cannot spin on one index forever. */
const corpusCost = (pattern, flags = 'g') => {
  const re = new RegExp(pattern, flags)
  let worst = 0
  for (const probe of REDOS_PROBES) {
    re.lastIndex = 0
    const start = performance.now()
    let match
    let steps = 0
    while ((match = re.exec(probe.text)) !== null) {
      if (match[0] === '') re.lastIndex = match.index + 1
      if (++steps > 20000) break
    }
    const ms = performance.now() - start
    if (ms > worst) worst = ms
  }
  return worst
}

{
  const flagOf = (rule) => `g${rule.caseInsensitive ? 'i' : ''}${rule.lineAnchor ? 'm' : ''}`
  const slowPresets = DEFAULT_HIGHLIGHT_RULES.filter((rule) => corpusCost(rule.pattern, flagOf(rule)) >= PROBE_BUDGET_MS)
  ok(
    slowPresets.length === 0,
    `no shipped preset would be quarantined by the corpus (${slowPresets.map((r) => r.id).join(', ') || 'none'})`
  )

  // A practical margin on top of the hard budget: the presets are plain keyword
  // patterns, so a probe that made one of them take anywhere near the budget
  // would mean the corpus itself is wrong, not the rule.
  const PRACTICAL_MS = 50
  const worst = DEFAULT_HIGHLIGHT_RULES.map((rule) => [rule.id, corpusCost(rule.pattern, flagOf(rule))])
  const over = worst.filter(([, ms]) => ms >= PRACTICAL_MS)
  ok(
    over.length === 0,
    `every preset stays far under the budget (worst: ${Math.max(...worst.map(([, ms]) => ms)).toFixed(2)}ms < ${PRACTICAL_MS}ms)`
  )

  // Ordinary user rules — the shapes the editor invites — are just as cheap.
  const userPatterns = [
    '\\b(?:ERROR|FAILED)\\b',
    '\\d+%',
    '(?<!not\\s)\\b(?:SUCCESS|PASS|OK)\\b',
    'BUG-(\\d+)',
    'https?://\\S+',
    '\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b',
    '^ERROR$',
    '(?<=^|\\s)[-dlbcps][rwxstST-]{9}(?![rwxstST-])',
    '[A-Z][a-z]+\\s+\\d{4}-\\d{2}-\\d{2}'
  ]
  const slowUser = userPatterns.filter((p) => corpusCost(p) >= PROBE_BUDGET_MS)
  ok(slowUser.length === 0, `no ordinary user pattern is quarantined (${slowUser.join(' | ') || 'none'})`)
}

// ---- 3. measured catastrophic shapes do not finish in budget ---------------
console.log('[hostile shapes]')

/** Hard timeout for a child that runs one pattern over the corpus. Long enough
 *  that node startup plus a full corpus scan fits (see the control below), short
 *  enough that several of them do not dominate the suite. */
const CHILD_TIMEOUT_MS = 800
const CORPUS_URL = new URL('../src/shared/redosProbes.ts', import.meta.url).href

/** Run one pattern over the real corpus in a child process. Returns true when
 *  the child finished on its own; false when it had to be killed. */
const finishes = (pattern) => {
  const code = `
    const { REDOS_PROBES } = await import(${JSON.stringify(CORPUS_URL)})
    const re = new RegExp(${JSON.stringify(pattern)}, 'g')
    for (const probe of REDOS_PROBES) {
      re.lastIndex = 0
      let match
      while ((match = re.exec(probe.text)) !== null) {
        if (match[0] === '') re.lastIndex = match.index + 1
      }
    }
    console.log('finished')
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS
  })
  return { finished: child.status === 0 && (child.stdout ?? '').includes('finished'), killed: child.error?.code === 'ETIMEDOUT' }
}

{
  // Control: a cheap pattern must complete inside the same timeout, otherwise a
  // killed child would prove nothing about the pattern. It also exercises the
  // child's whole path (startup, .ts import, corpus scan).
  const started = performance.now()
  const control = finishes('a')
  const controlMs = performance.now() - started
  ok(
    control.finished,
    `the control child scans the whole corpus (${controlMs.toFixed(0)}ms of ${CHILD_TIMEOUT_MS}ms, killed=${control.killed})`
  )
  ok(
    controlMs < CHILD_TIMEOUT_MS * 0.6,
    `the control leaves headroom, so a killed child means the pattern, not the machine (${controlMs.toFixed(0)}ms)`
  )

  // `(a+)+$` is the classic. The rest include the plan's static-heuristic misses
  // that DO reproduce here (`[(](a+)+$`, `(?:a|a)+$`, `((a|a))+$`), plus the
  // `(`-star families that need a line-terminator tail (`(.+)+$`, `(.*)*$`) and
  // an inner quantifier that can match empty (`(a*)*b`). All of them compile
  // instantly and then block for seconds on a few dozen characters, so no length
  // or time guard downstream can help.
  //
  // The plan's fourth miss, `(\w|\d)+$`, is NOT asserted: it finishes in well
  // under a millisecond on this V8 (see the note in redosProbes.ts), so the
  // corpus correctly does not quarantine it. The probe set is judged by
  // measurement, not by a table of supposedly-dangerous shapes.
  const dangerous = ['(a+)+$', '[(](a+)+$', '(?:a|a)+$', '((a|a))+$', '([a-z]+)*$', '(a*)*b', '(.+)+$', '(.*)*$']
  for (const pattern of dangerous) {
    const { finished, killed } = finishes(pattern)
    ok(
      !finished && killed,
      `the corpus blows the budget on ${pattern} (finished=${finished} killed=${killed})`
    )
  }
}

if (failed > 0) {
  console.error(`\n[redos-probes] ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('\n[redos-probes] ALL CHECKS PASSED')
