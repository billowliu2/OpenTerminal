import type { HighlightProfile, HighlightRule } from './settings'

/**
 * Per-host highlight profiles.
 *
 * A profile is a named subset of the rule list, and an SSH connection can be
 * bound to one so a production host runs a quieter set than a local shell. The
 * master switch (`terminal.highlightPerHost`) decides whether any of this is
 * consulted: with it off, `rulesForProfile` is never called and every session
 * runs the full set exactly as before.
 */

/**
 * Validate a profile list coming from disk. Ids and names are required, rule
 * references that no longer exist are dropped (deleting a rule must not leave a
 * profile pointing at nothing), and duplicate ids are refused because the UI
 * keys rows by them.
 */
export function sanitizeProfiles(
  value: unknown,
  knownRuleIds: Set<string>,
  warn: (message: string) => void
): HighlightProfile[] {
  if (!Array.isArray(value)) return []
  const profiles: HighlightProfile[] = []
  const seen = new Set<string>()
  value.forEach((entry, index) => {
    if (entry === null || typeof entry !== 'object') {
      warn(`highlightProfiles[${index}]: not an object — skipped`)
      return
    }
    const raw = entry as Record<string, unknown>
    if (typeof raw.id !== 'string' || raw.id === '' || typeof raw.name !== 'string') {
      warn(`highlightProfiles[${index}]: missing id/name — skipped`)
      return
    }
    if (seen.has(raw.id)) {
      warn(`highlightProfiles[${index}]: duplicate id — skipped`)
      return
    }
    seen.add(raw.id)

    const ruleIds: string[] = []
    if (Array.isArray(raw.ruleIds)) {
      for (const id of raw.ruleIds) {
        if (typeof id !== 'string') continue
        if (!knownRuleIds.has(id)) {
          warn(`highlightProfiles[${index}]: unknown rule "${id}" dropped`)
          continue
        }
        if (!ruleIds.includes(id)) ruleIds.push(id)
      }
    }
    profiles.push({ id: raw.id, name: raw.name, ruleIds })
  })
  return profiles
}

/**
 * The rules a session runs: the bound profile's subset, or everything when no
 * profile is bound, the profile is gone, or it selects nothing.
 */
export function rulesForProfile(
  rules: HighlightRule[],
  profileId: string | undefined,
  profiles: HighlightProfile[]
): HighlightRule[] {
  if (profileId === undefined) return rules
  const profile = profiles.find((candidate) => candidate.id === profileId)
  if (profile === undefined || profile.ruleIds.length === 0) return rules
  const wanted = new Set(profile.ruleIds)
  return rules.filter((rule) => wanted.has(rule.id))
}

/** Rules a profile leaves out — shown as a hint in the editor. */
export function excludedByProfile(
  rules: HighlightRule[],
  profile: HighlightProfile | undefined
): HighlightRule[] {
  if (profile === undefined) return []
  const wanted = new Set(profile.ruleIds)
  return rules.filter((rule) => !wanted.has(rule.id))
}
