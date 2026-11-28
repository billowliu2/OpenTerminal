/**
 * Highlight preview legibility gate.
 *
 * The settings page paints each rule's sample text with the rule's own
 * colour, on the settings dialog's surface — NOT on the terminal canvas the
 * colour was chosen for. On a light theme the shipped rule colours land at
 * 1.4–3.2:1 there and the sample text is unreadable; the terminal hides the
 * same mismatch behind xterm's minimum-contrast floor, the settings page has
 * no such repair.
 *
 * The page therefore repairs the colour itself (ensureContrast) before
 * painting it. This gate locks that repair: for every shipped theme and every
 * shipped rule colour (rule colour + value bands), the repaired colour must
 * clear 4.5:1 against the panel background.
 *
 * Imports zero-import modules directly (Node >= 22.18 type stripping).
 * Run: node tests/highlight-preview-contrast.mjs  (must exit 0)
 */
import { BUILTIN_THEMES } from '../src/shared/theme.ts'
import { DEFAULT_HIGHLIGHT_RULES } from '../src/shared/settings.ts'
import {
  contrast,
  ensureContrast,
  lightenToRatio,
  mix
} from '../src/renderer/src/theme/semantic.ts'

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}

/** The settings dialog surface: antd's colorBgElevated for the active theme. */
const panelBackground = (theme) =>
  mix(theme.colors.background, theme.colors.foreground, 0.1) ?? theme.colors.background

console.log('ensureContrast leaves an already legible colour alone:')
for (const [fg, bg] of [
  ['#3fb950', '#1e1e1e'],
  ['#000000', '#ffffff'],
  ['#ffffff', '#000000']
]) {
  ok(ensureContrast(fg, bg, 4.5) === fg, `${fg} on ${bg} unchanged`)
}

console.log('ensureContrast survives a malformed colour:')
ok(ensureContrast('not-a-color', '#1e1e1e', 4.5) === 'not-a-color', 'malformed fg returned as-is')
ok(ensureContrast('#3fb950', 'not-a-color', 4.5) === '#3fb950', 'malformed bg returned as-is')

console.log('lightenToRatio lifts a colour off a dark surface:')
ok(contrast('#123456', '#3d3f49') < 4.5, 'precondition: #123456 on #3d3f49 is illegible')
ok(contrast(lightenToRatio('#123456', '#3d3f49', 4.5), '#3d3f49') >= 4.5, 'lifted colour is legible')

console.log('every shipped rule colour is legible on every shipped theme:')
for (const theme of BUILTIN_THEMES) {
  const bg = panelBackground(theme)
  for (const rule of DEFAULT_HIGHLIGHT_RULES) {
    const colours = [rule.color.fg, ...(rule.bands ?? []).map((b) => b.fg)]
    for (const fg of colours) {
      const repaired = ensureContrast(fg, bg, 4.5)
      const ratio = contrast(repaired, bg)
      ok(ratio >= 4.5, `${theme.id} ${rule.id} ${fg} -> ${repaired} (${ratio.toFixed(2)}:1)`)
    }
  }
}

if (failed > 0) {
  console.error(`${failed} check(s) failed`)
  process.exit(1)
}
console.log('highlight-preview-contrast: all ok')
