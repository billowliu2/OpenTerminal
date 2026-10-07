/**
 * Reserved-accelerator self-test (reserved-accelerators.mjs).
 *
 * src/shared/reservedAccelerators.ts is the single table two guards read:
 *   - the settings recorder refuses to SAVE such a chord (SettingsTabs.tsx);
 *   - `applyGlobalShortcut` refuses to REGISTER one (main/globalShortcuts.ts).
 * They used to be two independent tables with two spellings of the same rule,
 * and only the renderer's had a test. What is pinned here:
 *   - the in-app chords: Ctrl+=/-/0 (font size) and Ctrl+PgUp/PgDn (tab cycle),
 *     under ANY extra modifiers — the in-app handlers ignore Shift/Alt, so a
 *     global registration of Ctrl+Shift+= would shadow them;
 *   - Ctrl+L, the panic lock, in every spelling a user or an older build can
 *     produce ('ctrl+l', 'Ctrl+L', 'Control+L', 'CommandOrControl+L');
 *   - everything else stays registrable, so the guard cannot grow into a
 *     blanket refusal.
 *
 * Build: node tests/build-bundles.cjs
 * Run:   node tests/reserved-accelerators.mjs   (must exit 0)
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { isReservedAccelerator, acceleratorParts } = require('./.reserved-accelerators.cjs')

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}

const reserved = [
  // --- the panic lock, every spelling ---------------------------------------
  'Ctrl+L',
  'ctrl+l',
  'CTRL+L',
  'Control+L',
  'control+l',
  'CommandOrControl+L',
  'CmdOrCtrl+L',
  'CommandOrCtrl+L',
  'Ctrl + L', // Electron tolerates surrounding whitespace
  // --- font size (Ctrl = / - / 0) under extra modifiers ---------------------
  'Control+=',
  'Control+-',
  'Control+0',
  'Control+Shift+=',
  'Control+Shift+-',
  'Control+Shift+0',
  'Control+Alt+=',
  'Control+Alt+Shift+0',
  'ctrl+0',
  // --- tab cycling (Ctrl+PgUp/PgDn) ----------------------------------------
  'Control+PageUp',
  'Control+PageDown',
  'Control+Shift+PageUp',
  'Control+Alt+PageDown',
  'ctrl+pageup'
]

const allowed = [
  // Not the panic chord: extra/missing modifiers change the meaning on purpose.
  'Alt+L',
  'Shift+L',
  'Super+L',
  'Control+Shift+L',
  'Control+Alt+L',
  'Control+Meta+L',
  // The font/tab keys WITHOUT Control belong to whatever is focused.
  '=',
  '-',
  '0',
  'Shift+=',
  'Alt+=',
  'PageUp',
  'PageDown',
  'Shift+PageUp',
  // Other Control chords are free (they do not collide with an in-app binding).
  'Control+R',
  'Control+Shift+I',
  'Control+1',
  'Control+PageHome',
  'Control+F5',
  'Alt+Control+P',
  // Standalone function keys.
  'F5',
  'F12',
  'Control+F12'
]

console.log('reserved (must be refused by both guards)')
for (const a of reserved) ok(isReservedAccelerator(a), `reserved: ${JSON.stringify(a)}`)

console.log('allowed (must stay registrable)')
for (const a of allowed) ok(!isReservedAccelerator(a), `allowed: ${JSON.stringify(a)}`)

console.log('modifier aliases fold to one canonical form')
ok(acceleratorParts('Ctrl+L').join('+') === 'control+l', "'Ctrl' folds to 'control'")
ok(acceleratorParts('CommandOrControl+L').join('+') === 'control+l', "'CommandOrControl' folds to 'control' (Windows-only app)")
ok(acceleratorParts('CmdOrCtrl+L').join('+') === 'control+l', "'CmdOrCtrl' folds to 'control'")
ok(acceleratorParts('Ctrl+Shift+P').join('+') === 'control+shift+p', 'Shift is folded to lower case and kept')
ok(acceleratorParts('Super+L')[0] === 'super', 'Super is preserved (not an alias of Control)')

console.log('degenerate input does not throw and grants nothing')
for (const a of ['', ' ', '+', 'Control+', '+L', 'nonsense']) {
  let threw = false
  let verdict
  try {
    verdict = isReservedAccelerator(a)
  } catch {
    threw = true
  }
  ok(!threw && verdict === false, `junk input refused without throwing: ${JSON.stringify(a)}`)
}

if (failed > 0) {
  console.error(`\n[reserved-accelerators] ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log(`\n[reserved-accelerators] ALL CHECKS PASSED (${reserved.length + allowed.length + 4 + 6} assertions)`)
