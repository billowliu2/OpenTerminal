/**
 * modeRailGesture.ts self-test。零 import 纯模块，Node 原生类型剥离直连 .ts。
 * 锁定双击手势语义：
 *  1) 单击 / 键盘触发（detail 1 / 0）一律 switch；
 *  2) detail 2 只有「手势前模式 === 本按钮模式」才 toggle-sidebar（双击当前工作区按钮）；
 *  3) detail 2 其余情况 noop（双击另一个按钮时第一击已完成切换，侧栏不动）。
 * Run: node tests/mode-rail-gesture.mjs  (must exit 0)
 */
import { decideModeClick } from '../src/renderer/src/workspace/modeRailGesture.ts'

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}

console.log('single click / keyboard always switch:')
ok(decideModeClick(1, null, 'terminal') === 'switch', 'detail=1 preMode=null → switch')
ok(decideModeClick(1, 'terminal', 'terminal') === 'switch', 'detail=1 same mode → switch')
ok(decideModeClick(1, 'terminal', 'ssh') === 'switch', 'detail=1 other mode → switch')
ok(decideModeClick(0, 'terminal', 'ssh') === 'switch', 'detail=0 keyboard → switch')

console.log('double click toggles sidebar only on the already-active button:')
ok(decideModeClick(2, 'terminal', 'terminal') === 'toggle-sidebar', 'detail=2 active terminal → toggle-sidebar')
ok(decideModeClick(2, 'ssh', 'ssh') === 'toggle-sidebar', 'detail=2 active ssh → toggle-sidebar')
ok(decideModeClick(2, 'terminal', 'ssh') === 'noop', 'detail=2 inactive ssh → noop（第一击已切换）')
ok(decideModeClick(2, 'ssh', 'terminal') === 'noop', 'detail=2 inactive terminal → noop')
ok(decideModeClick(2, null, 'terminal') === 'noop', 'detail=2 preMode=null → noop（防御）')

console.log('click streaks beyond 2 fall back to switch semantics:')
ok(decideModeClick(3, 'terminal', 'terminal') === 'switch', 'detail=3 → switch（不产生第二次翻转）')

if (failed > 0) {
  console.error(`${failed} check(s) failed`)
  process.exit(1)
}
console.log('mode-rail-gesture: all ok')
