/**
 * Rule-validation gate self-test (rule-validation.mjs).
 *
 * `src/shared/ruleValidation.ts` is the fail-closed front door: a stored pattern
 * runs only with a proof that matches it exactly, or as a factory built-in on
 * the whitelist. It is shared by the highlight engine and the link-rule engine,
 * so its decisions are pinned here rather than through either caller:
 *
 *   - the shape cleaner keeps exactly the four known fields and rejects
 *     everything else (a hand-edited settings.json can put anything under
 *     `validation`), while a stale-but-intact record survives it — staleness is
 *     the gate's business, not the cleaner's;
 *   - the flag spelling is the one both engines compile with, so a proof can
 *     never be compared against flags the rule does not run under;
 *   - the truth table is fail-closed in every direction: pending, quarantined,
 *     missing, expired probe version, edited pattern, edited flags;
 *   - the built-in whitelist is DERIVED from the shipped presets (no hand-copied
 *     pattern list) and exempts them without a proof, while a preset whose
 *     pattern or flags were edited loses the exemption;
 *   - link rules get no whitelist at all, and their gate runs inside
 *     `compileLinkRules` — the function the terminal's link provider calls.
 *
 * Direct .ts import (no esbuild bundle): ruleValidation.ts is zero-import and
 * linkRules.ts reaches for it through an explicit `.ts` specifier (Node's ESM
 * resolver does not try extensions). settings.ts has no runtime imports.
 * Run: node tests/rule-validation.mjs   (must exit 0)
 */
import {
  LINK_RULE_FLAGS,
  MAX_PATTERN_LEN,
  highlightFlags,
  makeBuiltinWhitelist,
  needsRuleValidation,
  normalizeRuleValidation,
  ruleKeyOf,
  ruleRunState,
  sanitizeRuleValidation,
  setRuleRuntimeKey,
  validationAllows
} from '../src/shared/ruleValidation.ts'
import { PROBE_VERSION } from '../src/shared/redosProbes.ts'
import { DEFAULT_HIGHLIGHT_RULES } from '../src/shared/settings.ts'
import { compileLinkRules, sanitizeLinkRules } from '../src/shared/linkRules.ts'

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}

/**
 * The environment the proofs in this file belong to. The main process installs
 * its own fingerprint at startup and the renderer is handed the same string
 * over IPC; here it is a literal, which also makes the runtime dimension
 * testable — a proof is only evidence for the environment it was measured in.
 */
const RUNTIME = 'test-app|test-electron|test-v8'
setRuleRuntimeKey(RUNTIME)

/** A well-formed proof for one pattern + flags. */
const proof = (pattern, flags = 'g', over = {}) => ({
  status: 'passed',
  pattern,
  flags,
  probeVersion: PROBE_VERSION,
  runtime: RUNTIME,
  ...over
})

// ---- 1. shape cleaner -------------------------------------------------------
console.log('[shape cleaner]')
{
  for (const status of ['passed', 'pending', 'quarantined']) {
    const raw = proof('a', 'g', { status })
    const out = sanitizeRuleValidation(raw)
    ok(out?.status === status, `a well-formed '${status}' record survives`)
  }

  {
    const raw = proof('a', 'g', { junk: 'x', nested: { deep: true } })
    const out = sanitizeRuleValidation(raw)
    ok(out !== undefined, 'a well-formed record with extra fields is kept')
    ok(
      JSON.stringify(Object.keys(out).sort()) === JSON.stringify(['flags', 'pattern', 'probeVersion', 'runtime', 'status']),
      `only the five known fields survive (${Object.keys(out).join(', ')})`
    )
    ok(out !== raw, 'the cleaner returns a fresh object rather than the input')
    ok(raw.junk === 'x', 'the cleaner does not mutate the input')
  }

  {
    // Staleness is not a shape problem: the record is kept and the GATE refuses
    // it. Erasing it here would lose the evidence a settings page wants to show.
    const stale = sanitizeRuleValidation(proof('a', 'g', { probeVersion: PROBE_VERSION - 1 }))
    ok(stale?.probeVersion === PROBE_VERSION - 1, 'a record from an older probe set is kept as-is')
  }

  const rejected = [
    ['undefined', undefined],
    ['null', null],
    ['a string', 'passed'],
    ['a number', 1],
    ['an array', []],
    ['an empty object', {}],
    ['a missing status', { pattern: 'a', flags: 'g', probeVersion: 1 }],
    ['an unknown status', proof('a', 'g', { status: 'trusted' })],
    ['a non-string pattern', proof(7, 'g')],
    ['a missing pattern', proof('a', 'g', { pattern: undefined })],
    ['a non-string flags', proof('a', 7)],
    ['a missing probeVersion', proof('a', 'g', { probeVersion: undefined })],
    ['a string probeVersion', proof('a', 'g', { probeVersion: '1' })],
    ['a NaN probeVersion', proof('a', 'g', { probeVersion: Number.NaN })],
    ['an infinite probeVersion', proof('a', 'g', { probeVersion: Number.POSITIVE_INFINITY })],
    // A record written before proofs carried a runtime cannot say which engine
    // measured it, so it is not evidence for any environment — the rule lands as
    // `pending` and is re-proved, which is the point of the field.
    ['a missing runtime', proof('a', 'g', { runtime: undefined })],
    ['an empty runtime', proof('a', 'g', { runtime: '' })],
    ['a non-string runtime', proof('a', 'g', { runtime: 7 })]
  ]
  for (const [label, value] of rejected) {
    ok(sanitizeRuleValidation(value) === undefined, `${label} is rejected`)
  }

  ok(MAX_PATTERN_LEN === 500, `the shared pattern bound is 500 (${MAX_PATTERN_LEN})`)
}

// ---- 2. flag spelling -------------------------------------------------------
console.log('[flags]')
{
  const cases = [
    ['no switches', undefined, undefined, 'g'],
    ['case-insensitive', true, undefined, 'gi'],
    ['line-anchored', undefined, true, 'gm'],
    ['both', true, true, 'gim'],
    ['a truthy non-boolean stays off', 1, 'yes', 'g']
  ]
  for (const [label, ci, la, want] of cases) {
    const got = highlightFlags(ci, la)
    ok(got === want, `${label} compiles as '${want}' (got '${got}')`)
  }

  ok(LINK_RULE_FLAGS === 'g', `link rules compile as plain 'g' (${LINK_RULE_FLAGS})`)
  {
    // The gate compares against this constant and `compileLinkRules` compiles
    // with it, so the two cannot drift apart into "proved under X, runs under Y".
    const [compiled] = compileLinkRules([
      { id: 'r', pattern: 'x', template: 'https://x', validation: proof('x', LINK_RULE_FLAGS) }
    ])
    ok(compiled?.regex.flags === LINK_RULE_FLAGS, `a compiled link regex uses exactly '${LINK_RULE_FLAGS}'`)
  }
}

// ---- 3. the gate ------------------------------------------------------------
console.log('[gate]')
{
  const cases = [
    ['no proof at all', 'ERROR', 'g', undefined, false],
    ['a matching passed proof', 'ERROR', 'g', proof('ERROR'), true],
    ['a pending proof', 'ERROR', 'g', proof('ERROR', 'g', { status: 'pending' }), false],
    ['a quarantined proof', 'ERROR', 'g', proof('ERROR', 'g', { status: 'quarantined' }), false],
    ['a proof for another pattern', 'ERROR', 'g', proof('WARNING'), false],
    ['a proof for another flag string', 'ERROR', 'gi', proof('ERROR', 'g'), false],
    ['a proof from an older probe set', 'ERROR', 'g', proof('ERROR', 'g', { probeVersion: PROBE_VERSION - 1 }), false],
    ['a proof from a newer probe set', 'ERROR', 'g', proof('ERROR', 'g', { probeVersion: PROBE_VERSION + 1 }), false],
    // The runtime is part of the proof: the same pattern measured on another V8
    // (another app build) says nothing about this one.
    ['a proof from another runtime', 'ERROR', 'g', proof('ERROR', 'g', { runtime: 'other|other|other' }), false],
    ['a proof for a prefixed pattern', 'ERROR', 'g', proof('^ERROR'), false]
  ]
  for (const [label, pattern, flags, validation, want] of cases) {
    const got = validationAllows(pattern, flags, validation, PROBE_VERSION)
    ok(got === want, `${label} → ${want} (got ${got})`)
  }

  // The engine passes a whitelist; link rules pass none. Everything above was
  // "no whitelist", so the empty-set case must behave identically.
  ok(
    !validationAllows('ERROR', 'g', undefined, PROBE_VERSION, new Set()),
    'an empty whitelist changes nothing'
  )

  // With no fingerprint installed there is no environment a proof could belong
  // to, so the gate refuses every one of them rather than accepting a verdict
  // from somewhere unknown.
  setRuleRuntimeKey('')
  ok(
    !validationAllows('ERROR', 'g', proof('ERROR'), PROBE_VERSION),
    'an uninstalled runtime refuses even a matching proof (fail-closed)'
  )
  setRuleRuntimeKey(RUNTIME)
}

// ---- 3b. run state, normalization and the work predicate --------------------
console.log('[run state]')
{
  const whitelist = makeBuiltinWhitelist(DEFAULT_HIGHLIGHT_RULES)
  const sample = DEFAULT_HIGHLIGHT_RULES[0]
  const sampleFlags = highlightFlags(sample.caseInsensitive, sample.lineAnchor)

  ok(
    ruleRunState(sample.pattern, sampleFlags, undefined, PROBE_VERSION, whitelist) === 'builtin',
    'a factory preset reads as built-in'
  )
  ok(ruleRunState('ERROR', 'g', proof('ERROR'), PROBE_VERSION) === 'passed', 'a matching passed proof reads as passed')
  ok(ruleRunState('ERROR', 'g', undefined, PROBE_VERSION) === 'pending', 'no proof reads as pending')
  ok(
    ruleRunState('ERROR', 'g', proof('ERROR', 'g', { status: 'pending' }), PROBE_VERSION) === 'pending',
    'a pending record reads as pending'
  )
  ok(
    ruleRunState('ERROR', 'g', proof('ERROR', 'g', { status: 'quarantined' }), PROBE_VERSION) === 'quarantined',
    'a quarantined record reads as quarantined'
  )
  ok(
    ruleRunState('WARNING', 'g', proof('ERROR', 'g', { status: 'quarantined' }), PROBE_VERSION) === 'pending',
    'a quarantined record for another pattern does not label this one'
  )
  ok(
    ruleRunState('ERROR', 'g', proof('ERROR', 'g', { status: 'quarantined', runtime: 'other' }), PROBE_VERSION) === 'pending',
    'a quarantine from another runtime reads as pending'
  )

  // Normalization: what the settings store runs on every load and save.
  ok(
    normalizeRuleValidation(proof('ERROR'), 'ERROR', 'g', PROBE_VERSION)?.status === 'passed',
    'a proof that still applies is kept untouched'
  )
  {
    const stale = normalizeRuleValidation(proof('ERROR'), 'ERROR', 'gi', PROBE_VERSION)
    ok(stale?.status === 'pending', 'a proof for other flags is rewritten to pending')
    ok(stale?.flags === 'gi' && stale?.pattern === 'ERROR', 'the rewritten record describes the rule as it stands')
    ok(stale?.runtime === RUNTIME && stale?.probeVersion === PROBE_VERSION, 'the rewritten record names the current environment')
    ok(
      sanitizeRuleValidation(stale) !== undefined,
      'the rewritten record is itself a well-formed record (not "corrupt data" on the next load)'
    )
  }
  ok(
    normalizeRuleValidation(proof('ERROR'), 'ERROR', 'g', PROBE_VERSION + 1)?.status === 'pending',
    'a proof from another probe set is rewritten to pending'
  )
  ok(
    normalizeRuleValidation(proof('ERROR', 'g', { runtime: 'other' }), 'ERROR', 'g', PROBE_VERSION)?.status === 'pending',
    'a proof from another runtime is rewritten to pending'
  )
  ok(normalizeRuleValidation(undefined, 'ERROR', 'g', PROBE_VERSION) === undefined, 'no proof stays no proof')
  {
    setRuleRuntimeKey('')
    const untouched = normalizeRuleValidation(proof('ERROR', 'g', { runtime: 'other' }), 'ERROR', 'g', PROBE_VERSION)
    ok(untouched?.runtime === 'other', 'without a fingerprint the record is left alone instead of being stamped with nothing')
    setRuleRuntimeKey(RUNTIME)
  }

  // The validator's work predicate: probe what has no verdict, never re-probe a
  // verdict that still applies (a write-back would otherwise loop through the
  // settings broadcast).
  ok(needsRuleValidation('ERROR', 'g', undefined, PROBE_VERSION), 'a rule with no proof needs validation')
  ok(needsRuleValidation('ERROR', 'g', proof('ERROR', 'g', { status: 'pending' }), PROBE_VERSION), 'a pending rule needs validation')
  ok(
    needsRuleValidation('ERROR', 'g', proof('ERROR', 'g', { runtime: 'other' }), PROBE_VERSION),
    'a rule whose verdict belongs to another runtime needs validation'
  )
  ok(!needsRuleValidation('ERROR', 'g', proof('ERROR'), PROBE_VERSION), 'a proved rule does not need validation')
  ok(
    !needsRuleValidation('ERROR', 'g', proof('ERROR', 'g', { status: 'quarantined' }), PROBE_VERSION),
    'a quarantined rule is not probed again on every settings change'
  )

  ok(ruleKeyOf('a', 'g') !== ruleKeyOf('a', 'gi'), 'the rule key separates flag strings')
  ok(ruleKeyOf('a', 'g') === ruleKeyOf('a', 'g'), 'the rule key is stable for the same rule')
}

// ---- 4. built-in whitelist --------------------------------------------------
console.log('[builtin whitelist]')
{
  const whitelist = makeBuiltinWhitelist(DEFAULT_HIGHLIGHT_RULES)
  ok(DEFAULT_HIGHLIGHT_RULES.length > 20, `the presets are the whitelist source (${DEFAULT_HIGHLIGHT_RULES.length} rules)`)
  ok(
    whitelist.size === DEFAULT_HIGHLIGHT_RULES.length,
    `every preset contributes its own key, none collide (${whitelist.size} keys)`
  )

  // Derived, not hand-copied: no preset may be missing, under its OWN flags.
  const missing = DEFAULT_HIGHLIGHT_RULES.filter(
    (rule) => !validationAllows(rule.pattern, highlightFlags(rule.caseInsensitive, rule.lineAnchor), undefined, PROBE_VERSION, whitelist)
  )
  ok(missing.length === 0, `every preset runs without a proof (missing: ${missing.map((r) => r.id).join(', ') || 'none'})`)

  // A preset is exempt because of the EXACT pattern + flags, so an edited copy
  // loses the exemption and has to earn a proof like any other rule.
  const sample = DEFAULT_HIGHLIGHT_RULES[0]
  ok(sample !== undefined, 'there is a preset to edit')
  ok(
    !validationAllows(sample.pattern, 'gi', undefined, PROBE_VERSION, whitelist) ||
      highlightFlags(sample.caseInsensitive, sample.lineAnchor) === 'gi',
    'a preset pattern under a DIFFERENT flag string is not exempt'
  )
  ok(
    !validationAllows(`${sample.pattern}x`, highlightFlags(sample.caseInsensitive, sample.lineAnchor), undefined, PROBE_VERSION, whitelist),
    'a preset pattern with an edited pattern is not exempt'
  )
  ok(
    !validationAllows('(a+)+$', 'g', undefined, PROBE_VERSION, whitelist),
    'a user pattern is not exempt just for looking like something'
  )
  ok(
    !validationAllows('', 'g', undefined, PROBE_VERSION, whitelist),
    'the empty pattern is never exempt'
  )

  // The exemption is about the pattern, not about the proof: a preset stays
  // runnable whatever state a stale record happens to be in.
  ok(
    validationAllows(sample.pattern, highlightFlags(sample.caseInsensitive, sample.lineAnchor), undefined, PROBE_VERSION + 5, whitelist),
    'a preset is exempt regardless of the probe version'
  )

  // ...and a user rule still needs its proof even when a whitelist is supplied.
  ok(
    validationAllows('BUG-\\d+', 'g', proof('BUG-\\d+'), PROBE_VERSION, whitelist),
    'a proven user rule runs alongside the whitelist'
  )
  ok(
    !validationAllows('BUG-\\d+', 'g', undefined, PROBE_VERSION, whitelist),
    'an unproven user rule does not run just because a whitelist exists'
  )
}

// ---- 5. link rules: gate, no whitelist --------------------------------------
console.log('[link gate]')
{
  const base = { id: 'r', pattern: 'BUG-(\\d+)', template: 'https://tracker/$1' }
  const compiled = (over) => compileLinkRules([{ ...base, ...over }])

  ok(compiled({}).length === 0, 'an unproven link rule is not compiled')
  ok(compiled({ validation: proof(base.pattern) }).length === 1, 'a proven link rule is compiled')
  ok(compiled({ validation: proof(base.pattern, 'g', { status: 'pending' }) }).length === 0, 'a pending link rule is not compiled')
  ok(compiled({ validation: proof(base.pattern, 'g', { status: 'quarantined' }) }).length === 0, 'a quarantined link rule is not compiled')
  ok(
    compiled({ validation: proof(base.pattern, 'g', { probeVersion: PROBE_VERSION - 1 }) }).length === 0,
    'a link proof from an older probe set does not compile'
  )
  ok(compiled({ validation: proof('BUG-\\d+') }).length === 0, 'a proof for an edited pattern does not compile')
  ok(compiled({ validation: proof(base.pattern, 'gi') }).length === 0, 'a proof under other flags does not compile')
  ok(compiled({ enabled: false, validation: proof(base.pattern) }).length === 0, 'a disabled rule stays off even with a proof')

  {
    // No built-in exemption on this side: nothing in a link rule ships with the
    // app, so a preset pattern pasted into a link rule is just another user
    // pattern and needs its own proof.
    const preset = DEFAULT_HIGHLIGHT_RULES.find((rule) => rule.id === 'ipv4')
    ok(preset !== undefined, 'the ipv4 preset is available for the paste test')
    const pasted = compileLinkRules([{ id: 'p', pattern: preset.pattern, template: 'https://x/$0' }])
    ok(pasted.length === 0, 'a link rule reusing a preset pattern is not exempt')
    const proved = compileLinkRules([{ id: 'p', pattern: preset.pattern, template: 'https://x/$0', validation: proof(preset.pattern) }])
    ok(proved.length === 1, 'the same link rule compiles once it holds its own proof')
  }

  {
    // Rule order is what decides which rule claims a span first, so the gate may
    // only remove rules, never reorder the survivors.
    const rules = [
      { id: 'a', pattern: 'A', template: 'https://a', validation: proof('A') },
      { id: 'b', pattern: 'B', template: 'https://b' },
      { id: 'c', pattern: 'C', template: 'https://c', validation: proof('C') }
    ]
    const out = compileLinkRules(rules)
    ok(
      out.map((r) => r.id).join(',') === 'a,c',
      `the gate filters without reordering (got ${out.map((r) => r.id).join(',')})`
    )
  }

  ok(compileLinkRules(undefined).length === 0, 'an absent list still compiles to nothing')
}

// ---- 6. the link load path keeps the proof's shape --------------------------
console.log('[link sanitize]')
{
  const raw = (over) => ({ id: 'r1', pattern: 'BUG-(\\d+)', template: 'https://x/$1', ...over })

  {
    const out = sanitizeLinkRules([raw({ validation: proof('BUG-(\\d+)', 'g', { junk: 1 }) })])
    ok(out.length === 1, 'a rule with a proof survives the sanitizer')
    ok(out[0].validation !== undefined, 'a well-formed proof is kept')
    ok(out[0].validation.junk === undefined, 'extra fields are dropped from the proof')
  }

  {
    const warnings = []
    const out = sanitizeLinkRules([raw({ validation: { status: 'nonsense' } })], (m) => warnings.push(m))
    ok(out.length === 1, 'a malformed proof does not cost the user the rule')
    ok(out[0].validation === undefined, 'a malformed proof is dropped')
    ok(
      warnings.some((m) => m.includes('validation')),
      `the drop is reported to the caller (${warnings.join(' | ') || 'no warning'})`
    )
  }

  {
    const out = sanitizeLinkRules([raw()])
    ok(out[0].validation === undefined, 'a rule without a proof stays without one (not defaulted to passed)')
  }

  {
    // End to end through the load path: sanitize keeps the proof, the gate then
    // accepts it — the two must not disagree about the flag string.
    const loaded = sanitizeLinkRules([raw({ validation: proof('BUG-(\\d+)', LINK_RULE_FLAGS) })])
    ok(compileLinkRules(loaded).length === 1, 'a sanitized proven rule still compiles')
  }
}

if (failed > 0) {
  console.error(`\n[rule-validation] ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('\n[rule-validation] ALL CHECKS PASSED')
