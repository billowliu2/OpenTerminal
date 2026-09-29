/**
 * Lock-shortcut classifier self-test (lock-shortcuts.mjs).
 *
 * Table-driven coverage of the two pure predicates the before-input-event guard
 * in src/main/index.ts is built from. This is the decision v1.0.17 got wrong
 * from inside an untestable closure, so every chord spelling that matters is
 * pinned here:
 *   - the panic lock is exactly Ctrl+L: Shift (IME switch on zh/ja) and Alt
 *     (AltGr on European layouts) must pass through, as must Caps-Lock 'L'
 *     variants only when they really are Ctrl+L
 *   - the locked-window blocklist: reload (F5, Ctrl+R, Ctrl+Shift+R), zoom in
 *     both plain and Shift-shifted spellings ('='/'+' and '-'/'_'), reset ('0'),
 *     and DevTools (Ctrl+Shift+I/J/C)
 *   - what must NOT be blocked: plain typing, Ctrl+C copy, Ctrl+L itself while
 *     already locked (it falls to the page), and unrelated Ctrl chords
 *
 * Build: node tests/build-bundles.cjs
 * Run:   node tests/lock-shortcuts.mjs   (must exit 0)
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { isLockBlockedShortcut, isPanicLockChord } = require('./.lock-shortcuts.cjs')

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}

/** Build a classifier input; modifiers default to off. */
const key = (k, mods = {}) => ({
  key: k,
  control: false,
  shift: false,
  alt: false,
  meta: false,
  ...mods
})
const ctrl = (k, mods = {}) => key(k, { control: true, ...mods })

// ---- panic lock chord (exactly Ctrl+L) --------------------------------------
console.log('panic lock chord')
ok(isPanicLockChord(ctrl('l')), 'Ctrl+L is the panic chord')
ok(isPanicLockChord(ctrl('L')), 'Ctrl+L with Caps Lock still matches (key is case-folded)')
ok(!isPanicLockChord(ctrl('l', { shift: true })), 'Ctrl+Shift+L passes (IME input-mode switch)')
ok(!isPanicLockChord(ctrl('l', { alt: true })), 'Ctrl+Alt+L passes (AltGr on European layouts)')
ok(!isPanicLockChord(ctrl('l', { meta: true })), 'Ctrl+Meta+L passes')
ok(!isPanicLockChord(key('l')), 'plain L passes (would eat typing otherwise)')
ok(!isPanicLockChord(ctrl('r')), 'Ctrl+R is not the panic chord')
ok(!isPanicLockChord(ctrl('l', { shift: true, alt: true })), 'Ctrl+Shift+Alt+L passes')

// ---- locked-window blocklist -------------------------------------------------
console.log('locked-window blocklist')
ok(isLockBlockedShortcut(key('f5')), 'F5 blocked (reload)')
ok(isLockBlockedShortcut(key('F5')), 'F5 case-folded')
ok(isLockBlockedShortcut(ctrl('r')), 'Ctrl+R blocked (reload)')
ok(isLockBlockedShortcut(ctrl('r', { shift: true })), 'Ctrl+Shift+R blocked (force reload)')
ok(isLockBlockedShortcut(ctrl('=')), 'Ctrl+= blocked (zoom in)')
ok(isLockBlockedShortcut(ctrl('+')), "Ctrl+Shift+= arrives as '+' and is blocked")
ok(isLockBlockedShortcut(ctrl('-')), 'Ctrl+- blocked (zoom out)')
ok(isLockBlockedShortcut(ctrl('_')), "Ctrl+Shift+- arrives as '_' and is blocked")
ok(isLockBlockedShortcut(ctrl('0')), 'Ctrl+0 blocked (zoom reset)')
ok(isLockBlockedShortcut(ctrl('i', { shift: true })), 'Ctrl+Shift+I blocked (DevTools)')
ok(isLockBlockedShortcut(ctrl('j', { shift: true })), 'Ctrl+Shift+J blocked (DevTools console)')
ok(isLockBlockedShortcut(ctrl('c', { shift: true })), 'Ctrl+Shift+C blocked (DevTools inspect)')

// ---- must not be blocked -----------------------------------------------------
console.log('pass-through chords')
ok(!isLockBlockedShortcut(key('r')), 'plain typing passes')
ok(!isLockBlockedShortcut(ctrl('c')), 'Ctrl+C passes (terminal copy)')
ok(!isLockBlockedShortcut(ctrl('l')), 'Ctrl+L passes the blocklist (handled by the panic branch)')
ok(!isLockBlockedShortcut(ctrl('i')), 'Ctrl+I without Shift passes')
ok(!isLockBlockedShortcut(key('f12')), 'F12 passes (Electron binds no default for it)')
ok(!isLockBlockedShortcut(ctrl('l', { shift: true })), 'Ctrl+Shift+L passes the blocklist too')

if (failed > 0) {
  console.error(`\n[lock-shortcuts] ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('\n[lock-shortcuts] ALL CHECKS PASSED')
