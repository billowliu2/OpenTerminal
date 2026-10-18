/**
 * Load-time admission for stored rules: the fail-closed gate the hot path
 * checks before a pattern may run, plus the shared flag spellings, the shape
 * cleaner for persisted proofs, the environment fingerprint a proof is scoped
 * to and the built-in whitelist factory.
 *
 * A rule runs when it holds a *passed* proof that matches its pattern, its
 * compile flags, the current probe version and the current runtime exactly — or
 * when it is a factory built-in on the whitelist (proven by the test suite,
 * shipped inside the app). Everything else is inert until the validator
 * re-proves it.
 *
 * Zero imports on purpose: `tests/rule-validation.mjs` loads this file
 * directly through Node's native type stripping, so nothing here may reach
 * out at runtime.
 */

/**
 * One rule's proof that it ran within budget on the probe corpus — in one
 * environment. The fingerprint fields are all part of the proof: a record is
 * only evidence for the exact pattern, flags, corpus and runtime it was
 * obtained in, which is why the gate compares every one of them instead of
 * trusting `status`.
 */
export interface RuleValidation {
  status: 'passed' | 'pending' | 'quarantined'
  /** the exact pattern the proof was obtained for */
  pattern: string
  /** the exact flag string the proof was obtained under */
  flags: string
  /** the probe version the proof was obtained against */
  probeVersion: number
  /** the runtime fingerprint the proof was obtained in (see `runtimeKeyOf`) */
  runtime: string
}

/** Longest pattern accepted anywhere (engine, store, editor) — one constant. */
export const MAX_PATTERN_LEN = 500

/** Every status a proof may carry. Anything else is a corrupt record. */
const STATUSES: readonly RuleValidation['status'][] = ['passed', 'pending', 'quarantined']

/** How a rule stands right now: the four states the UI and the gate speak in. */
export type RuleRunState = 'builtin' | 'passed' | 'pending' | 'quarantined'

/**
 * The version triple a proof is scoped to: the app build, the Electron build
 * and the V8 build. V8 is what actually runs the regex, so a new V8 (a new
 * Electron, i.e. a new app version) can change how a pattern behaves — a proof
 * measured on one engine says nothing about another. The probe corpus is
 * versioned separately (`PROBE_VERSION`): a corpus change invalidates proofs
 * without the engine having moved.
 */
export interface RuleRuntimeVersions {
  /** the app version (`app.getVersion()`) */
  app: string
  /** the Electron version (`process.versions.electron`) */
  electron: string
  /** the V8 version (`process.versions.v8`) — the engine the probes ran on */
  v8: string
}

/** Fingerprint of the environment a probe run happened in. */
export function runtimeKeyOf(versions: RuleRuntimeVersions): string {
  return `${versions.app}|${versions.electron}|${versions.v8}`
}

/**
 * The runtime this process accepts proofs for. Deliberately a module-level
 * value rather than a parameter threaded through every call site: the gate is
 * called from the highlight engine, the link-rule engine, the settings store
 * and the validator, and each of those would otherwise have to carry a value
 * none of them owns. The main process installs its own fingerprint at startup
 * (`main/ruleRuntime.ts`), the renderer installs the one it is handed over IPC
 * (`AppInfo.runtimeKey`), tests set one explicitly — same shape as the i18n
 * module's current language.
 *
 * The default is the empty string, which no proof carries, so an unset runtime
 * rejects every proof instead of accepting one from an unknown environment.
 */
let currentRuntime = ''

/** Install the fingerprint this process's proofs must match. */
export function setRuleRuntimeKey(key: string): void {
  currentRuntime = key
}

/** The installed fingerprint (`''` when nothing was installed yet). */
export function ruleRuntimeKey(): string {
  return currentRuntime
}

/**
 * Flags a highlight rule compiles with: `g`, plus `i` when case-insensitive
 * and `m` when line-anchored. The single spelling shared by the engine's
 * compile step and the whitelist — a rule proved under different flags than
 * it runs under is a rule that was never proved.
 */
export function highlightFlags(caseInsensitive?: boolean, lineAnchor?: boolean): string {
  return `g${caseInsensitive === true ? 'i' : ''}${lineAnchor === true ? 'm' : ''}`
}

/**
 * Flags a link rule compiles with: always plain `g`. Exported so
 * `compileLinkRules` compiles with the same string this module's gate compares
 * against — the gate is only meaningful while those two cannot drift apart.
 */
export const LINK_RULE_FLAGS = 'g'

/**
 * Identity of one rule for the gate: its exact source plus the exact flags.
 * Also the validator's dedupe key, so two rules that compile to the same thing
 * cost one probe run.
 */
export function ruleKeyOf(pattern: string, flags: string): string {
  return `${pattern}\u0000${flags}`
}

/**
 * Shape-clean one persisted proof. Load paths (settings store, link-rule
 * sanitizer) run every stored record through this instead of trusting the
 * field: a hand-edited `settings.json` or an imported file can carry anything
 * under `validation`, and a record with the wrong shape must not be carried
 * forward into the gate — the gate compares exact strings and would treat a
 * malformed record as "no proof" anyway, so keeping it would only mean a
 * corrupt object in memory and in the next save.
 *
 * Only the five known fields survive (extras are dropped), and `undefined`
 * means "no usable proof". This is a SHAPE check: whether the proof still
 * matches the pattern, the flags, the probe version and the runtime is the
 * gate's job (`validationAllows`), so a stale-but-well-formed record is kept as
 * evidence rather than silently erased. A record written before proofs carried
 * a runtime fingerprint has no `runtime` and is therefore not a usable proof —
 * it lands as `pending` and is re-proved, which is the point of the field.
 */
export function sanitizeRuleValidation(raw: unknown): RuleValidation | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const candidate = raw as Record<string, unknown>
  const { status, pattern, flags, probeVersion, runtime } = candidate
  if (typeof status !== 'string' || !STATUSES.includes(status as RuleValidation['status'])) return undefined
  if (typeof pattern !== 'string' || typeof flags !== 'string') return undefined
  if (typeof probeVersion !== 'number' || !Number.isFinite(probeVersion)) return undefined
  if (typeof runtime !== 'string' || runtime === '') return undefined
  return { status: status as RuleValidation['status'], pattern, flags, probeVersion, runtime }
}

/**
 * Factory for a built-in whitelist, keyed by pattern + flags. The rule list is
 * injected rather than imported so a caller derives the set from whatever
 * presets it actually ships — a preset that carries `lineAnchor` (or any flag
 * combination) is always covered, and this module stays zero-import.
 */
export function makeBuiltinWhitelist(
  rules: readonly { pattern: string; caseInsensitive?: boolean; lineAnchor?: boolean }[]
): ReadonlySet<string> {
  const out = new Set<string>()
  for (const rule of rules) {
    out.add(ruleKeyOf(rule.pattern, highlightFlags(rule.caseInsensitive, rule.lineAnchor)))
  }
  return out
}

/**
 * Whether a proof still describes the rule it is attached to, in THIS
 * environment. Every field is compared: the same pattern under other flags, a
 * proof from another corpus or from another engine is not the same proof.
 */
export function proofMatches(
  pattern: string,
  flags: string,
  validation: RuleValidation | undefined,
  expectedProbeVersion: number
): boolean {
  return (
    validation !== undefined &&
    validation.pattern === pattern &&
    validation.flags === flags &&
    validation.probeVersion === expectedProbeVersion &&
    validation.runtime === currentRuntime
  )
}

/**
 * Whether a rule may run on the hot path. Fail-closed: without a `passed`
 * proof that matches pattern, flags, probe version and runtime exactly the rule
 * does not run — except a hit on the built-in whitelist, which a caller may
 * supply (the highlight engine passes one; link rules pass none).
 */
export function validationAllows(
  pattern: string,
  flags: string,
  validation: RuleValidation | undefined,
  expectedProbeVersion: number,
  builtinWhitelist?: ReadonlySet<string>
): boolean {
  if (builtinWhitelist?.has(ruleKeyOf(pattern, flags))) return true
  return proofMatches(pattern, flags, validation, expectedProbeVersion) && validation?.status === 'passed'
}

/**
 * The rule's standing, derived rather than read off the record: a stored
 * `passed` whose pattern/flags/corpus/runtime no longer match is a pending
 * rule, whatever the field says. This is what the settings UI labels rows with,
 * so the label cannot disagree with what the engine will actually do.
 */
export function ruleRunState(
  pattern: string,
  flags: string,
  validation: RuleValidation | undefined,
  expectedProbeVersion: number,
  builtinWhitelist?: ReadonlySet<string>
): RuleRunState {
  if (builtinWhitelist?.has(ruleKeyOf(pattern, flags))) return 'builtin'
  if (!proofMatches(pattern, flags, validation, expectedProbeVersion)) return 'pending'
  return validation?.status === 'quarantined' ? 'quarantined' : validation?.status === 'passed' ? 'passed' : 'pending'
}

/**
 * Rewrite a proof that no longer applies to its rule into an explicit `pending`
 * record for the CURRENT environment. The main process runs this on every load
 * and every save (settings store), so a persisted `passed` from another app
 * build, another corpus or an edited pattern never reaches the renderer
 * claiming to be a verdict — the renderer would fail closed anyway, but the
 * file and the UI would both be lying about it.
 *
 * The rewritten record keeps the proof machinery intact (it is a well-formed
 * record for the rule as it now stands), which is what lets `needsRuleValidation`
 * see it as work to do rather than as corrupt data.
 */
export function normalizeRuleValidation(
  validation: RuleValidation | undefined,
  pattern: string,
  flags: string,
  expectedProbeVersion: number
): RuleValidation | undefined {
  if (validation === undefined) return undefined
  if (proofMatches(pattern, flags, validation, expectedProbeVersion)) return validation
  // Without an installed fingerprint there is no environment to normalize TO:
  // writing a `pending` record stamped with an empty runtime would only produce
  // a record the shape cleaner rejects as malformed on the next load. The gate
  // fails closed on the stale record anyway, so leaving it alone is both honest
  // and harmless.
  if (currentRuntime === '') return validation
  return { status: 'pending', pattern, flags, probeVersion: expectedProbeVersion, runtime: currentRuntime }
}

/**
 * Whether the validator should spend a probe run on this rule. True for a rule
 * with no proof, for one whose stored verdict is `pending`, and for one whose
 * proof belongs to another pattern/flags/corpus/runtime (the normalization
 * above turns those into `pending` too, but a caller holding a raw record gets
 * the same answer). `quarantined` and `passed` records that still match settle
 * the question: re-probing them would only repeat a run we already paid for.
 */
export function needsRuleValidation(
  pattern: string,
  flags: string,
  validation: RuleValidation | undefined,
  expectedProbeVersion: number
): boolean {
  if (!proofMatches(pattern, flags, validation, expectedProbeVersion)) return true
  return validation?.status === 'pending'
}
