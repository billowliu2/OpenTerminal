/**
 * Refit-throttle self-test (refit-throttle.mjs).
 *
 * `src/renderer/src/terminal/fitThrottle.ts` decides whether a resize event
 * may reflow now or must wait. The contract it pins:
 *
 *   - `lastFitAt <= 0` (no fit recorded, e.g. a freshly bound session) always
 *     fits immediately — the pty spawns at a placeholder size and the shell
 *     may already be drawing, so the first fit must never wait;
 *   - inside the throttle window the answer is the REMAINING wait (feeds the
 *     trailing timer that lands the final fit at the settled size);
 *   - at and past the window boundary the fit runs now;
 *   - the window length is configurable so the test does not depend on the
 *     production constant's value.
 *
 * Direct .ts import (no esbuild bundle needed): the module has no imports and
 * no runtime-only TS syntax, and Node >= 22.18 strips types itself.
 * Run: node tests/refit-throttle.mjs   (must exit 0)
 */
import { FIT_REFLOW_THROTTLE_MS, refitDelay } from '../src/renderer/src/terminal/fitThrottle.ts'

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}

console.log('the first fit never waits')
ok(refitDelay(0, 1000) === 0, 'lastFitAt = 0 fits immediately')
ok(refitDelay(-1, 1000) === 0, 'a negative marker also fits immediately')

console.log('inside the window the answer is the remaining wait')
ok(refitDelay(1000, 1000) === FIT_REFLOW_THROTTLE_MS, 'a fit at the same tick waits the full window')
ok(refitDelay(1000, 1100) === FIT_REFLOW_THROTTLE_MS - 100, 'mid-window returns the remainder')
ok(refitDelay(1000, 1000 + FIT_REFLOW_THROTTLE_MS - 1) === 1, 'one ms before the boundary waits 1ms')

console.log('at and past the boundary the fit runs now')
ok(refitDelay(1000, 1000 + FIT_REFLOW_THROTTLE_MS) === 0, 'exactly at the boundary fits')
ok(refitDelay(1000, 100000) === 0, 'long after the last fit fits')

console.log('the window length is a parameter')
ok(refitDelay(1000, 1050, 150) === 100, 'explicit throttleMs is honored')
ok(refitDelay(1000, 1150, 150) === 0, 'explicit window boundary fits')

if (failed > 0) {
  console.error(`\n[refit-throttle] ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('\n[refit-throttle] ALL CHECKS PASSED')
