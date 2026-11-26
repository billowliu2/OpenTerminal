/**
 * Contrast floor self-test (contrast-floor.mjs).
 *
 * Pins the contract of `contrastFloor` — the minimum contrast ratio the
 * renderer enforces between a cell's text and its background:
 *
 *   1) the user's value is honoured (4.5 by default, 1 turns it off);
 *   2) out-of-range and unusable values are clamped into xterm's 1..21;
 *   3) a background image keeps its own 4.5 floor (xterm reads a transparent
 *      background as black, so text over a wallpaper must clear AA).
 *
 * Run: node tests/contrast-floor.mjs  (must exit 0)
 */
import {
  BACKGROUND_IMAGE_FLOOR,
  CONTRAST_FLOOR_DEFAULT,
  CONTRAST_FLOOR_MAX,
  CONTRAST_FLOOR_MIN,
  contrastFloor
} from '../src/shared/contrastFloor.ts'

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}

console.log('the user value is honoured:')
ok(contrastFloor(4.5, false) === 4.5, '4.5 → 4.5')
ok(contrastFloor(3, false) === 3, '3 → 3')
ok(contrastFloor(1, false) === 1, '1 (off) → 1')
ok(contrastFloor(7, false) === 7, '7 → 7')
ok(contrastFloor(CONTRAST_FLOOR_DEFAULT, false) === CONTRAST_FLOOR_DEFAULT, 'the default stays the default')

console.log('out-of-range values are clamped into xterm\'s range:')
ok(contrastFloor(0, false) === CONTRAST_FLOOR_MIN, '0 → 1')
ok(contrastFloor(-3, false) === CONTRAST_FLOOR_MIN, '-3 → 1')
ok(contrastFloor(999, false) === CONTRAST_FLOOR_MAX, '999 → 21')
ok(contrastFloor(4.44, false) === 4.4, '4.44 → 4.4 (one decimal, like xterm)')
ok(contrastFloor(4.46, false) === 4.5, '4.46 → 4.5')

console.log('unusable values fall back to the default:')
ok(contrastFloor(Number.NaN, false) === CONTRAST_FLOOR_DEFAULT, 'NaN → the default')
ok(contrastFloor(undefined, false) === CONTRAST_FLOOR_DEFAULT, 'undefined → the default')
ok(contrastFloor(Number.POSITIVE_INFINITY, false) === CONTRAST_FLOOR_DEFAULT, 'Infinity → the default')

console.log('a background image keeps its own floor:')
ok(contrastFloor(1, true) === BACKGROUND_IMAGE_FLOOR, '1 with an image → 4.5')
ok(contrastFloor(3, true) === BACKGROUND_IMAGE_FLOOR, '3 with an image → 4.5')
ok(contrastFloor(7, true) === 7, '7 with an image → 7 (the user asked for more)')

if (failed > 0) {
  console.error(`\n${failed} contrast-floor assertion(s) failed`)
  process.exit(1)
}
console.log('\nall contrast-floor assertions passed')
