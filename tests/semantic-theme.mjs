/**
 * semantic.ts self-test. 该模块必须零 import（Node 原生类型剥离直连 .ts，
 * 同 tests/terminal-cwd.mjs 的约束）。锁三件事：
 *  1) isLightTheme 边界（>0.5 亮度为浅）；
 *  2) 深色分支 = SEMANTIC 锚点原值（零回归锁定）；
 *  3) 浅色分支全部达标：正文/fg ≥4.5，语义基色 ≥3.0。
 * Run: node tests/semantic-theme.mjs  (must exit 0)
 */
import { isLightTheme, semanticVars, SEMANTIC } from '../src/renderer/src/theme/semantic.ts'

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}

console.log('isLightTheme:')
ok(isLightTheme('#ffffff') === true, '#ffffff is light')
ok(isLightTheme('#fafafa') === true, '#fafafa is light')
ok(isLightTheme('#fdf6e3') === true, '#fdf6e3 is light')
ok(isLightTheme('#1e1e1e') === false, '#1e1e1e is dark')
ok(isLightTheme('#282a36') === false, '#282a36 is dark')

console.log('dark branch locks anchors (zero regression):')
const dark = semanticVars({ background: '#1e1e1e', foreground: '#cccccc' }, false)
ok(dark['muted'] === SEMANTIC.muted, 'muted = anchor')
ok(dark['success'] === SEMANTIC.success, 'success = anchor')
ok(dark['danger'] === SEMANTIC.danger, 'danger = anchor')
ok(dark['warning'] === SEMANTIC.warning, 'warning = anchor')
ok(dark['info'] === SEMANTIC.info, 'info = anchor')
ok(dark['scrollbar'] === SEMANTIC.scrollbar, 'scrollbar = anchor')
ok(dark['shadow'] === SEMANTIC.shadow, 'shadow = anchor')
ok(dark['colorScheme'] === 'dark', 'colorScheme dark')

console.log('light branch meets ratios:')
for (const bg of ['#f6f8fa', '#fafafa', '#fdf6e3']) {
  const v = semanticVars({ background: bg, foreground: '#383a42' }, true)
  const L = (h) => {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
      .map((s) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4))
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  }
  const cr = (a, b) => {
    const x = L(a), y = L(b)
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
  }
  for (const key of ['muted', 'textSecondary', 'successFg', 'dangerFg', 'warningFg', 'infoFg']) {
    ok(cr(v[key], bg) >= 4.5, `${bg} ${key} ${v[key]} >= 4.5 (${cr(v[key], bg).toFixed(2)})`)
  }
  for (const key of ['success', 'danger', 'warning', 'info']) {
    ok(cr(v[key], bg) >= 3, `${bg} ${key} ${v[key]} >= 3.0 (${cr(v[key], bg).toFixed(2)})`)
  }
  ok(v['colorScheme'] === 'light', `${bg} colorScheme light`)
}

if (failed > 0) {
  console.error(`${failed} check(s) failed`)
  process.exit(1)
}
console.log('semantic-theme: all ok')
