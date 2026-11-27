/**
 * Primary-fill label contrast self-test (primary-contrast.mjs).
 *
 * The label drawn on antd's primary fill must be READABLE ON THE FILL, not on
 * the chrome background. The settings dialog's selected radio segment used
 * `--tab-accent-fg` — a token derived against the CHROME BACKGROUND — as its
 * label colour on the primary-blue fill, which measured 1.51:1 in light chrome
 * and 1.92:1 in dark chrome: the selected language / renderer-mode label was
 * effectively invisible.
 *
 * The fix derives the label against the fill itself (`onPrimaryLabel()`) and
 * pins the fill (`PRIMARY_COLOR`), so the two can never drift apart.
 *
 * Direct .ts import (no esbuild bundle needed): semantic.ts has zero imports
 * and Node >= 22.18 strips types itself.
 * Run: node tests/primary-contrast.mjs   (must exit 0)
 */
import { contrast, onPrimaryLabel, PRIMARY_COLOR } from '../src/renderer/src/theme/semantic.ts'

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}

console.log('[primary fill]')
{
  const label = onPrimaryLabel()
  const ratio = contrast(label, PRIMARY_COLOR)
  ok(ratio >= 4.5, `the label on the primary fill reaches 4.5:1 (got ${ratio.toFixed(2)}:1)`)
  ok(contrast('#ffffff', PRIMARY_COLOR) >= 4.5, 'white on the pinned primary reaches 4.5:1')
  ok(contrast(label, PRIMARY_COLOR) >= contrast('#62c670', PRIMARY_COLOR),
    'the derived label beats the old --tab-accent-fg value')
}

console.log('[the old token is not the label colour]')
{
  // --tab-accent-fg (dark chrome) was #62c670 — 1.92:1 on the fill.
  ok(contrast('#62c670', PRIMARY_COLOR) < 4.5, 'the old value is below 4.5:1 on the fill')
  ok(contrast('#266f30', PRIMARY_COLOR) < 4.5, 'the old light-chrome value is below 4.5:1 too')
}

if (failed > 0) {
  console.error(`\n[primary-contrast] ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('\n[primary-contrast] ALL CHECKS PASSED')