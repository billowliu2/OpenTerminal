/**
 * ReDoS probe corpus: inputs built to punish a pattern that backtracks
 * catastrophically. A stored rule carries a validation proof saying it ran
 * through every one of these inside the budget; the proof's `probeVersion` is
 * this module's `PROBE_VERSION`, so an app upgrade that revises the corpus
 * invalidates every proof written against the old one.
 *
 * Zero imports on purpose: the probe set is data the test loads directly
 * (Node's native type stripping), and the later-step executor (a budgeted
 * Worker) bundles the same array — neither needs this module to reach out.
 *
 * What the corpus is NOT: it is not a regex parser and not a proof of safety.
 * Nothing here reads a pattern, so a hostile shape nobody thought of passes —
 * that is why the plan calls the result "passed the current probes", never
 * "safe". The corpus only has to be hostile enough that the shapes we have
 * *measured* as catastrophic blow their budget on it, while the shipped
 * presets and ordinary rules stay far inside theirs.
 */

/** Bump whenever the probe set below changes shape or content. */
export const PROBE_VERSION = 1

/** Wall budget (ms) a rule gets against every probe before it is failed. */
export const PROBE_BUDGET_MS = 500

/** Longest probe input a rule is ever executed against. */
export const PROBE_MAX_LEN = 4096

export interface RedosProbe {
  /** Which backtracking family the probe is built to hit. */
  shape: 'repeat' | 'failing-terminator' | 'alternation' | 'overlap-class' | 'literal-prefix'
  /** The input handed to the rule's exec loop. */
  text: string
}

/**
 * Filler run helper. Probes are written at (or one character below) the length
 * cap on purpose: the cost of a catastrophic shape grows exponentially with the
 * input, so a corpus of short samples would let a hostile rule finish and look
 * healthy. 4096 is also the engine's `MAX_LINE_LEN` — the longest line that can
 * ever reach a user regex — so nothing here exceeds what a terminal could
 * legitimately deliver.
 */
const CAP = PROBE_MAX_LEN
const run = (char: string, length: number = CAP): string => char.repeat(length)

/**
 * The corpus. Five families, each with several variants because a pattern can
 * be immune to one filler and helpless against the next (`\d+`-based rules do
 * not care about a run of `a`, `[a-z]+`-based ones do not care about digits):
 *
 *   - `repeat` — one long run, the `(a+)+` / `(.*)*` family: the inner
 *     quantifier splits the run in exponentially many ways once a later part of
 *     the pattern fails.
 *   - `failing-terminator` — a long run plus a tail that defeats a required
 *     `$` / literal suffix. This is the family that catches the shapes the
 *     static heuristic missed (`(?:a|a)+$`, `((a|a))+$`): without a failing
 *     tail a greedy match succeeds on the first try and never backtracks. The
 *     digit-run variant is what punishes a `(\w|\d)+$`-shaped rule wherever
 *     that shape is actually slow.
 *   - `alternation` — interleaved characters (`abab…`) so branches of a
 *     `(?:a|ab)+`-style pattern overlap at every step.
 *   - `overlap-class` — `aab` / `aaab` / `a1_` runs, where the character
 *     classes a branch uses (`\w` vs `\d`, `[a-z]` vs `[a-z]+`) overlap.
 *   - `literal-prefix` — a known literal head (`(`, `[`, `/`, tab, `error `,
 *     `http://`) in front of the run, so a pattern that requires that literal
 *     still gets to the exponential part instead of failing at offset 0. The
 *     `(` head is the measured `[(](a+)+$` regression: without a literal `(`
 *     in the input the pattern never matches anything and never backtracks.
 *
 * Every text is synthetic, deterministic and carries no terminal content — no
 * recorded output, no user data, no randomness. The one non-printable character
 * allowed is a single trailing LF (see the `.`-family probe): it is the only
 * way to make a pattern whose body is `.` fail at the end of the input.
 *
 * A note on what "hostile" means here: the corpus is judged by measurement on
 * the engine that actually runs it, not by shape. `(\w|\d)+$`, one of the four
 * shapes the static heuristic missed, turns out to be FAST on V8 12.4 (a 4KB
 * digit run finishes in well under a millisecond — the engine appears to merge
 * the two single-character alternatives), while `([a-z]+)*$` and `(a|a)+$` grow
 * exponentially on the same engine. The digit-run probe below stays in the
 * corpus so the shape is punished wherever it is slow; nothing here claims a
 * shape is dangerous just because a table says so.
 */
export const REDOS_PROBES: readonly RedosProbe[] = [
  // --- repeat: one long run ------------------------------------------------
  { shape: 'repeat', text: run('a') },
  { shape: 'repeat', text: run('A') },
  { shape: 'repeat', text: run('0') },
  { shape: 'repeat', text: run(' ') },

  // --- failing-terminator: a run a required suffix cannot accept -----------
  { shape: 'failing-terminator', text: run('a', CAP - 1) + 'b' },
  { shape: 'failing-terminator', text: run('a', CAP - 1) + '!' },
  { shape: 'failing-terminator', text: run('1', CAP - 1) + 'x' },
  // `.` cannot cross a line terminator, so a trailing LF is the only tail that
  // makes a `.`-based shape fail: `(.+)+$` and `(.*)*$` match a whole `a` run
  // instantly and only backtrack when this probe denies them the end of input.
  { shape: 'failing-terminator', text: run('a', CAP - 1) + '\n' },
  { shape: 'failing-terminator', text: run('a', CAP / 2) + 'b' + run('a', CAP / 2 - 1) },

  // --- alternation: interleaved characters ---------------------------------
  { shape: 'alternation', text: 'ab'.repeat(CAP / 2) },
  { shape: 'alternation', text: 'ab'.repeat(CAP / 2 - 1) + 'a' },
  { shape: 'alternation', text: 'aba'.repeat(1365) },
  { shape: 'alternation', text: 'a1'.repeat(CAP / 2) },

  // --- overlap-class: characters two branches both accept ------------------
  { shape: 'overlap-class', text: 'aab'.repeat(1365) },
  { shape: 'overlap-class', text: 'aaab'.repeat(1024) },
  { shape: 'overlap-class', text: 'a1_'.repeat(1365) },
  { shape: 'overlap-class', text: 'aaa'.repeat(1365) },

  // --- literal-prefix: a known head in front of the run --------------------
  { shape: 'literal-prefix', text: '(' + run('a', CAP - 2) + 'b' },
  { shape: 'literal-prefix', text: '(' + run('a', CAP - 1) },
  { shape: 'literal-prefix', text: '[' + run('a', CAP - 1) },
  { shape: 'literal-prefix', text: '/' + run('a', CAP - 1) },
  { shape: 'literal-prefix', text: '\t' + run('a', CAP - 1) },
  { shape: 'literal-prefix', text: 'error '.repeat(400) + 'x' },
  { shape: 'literal-prefix', text: 'http://' + run('a', CAP - 7) }
]
