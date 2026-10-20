/**
 * 图标栏模式按钮（终端工作区 / SSH 工作区）的单击·双击手势判定。
 * 零 import 纯模块 —— tests/mode-rail-gesture.mjs 经 Node 原生类型剥离直连本文件。
 *
 * 浏览器双击时序是 click(detail=1) → click(detail=2) → dblclick，且 detail=2 到达时
 * store 里的模式已被第一击更新，所以调用方必须在 detail===1 时把「手势前模式」存进 ref、
 * detail===2 时传入本函数比对 —— 绝不能在第二击时读当前 store 值。
 */
export type RailMode = 'terminal' | 'ssh'

export type ModeClickAction = 'switch' | 'toggle-sidebar' | 'noop'

/**
 * 判定一次 click 属于哪种动作：
 * - detail 1（单击或双击的第一击）→ 'switch'：记录手势前模式并切换工作区
 * - detail 2 且手势前模式 === 本按钮模式 → 'toggle-sidebar'：双击的是当前工作区按钮
 * - detail 2 且不等 → 'noop'：第一击已完成切换，侧栏不动
 * - detail 0（键盘 Enter/Space 触发）→ 'switch'：无障碍路径保持单击语义
 */
export function decideModeClick(detail: number, preGestureMode: RailMode | null, buttonMode: RailMode): ModeClickAction {
  if (detail === 2) return preGestureMode === buttonMode ? 'toggle-sidebar' : 'noop'
  return 'switch'
}
