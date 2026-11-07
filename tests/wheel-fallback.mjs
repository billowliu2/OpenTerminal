/**
 * Wheel fallback self-test (wheel-fallback.mjs).
 *
 * Pins the contract of `wheelFallbackSequence` — the full-screen TUI rescue that
 * turns a wheel notch into PageUp/PageDown when the child never received mouse
 * reporting (Windows ConPTY drops the enable sequence, see wheelFallback.ts):
 *
 *   1) normal buffer → never intercept (a shell's scrollback keeps its wheel);
 *   2) alternate screen + mouse tracking → never intercept (vim/tmux own it);
 *   3) alternate screen + no mouse tracking → PageUp up / PageDown down;
 *   4) zero delta → never intercept (a trackpad taps out exactly 0).
 *
 * Run: node tests/wheel-fallback.mjs  (must exit 0)
 */
import {
  WHEEL_FALLBACK_PAGE_DOWN,
  WHEEL_FALLBACK_PAGE_UP,
  wheelFallbackSequence
} from '../src/renderer/src/terminal/wheelFallback.ts'

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}

console.log('normal buffer is never intercepted:')
for (const mode of ['none', 'x10', 'vt200', 'drag', 'any']) {
  ok(
    wheelFallbackSequence({ alternate: false, mouseTrackingMode: mode }, -120) === undefined,
    `alternate=false mode=${mode} → undefined`
  )
}

console.log('alternate screen with real mouse reporting is left alone:')
for (const mode of ['x10', 'vt200', 'drag', 'any']) {
  ok(
    wheelFallbackSequence({ alternate: true, mouseTrackingMode: mode }, -120) === undefined,
    `alternate=true mode=${mode} → undefined`
  )
  ok(
    wheelFallbackSequence({ alternate: true, mouseTrackingMode: mode }, 120) === undefined,
    `alternate=true mode=${mode} (down) → undefined`
  )
}

console.log('alternate screen without mouse reporting pages:')
ok(
  wheelFallbackSequence({ alternate: true, mouseTrackingMode: 'none' }, -120) === WHEEL_FALLBACK_PAGE_UP,
  'wheel up → PageUp'
)
ok(
  wheelFallbackSequence({ alternate: true, mouseTrackingMode: 'none' }, 120) === WHEEL_FALLBACK_PAGE_DOWN,
  'wheel down → PageDown'
)
ok(
  wheelFallbackSequence({ alternate: true, mouseTrackingMode: 'none' }, -1) === WHEEL_FALLBACK_PAGE_UP,
  'a 1px notch still pages (magnitude is ignored)'
)
ok(
  wheelFallbackSequence({ alternate: true, mouseTrackingMode: 'none' }, -12000) === WHEEL_FALLBACK_PAGE_UP,
  'a huge pixel delta still pages'
)

console.log('zero delta is left alone:')
ok(
  wheelFallbackSequence({ alternate: true, mouseTrackingMode: 'none' }, 0) === undefined,
  'deltaY=0 → undefined'
)

console.log('the sequences are the expected ones:')
ok(WHEEL_FALLBACK_PAGE_UP === '\x1b[5~', 'PageUp is ESC[5~')
ok(WHEEL_FALLBACK_PAGE_DOWN === '\x1b[6~', 'PageDown is ESC[6~')

if (failed > 0) {
  console.error(`\nFAILED: ${failed} assertion(s)`)
  process.exit(1)
}
console.log('\nall wheel-fallback assertions passed')
