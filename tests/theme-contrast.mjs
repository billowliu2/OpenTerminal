/**
 * Builtin theme palette contrast gate. Light themes: foreground + all 16 ANSI
 * colors must reach 4.5:1 against the theme background (WCAG AA body text);
 * cursor must reach 3:1. Dark themes: only the foreground sanity check (>=4.5)
 * — dark palettes are locked aesthetics, not regression targets here.
 * Imports ../src/shared/theme.ts directly (zero-import module, Node >= 22.18).
 * Run: node tests/theme-contrast.mjs  (must exit 0)
 */
import { BUILTIN_THEMES } from '../src/shared/theme.ts'

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}
const L = (h) => {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((s) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
const cr = (a, b) => {
  const x = L(a), y = L(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
  'brightMagenta', 'brightCyan', 'brightWhite']
const isLight = (bg) => L(bg) > 0.5

for (const t of BUILTIN_THEMES) {
  const c = t.colors
  const light = isLight(c.background)
  console.log(`${t.id} (${light ? 'light' : 'dark'}, bg ${c.background}):`)
  ok(cr(c.foreground, c.background) >= 4.5, `foreground ${c.foreground} ${cr(c.foreground, c.background).toFixed(2)}`)
  ok(cr(c.cursor, c.background) >= 3, `cursor ${c.cursor} ${cr(c.cursor, c.background).toFixed(2)}`)
  if (!light) continue
  for (const k of ANSI) {
    ok(cr(c[k], c.background) >= 4.5, `${k} ${c[k]} ${cr(c[k], c.background).toFixed(2)}`)
  }
}

if (failed > 0) {
  console.error(`${failed} check(s) failed`)
  process.exit(1)
}
console.log('theme-contrast: all ok')
