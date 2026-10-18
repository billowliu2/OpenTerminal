import { useEffect, useRef, useState } from 'react'
import type { RuleValidationKind } from '@shared/ipc'
import { LINK_RULE_FLAGS, highlightFlags, type RuleRunState, type RuleValidation } from '@shared/ruleValidation'

/**
 * Debounced probe of a rule DRAFT (ruleProbe.ts).
 *
 * The editor cannot decide on its own whether a pattern is safe to run: the
 * verdict comes from the main process's probe worker, and running the draft in
 * the renderer to find out is exactly what the gate exists to prevent. So the
 * editor asks, debounced while the user types, and until the answer is `passed`
 * the draft is not executed — no preview, no hot path.
 *
 * Two details that matter more than they look:
 *   - every request carries a sequence number, and a reply whose sequence is no
 *     longer current is dropped. Without it a slow probe of an abandoned draft
 *     would overwrite the verdict for the pattern actually on screen, which is
 *     the one failure mode that could get a hostile pattern previewed.
 *   - `enabled: false` (dialog closed, empty or uncompilable pattern) resets the
 *     state instead of probing: there is nothing to run, and a probe run costs a
 *     worker slot.
 */
const DEBOUNCE_MS = 400

export interface DraftProbe {
  state: 'idle' | 'probing' | RuleRunState
  /** slowest probe in ms, when a run completed */
  ms?: number
  /**
   * A proof the draft may be previewed with — present only when the probe
   * passed. It is never stored: the durable proof is written by the main
   * process when the rule itself is saved.
   */
  validation?: RuleValidation
}

export interface DraftProbeInput {
  kind: RuleValidationKind
  /** the pattern as it would be saved (trimmed) */
  pattern: string
  caseInsensitive?: boolean
  lineAnchor?: boolean
  /** false while the draft cannot run at all (closed dialog, invalid regex) */
  enabled: boolean
}

export function useRuleProbe(input: DraftProbeInput): DraftProbe {
  const { kind, pattern, caseInsensitive, lineAnchor, enabled } = input
  const [probe, setProbe] = useState<DraftProbe>({ state: 'idle' })
  const sequence = useRef(0)

  useEffect(() => {
    const mine = ++sequence.current
    if (!enabled) {
      setProbe({ state: 'idle' })
      return
    }
    setProbe({ state: 'probing' })
    const timer = window.setTimeout(() => {
      const api = window.api
      if (api?.validateRules === undefined) {
        setProbe({ state: 'pending' })
        return
      }
      const flags = kind === 'link' ? LINK_RULE_FLAGS : highlightFlags(caseInsensitive, lineAnchor)
      void api
        .validateRules({ kind, items: [{ id: 'draft', pattern, caseInsensitive, lineAnchor }] })
        .then((report) => {
          if (mine !== sequence.current) return
          const outcome = report.results[0]
          const state: DraftProbe['state'] = outcome?.state ?? 'pending'
          setProbe({
            state,
            ...(outcome?.ms !== undefined ? { ms: outcome.ms } : {}),
            // Only a `passed` verdict earns a proof. A `builtin` verdict is
            // exempt from probing, so there is no measurement to cite — it runs
            // because the engines' whitelist recognizes the pattern+flags, which
            // is why the caller shows it as 内置规则 instead of a fresh pass.
            ...(state === 'passed'
              ? {
                  validation: {
                    status: 'passed' as const,
                    pattern,
                    flags,
                    probeVersion: report.probeVersion,
                    runtime: report.runtime
                  }
                }
              : {})
          })
        })
        .catch(() => {
          if (mine === sequence.current) setProbe({ state: 'pending' })
        })
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [kind, pattern, caseInsensitive, lineAnchor, enabled])

  return probe
}
