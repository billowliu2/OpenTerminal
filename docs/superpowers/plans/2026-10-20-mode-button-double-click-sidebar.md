# 侧栏模式按钮双击收展侧栏 Implementation Plan

> ⚠️ **已归档（2026-10-21）**：本计划已实施完毕并随 v1.0.31 发布，仅作历史记录，不再维护。后续工作见 [`docs/PLAN-2026-10-21-backlog.md`](../../PLAN-2026-10-21-backlog.md)。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 图标栏的「终端工作区 / SSH 工作区」模式按钮新增双击手势：双击当前工作区按钮 = 展开/收起侧栏；单击（含双击另一个按钮）只切换工作区。

**Architecture:** 不挂 `onDoubleClick`，直接在按钮 `onClick` 里用浏览器原生 `MouseEvent.detail` 连击计数判定手势。关键约束：双击时序是 `click(detail=1) → click(detail=2) → dblclick`，detail=2 到达时 zustand store 已被第一击更新，因此「手势前模式」必须在 detail===1 时存进 ref。判定逻辑抽成零 import 纯模块（仓库惯例，Node 原生类型剥离直连测试）。

**Tech Stack:** React 19.2.8 / zustand 5.0.15 / TypeScript strict / Node ≥22.18 原生 TS 剥离测试。

**已核实前提**（子代理两轮核实，全部属实）：
- `ModeRailButtons`（Workspace.tsx:1545）与 `IconRail`（:1506）全链路无条件渲染、无 key、无 StrictMode —— ref 生命周期 = 应用生命周期
- antd Tooltip（6.6.2）只代理 8 种事件，不含 click 之外的干扰；`e.detail` 在合成事件上可靠
- zustand v5 选择器走 `Object.is`，同值 set 不重渲染（双击当前按钮的第二击零副作用）
- `toggleSidebar`（Workspace.tsx:341，useCallback 稳定引用）已作为 `onToggleSidebar` 传入 `IconRail`（:1274），透传即可，Workspace 自身 props 接线不动
- `WorkspaceMode` 类型已在 Workspace.tsx:42 导入；`useRef` 已在用
- 渲染层无全局 click 监听、无既有 `e.detail` 消费者，无双击手势冲突

## Global Constraints

- **不执行任何 git commit / push** —— 改动留在工作区由用户审查（仓库 owner 惯例）
- 新纯模块 `modeRailGesture.ts` **零 import**（Node 原生类型剥离直连的硬约束，同 semantic.ts / workspaceMode.ts）
- 不改 CSS、不改 i18n 词典、不动现有收展按钮（rail 顶部 MenuFold/MenuUnfold）
- 行为语义锁定：detail 0/1 → 切换；detail 2 且手势前模式=本按钮 → 翻侧栏；detail 2 其余 → 无操作
- 测试脚手架照 `tests/semantic-theme.mjs`：`ok(cond, msg)` 计数器 + 末尾 `process.exit(failed ? 1 : 0)`

---

### Task 1: 纯手势判定模块 + 表驱动测试（TDD）

**Files:**
- Test: `tests/mode-rail-gesture.mjs`（新建）
- Create: `src/renderer/src/workspace/modeRailGesture.ts`（新建）
- Modify: `package.json:16`（test 链尾追加）
- Modify: `AGENTS.md`（测试计数 35→36 + 两处清单）

**Interfaces:**
- Produces: `decideModeClick(detail: number, preGestureMode: RailMode | null, buttonMode: RailMode): ModeClickAction`，`RailMode = 'terminal' | 'ssh'`，`ModeClickAction = 'switch' | 'toggle-sidebar' | 'noop'` —— Task 2 的 `ModeRailButtons` 消费此签名。

- [x] **Step 1: 先写测试 `tests/mode-rail-gesture.mjs`**

```js
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
```

- [x] **Step 2: 运行测试确认失败**

Run: `node tests/mode-rail-gesture.mjs`
Expected: FAIL —— `ERR_MODULE_NOT_FOUND`（模块尚不存在）

- [x] **Step 3: 实现 `src/renderer/src/workspace/modeRailGesture.ts`**

```ts
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
```

- [x] **Step 4: 运行测试确认通过**

Run: `node tests/mode-rail-gesture.mjs`
Expected: PASS —— 10 行 `ok`，末尾 `mode-rail-gesture: all ok`，exit 0

- [x] **Step 5: 登记测试到 package.json**

`package.json:16` 的 `"test"` 链尾，在 `node tests/link-rules.mjs` 之后追加：

```
 && node tests/mode-rail-gesture.mjs
```

（新测试是零 import 直连型，不依赖 bundle，位置在链尾即可。）

- [x] **Step 6: 同步 AGENTS.md 测试清单（项目规则：改 AGENTS.md 所载内容须同步）**

两处编辑：
1. 「测试」条目里 `可离线运行的 35 个测试` → `36 个测试`，枚举末尾 `font-stack、link-rules；` → `font-stack、link-rules、mode-rail-gesture；`
2. 同条目括号内的渲染层纯函数测试枚举 `…hl-rules、link-rules 等）` → `…hl-rules、link-rules、mode-rail-gesture 等）`

### Task 2: Workspace.tsx 接线

**Files:**
- Modify: `src/renderer/src/workspace/Workspace.tsx`（import 一处、ModeRailButtons :1545、IconRail JSX :1532）

**Interfaces:**
- Consumes: Task 1 的 `decideModeClick` / `ModeClickAction`；既有 `useWorkspaceModeStore`（含 `.getState()`）、`WorkspaceMode` 类型（已在 :42 导入）、`useRef`（已在用）、IconRail 已有的 `onToggleSidebar` prop。

- [x] **Step 1: 加 import**

在 Workspace.tsx:43 `import { useWorkspaceModeStore } from './workspaceModeStore'` 之后加：

```ts
import { decideModeClick } from './modeRailGesture'
```

- [x] **Step 2: 替换 ModeRailButtons（:1545–1564 整段）**

旧代码（原样，供 Edit 的 old_string）：

```tsx
/** M6.1: terminal / SSH workspace entries in the icon rail. */
function ModeRailButtons(): React.JSX.Element {
  const mode = useWorkspaceModeStore((s) => s.mode)
  const setMode = useWorkspaceModeStore((s) => s.setMode)
  return (
    <>
      <RailButton
        title={t('workspace.rail.terminalWorkspace')}
        icon={<CodeOutlined />}
        active={mode === 'terminal'}
        onClick={() => setMode('terminal')}
      />
      <RailButton
        title={t('workspace.rail.sshWorkspace')}
        icon={<CloudServerOutlined />}
        active={mode === 'ssh'}
        onClick={() => setMode('ssh')}
      />
    </>
  )
}
```

新代码：

```tsx
/** M6.1: terminal / SSH workspace entries in the icon rail. 双击当前工作区按钮 = 收展侧栏。 */
function ModeRailButtons({ onToggleSidebar }: { onToggleSidebar: () => void }): React.JSX.Element {
  const mode = useWorkspaceModeStore((s) => s.mode)
  const setMode = useWorkspaceModeStore((s) => s.setMode)
  /** 手势开始前的模式。detail===2 到达时 store 已被第一击更新，判定「双击的是不是当前工作区」只能用这里存的值。 */
  const preGestureModeRef = useRef<WorkspaceMode | null>(null)

  const handleModeClick = (buttonMode: WorkspaceMode) => (e: React.MouseEvent<HTMLButtonElement>): void => {
    const action = decideModeClick(e.detail, preGestureModeRef.current, buttonMode)
    if (action === 'toggle-sidebar') {
      onToggleSidebar()
      return
    }
    if (action === 'noop') return
    preGestureModeRef.current = useWorkspaceModeStore.getState().mode
    setMode(buttonMode)
  }

  return (
    <>
      <RailButton
        title={t('workspace.rail.terminalWorkspace')}
        icon={<CodeOutlined />}
        active={mode === 'terminal'}
        onClick={handleModeClick('terminal')}
      />
      <RailButton
        title={t('workspace.rail.sshWorkspace')}
        icon={<CloudServerOutlined />}
        active={mode === 'ssh'}
        onClick={handleModeClick('ssh')}
      />
    </>
  )
}
```

- [x] **Step 3: IconRail 内透传（:1532）**

`<ModeRailButtons />` → `<ModeRailButtons onToggleSidebar={onToggleSidebar} />`

- [x] **Step 4: 渲染层类型检查**

Run: `npx tsc --noEmit -p tsconfig.web.json`
Expected: 无输出，exit 0

- [x] **Step 5: 全量测试**

Run: `npm test`
Expected: pretest 类型检查 + 36 个离线测试全部通过，exit 0

- [x] **Step 6: 自审 diff**

Run: `git diff --stat` + `git status`
Expected: 恰好 3 改 2 新：`Workspace.tsx`、`package.json`、`AGENTS.md` 修改；`modeRailGesture.ts`、`tests/mode-rail-gesture.mjs` 新增（共 5 个路径；本计划文档自身 untracked 属预期，无其它文件）；无 CSS / i18n 词典改动
