/**
 * The main process's runtime fingerprint (ruleRuntime.ts).
 *
 * A rule-validation proof is only evidence for the environment it was measured
 * in (`shared/ruleValidation.ts`), so the main process has to be able to name
 * that environment: this is the one place that reads the app, Electron and V8
 * versions and turns them into the key every proof must carry. The renderer
 * gets the same string over IPC (`AppInfo.runtimeKey`) instead of guessing at
 * it, so both processes compare against one value rather than two that could
 * drift.
 *
 * `installRuleRuntime` must run before anything reads or writes settings: the
 * store normalizes stored proofs against this fingerprint on every load, and a
 * normalization that ran with no fingerprint installed would rewrite every
 * proof to `pending`.
 */
import { app } from 'electron'
import { runtimeKeyOf, setRuleRuntimeKey } from '../shared/ruleValidation'

/** The fingerprint of the running build. */
export function currentRuntimeKey(): string {
  return runtimeKeyOf({
    app: app.getVersion(),
    electron: process.versions.electron ?? '',
    v8: process.versions.v8 ?? ''
  })
}

/** Install the fingerprint and hand it back (startup wiring, tests). */
export function installRuleRuntime(): string {
  const key = currentRuntimeKey()
  setRuleRuntimeKey(key)
  return key
}
