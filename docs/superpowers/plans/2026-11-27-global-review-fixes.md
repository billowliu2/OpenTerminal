# OpenTerminal 全局 Review 修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 2026-11-27 全局 review 查出的 10 个 P0/P1 缺陷与 3 组 P2 问题逐条修掉，让代码重新满足 AGENTS.md 的硬规则，并给目前只有散文、没有测试的关键守门规则补上闸门。

**Architecture:** 全部是**定点修复**，不引入新架构、不加新依赖、不改公共契约。分四个波次：Wave 1 修用户可见缺陷，Wave 2 补"护栏其实没生效"的漏洞，Wave 3 修健壮性，Wave 4 收尾（校验、闸门、文档）。每个任务自带一条可独立验证的测试闭环，遵循项目既有约定：新逻辑抽**零 import 纯模块** + Node 原生类型剥离表驱动测试。

**Tech Stack:** Electron + electron-vite + React 19 + TypeScript strict + antd 6 + zustand + `@xterm/xterm` 6.1.0-beta.304 + dockview-react 8。测试：Node ≥ 22.18 原生类型剥离（`node tests/*.mjs`）、esbuild 打包（`tests/build-bundles.cjs`）、源码结构扫描（`tests/ot-var-names.mjs` 既有模式）。

---

## Global Constraints

以下为全局约束，**每个任务都隐含包含**，逐字取自 AGENTS.md：

1. **依赖分类**：只有 `src/main/`/`src/preload/` 实际 import 的包才能进 `dependencies`；纯渲染层依赖一律 `devDependencies`。本计划**不新增任何依赖**。
2. **纯逻辑抽纯模块**：新增纯逻辑一律抽**零 import** 纯模块 + Node 原生类型剥离表驱动测试（Node 22.18+；20/22.17 以下报 `ERR_UNKNOWN_FILE_EXTENSION`）。
3. **CSS 颜色**：CSS 一律 `var(--ot-*, 锚点兜底)`，**禁止裸颜色字面量**；`tests/css-theme-vars.mjs` 是 fail-closed 守门。
4. **新增 `--ot-*` 变量必须改三处**：`OtVarName` 联合 + `semanticVars()` 两个分支 + `global.css` 的 `:root` 声明。`tests/ot-var-names.mjs` 锁"CSS 引用名 = JS 写入名 = global.css 声明名"。
5. **语义变量零 import**：`src/renderer/src/theme/semantic.ts` 必须保持零 import（测试靠 Node 类型剥离直连）。
6. **测试链同步**：新增测试文件必须加进 `package.json` 的 `test` 脚本链，并同步 AGENTS.md 的测试数量。
7. **i18n 四语言键同步**（zh-CN / zh-TW / en / ja）。本计划不新增用户可见文案，Task 12 只改行为不改文案。
8. **改 AGENTS.md 已文档化的行为时，同步更新 AGENTS.md**。本计划有多处属于此类（见各任务的 "AGENTS.md" 小节）。
9. **提交规范**：`fix(<scope>): <中文摘要>`；每个任务一个提交。
10. **发布提交必须带 `package-lock.json`**：本计划不涉及发版，不适用。

**统一验证命令**（每个任务结束时至少跑一次）：

```bash
npm run typecheck && npm test
```

**预期输出**：`npm test` 链尾出现 `[<新测试名>] ALL CHECKS PASSED`，进程 exit 0。

---

## File Structure

### 新建文件

| 文件 | 职责 | 归属任务 |
|---|---|---|
| `src/renderer/src/terminal/sessionFlush.ts` | 纯模块：把"高亮流持有的残留 + 批处理窗口"一次性推给 xterm 的顺序契约 | Task 1 |
| `src/renderer/src/workspace/templateApply.ts` | 纯模块：布局模板的 fromJSON 调用 + "哪些 dockview 真的被触碰过"的判定 | Task 3 |
| `scripts/releaseFeeds.cjs` | 纯模块：发布脚本该检查哪些更新源（降级护栏的 feed 选择） | Task 9 |
| `tests/session-flush.mjs` | Task 1 的表驱动测试 | Task 1 |
| `tests/template-apply.mjs` | Task 3 的表驱动测试 | Task 3 |
| `tests/primary-contrast.mjs` | Task 2 的对比度断言 | Task 2 |
| `tests/terminal-theme-deps.mjs` | Task 10 的依赖结构扫描 | Task 10 |
| `tests/release-feeds.mjs` | Task 9 的表驱动测试 | Task 9 |

### 修改文件

| 文件 | 改动 | 归属任务 |
|---|---|---|
| `src/renderer/src/terminal/TerminalView.tsx` | markDead 释放残留；theme effect 依赖收窄 | Task 1, Task 10 |
| `src/renderer/src/theme/semantic.ts` | 新增 `PRIMARY_COLOR` / `onPrimaryLabel()` | Task 2 |
| `src/renderer/src/theme/chrome.ts` | 写 `--chrome-on-primary` | Task 2 |
| `src/renderer/src/main.tsx` | antd `colorPrimary` 固定为 `PRIMARY_COLOR` | Task 2 |
| `src/renderer/src/global.css` | `:root` 增加 `--chrome-on-primary` | Task 2 |
| `src/renderer/src/settings/settings.css` | 选中分段标签改用 `--chrome-on-primary` | Task 2 |
| `src/renderer/src/workspace/Workspace.tsx` | 模板应用改用 `applyTemplatePayload` | Task 3 |
| `src/main/settingsStore.ts` | 刷新预设时一并带 `basic`/`category` | Task 6 |
| `src/renderer/src/terminal/highlightEngine.ts` | CSI final 字节类放宽 | Task 7 |
| `src/main/sftp.ts` | 上传句柄在失败路径关闭 | Task 8 |
| `scripts/release.cjs` | 降级护栏的 feed 选择改用 `feedsToGuard` | Task 9 |
| `tests/hl-rules.mjs` | 回放闸门边界用例 + CSI final 用例 | Task 4, Task 7 |
| `tests/css-theme-vars.mjs` | 扫描器收紧 | Task 5 |
| `tests/settings-store.mjs` | 升级元数据用例 | Task 6 |
| `tests/sftp-timeout.mjs` | 句柄关闭用例 | Task 8 |
| `scripts/verify-deps.cjs` | 增加依赖分类闸门 | Task 11 |
| `package.json` | 测试链加入 5 个新测试；`engines` 声明 | Task 1, 2, 3, 9, 10, 11 |
| `src/main/ssh.ts` / `src/renderer/src/workspace/Workspace.tsx` | 主机密钥 TTL 提为共享常量 | Task 12 |
| `src/renderer/src/workspace/HostKeyModal.tsx` | 遮罩/Esc 不再等于 reject | Task 12 |
| `src/renderer/src/sftp/FilePanel.tsx` | 上传监听器句柄集合 | Task 12 |
| `src/main/updater.ts` | 下载路径加停顿检测 | Task 12 |
| `docs/STATE.md` / `docs/ROADMAP.md` / `AGENTS.md` | 文档漂移修正 | Task 13 |

---

# Wave 1 — 用户可见缺陷（P0）

### Task 1: 会话退出时释放高亮流持有的残留

**问题**：`HighlightStream.push()` 对无 ESC 的纯文本**整块持有**、返回空串（`highlightEngine.ts:900-908`），释放只有两条路：16ms 定时器或 `flush()`。而 `markDead`（`TerminalView.tsx:1493-1501`）只 `batcher.flushNow()`——此时内容还卡在 stream 里——随后置 `deadRef.current = true`；16ms 定时器触发时 `if (deadRef.current) return`（`:1338`），**残留永远不写进 xterm**。PTY_DATA 与 PTY_EXIT 是有序 IPC 消息，间隔常 < 16ms，所以会话最后一行输出经常整段消失，且会话已死、无 replay 可救。

AGENTS.md「终端尺寸同步」一节写的"markDead 先 flushNow() 再置 dead 标志"只对 batcher 实现了，stream 的 carry 被漏掉了。

**Files:**
- Create: `src/renderer/src/terminal/sessionFlush.ts`
- Create: `tests/session-flush.mjs`
- Modify: `src/renderer/src/terminal/TerminalView.tsx:1493-1501`（markDead）、`:1626-1630`（拆卸路径注释）
- Modify: `package.json`（test 脚本链）

**Interfaces:**
- Consumes: 无（本任务的纯模块不 import 任何东西）
- Produces:
  ```ts
  // src/renderer/src/terminal/sessionFlush.ts
  export interface FlushableStream { flush(): string }
  export interface FlushableBatcher { push(text: string): void; flushNow(): void }
  export function flushPendingOutput(stream: FlushableStream, batcher: FlushableBatcher): void
  ```
  后续任务不依赖它；`TerminalView.tsx` 是唯一调用方。

- [ ] **Step 1: 写失败的测试**

创建 `tests/session-flush.mjs`：

```js
/**
 * Session-death flush self-test (session-flush.mjs).
 *
 * The output path has TWO buffers between the PTY and xterm:
 *   - HighlightStream holds the trailing TEXT RUN of every escape-free chunk
 *     (it must hold it, or a rule anchored with `^` would match mid-line);
 *   - WriteBatcher holds a ~16ms window of what the stream already released.
 *
 * The session-death path must release BOTH, in that order, before the pane
 * starts dropping writes: PTY_EXIT arrives right after the last PTY_DATA, so
 * whatever is still held is exactly the session's final output. Releasing only
 * the batcher (the old behaviour) dropped the last line of every session that
 * ended within 16ms of its last output — and a dead session has no replay to
 * re-fetch it from.
 *
 * Direct .ts import (no esbuild bundle needed): the module has no imports and
 * no runtime-only TS syntax, and Node >= 22.18 strips types itself.
 * Run: node tests/session-flush.mjs   (must exit 0)
 */
import { flushPendingOutput } from '../src/renderer/src/terminal/sessionFlush.ts'
import { WriteBatcher } from '../src/renderer/src/terminal/writeBatcher.ts'

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}

console.log('the final output survives the session-death path')
{
  const calls = []
  // A 10s window: without the flush the batcher would still be holding when
  // the test ends, which is exactly the bug (the text never reaches xterm).
  const batcher = new WriteBatcher((text) => calls.push(text), 10_000)
  const stream = { flush: () => 'final line\r\n' }
  flushPendingOutput(stream, batcher)
  ok(calls.length === 1, `the held text is written exactly once (got ${calls.length})`)
  ok(calls[0] === 'final line\r\n', 'the held text reaches the sink verbatim')
  batcher.dispose()
}

console.log('the held text is queued BEFORE the window is closed')
{
  const order = []
  const batcher = {
    push: () => order.push('push'),
    flushNow: () => order.push('flushNow')
  }
  flushPendingOutput({ flush: () => 'x' }, batcher)
  ok(order.join(',') === 'push,flushNow', `push must precede flushNow (got ${order.join(',')})`)
}

console.log('an empty stream does not queue an empty string')
{
  const pushed = []
  const batcher = { push: (t) => pushed.push(t), flushNow: () => undefined }
  flushPendingOutput({ flush: () => '' }, batcher)
  ok(pushed.length === 0, 'nothing is queued when the stream holds nothing')
}

console.log('the batcher window is always closed')
{
  let flushed = 0
  const batcher = { push: () => undefined, flushNow: () => { flushed += 1 } }
  flushPendingOutput({ flush: () => '' }, batcher)
  ok(flushed === 1, 'flushNow runs even when the stream was empty')
}

if (failed > 0) {
  console.error(`\n[session-flush] ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('\n[session-flush] ALL CHECKS PASSED')
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/session-flush.mjs`
Expected: FAIL —— `ERR_MODULE_NOT_FOUND`（`sessionFlush.ts` 还不存在）。

- [ ] **Step 3: 实现纯模块**

创建 `src/renderer/src/terminal/sessionFlush.ts`：

```ts
/**
 * Release everything the output path is still holding, in the order the
 * terminal must see it.
 *
 * Two buffers sit between the PTY and xterm:
 *   - the highlight stream holds the trailing TEXT RUN of every escape-free
 *     chunk (it has to hold it, or a rule anchored with `^` would match
 *     mid-line), and
 *   - the write batcher holds a ~16ms window of what the stream already
 *     released.
 *
 * The session-death path must release BOTH, and it must do it BEFORE the pane
 * starts dropping writes: PTY_EXIT lands right after the last PTY_DATA, so
 * whatever is still held IS the session's final output. Releasing only the
 * batcher dropped the last line of every session that ended within 16ms of
 * its last output — and a dead session has no replay left to re-fetch it.
 *
 * Zero imports on purpose: the test reaches this module through Node's
 * native type stripping (Node >= 22.18).
 */

/** The part of HighlightStream this module needs. */
export interface FlushableStream {
  /** Release the held bytes as a final text run. */
  flush(): string
}

/** The part of WriteBatcher this module needs. */
export interface FlushableBatcher {
  /** Queue text for the next window. */
  push(text: string): void
  /** Emit the queued text now and cancel the pending window. */
  flushNow(): void
}

/**
 * Push the stream's held bytes into the batcher, then close the batcher's
 * window. The order matters: a flushNow() before the push would close an
 * empty batcher and leave the held text sitting in the next window.
 */
export function flushPendingOutput(stream: FlushableStream, batcher: FlushableBatcher): void {
  const held = stream.flush()
  if (held) batcher.push(held)
  batcher.flushNow()
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node tests/session-flush.mjs`
Expected: PASS —— 4 组断言全 ok，末行 `[session-flush] ALL CHECKS PASSED`，exit 0。

- [ ] **Step 5: 接到 `TerminalView.tsx`**

在 `src/renderer/src/terminal/TerminalView.tsx` 的 import 区加上：

```ts
import { flushPendingOutput } from './sessionFlush'
```

把 `markDead`（当前 `:1493-1501`）改成：

```ts
    const markDead = (code: number): void => {
      // Two buffers may still hold the session's final output: the highlight
      // stream (it holds every escape-free chunk's trailing text run) and the
      // batcher (a ~16ms window of what the stream already released). Both must
      // reach xterm BEFORE the dead flag starts dropping writes — PTY_EXIT
      // lands right after the last PTY_DATA, so what is still held IS the last
      // line of output, and a dead session has no replay to re-fetch it from.
      flushPendingOutput(stream, batcher)
      deadRef.current = true
      setExitCode(code)
      setDead(true)
    }
```

把拆卸路径的注释（当前 `:1626-1630`）改成诚实的版本：

```ts
      // Drop the stream with the session; a fresh one is created next bind so no
      // carry survives across sessions. The held bytes are DISCARDED on purpose:
      // a rebind re-fetches the session replay (which carries the same text),
      // and an unmount disposes the terminal two lines below — writing them
      // would be a no-op at best and a write into a dying terminal at worst.
      // The session-DEATH path does release them (see markDead): that session
      // is gone, so there is no replay to re-fetch.
      streamRef.current?.flush()
```

- [ ] **Step 6: 把新测试加进测试链**

在 `package.json` 的 `scripts.test` 里，把 `node tests/write-batcher.mjs` 后面加上 `node tests/session-flush.mjs`：

```json
"test": "node tests/build-bundles.cjs && ... && node tests/write-batcher.mjs && node tests/session-flush.mjs && ..."
```

- [ ] **Step 7: 全量验证**

Run: `npm run typecheck && npm test`
Expected: exit 0，无新增 FAIL。

- [ ] **Step 8: 提交**

```bash
git add src/renderer/src/terminal/sessionFlush.ts src/renderer/src/terminal/TerminalView.tsx tests/session-flush.mjs package.json
git commit -m "fix(terminal): 会话退出时释放高亮流持有的残留输出"
```

**AGENTS.md**：在「终端尺寸同步」一节的 `markDead` 描述后补一句「高亮流的 carry 也要一起释放（`flushPendingOutput`），否则会话最后一行输出会随会话一起消失」。

---

### Task 2: 选中分段按钮的标签色（对比度回归）

**问题**：`settings.css:201-209` 把选中分段的文字设为 `var(--tab-accent-fg, #fff)`。但 `--tab-accent-fg` 是 `chrome.ts:97` **对 chrome 背景**推导的（深色主题 = 强调色提亮 18%，浅色主题 = 对背景 `darkenToRatio`），而选中分段的填充是 antd 的 `colorPrimary`——`main.tsx:324-330` **从未覆盖它**，所以填充是 antd 默认的 `#1677ff`。实测（用项目自己的 `contrast()`）：

| 主题 | `--tab-accent-fg` | 对 `#1677ff` | antd 原生 `#fff` |
|---|---|---|---|
| 深色 chrome | `#62c670` | **1.92:1** | 4.10:1 |
| 浅色 chrome | `#266f30` | **1.51:1** | 4.10:1 |

受影响：渲染模式单选组（`SettingsTabs.tsx:367-374`，`buttonStyle="solid"`）与语言单选组（`:526-531`）。这是 `beaa6f1` 引入的回归（原本写死 `#fff`）。

**修法**：把"主色填充上的标签色"变成一个**对填充色推导**的量。同时把 `colorPrimary` 固定为应用自己的常量 `#0f66d8`（比 antd 默认 `#1677ff` 略深，肉眼几乎无差），白字对它的对比度是 **5.37:1**，越过 4.5 线。

**Files:**
- Modify: `src/renderer/src/theme/semantic.ts`（新增两个导出）
- Modify: `src/renderer/src/theme/chrome.ts:31-75`（写 `--chrome-on-primary`）
- Modify: `src/renderer/src/main.tsx:324-330`（`colorPrimary`）
- Modify: `src/renderer/src/global.css:2-40`（`:root` 声明）
- Modify: `src/renderer/src/settings/settings.css:199-209`
- Create: `tests/primary-contrast.mjs`
- Modify: `package.json`（test 脚本链）

**Interfaces:**
- Consumes: `semantic.ts` 已有的 `contrast(a, b): number`
- Produces:
  ```ts
  // src/renderer/src/theme/semantic.ts
  export const PRIMARY_COLOR: string   // '#0f66d8'
  export function onPrimaryLabel(): string  // '#ffffff'（对 PRIMARY_COLOR ≥ 4.5:1 时）
  ```

- [x] **Step 1: 写失败的测试**

创建 `tests/primary-contrast.mjs`：

```js
/**
 * Primary-fill label contrast self-test (primary-contrast.mjs).
 *
 * The label drawn on antd's primary fill must be READABLE ON THE FILL, not on
 * the chrome background. The settings dialog's selected radio segment used
 * `--tab-accent-fg` — a token derived against the CHROME BACKGROUND — as its
 * label colour on the primary-blue fill, which measured 1.51:1 in light chrome
 * and 1.92:1 in dark chrome: the selected language / renderer-mode label was
 * effectively invisible.
 *
 * The fix derives the label against the fill itself (`onPrimaryLabel()`) and
 * pins the fill (`PRIMARY_COLOR`), so the two can never drift apart.
 *
 * Direct .ts import (no esbuild bundle needed): semantic.ts has zero imports
 * and Node >= 22.18 strips types itself.
 * Run: node tests/primary-contrast.mjs   (must exit 0)
 */
import { contrast, onPrimaryLabel, PRIMARY_COLOR } from '../src/renderer/src/theme/semantic.ts'

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}

console.log('[primary fill]')
{
  const label = onPrimaryLabel()
  const ratio = contrast(label, PRIMARY_COLOR)
  ok(ratio >= 4.5, `the label on the primary fill reaches 4.5:1 (got ${ratio.toFixed(2)}:1)`)
  ok(contrast('#ffffff', PRIMARY_COLOR) >= 4.5, 'white on the pinned primary reaches 4.5:1')
  ok(contrast(label, PRIMARY_COLOR) >= contrast('#62c670', PRIMARY_COLOR),
    'the derived label beats the old --tab-accent-fg value')
}

console.log('[the old token is not the label colour]')
{
  // --tab-accent-fg (dark chrome) was #62c670 — 1.92:1 on the fill.
  ok(contrast('#62c670', PRIMARY_COLOR) < 4.5, 'the old value is below 4.5:1 on the fill')
  ok(contrast('#266f30', PRIMARY_COLOR) < 4.5, 'the old light-chrome value is below 4.5:1 too')
}

if (failed > 0) {
  console.error(`\n[primary-contrast] ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('\n[primary-contrast] ALL CHECKS PASSED')
```

- [x] **Step 2: 运行测试确认失败**

Run: `node tests/primary-contrast.mjs`
Expected: FAIL —— `SyntaxError: The requested module ... does not provide an export named 'onPrimaryLabel'`。

- [x] **Step 3: 在 `semantic.ts` 加常量与推导函数**

在 `src/renderer/src/theme/semantic.ts` 的 `OtVarName` 类型**之前**插入：

```ts
/**
 * antd's primary fill. The app PINS it (main.tsx sets the antd token
 * `colorPrimary` to this exact value) so the colour of a label drawn on that
 * fill can be DERIVED against the real fill instead of guessed.
 *
 * It is one step darker than antd's own default (#1677ff): the default only
 * reaches 4.10:1 with a white label, while this reaches 5.37:1. The visual
 * delta is imperceptible, and every primary button in the app gains the
 * contrast.
 */
export const PRIMARY_COLOR = '#0f66d8'

/**
 * The readable label colour for text drawn on PRIMARY_COLOR.
 *
 * White is used whenever it clears 4.5:1 against the fill; otherwise the dark
 * ink is. The chrome-background token `--tab-accent-fg` must NOT be used for
 * this: it is derived against the CHROME BACKGROUND, and reusing it as a
 * label on the primary fill measured 1.51:1 (light chrome) / 1.92:1 (dark).
 */
export function onPrimaryLabel(): string {
  return contrast('#ffffff', PRIMARY_COLOR) >= 4.5 ? '#ffffff' : '#101418'
}
```

> **插入位置已确认**：`contrast` 在 `semantic.ts:48`，`OtVarName` 在 `:98`——插在 `OtVarName` 之前即可，`contrast` 已在作用域内。`PRIMARY_COLOR` 是模块级 `const`，模块求值完成前不会被调用，无 TDZ 问题。
>
> `HighlightRule` 上已有 `basic?: boolean`（`src/shared/settings.ts:57`）与 `category?: HighlightCategory`（`:59`），类型上直接可用。

- [x] **Step 4: 在 `chrome.ts` 写 `--chrome-on-primary`**

在 `src/renderer/src/theme/chrome.ts` 的 `applyChromeTheme` 里，`for (const [name, value] of Object.entries(semanticVars(...)))` 那行**之后**加一行：

```ts
  // The label colour for anything drawn on antd's primary fill. Derived
  // against the fill itself (see semantic.ts) — the tab-accent token is
  // derived against the chrome background and lands below 2:1 on that fill.
  style.setProperty('--chrome-on-primary', onPrimaryLabel())
```

并把 import 行改成：

```ts
import { contrast, darkenToRatio, isLightTheme, mix, onPrimaryLabel, semanticVars } from './semantic'
```

- [x] **Step 5: 固定 antd 的 `colorPrimary`**

把 `src/renderer/src/main.tsx` 的 import 行加上 `PRIMARY_COLOR`：

```ts
import { mix, onPrimaryLabel } from './theme/chrome'
import { isLightTheme, PRIMARY_COLOR } from './theme/semantic'
```

（若 `main.tsx` 已从 `./theme/semantic` 导入 `isLightTheme`，就在那一行补 `PRIMARY_COLOR`，不要新增重复 import。）

把 antd 的 token 块（`:324-330`）改成：

```tsx
        token: {
          colorBgBase: colors.background,
          colorBgContainer: mix(colors.background, colors.foreground, 0.06) ?? (light ? '#f5f5f5' : '#1f1f1f'),
          colorBgElevated: mix(colors.background, colors.foreground, 0.1) ?? (light ? '#f5f5f5' : '#252525'),
          colorTextBase: colors.foreground,
          // Pinned (not antd's default #1677ff): the settings dialog draws a
          // label on the primary fill, and the label colour is derived from
          // this exact value. See semantic.ts PRIMARY_COLOR.
          colorPrimary: PRIMARY_COLOR,
          borderRadius: 6
        }
```

- [x] **Step 6: `global.css` 增加 `:root` 兜底**

在 `src/renderer/src/global.css` 的 `:root` 块里，`--chrome-tab-fg-hover: #d0d0d0;` 那一行**之后**加：

```css
  /* Label colour for anything drawn on antd's primary fill; overwritten per
     theme by applyChromeTheme(). */
  --chrome-on-primary: #ffffff;
```

并把 `tests/css-theme-vars.mjs` 里 `'global.css'` 的白名单集合补上 `'#ffffff'`：

```js
  'global.css': new Set([
    '#181818', '#cccccc', '#2d2d2d', '#3b8eea', '#2a2a2a', '#101418', '#98a2ab', '#d0d0d0',
    '#8a8a8a', '#3fb950', '#f85149', '#d29922', '#58a6ff', '#ff6b6b', '#ffffff',
    'rgba(255, 255, 255, 0.04)', 'rgba(255, 255, 255, 0.07)', 'rgba(255, 255, 255, 0.1)',
    'rgba(255, 255, 255, 0.2)', 'rgba(255, 255, 255, 0.08)', 'rgba(255, 255, 255, 0.16)',
    'rgba(204, 204, 204, 0.78)', 'rgba(204, 204, 204, 0.05)',
    'rgba(24, 26, 31, 0.85)', 'rgba(125, 145, 170, 0.5)', 'rgba(150, 172, 200, 0.7)',
    'rgba(0, 0, 0, 0.45)', 'rgba(59, 142, 234, 0.2)'
  ]),
```

> `theme/chrome.ts` 的白名单已经含 `'#ffffff'`，无需改动。

- [x] **Step 7: 设置页改用新 token**

把 `src/renderer/src/settings/settings.css:199-209` 整段替换为：

```css
/* Selected segment: the filled (primary) background needs a light label.
   The label colour is derived against the FILL (--chrome-on-primary), not
   against the chrome background — the tab-accent token landed at 1.5-1.9:1
   on this blue and made the selected language / renderer-mode unreadable. */
.settings-radio-group .ant-radio-button-wrapper-checked:not(.ant-radio-button-wrapper-disabled),
.settings-language-group .ant-radio-button-wrapper-checked:not(.ant-radio-button-wrapper-disabled) {
  color: var(--chrome-on-primary, #fff);
}

.settings-radio-group .ant-radio-button-wrapper-checked:not(.ant-radio-button-wrapper-disabled):hover,
.settings-language-group .ant-radio-button-wrapper-checked:not(.ant-radio-button-wrapper-disabled):hover {
  color: var(--chrome-on-primary, #fff);
}
```

- [ ] **Step 8: 把新测试加进测试链**

在 `package.json` 的 `scripts.test` 里，`node tests/theme-contrast.mjs` 后面加 `node tests/primary-contrast.mjs`。

- [x] **Step 9: 运行测试确认通过**

Run: `node tests/primary-contrast.mjs && node tests/css-theme-vars.mjs && node tests/ot-var-names.mjs && node tests/semantic-theme.mjs`
Expected: 全部 exit 0。

- [ ] **Step 10: 全量验证**

Run: `npm run typecheck && npm test`
Expected: exit 0。

- [ ] **Step 11: 提交**

```bash
git add src/renderer/src/theme/semantic.ts src/renderer/src/theme/chrome.ts src/renderer/src/main.tsx src/renderer/src/global.css src/renderer/src/settings/settings.css tests/primary-contrast.mjs tests/css-theme-vars.mjs package.json
git commit -m "fix(theme): 选中分段标签改用对填充色推导的标签色"
```

**AGENTS.md**：在「主题机制」一节补一条：「antd 的 `colorPrimary` 由应用固定为 `semantic.ts` 的 `PRIMARY_COLOR`；画在主色填充上的标签色用 `onPrimaryLabel()` 对**填充色**推导，不要用对 chrome 背景推导的 `--tab-accent-fg`」。

---

### Task 3: 模板应用只回灌真正被触碰的 dockview

**问题**：`Workspace.tsx:1129/1131/1135` 在调用 `fromJSON` **之前**就置 `terminalTouched = true` / `sshTouched = true`。但 dockview 的 `_doFromJSON` 先校验再改状态——`node_modules/dockview-core/dist/dockview-core.js:16583-16584`：

```js
if (typeof data !== "object" || data === null) throw new Error("dockview: serialized layout must be a non-null object");
if (!data.grid || data.grid.root?.type !== "branch" || !Array.isArray(data.grid.root.data)) throw new Error("dockview: root must be of type branch");
```

`this.clear()` 在 `:16693` / `:16697`——**在校验之后**。所以畸形 payload 根本不会清空 dockview，活面板毫发无损。

但 catch 分支（`Workspace.tsx:1145-1152`）看到 `terminalTouched=true` 就回灌快照 → `fromJSON(snapshot)` 这次过了校验 → `clear()` → `onDidRemovePanel` → `releaseSession` → `killSession` → **活着的本地终端全部被杀**。双布局更糟：`sshTouched=true` 也会在 ssh 抛错时把 ssh dockview 清掉。

这正好违反 AGENTS.md「布局模板」一节的"只回灌**这次真的被 `fromJSON` 触碰的** dockview"。

**Files:**
- Create: `src/renderer/src/workspace/templateApply.ts`
- Create: `tests/template-apply.mjs`
- Modify: `src/renderer/src/workspace/Workspace.tsx:1121-1152`
- Modify: `package.json`（test 脚本链）

**Interfaces:**
- Consumes: 无（纯模块）
- Produces:
  ```ts
  // src/renderer/src/workspace/templateApply.ts
  export interface DockviewLike {
    fromJSON(data: unknown): void
    toJSON(): unknown
  }
  export interface TemplateApplyResult {
    terminalTouched: boolean
    sshTouched: boolean
    error?: unknown
  }
  export function applyTemplatePayload(
    terminalApi: DockviewLike | undefined,
    sshApi: DockviewLike | undefined,
    payload: { terminal?: unknown; ssh?: unknown },
    hasDualLayout: boolean
  ): TemplateApplyResult
  ```

- [ ] **Step 1: 写失败的测试**

创建 `tests/template-apply.mjs`：

```js
/**
 * Template-apply touched-dockview self-test (template-apply.mjs).
 *
 * dockview validates a serialized layout BEFORE it clears anything
 * (dockview-core: `if (!data.grid || data.grid.root?.type !== "branch" ...)
 * throw` runs ahead of `this.clear()`), so a malformed payload leaves the
 * dockview — and every live session in it — completely untouched.
 *
 * The workspace used to mark a dockview as "touched" BEFORE calling
 * fromJSON, so the recovery path then restored a snapshot into a dockview the
 * template never reached: restoring CLEARS the dockview, and the
 * `onDidRemovePanel` that follows kills the sessions of the panels that were
 * still alive. A corrupt template therefore destroyed every live terminal.
 *
 * Direct .ts import (no esbuild bundle needed): the module has no imports and
 * Node >= 22.18 strips types itself.
 * Run: node tests/template-apply.mjs   (must exit 0)
 */
import { applyTemplatePayload } from '../src/renderer/src/workspace/templateApply.ts'

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}

/** A dockview double: `fromJSON` throws when `throwOn` matches the payload. */
const makeApi = (throwOn) => {
  const api = {
    loaded: [],
    fromJSON(data) {
      if (throwOn && throwOn(data)) throw new Error('dockview: root must be of type branch')
      api.loaded.push(data)
    },
    toJSON() {
      return { grid: { root: { type: 'branch', data: [] } } }
    }
  }
  return api
}

console.log('a malformed terminal payload leaves the terminal dockview untouched')
{
  const terminal = makeApi(() => true)
  const ssh = makeApi(() => false)
  const res = applyTemplatePayload(terminal, ssh, { terminal: { grid: null } }, true)
  ok(res.error !== undefined, 'the failure is reported to the caller')
  ok(res.terminalTouched === false, 'the terminal dockview is NOT marked as touched')
  ok(res.sshTouched === false, 'the ssh dockview is NOT marked as touched')
}

console.log('a successful terminal load followed by a failing ssh load')
{
  const terminal = makeApi(() => false)
  const ssh = makeApi(() => true)
  const res = applyTemplatePayload(terminal, ssh, { terminal: { a: 1 }, ssh: { b: 2 } }, true)
  ok(res.error !== undefined, 'the failure is reported to the caller')
  ok(res.terminalTouched === true, 'the terminal dockview WAS touched (it loaded)')
  ok(res.sshTouched === false, 'the ssh dockview was NOT touched (it threw before loading)')
}

console.log('a fully successful dual load')
{
  const terminal = makeApi(() => false)
  const ssh = makeApi(() => false)
  const res = applyTemplatePayload(terminal, ssh, { terminal: { a: 1 }, ssh: { b: 2 } }, true)
  ok(res.error === undefined, 'no error is reported')
  ok(res.terminalTouched === true && res.sshTouched === true, 'both dockviews are marked as touched')
  ok(terminal.loaded.length === 1 && ssh.loaded.length === 1, 'each dockview loaded exactly once')
}

console.log('a legacy single-dockview payload loads into the terminal dockview')
{
  const terminal = makeApi(() => false)
  const ssh = makeApi(() => false)
  const res = applyTemplatePayload(terminal, ssh, { grid: { root: { type: 'branch', data: [] } } }, false)
  ok(res.error === undefined, 'no error is reported')
  ok(res.terminalTouched === true, 'the terminal dockview is marked as touched')
  ok(res.sshTouched === false, 'the ssh dockview is never touched by a legacy payload')
  ok(terminal.loaded.length === 1, 'the terminal dockview loaded the payload')
  ok(ssh.loaded.length === 0, 'the ssh dockview was not touched at all')
}

console.log('a missing dockview api is not a crash')
{
  const res = applyTemplatePayload(undefined, undefined, { terminal: { a: 1 } }, true)
  ok(res.error === undefined, 'a missing api is skipped, not an error')
  ok(res.terminalTouched === false && res.sshTouched === false, 'nothing is marked as touched')
}

if (failed > 0) {
  console.error(`\n[template-apply] ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('\n[template-apply] ALL CHECKS PASSED')
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/template-apply.mjs`
Expected: FAIL —— `ERR_MODULE_NOT_FOUND`（`templateApply.ts` 还不存在）。

- [ ] **Step 3: 实现纯模块**

创建 `src/renderer/src/workspace/templateApply.ts`：

```ts
/**
 * Apply a workspace template payload to the two dockviews.
 *
 * The point of this module is ONE question: which dockview did the template
 * actually reach? dockview validates a serialized layout BEFORE it clears
 * anything (dockview-core throws "root must be of type branch" ahead of
 * `this.clear()`), so a malformed payload leaves the dockview — and every
 * live session in it — completely untouched.
 *
 * The workspace used to answer that question by marking a dockview as
 * "touched" BEFORE calling fromJSON. The recovery path then restored a
 * snapshot into a dockview the template never reached, and restoring CLEARS
 * the dockview: the `onDidRemovePanel` that follows kills the sessions of the
 * panels that were still alive. A corrupt template therefore destroyed every
 * live terminal.
 *
 * The rule here is the opposite: a dockview counts as touched only after its
 * fromJSON RETURNED. A dockview whose fromJSON threw was not modified, so the
 * caller must not restore a snapshot into it.
 *
 * Zero imports on purpose: the test reaches this module through Node's
 * native type stripping (Node >= 22.18).
 */

/** The part of a DockviewReact api this module needs. */
export interface DockviewLike {
  fromJSON(data: unknown): void
  toJSON(): unknown
}

/** Which dockviews the payload actually reached, and why it stopped. */
export interface TemplateApplyResult {
  /** The terminal dockview loaded the payload (it must be restored on failure). */
  terminalTouched: boolean
  /** The ssh dockview loaded the payload (it must be restored on failure). */
  sshTouched: boolean
  /** The error that stopped the load, if any. */
  error?: unknown
}

/**
 * Load the payload into the dockviews it belongs to.
 *
 * `hasDualLayout` is false for the legacy (pre-M6.1) single-dockview format,
 * whose payload goes wholly into the terminal dockview.
 */
export function applyTemplatePayload(
  terminalApi: DockviewLike | undefined,
  sshApi: DockviewLike | undefined,
  payload: { terminal?: unknown; ssh?: unknown },
  hasDualLayout: boolean
): TemplateApplyResult {
  let terminalTouched = false
  let sshTouched = false
  try {
    if (hasDualLayout) {
      if (terminalApi) {
        terminalApi.fromJSON(payload.terminal)
        terminalTouched = true
      }
      if (sshApi) {
        sshApi.fromJSON(payload.ssh)
        sshTouched = true
      }
    } else if (terminalApi) {
      terminalApi.fromJSON(payload as unknown)
      terminalTouched = true
    }
  } catch (error) {
    return { terminalTouched, sshTouched, error }
  }
  return { terminalTouched, sshTouched }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node tests/template-apply.mjs`
Expected: PASS —— 5 组断言全 ok，exit 0。

- [ ] **Step 5: 接到 `Workspace.tsx`**

在 `src/renderer/src/workspace/Workspace.tsx` 的 import 区加上：

```ts
import { applyTemplatePayload, type DockviewLike } from './templateApply'
```

把 `Workspace.tsx:1117-1202` 那一整段（从 `// Which dockview the payload reached` 注释一直到 `activePanelRef.current = apiOfMode(...)`）替换为下面这段：

```tsx
        // Which dockview the payload reached — a failed load must not put a
        // snapshot back into one it never touched: restoring a dockview wipes
        // the panels that are still alive in it (and, through `onDidRemovePanel`,
        // kills the sessions behind them).
        //
        // dockview validates the payload BEFORE it clears anything (it throws
        // "root must be of type branch" ahead of `this.clear()`), so a malformed
        // layout leaves the dockview untouched — which means it must NOT be
        // restored. `applyTemplatePayload` marks a dockview as touched only
        // after its fromJSON RETURNED, so these flags are the truth.
        const applied = applyTemplatePayload(
          terminalApiRef.current as unknown as DockviewLike | undefined,
          sshApiRef.current as unknown as DockviewLike | undefined,
          payload,
          hasDualLayout
        )
        const sshTouched = applied.sshTouched
        if (applied.error !== undefined) {
          console.error('[workspace] template apply failed', meta.id, applied.error)
          // The wipe took the panels down with it — and `onDidRemovePanel` took
          // their sessions, so the user is left with an empty workspace and
          // nothing to reattach to. Put each touched dockview back from its
          // snapshot, then give every pane that comes back a fresh session: the
          // one it used to show is gone.
          if (applied.terminalTouched && terminalSnapshot) {
            restoreLayoutSnapshot(terminalApiRef.current, terminalSnapshot)
            if (terminalApiRef.current) await rebindRestoredPanels(terminalApiRef.current)
          }
          if (applied.sshTouched && sshSnapshot) {
            restoreLayoutSnapshot(sshApiRef.current, sshSnapshot)
            if (sshApiRef.current) await rebindRestoredPanels(sshApiRef.current)
          }
          // No session may outlive its panels: the dockview the payload never
          // reached still shows its own (they stay), everything else goes.
          const live = new Set<string>()
          for (const api of [terminalApiRef.current, sshApiRef.current]) {
            for (const panel of api?.panels ?? []) {
              const sid = sessionIdOf(panel)
              if (sid) live.add(sid)
            }
          }
          for (const sid of previousSessions) if (!live.has(sid)) killSession(sid)
          // The panel counters and the sidebar list describe the aborted load,
          // not the layout that is back; rebuild both from the panels that are
          // actually here.
          recountAll()
          recomputeLocalPanels()
          const mode = useWorkspaceModeStore.getState().mode
          activePanelRef.current = apiOfMode(mode, terminalApiRef.current, sshApiRef.current)?.activePanel
          message.error(t('workspace.template.applyFailedRestored'))
          return
        }

        // Fresh sessions for every restored terminal panel. Only a dockview the
        // payload actually reached may be rebound: `rebindRestoredPanels`
        // rewrites each panel's params to a fresh *local* session, so running it
        // over a legacy template's untouched ssh workspace would demote its live
        // SSH panes to local terminals.
        if (terminalApiRef.current) await rebindRestoredPanels(terminalApiRef.current)
        if (sshTouched && sshApiRef.current) await rebindRestoredPanels(sshApiRef.current)

        // A template carries the tab titles it was saved with, which may be in
        // another language (or written by a build whose language the user has
        // since switched away from).
        retitleAutoPanels()

        // Old sessions are unreachable after the layout swap — kill them, but
        // only the ones no panel shows any more: a legacy template never reached
        // the ssh dockview, whose panes keep their live SSH sessions (the same
        // `live` test the failure path uses).
        const live = new Set<string>()
        for (const api of [terminalApiRef.current, sshApiRef.current]) {
          for (const panel of api?.panels ?? []) {
            const sid = sessionIdOf(panel)
            if (sid) live.add(sid)
          }
        }
        for (const sid of previousSessions) if (!live.has(sid)) killSession(sid)
        recountAll()
        recomputeLocalPanels()
        const mode = useWorkspaceModeStore.getState().mode
        activePanelRef.current = apiOfMode(mode, terminalApiRef.current, sshApiRef.current)?.activePanel
```

> **`sshTouched` 的来源变了**：原代码里它是 `let sshTouched = false` 局部变量，成功路径 `:1180` 也在用。改写后它是 `const sshTouched = applied.sshTouched`——语义与原来一致（"这个 dockview 被模板真正碰到过"），但现在由纯模块判定，不再是"调用前就置 true"。
>
> **`try/catch` 这层壳被移除了**：原来 `fromJSON` 在 try 里、恢复逻辑在 catch 里。现在调用发生在纯模块内部，错误以 `applied.error` 返回——**不要留一个空的 try/catch**。
>
> **注意**：`retitleAutoPanels()` 之后那段 `live` 集合计算与 `killSession` 在**成功路径和失败路径里各有一份**（原代码就是这样：失败路径的副本在 catch 里，成功路径的副本在 try 之后）。改写后失败路径的副本在 `if (applied.error !== undefined)` 块内、成功路径的副本在块外——**两份都保留**，不要合并（合并会让失败路径提前 kill 掉还没恢复的会话）。

- [ ] **Step 6: 把新测试加进测试链**

在 `package.json` 的 `scripts.test` 里，`node tests/write-batcher.mjs` 后面（Task 1 加的位置再往后）加 `node tests/template-apply.mjs`。

- [ ] **Step 7: 全量验证**

Run: `npm run typecheck && npm test`
Expected: exit 0。

- [ ] **Step 8: 提交**

```bash
git add src/renderer/src/workspace/templateApply.ts src/renderer/src/workspace/Workspace.tsx tests/template-apply.mjs package.json
git commit -m "fix(workspace): 模板失败时只回灌真正被触碰的 dockview"
```

---

# Wave 2 — 护栏与升级路径（P1）

### Task 4: 给 `MAX_REPLAY_SEQUENCES` 补边界测试

**问题**：`highlightEngine.ts:413` 的 `MAX_REPLAY_SEQUENCES = 3` 是防止"回放放大 4.30x / 渲染线程冻结 18.4s"的那道闸门（AGENTS.md「关键词高亮」四护栏之二）。闸门逻辑在 `SgrState.restore`（`:432-434`）：`this.count > 0 && this.count <= MAX_REPLAY_SEQUENCES ? this.value : ''`。

但**唯一**覆盖它的测试是 `tests/hl-rules.mjs:1216-1239` 的 `[restore cost budget]`，它的样本每行只有 1 个 SGR + 1 个 reset → `count` 永远不超过 3 → **把闸门改成 999 或删掉，测试照样全绿**。

**Files:**
- Modify: `tests/hl-rules.mjs`（在 `[restore cost budget]` 段之后新增一段）

- [ ] **Step 1: 写失败的测试**

在 `tests/hl-rules.mjs` 的 `[restore cost budget]` 段（`:1216-1239`）**之后**插入：

```js
console.log('[replay sequence gate]')
{
  // The replay budget is counted in SEQUENCES (MAX_REPLAY_SEQUENCES = 3), not
  // bytes. The cost-budget case above only ever holds ONE sequence before the
  // span, so it can never fail when the gate is raised or deleted — and this
  // gate is the one that stopped a 4.30x chunk inflation from freezing the
  // render thread for 18.4s.
  const warn = compile([{ id: 'w', pattern: 'WARNING', priority: 1, color: { fg: '#ff0000' } }])
  const countOf = (hay, needle) => hay.split(needle).length - 1

  const state3 = '\x1b[33m\x1b[1m\x1b[4m'
  const state4 = state3 + '\x1b[7m'

  const three = applyHighlights(`${state3}WARNING tail`, warn)
  ok(
    countOf(three, state3) === 2,
    `a state of three sequences is still replayed after the span (got ${countOf(three, state3)})`
  )

  const four = applyHighlights(`${state4}WARNING tail`, warn)
  ok(
    countOf(four, state4) === 1,
    `a state of four sequences is NOT replayed (got ${countOf(four, state4)})`
  )
  ok(
    countOf(four, state3) === 1,
    'the four-sequence state is dropped whole — no truncated three-sequence copy is replayed'
  )
}
```

> **这三个断言的数值已用真实引擎实测确认**（esbuild 打包 `highlightEngine.ts` + `ruleValidation.ts` + `redosProbes.ts` 成同一份 bundle，与 `tests/hl-rules.mjs` 的做法一致）：
> - `three` 的输出是 `"\x1b[33m\x1b[1m\x1b[4m" + "\x1b[38;2;255;0;0mWARNING\x1b[0m" + "\x1b[33m\x1b[1m\x1b[4m tail"` → `countOf(three, state3) === 2` ✓
> - `four` 的输出是 `"\x1b[33m\x1b[1m\x1b[4m\x1b[7m" + "\x1b[38;2;255;0;0mWARNING\x1b[0m tail"` → `countOf(four, state4) === 1` ✓
>
> **注意**：`state4 = state3 + '\x1b[7m'`，所以 `four` 天然包含 `state3` 作为前缀——**断言必须是 `countOf(...) === 1`（计数），不能用 `!four.includes(state3)`（包含）**，后者恒为 false 会让用例在实现正确时也变红。
>
> **另一处易错点**：`compile()` 之外的 `compileRules()` 会走 ReDoS 证明闸门，手写规则没有 proof 就是**惰性的**（不匹配任何东西）。本用例必须用文件里现成的 `compile()` 辅助函数（`tests/hl-rules.mjs:71`，它给每条手写规则盖上 proof）。`enabled` 字段可以不写（`compileRules` 缺省为 true）。

- [ ] **Step 2: 运行测试确认当前实现下通过**

Run: `node tests/build-bundles.cjs && node tests/.hl-rules.cjs`
Expected: **PASS**（当前实现是对的——这一步确认的是用例本身能跑）。

- [ ] **Step 3: 证明这条用例真的有牙齿（临时变异验证）**

临时把 `src/renderer/src/terminal/highlightEngine.ts:413` 改成：

```ts
const MAX_REPLAY_SEQUENCES = 999
```

Run: `node tests/build-bundles.cjs && node tests/.hl-rules.cjs`
Expected: **FAIL** —— `a state of four sequences is NOT replayed`。

把常量改回 `3`，重新 `node tests/build-bundles.cjs && node tests/.hl-rules.cjs`，Expected: PASS。

> 这一步是本任务的核心价值：**证明闸门现在真的被守住了**。变异验证没做完不算完成。

- [ ] **Step 4: 全量验证**

Run: `npm run typecheck && npm test`
Expected: exit 0。

- [ ] **Step 5: 提交**

```bash
git add tests/hl-rules.mjs
git commit -m "test(highlight): 给 SGR 回放序列数闸门补边界用例"
```

**AGENTS.md**：在「关键词高亮」的 SGR 四护栏②那一条后面补一句「闸门有边界用例（3 放行 / 4 丢弃），改 `MAX_REPLAY_SEQUENCES` 必须让 `tests/hl-rules.mjs` 变红」。

---

### Task 5: 收紧 `css-theme-vars.mjs` 扫描器

**问题**：`tests/css-theme-vars.mjs` 是 AGENTS.md 指定的 fail-closed 闸门，但它有三个实测可绕过的口子：

| 位置 | 问题 |
|---|---|
| `:74` | `COLOR = /#[0-9a-fA-F]{3,8}\b(?![-\w])|rgba?\([^)]*\)/g` —— 只认 `#hex` 和 `rgb()/rgba()`。**CSS 具名颜色（`red`）、`hsl()`、`hsla()`、`oklch()`、`lab()`、`lch()` 全部漏过**，而它们在浅色主题下同样是"主题盲"的颜色。 |
| `:82` | `.replace(/color-mix\([^)]*\)/g, '()')` —— 把 `color-mix(...)` **整段抹掉**再扫描，于是 `color-mix(in srgb, #ff0000 50%, transparent)` 里的 hex 看不见。 |
| `:85` | `if (line.includes('${')) return` —— 跳过**任何**含 `${` 的行，于是模板字符串行上的真实字面量逃逸。 |

**Files:**
- Modify: `tests/css-theme-vars.mjs`

- [ ] **Step 1: 写失败的负向自测**

把 `tests/css-theme-vars.mjs` 末尾的负向自测块（当前 `:106-114`）替换为：

```js
// Negative self-test: the matcher must catch literals incl. 3/4-digit hex
{
  const probe = stripComments('.a{color:#fff9;border:#abcd}')
  const hits = [...probe.matchAll(COLOR)].length
  if (hits < 2) {
    console.error('self-test failed: matcher did not catch probe literals')
    process.exit(1)
  }
}
// Negative self-test: the families that used to pass the scanner.
{
  // The named colour is case-insensitive (CSS keywords are), the functional
  // notations are NOT (see the two-regex split below).
  const families = [
    ['a named colour', '.a{color:red}', 'red', 'named'],
    ['an hsl() colour', '.a{color:hsl(0,100%,50%)}', 'hsl(0,100%,50%)', 'func'],
    ['an hsla() colour', '.a{color:hsla(0,100%,50%,0.5)}', 'hsla(0,100%,50%,0.5)', 'func'],
    ['an oklch() colour', '.a{color:oklch(0.7 0.1 200)}', 'oklch(0.7 0.1 200)', 'func'],
    ['a lab() colour', '.a{color:lab(50% 40 59)}', 'lab(50% 40 59)', 'func'],
    ['a lch() colour', '.a{color:lch(50% 40 59)}', 'lch(50% 40 59)', 'func']
  ]
  for (const [label, source, literal, kind] of families) {
    const re = kind === 'named' ? NAMED_COLOR : COLOR
    const hits = [...stripComments(source).matchAll(re)].map((m) => m[0].toLowerCase())
    if (!hits.includes(literal)) {
      console.error(`self-test failed: matcher did not catch ${label} (${literal})`)
      process.exit(1)
    }
  }
}
// Negative self-test: a color-mix() body must not hide its own literals.
{
  const body = 'color-mix(in srgb, #ff0000 50%, transparent)'
  const hits = [...stripComments(`.a{${body}}`).matchAll(COLOR)].map((m) => m[0].toLowerCase())
  if (!hits.includes('#ff0000')) {
    console.error('self-test failed: matcher did not catch a hex inside color-mix()')
    process.exit(1)
  }
}
// Negative self-test: a functional notation must NOT match a TypeScript type
// annotation. The `i` flag on a combined regex makes `rgb(` match `Rgb(hex:
// string)` — which is why the functional notations stay case-sensitive.
{
  const hits = [...stripComments('const f = (x: Rgb(hex: string)) => x').matchAll(COLOR)]
  if (hits.length > 0) {
    console.error('self-test failed: the matcher caught a TypeScript type annotation')
    process.exit(1)
  }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/css-theme-vars.mjs`
Expected: FAIL —— `self-test failed: matcher did not catch a named colour (red)`。

- [ ] **Step 3: 扩展 `COLOR` 并收紧两处跳过**

把 `tests/css-theme-vars.mjs:74` 的 `COLOR` 拆成**两条**正则，替换原定义：

```js
/** hex + the functional colour notations.
 *  CASE-SENSITIVE on purpose: with an `i` flag `rgb(` also matches
 *  `Rgb(hex: string)` — a TypeScript type annotation, not a colour. */
const COLOR =
  /#[0-9a-fA-F]{3,8}\b(?![-\w])|rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\)|(?:ok)?lab\([^)]*\)|lch\([^)]*\)/g
/** The CSS named colours. Case-insensitive (CSS keywords are), but ONLY in a
 *  value position — and never as a property name:
 *   - the lookbehind puts it after `:` / `,` / `(` or at the start of a
 *     declaration, so prose in a string is not a hit;
 *   - the trailing (?![\-\w]) keeps `white-space: nowrap` from matching the
 *     "white" in the property NAME. Without it that one property alone
 *     produces 60 false positives across the renderer.
 *  Measured on this repo: the naive named-colour regex (no guards) reports 183
 *  hits, of which 86 are `white-space`; with both guards it reports 0. */
const NAMED_COLOR =
  /(?<=^|[:(,]\s*|\s)(?:red|green|blue|black|white|gray|grey|yellow|orange|purple|pink|cyan|magenta|brown|silver|gold|beige|ivory|khaki|lime|maroon|navy|olive|teal|tomato|violet|aqua|coral|crimson|indigo|lavender|plum|orchid|salmon|sienna|tan|wheat|azure)\b(?![\-\w])/gi
```

> JS 支持变长 lookbehind（V8），所以 `(?<=^|[:(,]\s*|\s)` 合法。lookbehind 是零宽的，`m[0]` 仍是颜色名本身（`"red"`），上面自测里的 `hits.includes(literal)` 才成立。

把扫描主循环（`:84-92`）里的 `for (const m of line.matchAll(COLOR))` 改成**两条都扫**：

```js
    for (const m of line.matchAll(COLOR)) {
      const lit = m[0].toLowerCase()
      if (wl && wl.has(lit)) continue
      console.error(`RAW ${rel}:${idx + 1}: ${lit}`)
      violations++
    }
    for (const m of line.matchAll(NAMED_COLOR)) {
      const lit = m[0].toLowerCase()
      if (wl && wl.has(lit)) continue
      console.error(`RAW ${rel}:${idx + 1}: ${lit}`)
      violations++
    }
```

把 `:82` 的扫描行改成（**不再抹掉 color-mix 的整个 body**，只把 `var()` 的 fallback 摘掉；color-mix 内部改由上面那条 `COLOR` 自己识别）：

```js
  const outsideVar = raw.replace(/var\([^)]*\)/g, '()')
```

把 `:85` 的整行跳过改成**只跳过真正的模板插值行**——判定标准：该行里 `${` 出现在一个**反引号字符串**内部。实现上先把带插值的模板字面量整体摘掉：

```js
  // A template literal that INTERPOLATES may build a colour from variables
  // (MonitorPanel's withAlpha constructs rgba() from a resolved hex) and
  // carries no literal to police. A template literal with no interpolation is
  // just a string — its contents are still a literal.
  const outsideVar = raw
    .replace(/var\([^)]*\)/g, '()')
    .replace(/`(?:[^`\\]|\\.)*\$\{[^}]*\}(?:[^`\\]|\\.)*`/g, '()')
```

并把 `:85` 的跳过行删掉（不再需要）：

```js
//     if (line.includes('${')) return   ← 删除
```

> **实施注意**：`.replace(/var\([^)]*\)/g, '()')` 会把 `var(--ot-text, #fff)` 的 fallback 一起吃掉，所以 fallback 检查（`:93-104`）必须继续跑在**原始 `raw`** 上，不能跑在 `outsideVar` 上——现有代码已经是这样，别改。

- [ ] **Step 4: 运行测试确认通过**

Run: `node tests/css-theme-vars.mjs`
Expected: PASS —— `css-theme-vars: all ok`，exit 0。

- [ ] **Step 5: 跑一次全仓扫描，确认新规则没有挖出真违规**

Run: `npm test`
Expected: exit 0。

**这一步的结果已经预演过**（用计划里的 `COLOR` 正则 + 扫描器现有的 `stripComments` / `var()` 处理跑遍 `src/renderer/src`）：命中的 97 处**全部是旧正则本来就会命中**的那些真实字面量（`#hex` / `rgba()`），它们已经在各文件的 `WHITELIST` 里；**新增的颜色族（具名色 / `hsl()` / `oklch()` / `lab()` / `lch()`）在本仓命中 0 处**。

所以：
- 若 `npm test` 直接变绿 → 仓库本来就没有这些写法的违规，Task 5 收工；
- 若变红 → 每一条 `RAW <file>:<line>` 都是**真的**违规（不是误报），逐条改成 `var(--ot-*, 锚点兜底)`，或——确实是 antd/图表的有意为之——加进该文件的 `WHITELIST` 集合并写一行注释说明为什么。

> 不要给具名色加"宽松放行"：**本仓现在一个具名色都没用**，一旦放行就等于把这道闸门重新拆掉。

- [ ] **Step 6: 全量验证**

Run: `npm run typecheck && npm test`
Expected: exit 0。

- [ ] **Step 7: 提交**

```bash
git add tests/css-theme-vars.mjs src/renderer/src
git commit -m "test(theme): 收紧裸颜色扫描器，补具名色与 color-mix 自测"
```

**AGENTS.md**：在「主题机制」一节 CSS 那条后面补「扫描器覆盖 `#hex` / `rgb()` / `hsl()` / `oklch()` / `lab()` / `lch()` / CSS 具名颜色，且不放过 `color-mix()` 体内的字面量」。

---

### Task 6: 升级时补齐 `basic` / `category` 元数据

**问题**：`src/shared/settings.ts:586-590` 是**模块加载时**给预设对象补 `basic` / `category` 的；而 `src/main/settingsStore.ts:262` 的 `refreshBuiltinRules` 只从预设取 `pattern` + `caseInsensitive`。

git 证据（`git log -S`）：`basic: true`、`highlightMode`、okstate/badstate 的 pattern 变更**全部落在同一个 commit `e08e1cf`**。所以比它老的安装，存的 okstate/badstate 规则既没有 `basic` 也没有 `category`，升级时被刷新了 pattern 却仍然没有这两个字段 → **basic 模式下 SUCCESS/PASS/OK/DONE 与 FAILED/ERROR 全部不再着色**，设置页的分类分组也把它们归到"无分类"。

**Files:**
- Modify: `src/main/settingsStore.ts:251-263`（`refreshBuiltinRules`）
- Modify: `tests/settings-store.mjs`

- [x] **Step 1: 写失败的测试**

在 `tests/settings-store.mjs` 末尾（`if (failed > 0) { … }` 之前）插入：

```js
// ---- preset upgrade keeps the basic / category metadata -------------------
console.log('[preset upgrade metadata]')
{
  // The `basic` flag and the `category` came in with the preset overhaul
  // (the same commit that changed the okstate/badstate patterns), so an install
  // older than that has neither. The refresh took the pattern from the preset
  // but not the tags — so the upgraded rules dropped out of the `basic`
  // highlight mode and out of the category grouping in the settings page.
  const legacyOk = {
    id: 'okstate',
    pattern: '\\b(SUCCESS|PASS|OK|DONE|PASSED)\\b',
    enabled: true,
    priority: 20,
    color: { fg: '#3fb950' },
    builtin: true
  }
  const legacyBad = {
    id: 'badstate',
    pattern: '\\b(FAILED|ERROR|FAIL|FATAL|WARN|WARNING|DENIED)\\b',
    enabled: true,
    priority: 21,
    color: { fg: '#f85149' },
    builtin: true
  }
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({ highlightRules: [legacyOk, legacyBad] }),
    'utf8'
  )
  const loaded = store.loadSettings()
  const okRule = loaded.highlightRules.find((r) => r.id === 'okstate')
  const badRule = loaded.highlightRules.find((r) => r.id === 'badstate')
  ok(okRule !== undefined, 'the legacy okstate rule survived the load')
  ok(
    okRule.pattern !== legacyOk.pattern,
    'the legacy okstate pattern was upgraded to the current preset'
  )
  ok(okRule.basic === true, 'the upgraded okstate keeps the basic flag')
  ok(okRule.category === 'status', `the upgraded okstate keeps the category (got ${okRule.category})`)
  ok(badRule !== undefined, 'the legacy badstate rule survived the load')
  ok(badRule.basic === true, 'the upgraded badstate keeps the basic flag')
  ok(badRule.category === 'status', `the upgraded badstate keeps the category (got ${badRule.category})`)
  ok(okRule.color.fg === '#3fb950', "the user's own colour survived the upgrade")
}
```

- [x] **Step 2: 运行测试确认失败**

Run: `node tests/build-bundles.cjs && node tests/settings-store.mjs`
Expected: FAIL —— `the upgraded okstate keeps the basic flag`。

- [x] **Step 3: 实现修复**

把 `src/main/settingsStore.ts:260-262` 这三行：

```ts
    changed = true
    warnings.push(`highlightRules.${rule.id}: preset pattern updated`)
    return { ...rule, pattern: preset.pattern, caseInsensitive: preset.caseInsensitive }
```

改成：

```ts
    changed = true
    warnings.push(`highlightRules.${rule.id}: preset pattern updated`)
    // The preset's own tags come along with the pattern. `basic` and
    // `category` were introduced by the same commit that changed these
    // patterns, so an install older than that carries neither: refreshing the
    // pattern alone left the rule out of the `basic` highlight mode and out
    // of the category grouping in the settings page. A tag the preset does not
    // define is left alone — that is the user's own marking of a rule.
    return {
      ...rule,
      pattern: preset.pattern,
      caseInsensitive: preset.caseInsensitive,
      ...(preset.basic === true ? { basic: true } : {}),
      ...(preset.category !== undefined ? { category: preset.category } : {})
    }
```

> `preset` 的类型是 `HighlightRule`，`basic` / `category` 已在该类型上（`src/shared/settings.ts`），直接取用即可。

- [x] **Step 4: 运行测试确认通过**

Run: `node tests/build-bundles.cjs && node tests/settings-store.mjs`
Expected: PASS —— `[preset upgrade metadata]` 段全 ok。

- [x] **Step 5: 全量验证**

Run: `npm run typecheck && npm test`
Expected: exit 0。

- [ ] **Step 6: 提交**

```bash
git add src/main/settingsStore.ts tests/settings-store.mjs
git commit -m "fix(highlight): 预设升级时补齐 basic/category 元数据"
```

**AGENTS.md**：在「关键词高亮」的「升级旧安装」一条里补：「刷新预设时必须一并取预设的 `basic` / `category`——它们与 pattern 变更同批引入，只刷 pattern 会让老用户的 basic 模式失去成功/失败着色」。

---

### Task 7: `ESCAPE_RE` 的 CSI final 字节类

**问题**：`highlightEngine.ts:100` 的 CSI 分支结尾字节类是 `[A-Za-z]`，但 ECMA-48 的 CSI final 是 `0x40–0x7E`——`~ @ ` { | } [ \ ] ^ _` 全部落空。实测 `ESC[1~`、`ESC[3~`、`ESC[200~`、`ESC[@` 都不会被切成 seq。

后果由 `applyHighlights:734-737` 决定：text run 里含残留 ESC 就**整段原样输出**，所以该逻辑行上所有关键词都不着色。这与 AGENTS.md 已经为 `<>=` 写过一次的坑是同一类。

**Files:**
- Modify: `src/renderer/src/terminal/highlightEngine.ts:99-100`
- Modify: `tests/hl-rules.mjs`

- [ ] **Step 1: 写失败的测试**

在 `tests/hl-rules.mjs` 的 `[reset spellings and CSI parameters]` 段（`:1266-1272`）里，把那个 `for` 循环的数组扩成：

```js
  for (const [label, seq] of [
    ['ESC[>4;1m (modifyOtherKeys)', '\x1b[>4;1m'],
    ['ESC[<0;1;2M (SGR mouse)', '\x1b[<0;1;2M'],
    ['ESC[=1;1$y (DECRQM)', '\x1b[=1;1$y'],
    // ECMA-48 puts the CSI final byte in 0x40-0x7E, so it is not limited to
    // the letters: `~` (key reports), `@` (insert characters), `{` (REP) and
    // friends all end a CSI. A sequence the tokenizer does not recognise
    // leaves a raw ESC in the text run, and a text run with a raw ESC is
    // emitted raw — the WHOLE line loses its highlighting.
    ['ESC[1~ (key report)', '\x1b[1~'],
    ['ESC[3~ (delete key)', '\x1b[3~'],
    ['ESC[200~ (bracketed paste)', '\x1b[200~'],
    ['ESC[2@ (insert characters)', '\x1b[2@'],
    ['ESC[3{ (REP)', '\x1b[3{']
  ]) {
    ok(applyHighlights(`${seq}WARNING after\n`, warn).includes('255;0;0'), `${label} keeps the rest of the line highlighted`)
  }
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/build-bundles.cjs && node tests/.hl-rules.cjs`
Expected: FAIL —— `ESC[1~ (key report) keeps the rest of the line highlighted`。

- [ ] **Step 3: 放宽 final 字节类**

把 `src/renderer/src/terminal/highlightEngine.ts:99-100` 改成：

```ts
const ESCAPE_RE =
  /(\x1b\[[0-9;:?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>]|\x1b[0-9:;<?@A-OQ-WYZ\\`a-z{|}~])/g
```

即：CSI 分支的 `[A-Za-z]` → `[@-~]`（`0x40–0x7E` 的完整区间）。

- [ ] **Step 4: 运行测试确认通过**

Run: `node tests/build-bundles.cjs && node tests/.hl-rules.cjs`
Expected: PASS —— 全部断言 ok。

> **回归注意**：`[@-~]` 比 `[A-Za-z]` 宽，多出来的 final 字节里包含 `\`（`0x5C`）与 `]`（`0x5D`）。确认单字符 Fe 分支 `\x1b[0-9:;<?@A-OQ-WYZ\\`a-z{|}~]` 里的 `\\` 仍然先被消费——它排在 CSI 分支之后，且 CSI 分支要求 `ESC[` 开头，两者不会互相抢。跑完 `tests/.hl-rules.cjs` 与 `tests/.hl-split-smoke.cjs` 即可确认。

- [ ] **Step 5: 全量验证**

Run: `npm run typecheck && npm test`
Expected: exit 0。

- [ ] **Step 6: 提交**

```bash
git add src/renderer/src/terminal/highlightEngine.ts tests/hl-rules.mjs
git commit -m "fix(highlight): CSI 结尾字节类放宽到 ECMA-48 的 0x40-0x7E"
```

**AGENTS.md**：把「ESCAPE_RE 的 CSI 参数类必须含私有前缀与中间字节」那条的字节类从 `[A-Za-z]` 改成 `[@-~]`，并说明"CSI final 是 0x40–0x7E，不限于字母"。

---

# Wave 3 — 健壮性（P1）

### Task 8: SFTP 上传在失败路径关闭远端句柄

**问题**：`src/main/sftp.ts:581` 打开远端 handle，`:624` 只在成功路径关闭；`:629-632` 的 catch 只 unlink 不 close。`fsp.open(local,'r')` 在 `:585` 失败时同样漏掉。SFTP 通道是会话级缓存的 → 泄漏的句柄留到会话结束（反复失败上传 → 服务端 FD 增长）。下载路径用 `finally` 关，是对的。

**Files:**
- Modify: `src/main/sftp.ts:581-632`
- Modify: `tests/sftp-timeout.mjs`

- [x] **Step 1: 写失败的测试**

在 `tests/sftp-timeout.mjs` 末尾（`if (failed > 0) { … }` 之前）插入：

```js
// ---- a failed upload must close the remote handle ------------------------
console.log('[upload handle cleanup]')
{
  // The remote handle is opened (sftp.open) BEFORE the local file is read
  // (fsp.open), so a failure in EITHER place used to leave it open: the SFTP
  // channel is session-scoped and deliberately cached, so the handle leaked
  // for the whole session — the server accumulated one open file per failed
  // upload.
  //
  // The trigger is deterministic: the fake's `open` callback deletes the
  // local file, so the fsp.open that follows fails with ENOENT.
  const local = join(root, 'upload-src.bin')
  writeFileSync(local, 'payload')
  reset((op) => {
    if (op === 'open') rmSync(local, { force: true })
    return 'ok'
  })
  // The provider registered earlier in this file is replaced by later cases,
  // so re-register one that hands out a fresh fake wrapper.
  sftp.registerSftpClientProvider(() => ({
    sftp: (cb) => {
      const w = makeWrapper()
      openedChannels.push(w)
      cb(null, w)
    }
  }))
  const finished = new Promise((resolve) => {
    sftp
      .uploadRemote('s-cleanup', [local], '/remote', (_channel, payload) => {
        if (payload && payload.state === 'error') resolve(payload)
      })
      .catch(() => resolve(null))
  })
  await finished
  const opens = calls.filter((c) => c.op === 'open')
  const closes = calls.filter((c) => c.op === 'close')
  ok(opens.length === 1, `the remote file was opened exactly once (got ${opens.length})`)
  ok(closes.length === 1, `the remote handle was closed exactly once (got ${closes.length})`)
}
```

> 签名已核对：`uploadRemote(sessionId: string, localPaths: string[], remoteDir: string, broadcast: Broadcast): Promise<string>`（`src/main/sftp.ts:562`）。`broadcast(channel, payload)` 的 payload 是 `TransferProgressEvent`，带 `state` 字段（`'done' | 'error' | 'cancelled'`）。上传本身是 detached 的，错误通过 broadcast 送达，所以用例等的是 broadcast 而不是返回的 promise。
>
> 该文件已经 `import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'`——`rmSync` 可直接用。`reset()` / `makeWrapper()` / `calls` / `openedChannels` 都是文件级变量，`reset(impl)` 会同时重置 `calls` 与 `behaviour`。

- [x] **Step 2: 运行测试确认失败**

Run: `node tests/build-bundles.cjs && node tests/sftp-timeout.mjs`
Expected: FAIL —— `the remote handle was closed exactly once (got 0)`。

- [x] **Step 3: 实现修复**

把 `src/main/sftp.ts` 的上传块（`:581-632`）改成在 `finally` 里关句柄：

```ts
          const handle = await p<Buffer>(cb => sftp.open(remote, 'w', cb))
          const inflight = new Set<Promise<void>>()
          let firstError: Error | undefined
          try {
            const localHandle = await fsp.open(local, 'r')
            try {
              let pos = 0
              let lastEmit = 0
              for (;;) {
                if (transfer.cancelled) throw new OperationError(t('main.sftp.cancelled'))
                if (firstError) throw firstError
                while (inflight.size >= UPLOAD_WINDOW) {
                  await Promise.race(inflight)
                  if (firstError) throw firstError
                }
                // per-iteration buffer: pipelined writes outlive the loop, and
                // ssh2 re-reads the overflow tail after the ACK arrives
                const buf = Buffer.allocUnsafe(CHUNK)
                const { bytesRead } = await localHandle.read(buf, 0, CHUNK, pos)
                if (bytesRead === 0) break
                const offset = pos
                pos += bytesRead
                const now = Date.now()
                if (now - lastEmit > 150 || pos === size) {
                  lastEmit = now
                  emit({ transferId: id, kind: 'upload', state: 'running', file: name, bytes: pos, totalBytes: size })
                }
                const pr = pVoidTransfer(cb => sftp.write(handle, buf, 0, bytesRead, offset, cb))
                inflight.add(
                  pr.catch((err: Error) => {
                    firstError = firstError ?? err
                  })
                )
              }
              // NOTE: do NOT await the write acks before close — this server
              // acks lazily; close flushes and commits everything server-side.
            } finally {
              await localHandle.close()
            }
            await Promise.race([
              // The stall guard owns this wait (10s), so the close itself stays
              // unbounded-by-`bounded` — otherwise a timeout landing after the
              // race is decided would reject with nothing listening.
              rawVoid(cb => sftp.close(handle, cb)),
              new Promise<void>((r) => setTimeout(r, 10_000))
            ])
            await Promise.allSettled(inflight)
            if (firstError) throw firstError
          } catch (err) {
            // The handle was opened before the local file was read, so a
            // failure in EITHER place would leak it: the SFTP channel is
            // session-scoped and deliberately cached, so the handle stayed open
            // for the whole session. Closing it here is idempotent — the
            // success path already closed it.
            await pVoid(cb => sftp.close(handle, cb)).catch(() => undefined)
            await pVoid(cb => sftp.unlink(remote, cb)).catch(() => undefined)
            throw err
          }
```

> 成功路径的 `sftp.close(handle, cb)` 保持在原位；catch 里再关一次是安全的（ssh2 对已关闭的句柄只会回调一个错误，被 `.catch(() => undefined)` 吃掉）。

- [x] **Step 4: 运行测试确认通过**

Run: `node tests/build-bundles.cjs && node tests/sftp-timeout.mjs`
Expected: PASS —— `[upload handle cleanup]` 段全 ok。

- [x] **Step 5: 全量验证**

Run: `npm run typecheck && npm test`
Expected: exit 0。

- [ ] **Step 6: 提交**

```bash
git add src/main/sftp.ts tests/sftp-timeout.mjs
git commit -m "fix(sftp): 上传失败路径也要关闭远端句柄"
```

---

### Task 9: `--channel-only` 不再查询 GitHub

**问题**：`scripts/release.cjs:488` 的 `assertNoDowngrade()` 在 `:492` 的 `if (CHANNEL_ONLY)` **之前**执行；而 `:212` 判定 GitHub 只看 `!SKIP_GH`，没考虑 `CHANNEL_ONLY`。`githubLatestVersion()` 是 fail-closed 的 → 代理/网络一失败就抛 → **整条国内通道修复被 GitHub 拖死**。这正是双通道拆分要避免的场景。

**Files:**
- Create: `scripts/releaseFeeds.cjs`
- Create: `tests/release-feeds.mjs`
- Modify: `scripts/release.cjs:209-221`、`:485-496`
- Modify: `package.json`（test 脚本链）

**Interfaces:**
- Consumes: 无
- Produces:
  ```js
  // scripts/releaseFeeds.cjs
  module.exports = { feedsToGuard }
  // feedsToGuard({ skipGitea, skipGitHub, channelOnly }) -> Array<[label, reader]>
  ```

- [ ] **Step 1: 写失败的测试**

创建 `tests/release-feeds.mjs`：

```js
/**
 * Release downgrade-guard feed selection self-test (release-feeds.mjs).
 *
 * The guard must check exactly the feeds THIS RUN WILL WRITE. It used to pick
 * the GitHub feed whenever GitHub was not skipped — including a
 * `--channel-only` run, which never touches GitHub. Because the GitHub probe
 * is fail-closed (a network error aborts), a GitHub or proxy outage killed the
 * domestic channel-repair path that the two-feed split exists to protect.
 *
 * Run: node tests/release-feeds.mjs   (must exit 0)
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { feedsToGuard } = require('../scripts/releaseFeeds.cjs')

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}

const labels = (opts) => feedsToGuard(opts).map(([label]) => label)

console.log('[feeds to guard]')
{
  ok(
    labels({ skipGitea: false, skipGitHub: false, channelOnly: false }).length === 2,
    'a full publish guards both feeds'
  )
  ok(
    labels({ skipGitea: false, skipGitHub: false, channelOnly: true }).length === 1,
    'a channel-only publish guards the channel only'
  )
  ok(
    labels({ skipGitea: false, skipGitHub: true, channelOnly: false }).length === 1,
    '--skip-github guards the channel only'
  )
  ok(
    labels({ skipGitea: true, skipGitHub: false, channelOnly: false }).length === 1,
    '--skip-gitea guards the GitHub feed only'
  )
  ok(
    labels({ skipGitea: true, skipGitHub: true, channelOnly: false }).length === 0,
    'skipping both guards nothing'
  )
}

console.log('[the guard never probes a feed it will not write]')
{
  const guarded = feedsToGuard({ skipGitea: false, skipGitHub: false, channelOnly: true })
  ok(
    !guarded.some(([label]) => label.includes('GitHub')),
    'a channel-only publish never reads the GitHub feed'
  )
}

if (failed > 0) {
  console.error(`\n[release-feeds] ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('\n[release-feeds] ALL CHECKS PASSED')
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/release-feeds.mjs`
Expected: FAIL —— `Cannot find module '../scripts/releaseFeeds.cjs'`。

- [ ] **Step 3: 实现纯模块**

创建 `scripts/releaseFeeds.cjs`：

```js
/* Which update feeds a publish run must check for a downgrade.

   The guard is fail-closed: a feed it cannot read aborts the publish. That is
   right for a feed this run is ABOUT TO WRITE, and wrong for one it will not
   touch: a `--channel-only` run (the repair path for a channel upload that
   died halfway) never touches GitHub, but it used to probe the GitHub feed
   anyway — so a GitHub or proxy outage aborted the domestic channel repair
   that the two-feed split exists to protect.

   The rule is simply "check the feeds this run writes". */
'use strict'

/**
 * @param {{ skipGitea: boolean, skipGitHub: boolean, channelOnly: boolean }} opts
 * @returns {Array<[string, () => Promise<string | undefined>]>} label + reader pairs
 */
function feedsToGuard({ skipGitea, skipGitHub, channelOnly }) {
  const feeds = []
  if (!skipGitea) feeds.push(['update channel', () => channelVersion(CHANNEL_BASE)])
  // A channel-only run writes the Gitea channel and nothing else, so the
  // GitHub feed is not one of ITS feeds.
  if (!skipGitHub && !channelOnly) feeds.push(['GitHub release feed', () => githubLatestVersion()])
  return feeds
}

module.exports = { feedsToGuard }
```

> **重要**：上面的 `channelVersion` / `CHANNEL_BASE` / `githubLatestVersion` 是 `release.cjs` 内部的符号，纯模块里拿不到。**正确做法**是让 `feedsToGuard` 只做**选择**，把读取函数作为参数传入。改成下面这个签名（测试同步调整）：

```js
'use strict'

/**
 * Pick the update feeds this publish run must check for a downgrade.
 *
 * The guard is fail-closed: a feed it cannot read aborts the publish. That is
 * right for a feed this run is ABOUT TO WRITE, and wrong for one it will not
 * touch: a `--channel-only` run (the repair path for a channel upload that
 * died halfway) never touches GitHub, but it used to probe the GitHub feed
 * anyway — so a GitHub or proxy outage aborted the domestic channel repair
 * that the two-feed split exists to protect.
 *
 * The rule is simply "check the feeds this run writes".
 *
 * @param {{ skipGitea: boolean, skipGitHub: boolean, channelOnly: boolean }} opts
 * @param {{ channel: () => Promise<string|undefined>, github: () => Promise<string|undefined> }} readers
 * @returns {Array<[string, () => Promise<string|undefined>]>} label + reader pairs
 */
function feedsToGuard({ skipGitea, skipGitHub, channelOnly }, readers) {
  const feeds = []
  if (!skipGitea) feeds.push(['update channel', readers.channel])
  if (!skipGitHub && !channelOnly) feeds.push(['GitHub release feed', readers.github])
  return feeds
}

module.exports = { feedsToGuard }
```

测试同步改成：

```js
const readers = { channel: async () => undefined, github: async () => undefined }
const labels = (opts) => feedsToGuard(opts, readers).map(([label]) => label)
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node tests/release-feeds.mjs`
Expected: PASS —— `[feeds to guard]` 段全 ok，exit 0。

- [ ] **Step 5: 接到 `release.cjs`**

在 `scripts/release.cjs` 的 require 区加上：

```js
const { feedsToGuard } = require('./releaseFeeds.cjs')
```

把 `assertNoDowngrade`（`:209-221`）里的 feed 选择部分改成：

```js
    async function assertNoDowngrade() {
      const feeds = feedsToGuard(
        { skipGitea: SKIP_GITEA, skipGitHub: SKIP_GH, channelOnly: CHANNEL_ONLY },
        {
          channel: () => channelVersion(CHANNEL_BASE),
          github: () => githubLatestVersion()
        }
      )
      for (const [label, read] of feeds) {
        const live = await read()
        if (!live) continue
        if (compareVersions(live, V) > 0) {
          throw new Error(`refusing to publish v${V}: the ${label} already serves v${live} — an older version would overwrite its latest.yml/assets and roll the installed clients back. Publish from the newer branch, or bump the version.`)
        }
        console.log(`${label} currently serves v${live}`)
      }
    }
```

（`assertNoDowngrade` 是**模块级函数**，在 `scripts/release.cjs:209`——不是 `main()` 内部的。上面给出的缩进即模块级缩进，直接替换即可。`CHANNEL_ONLY` / `SKIP_GH` / `SKIP_GITEA` 三个常量在 `:36-39` 是模块级的，函数里能直接读到。）

- [ ] **Step 6: 把新测试加进测试链**

在 `package.json` 的 `scripts.test` 里，`node tests/updater-fallback.mjs` 后面加 `node tests/release-feeds.mjs`。

- [ ] **Step 7: 全量验证 + 手工验证参数组合**

Run: `npm run typecheck && npm test`
Expected: exit 0。

Run: `node scripts/release.cjs 0.0.1 --channel-only --skip-gitea`
Expected: exit 1，且**在联网之前**就打印拒绝信息（参数解析阶段拒绝，不触发任何网络请求）。

Run: `node scripts/release.cjs 0.0.1 --channel-only`
Expected: 走到降级护栏时**只查 Gitea 通道**（日志里出现 `update channel currently serves v…`，不出现 `GitHub release feed currently serves v…`）。

> 这两条手工验证是本任务的核心验收：**不得真的上传任何东西**。用一个明显偏低的版本号（`0.0.1`）确保即便走到上传也会被降级护栏拦下。

- [ ] **Step 8: 提交**

```bash
git add scripts/releaseFeeds.cjs scripts/release.cjs tests/release-feeds.mjs package.json
git commit -m "fix(release): --channel-only 不再探测 GitHub 源"
```

---

### Task 10: `options.theme` 只在真正变化时赋值

**问题**：`TerminalView.tsx:408-421` 的 `themeOpts` 含 `contrastRatio`、`bgOpts` 含 `opacity`/`dim`；`:1681-1689` 的 effect 依赖 `[themeOpts, bgOpts]`，**无条件**重写 `term.options.theme = withChromeColors(colors, bgOpts.image !== '', lightTheme)`。

但赋值结果只取决于 `themeId` / `customThemes` / `bgOpts.image !== ''`。于是**拖动背景透明度滑块、拖动压暗层滑块、改对比度下限**，都会给每个打开的窗格重新赋一次 `options.theme`——而按 AGENTS.md 记录的上游行为（xtermjs/xterm.js#6291），xterm 6.1 **每次 `options.theme` 赋值都会新建并丢弃一张 TextureAtlas**。

**Files:**
- Modify: `src/renderer/src/terminal/TerminalView.tsx:408-421`、`:1681-1689`
- Create: `tests/terminal-theme-deps.mjs`
- Modify: `package.json`（test 脚本链）

- [ ] **Step 1: 写失败的测试**

创建 `tests/terminal-theme-deps.mjs`：

```js
/**
 * Terminal theme-effect dependency self-test (terminal-theme-deps.mjs).
 *
 * xterm 6.1 builds and discards a TextureAtlas on EVERY `options.theme`
 * assignment (xtermjs/xterm.js#6291, unfixed upstream), so the theme effect
 * must depend on EXACTLY what the assignment consumes: the theme id, the
 * custom themes and whether a background image is set.
 *
 * The effect used to depend on the whole theme/bg option groups, which also
 * carry the contrast floor and the scrim opacity/dim — so dragging the
 * background-opacity slider re-assigned `options.theme` on every open pane
 * and burned a texture atlas per assignment.
 *
 * This is a structural test: the dependency array is the contract, and it is
 * the part a refactor is most likely to widen again.
 *
 * Run: node tests/terminal-theme-deps.mjs   (must exit 0)
 */
import { readFileSync } from 'node:fs'

const SRC = 'src/renderer/src/terminal/TerminalView.tsx'
const src = readFileSync(SRC, 'utf8')

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}

// Every `useEffect(() => { ... }, [deps])` block in the component.
const effects = [...src.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[([^\]]*)\]\)/g)].map((m) => ({
  body: m[1],
  deps: m[2]
}))

console.log('[theme effect dependencies]')
{
  const themeEffect = effects.find((e) => e.body.includes('term.options.theme'))
  ok(themeEffect !== undefined, 'the theme effect exists')
  if (themeEffect) {
    ok(
      !/minimumContrastRatio|backgroundImageOpacity|backgroundImageDim/.test(themeEffect.deps),
      `the theme effect does not depend on the contrast floor or the scrim (deps: ${themeEffect.deps.trim()})`
    )
    ok(
      !/minimumContrastRatio/.test(themeEffect.body),
      'the theme effect does not set the contrast floor'
    )
  }
}

console.log('[contrast floor has its own effect]')
{
  const contrastEffect = effects.find((e) => e.body.includes('term.options.minimumContrastRatio'))
  ok(contrastEffect !== undefined, 'the contrast floor is assigned in an effect')
  if (contrastEffect) {
    ok(
      !contrastEffect.body.includes('term.options.theme'),
      'the contrast effect does not touch options.theme'
    )
  }
}

if (failed > 0) {
  console.error(`\n[terminal-theme-deps] ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('\n[terminal-theme-deps] ALL CHECKS PASSED')
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/terminal-theme-deps.mjs`
Expected: FAIL —— `the theme effect does not depend on the contrast floor or the scrim`。

- [ ] **Step 3: 收窄依赖**

把 `src/renderer/src/terminal/TerminalView.tsx:408-421` 的两个选择器改成：

```ts
  // The theme effect assigns `term.options.theme`, and xterm 6.1 builds and
  // discards a TextureAtlas on EVERY such assignment (xtermjs/xterm.js#6291,
  // unfixed upstream). So this group carries EXACTLY what the assignment
  // consumes — the theme id, the custom themes, and whether a background image
  // is set. The contrast floor and the scrim opacity/dim live in their own
  // groups: they cannot change the theme, and depending on them would burn an
  // atlas per slider tick.
  const themeOpts = useSettingsStore(
    useShallow((s) => ({
      themeId: s.settings.terminal.themeId,
      customThemes: s.settings.customThemes,
      hasImage: s.settings.terminal.backgroundImage !== ''
    }))
  )
  const contrastOpts = useSettingsStore(
    useShallow((s) => ({
      ratio: s.settings.terminal.minimumContrastRatio,
      hasImage: s.settings.terminal.backgroundImage !== ''
    }))
  )
  const bgOpts = useSettingsStore(
    useShallow((s) => ({
      image: s.settings.terminal.backgroundImage,
      opacity: s.settings.terminal.backgroundImageOpacity,
      dim: s.settings.terminal.backgroundImageDim
    }))
  )
```

把 `:1681-1689` 的 effect 拆成两个：

```ts
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const colors = getThemeById(themeOpts.themeId, themeOpts.customThemes).colors
    const lightTheme = isLightTheme(colors.background)
    term.options.theme = withChromeColors(colors as ITheme, themeOpts.hasImage, lightTheme)
    term.options.drawBoldTextInBrightColors = !lightTheme
  }, [themeOpts])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.minimumContrastRatio = contrastFloor(contrastOpts.ratio, contrastOpts.hasImage)
  }, [contrastOpts])
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node tests/terminal-theme-deps.mjs`
Expected: PASS —— 4 组断言全 ok。

- [ ] **Step 5: 改掉构造路径的引用（Step 3 移走了 `themeOpts.contrastRatio`，这里必须一起改）**

构造路径 `TerminalView.tsx:1178` 正是用 `themeOpts.contrastRatio`：

```ts
      minimumContrastRatio: contrastFloor(themeOpts.contrastRatio, bgOpts.image !== ''),
```

把它改成：

```ts
      minimumContrastRatio: contrastFloor(contrastOpts.ratio, contrastOpts.hasImage),
```

**为什么安全**：构造 effect 的依赖是 `[sessionId]`（`TerminalView.tsx:1639`），而且它已经带着 `// eslint-disable-next-line react-hooks/exhaustive-deps -- terminal constructed exactly once`（`:1638`）——所以把 `contrastOpts` 读进构造路径**不会**让终端在对比度变化时被重建。effect 体捕获的是触发它的那次渲染的值，与原来的 `themeOpts.contrastRatio` 语义完全一致。

Run: `grep -n "minimumContrastRatio\|contrastRatio" src/renderer/src/terminal/TerminalView.tsx`
Expected: 构造与热更两处都用 `contrastOpts.ratio` / `contrastOpts.hasImage`；`themeOpts.contrastRatio` 不再出现。

- [ ] **Step 6: 把新测试加进测试链**

在 `package.json` 的 `scripts.test` 里，`node tests/contrast-floor.mjs` 后面加 `node tests/terminal-theme-deps.mjs`。

- [ ] **Step 7: 全量验证**

Run: `npm run typecheck && npm test`
Expected: exit 0。

- [ ] **Step 8: 提交**

```bash
git add src/renderer/src/terminal/TerminalView.tsx tests/terminal-theme-deps.mjs package.json
git commit -m "fix(terminal): options.theme 只在真正变化时赋值"
```

**AGENTS.md**：在「终端字体」一节末尾（或 xterm 相关段落）补：「`term.options.theme` 的 effect 依赖必须只含 `themeId` / `customThemes` / `hasImage`——xterm 6.1 每次赋值都新建并丢弃一张 TextureAtlas（xtermjs/xterm.js#6291），依赖里多带一个对比度或压暗滑块就是每滑一下烧一张图集」。

---

# Wave 4 — 收尾（P2 + 文档）

### Task 11: 设置校验、依赖分类闸门、Node 版本声明

**问题（三件相关的小事）：**
1. `settingsStore.ts:400-411` 的 `TERMINAL_KEYS` 循环只做 `typeof` 检查 → `tabAccentColor` 是**唯一**没有颜色格式校验的字段，手改成 `"not-a-color"` 会进 `setProperty('--tab-accent', …)` 和 antd 的 ColorPicker。
2. AGENTS.md 写着依赖分类规则，但 `scripts/verify-deps.cjs` 按其自身注释**只查版本一致性**——分类规则**没有任何自动闸门**（当前分类是对的，已 grep 验证）。
3. `package.json` **没有 `engines` 字段**：Node 原生类型剥离需要 ≥ 22.18，AGENTS.md 写了但包没声明，CI 也只锁 `node-version: 22`（没有 minor 下限）。

**Files:**
- Modify: `src/main/settingsStore.ts:400-411`
- Modify: `scripts/verify-deps.cjs`
- Modify: `package.json`（`engines` + `scripts.test`）
- Modify: `.github/workflows/ci.yml`
- Modify: `tests/settings-store.mjs`

- [x] **Step 1: 写失败的测试（设置校验）**

在 `tests/settings-store.mjs` 末尾插入：

```js
// ---- colour-bearing terminal settings are validated ------------------------
console.log('[tabAccentColor validation]')
{
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({ terminal: { tabAccentColor: 'not-a-color' } }),
    'utf8'
  )
  const loaded = store.loadSettings()
  ok(
    /^#[0-9a-f]{6}$/i.test(loaded.terminal.tabAccentColor),
    `an invalid tabAccentColor is repaired to a hex colour (got '${loaded.terminal.tabAccentColor}')`
  )
  const good = await roundTrip({ terminal: { ...store.loadSettings().terminal, tabAccentColor: '#ff8800' } })
  ok(good.terminal.tabAccentColor === '#ff8800', 'a valid tabAccentColor survives')
}
```

- [x] **Step 2: 运行测试确认失败**

Run: `node tests/build-bundles.cjs && node tests/settings-store.mjs`
Expected: FAIL —— `an invalid tabAccentColor is repaired to a hex colour`。

- [x] **Step 3: 实现颜色校验**

在 `src/main/settingsStore.ts` 的 `TERMINAL_KEYS` 循环之后（`:410` 之后）插入：

```ts
      // The accent colour reaches setProperty('--tab-accent', …) and antd's
      // ColorPicker. It is the one colour-bearing terminal setting with no
      // format check, so a hand-edited "not-a-color" became an invalid CSS
      // value and a broken picker.
      if (!/^#[0-9a-f]{6}$/i.test(terminal.tabAccentColor)) {
        errors.push('terminal.tabAccentColor')
        terminal.tabAccentColor = DEFAULT_SETTINGS.terminal.tabAccentColor
      }
```

> `DEFAULT_SETTINGS.terminal.tabAccentColor` 的默认值是 `#3fb950`（`src/shared/settings.ts`）。确认该字段确实在 `DEFAULT_SETTINGS.terminal` 里；若不在，先补上默认值。

- [x] **Step 4: 运行测试确认通过**

Run: `node tests/build-bundles.cjs && node tests/settings-store.mjs`
Expected: PASS。

- [x] **Step 5: 给依赖分类加闸门**

在 `scripts/verify-deps.cjs` 末尾（`console.log(\`dependencies ok: …\`)` 之前）插入：

```js
/* Classification gate: only packages that src/main/ or src/preload/ actually
   import may sit in `dependencies`. The renderer is fully bundled by Vite
   (externalizeDepsPlugin does not apply to it), so a renderer-only package in
   `dependencies` is dead weight in the installer — and, far worse, a
   main-process package DEMOTED to devDependencies gets externalized by the
   build and silently dropped from the packaged app. */
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const runtimeDeps = Object.keys(pkg.dependencies ?? {})
const devDeps = Object.keys(pkg.devDependencies ?? {})
// `electron` is imported by src/main everywhere but lives in devDependencies
// (electron-vite injects it at build time); Node builtins are not packages.
const BUILTINS = new Set(require('node:module').builtinModules)
const IGNORED = new Set(['electron'])

/** Bare (non-relative) import specifiers under a directory. */
function bareImports(dir) {
  const found = new Set()
  const walkDir = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name)
      if (entry.isDirectory()) walkDir(p)
      else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) {
        const src = fs.readFileSync(p, 'utf8')
        for (const m of src.matchAll(/(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g)) {
          const spec = m[1]
          if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('@shared/')) continue
          if (spec.startsWith('node:')) continue
          // `pkg/sub` -> `pkg`
          const name = spec.startsWith('@')
            ? spec.split('/').slice(0, 2).join('/')
            : spec.split('/')[0]
          if (IGNORED.has(name) || BUILTINS.has(name)) continue
          found.add(name)
        }
      }
    }
  }
  walkDir(dir)
  return found
}

const mainImports = new Set([
  ...bareImports(path.join(ROOT, 'src', 'main')),
  ...bareImports(path.join(ROOT, 'src', 'preload'))
])

const misclassified = []
for (const name of runtimeDeps) {
  if (!mainImports.has(name)) misclassified.push(`${name} is in dependencies but src/main|preload never imports it`)
}
for (const name of devDeps) {
  if (IGNORED.has(name) || BUILTINS.has(name)) continue
  if (mainImports.has(name)) misclassified.push(`${name} is imported by src/main|preload but sits in devDependencies`)
}

if (misclassified.length) {
  console.error('dependency classification is wrong:')
  for (const line of misclassified) console.error(`  ${line}`)
  console.error('\n只有 src/main/ 或 src/preload/ 实际 import 的包才能进 dependencies。')
  process.exit(1)
}
```

- [x] **Step 6: 运行分类闸门**

Run: `node scripts/verify-deps.cjs`
Expected: `dependencies ok: … packages verified, … optional entries skipped`，exit 0。

> **`electron` 必须显式豁免**：它被 `src/main` 大量 import，但按 electron-vite 的惯例只在 `devDependencies` 里（`package.json` 实测：`electron` 在 devDeps，不在 deps）。不豁免的话闸门会立刻报 `electron is imported by src/main|preload but sits in devDependencies`。
>
> Node 内置模块（`fs` / `path` / `os` / `net` / `url` / `stream` / `crypto` / `string_decoder` / `node:*`）实测也会出现在 import 列表里，但它们既不在 `dependencies` 也不在 `devDependencies`，两条规则都不会命中；仍建议用 `module.builtinModules` 一并跳过，避免以后有人把它们写进 `dependencies`。

- [x] **Step 7: 声明 Node 版本**

在 `package.json` 的顶层（与 `version` 同级）加：

```json
  "engines": {
    "node": ">=22.18"
  },
```

把 `.github/workflows/ci.yml` 里的 Node 版本从 `22` 改成 `22.18`（保持 `actions/setup-node` 的 `node-version` 字段格式）：

```yaml
      - uses: actions/setup-node@v4
        with:
          node-version: 22.18
```

- [x] **Step 8: 全量验证**

Run: `npm run typecheck && npm test && node scripts/verify-deps.cjs`
Expected: 全部 exit 0。

- [ ] **Step 9: 提交**

```bash
git add src/main/settingsStore.ts scripts/verify-deps.cjs package.json .github/workflows/ci.yml tests/settings-store.mjs
git commit -m "fix(settings): 校验强调色并给依赖分类加闸门"
```

**AGENTS.md**：把「依赖分类」那条改成「……**`scripts/verify-deps.cjs` 会拦**（版本一致性 + 分类）」；并把「渲染层纯函数测试用 Node 22.18+」补一句「`package.json` 的 `engines.node` 声明 `>=22.18`」。

---

### Task 12: 弹窗、上传监听器、TTL 常量、下载超时

**问题（四件小事）：**
1. `HostKeyModal.tsx:22-43` 没设 `maskClosable` / `keyboard` → antd 默认让**遮罩点击和 Esc** 触发 `onCancel` → 映射成 `onDecision('reject')` → **误点一下就静默拒绝连接**（指纹变更时更是无确认）。同仓的 `ZmodemOffers.tsx:120-124` 已正确禁用。
2. `FilePanel.tsx:614-645`：第二次上传覆盖 `uploadOffRef.current`，第一个上传的 `off` 句柄永久丢失 → 它的 `finish()` 永不执行，列表不刷新。
3. `HOST_KEY_PROMPT_TTL_MS`（`Workspace.tsx:114`）与 `DEFAULT_TIMEOUTS.prompt`（`ssh.ts:79`）是**两个独立字面量**，AGENTS.md 说"两处必须同步改"，但没有约束也没有测试。
4. `updater.ts:374-401` 的下载路径**没有整体超时**：`downloadUpdate()` 若永不落地，`downloadInFlight` 永远卡住，之后每次尝试都返回那个挂死的 promise，自动更新从此失效。

**Files:**
- Modify: `src/renderer/src/workspace/HostKeyModal.tsx:22-43`
- Modify: `src/renderer/src/sftp/FilePanel.tsx:614-645`
- Modify: `src/shared/ipc.ts`（新增共享 TTL 常量）或 `src/shared/settings.ts`
- Modify: `src/main/ssh.ts:79`、`src/renderer/src/workspace/Workspace.tsx:114`
- Modify: `src/main/updater.ts:374-401`

- [x] **Step 1: 修 HostKeyModal 的误关**

`src/renderer/src/workspace/HostKeyModal.tsx:27-43` 的 `<Modal>` 没有 `maskClosable` / `keyboard`，antd 的默认值让**遮罩点击**和 **Esc** 都触发 `onCancel`——而 `onCancel` 映射成 `onDecision('reject')`，于是误点一下就静默拒绝了这次连接（指纹变更时更是毫无提示）。

把 `src/renderer/src/workspace/HostKeyModal.tsx:27` 的 `<Modal` 改成：

```tsx
    <Modal
      open
      // A stray mask click or Esc must NOT decide the prompt: `onCancel` is
      // the REJECT button, and a mis-click used to abort the SSH handshake
      // silently (the "changed" fingerprint case with no confirmation).
      maskClosable={false}
      keyboard={false}
      title={
```

其余属性（`title` 的内容、`okText` / `cancelText` / `okButtonProps` / `cancelButtonProps` / `onOk` / `onCancel` / `width`）**保持原样**——显式的「拒绝」按钮仍然走 `onCancel` → `onDecision('reject')`。

参照 `src/renderer/src/workspace/ZmodemOffers.tsx:120-124` 的既有写法（它已经这样设了）。

- [x] **Step 2: 修 FilePanel 的上传监听器**

`src/renderer/src/sftp/FilePanel.tsx:558` 是一个单值 ref：

```ts
  /** Unsubscribe for the transfer listener the in-flight upload registered. */
  const uploadOffRef = useRef<(() => void) | null>(null)
```

第二次上传在 `:634` 直接覆盖它，第一个上传的 `off` 句柄就永远不会被调用——它的 `finish()` 也不会执行，列表不刷新，监听器一直挂着。

改成集合：

```ts
  /** Unsubscribe handles for the transfer listeners the in-flight uploads
   *  registered. A Set, not a single ref: a second upload must not orphan the
   *  first one's handle — it could then never be removed, and its terminal
   *  event would never refresh the listing. */
  const uploadOffsRef = useRef<Set<() => void>>(new Set())
```

把 `:560-567` 的卸载清理改成遍历整个集合：

```ts
  useEffect(() => {
    return () => {
      // An upload can still be running — or never deliver a terminal event —
      // when the panel unmounts; without this its IPC listener outlives it.
      for (const off of uploadOffsRef.current) off()
      uploadOffsRef.current.clear()
    }
  }, [])
```

把 `startUpload`（`:614-645`）整体改成：

```ts
  const startUpload = (files: string[]): void => {
    let targetId: string | null = null
    let settled = false
    const earlyTerminalIds: string[] = []
    const finish = (): void => {
      if (settled) return
      settled = true
      off()
      uploadOffsRef.current.delete(off)
      // `dir` here is the directory the upload was started from; if the user
      // has navigated away since, refreshing it would yank the panel back.
      if (dirRef.current === dir) void refresh(dir)
    }
    const off = window.api.onTransferProgress((e: TransferProgressEvent) => {
      if (e.state !== 'done' && e.state !== 'error' && e.state !== 'cancelled') return
      if (targetId === null) {
        earlyTerminalIds.push(e.transferId)
        return
      }
      if (e.transferId === targetId) finish()
    })
    uploadOffsRef.current.add(off)
    window.api.uploadRemote(sessionId, files, dir).then(
      (id: string) => {
        targetId = id
        if (earlyTerminalIds.includes(id)) finish()
      },
      (err: unknown) => {
        off()
        uploadOffsRef.current.delete(off)
        message.error((err as Error).message)
      }
    )
  }
```

> `off` 在 `finish` 里被引用、而 `off` 的 `const` 声明在 `finish` **之后**——这是原代码就有的结构（`:618` 引用 `:626` 声明的 `off`），TypeScript 允许闭包里的前向引用，**不要**调整这个结构。

- [x] **Step 3: 把主机密钥 TTL 提为共享常量**

在 `src/shared/ipc.ts`（主进程与渲染层都 import 的契约文件）里加：

```ts
/** The host-key prompt's lifetime. The main process stops broadcasting after
 *  this, and the renderer sweeps the queue on the same clock — the two MUST
 *  agree, or the renderer either drops a live prompt or keeps a dead one. */
export const HOST_KEY_PROMPT_TTL_MS = 120_000
```

把 `src/main/ssh.ts:79` 改成：

```ts
const DEFAULT_TIMEOUTS = { prompt: HOST_KEY_PROMPT_TTL_MS, connect: 15_000 }
```

并在 `ssh.ts` 的 import 区加上 `import { HOST_KEY_PROMPT_TTL_MS } from '@shared/ipc'`。

把 `src/renderer/src/workspace/Workspace.tsx:114` 改成：

```ts
const HOST_KEY_PROMPT_TTL_MS = SHARED_HOST_KEY_PROMPT_TTL_MS
```

（若 `Workspace.tsx` 已经从 `@shared/ipc` 导入了一堆名字，直接把 import 里的 `HOST_KEY_PROMPT_TTL_MS` 加进去，删掉本地的 `const`，并把 `:688` 的用法保持不变。**不要两处都定义同名常量**——会导致重复声明的编译错误。）

- [x] **Step 4: 给更新器的下载路径加停顿检测**

`src/main/updater.ts:374-401` 的 `handleDownload` 把 `downloadInFlight = task`（`:395`）并在 `task.then(release, release)`（`:399`）里清掉。若 `autoUpdater.downloadUpdate()` **永不落地**，两者都不发生 → `downloadInFlight` 永远指着那个挂死的 promise → 之后每次 `handleDownload` 都在 `:376` 直接 `return downloadInFlight`，自动更新从此失效。

检查路径有 `withTimeout`，下载路径没有——但一刀切的超时会杀掉"慢而有进度"的下载，所以用**停顿检测**（进度事件重置计时器）。

先在 `updater.ts` 的常量区（`const budgets = { … }` 之后）加：

```ts
/** A download that reports no progress for this long is considered stalled. */
const DOWNLOAD_STALL_MS = 120_000
```

再把 `handleDownload` 的函数体（`:374-401`）替换为：

```ts
async function handleDownload(source: DownloadSource = 'manual'): Promise<void> {
  // One transfer at a time: a second call would restart the same download.
  if (downloadInFlight) return downloadInFlight
  if (!app.isPackaged) return
  // Claim the version before the transfer starts, so another `update-available`
  // for it (the 4-hour cycle) cannot start a second one — and so a manual
  // download of that version already on disk is not re-fetched in the
  // background later. Rolled back on failure: a download that never finished
  // must be retried by the next check, and claiming it permanently would leave
  // auto-download silently dead.
  const seen = state.version === undefined ? undefined : actedFor(state.version)
  if (seen) seen.fetchHandled = true
  // Stall watchdog: a download that never settles leaves `downloadInFlight`
  // set, and every later attempt returns that stuck promise — the updater is
  // dead for the rest of the session. A flat timeout would kill a
  // slow-but-progressing transfer, so the clock is reset by the progress
  // event instead.
  let lastProgress = Date.now()
  const onProgress = (): void => {
    lastProgress = Date.now()
  }
  autoUpdater.on('download-progress', onProgress)
  const task = (async (): Promise<void> => {
    setState({ status: 'downloading', percent: 0, auto: source === 'auto' })
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      if (seen) seen.fetchHandled = false
      setState({ status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  })()
  downloadInFlight = task
  const watchdog = setInterval(() => {
    if (Date.now() - lastProgress <= DOWNLOAD_STALL_MS) return
    // Stalled: drop the in-flight marker so the next check can retry.
    if (downloadInFlight === task) downloadInFlight = undefined
  }, Math.max(1000, Math.floor(DOWNLOAD_STALL_MS / 4)))
  watchdog.unref?.()
  const release = (): void => {
    clearInterval(watchdog)
    autoUpdater.removeListener('download-progress', onProgress)
    if (downloadInFlight === task) downloadInFlight = undefined
  }
  task.then(release, release)
  return task
}
```

**关键不变量**：`release` 里必须 `clearInterval(watchdog)` 且 `removeListener`——否则每次下载都留下一个永久监听的 progress 回调和一个 30 秒的 interval。watchdog 必须 `.unref()`（AGENTS.md：所有 timer 必须 `.unref()`）。

- [ ] **Step 5: 全量验证**

Run: `npm run typecheck && npm test`
Expected: exit 0。

- [ ] **Step 6: 提交**

```bash
git add src/renderer/src/workspace/HostKeyModal.tsx src/renderer/src/sftp/FilePanel.tsx src/shared/ipc.ts src/main/ssh.ts src/renderer/src/workspace/Workspace.tsx src/main/updater.ts
git commit -m "fix(ui): 主机密钥弹窗不误关、上传监听器不丢、TTL 共享、下载加停顿检测"
```

**AGENTS.md**：在「锁屏」/「更新机制」相关段落补一句「主机密钥提示的 TTL 是 `src/shared/ipc.ts` 的 `HOST_KEY_PROMPT_TTL_MS`，主进程与渲染层共用同一个常量」。

---

### Task 13: 文档漂移修正

**问题（都是会误导下一个接手的人）：**
1. `docs/STATE.md:73` 仍写 `HTTPS_PROXY=http://127.0.0.1:7897`——**该端口已死**，AGENTS.md 写的是 7890。
2. `docs/STATE.md:66-67` 把发布顺序写成"Gitea release → 通道 → GitHub"，而 `scripts/release.cjs:502-521` **现在先发 GitHub**。
3. `docs/ROADMAP.md:169-171` 列的 4 项"已知待办"其实**已经修好**（更新定时器重置 `updater.ts:573`、启动检查语义 `updater.ts:559-565`、`--channel-only --skip-gitea` 组合 `release.cjs:46-51`、exe/blockmap 重传缺口 `release.cjs:367-389`）。
4. AGENTS.md 写"36 个离线测试"，实际 `npm test` 链里是 **39** 条（Task 1/2/3/9/10 之后会变成 44 条）。

**Files:**
- Modify: `docs/STATE.md:66-73`
- Modify: `docs/ROADMAP.md:169-171`
- Modify: `AGENTS.md`（测试数量）

- [x] **Step 1: 修 STATE.md 的两行错话**

把 `docs/STATE.md:66-73` 那一段（发布流程的第 2 步与最后的代理说明）改成：

```markdown
2. `node scripts/release.cjs <版本号>`（**不带 skip 参数**，Gitea 与 GitHub 一起发）：**先发 GitHub release**（主更新通道先落地），再发 Gitea release + 更新通道——GitHub 失败会被捕获，**不影响 Gitea 照发**，最后才以非零退出码抛出（需要重跑；重跑安全，已传资产会跳过）。上传前 `assertNoDowngrade()` 会读**本次要写的那些源**的版本，线上版本更高时直接拒绝——**该探测已 fail-closed**：网络错误 / 非 404 失败 / 解析不出 version 一律抛错中止发布，只有通道真空（404）才放行；通道探测在 `pruneChannel` 前那次是 best-effort（失败只跳过清理并打日志，不中断已生效的发布）。**`--channel-only` 只查国内通道**（它不写 GitHub，探测 GitHub 只会让通道修复被 GitHub 故障拖死）
```

把该文件末尾的代理说明从 `7897` 改成 `7890`：

```markdown
> GitHub 请求走 `HTTPS_PROXY=http://127.0.0.1:7890`（脚本只把它用于 GitHub）；国内通道全程直连，不设代理。**代理端口会变**：先 `netstat -ano | grep LISTENING | grep -E "789[0-9]"` 确认实际监听端口再跑
```

- [x] **Step 2: 修 ROADMAP 的过期待办**

`docs/ROADMAP.md` 的「已知待办」里有 **5 条已经修好却还挂着**的（逐条核对过代码）：

| ROADMAP 条目 | 已经修在 |
|---|---|
| 周期检查可被高频设置写入推迟 | `src/main/updater.ts:573`（只在 interval 值真变时重建定时器） |
| 「启动时自动检查」运行中途拨开会在 ~5s 后立即检查 | `src/main/updater.ts:559-565`（`startupArmed` 启动时即消费） |
| 下载无整体超时 | **本计划 Task 12**（停顿检测看门狗） |
| `release.cjs --channel-only` 与 `--skip-gitea` 组合矛盾 | `scripts/release.cjs:46-51`（参数解析阶段直接拒绝该组合） |
| `release.cjs 通道重传缺口：exe/blockmap 的 PUT 撞 409 | `scripts/release.cjs:367-389`（409→删除→重传） |

把这 5 条从 `docs/ROADMAP.md` 的「已知待办」列表里删掉（原样删除整行 `- [ ] …`），并在该列表开头补一条说明：

```markdown
- ~~周期检查被设置写入推迟 / 启动检查中途拨开 / 下载无整体超时 / `--channel-only --skip-gitea` 组合 / 通道 exe+blockmap 重传缺口~~（均已修，见 `AGENTS.md` 更新机制与发布新版本两节）
```

**保留不动**的条目：两条 i18n 专项（zh-TW 用语统一、ja 片假名长音符号统一）与四条功能待办（autoWrap 固定列宽、OSC 标题跟随、内置等宽字体、webgl 数量上限降级）。

顺手把本次 review 新发现的 ja 用词漂移补进 i18n 那条（`src/shared/i18n/dicts/ja/settings.ts:265` 与 `:268` 用「端末」，而词典其余 40 处用「ターミナル」）：

```markdown
- [ ] ja 片假名长音符号统一：`フォルダ`(6) / `フォルダー`(7) 混用，二选一全局统一；另 `ja/settings.ts:265,268` 用「端末」而词典其余 40 处用「ターミナル」，一并统一
```

- [x] **Step 3: 同步 AGENTS.md 的测试数量**

在 `AGENTS.md` 的「常用命令」一节，把测试那一条的"36 个离线测试"改成实际条数：

```markdown
- 测试：`npm test`（pretest 先 typecheck → `tests/build-bundles.cjs` 重建 → **44** 个离线测试，清单见 `package.json` 的 `test` 脚本）。渲染层纯函数测试用 Node 22.18+ 原生类型剥离直连 `.ts` 源文件，Node 20/22.17 以下报 `ERR_UNKNOWN_FILE_EXTENSION`；真实服务器测试需 `JD_*` 凭据，不在列
```

> **条数必须实测**：`node -e "console.log(require('./package.json').scripts.test.match(/node tests\/[^ ]+/g).length)"`，把输出填进去。

- [ ] **Step 4: 全量验证**

Run: `npm test`
Expected: exit 0，且实测条数与 AGENTS.md 里写的数字一致。

- [ ] **Step 5: 提交**

```bash
git add docs/STATE.md docs/ROADMAP.md AGENTS.md
git commit -m "docs: 修正发布顺序、代理端口与测试数量的过期陈述"
```

---

### Task 14: 其余 P2 收尾（路径准入、IPC URL、并发上限、死代码、计时器、ja 用词）

**问题（review 里判为 Minor / 硬性收尾的一组）：**
1. `localPathGrants.ts:150-163` 的 `realpathSync` 兜底在**任何**异常下都返回原目标——包括"悬空符号链接"（`realpathSync` 对悬空链接同样抛 ENOENT，和"文件不存在"无法区分）。于是授权目录里一个指向别处的悬空链接会被 `createWriteStream` 跟随，写到授权目录之外。
2. `ipc.ts:63` 的 `isTrustedRendererUrl` 对 `file:` URL 只比 `pathname`，忽略 `host`——`file://evil-host/<同样路径>` 会被判定为可信。
3. `pty.ts:155` 的 `pendingOpens` 无上限（`sessionExits` 有 512 的纪律）。
4. 死代码：`clearSessionSnapshot`、`posixFallbackShell`、`integrationHome`、`jsonFileIn`、`sftp.ts` 里重复的 `FAKE_FS`、`commands.ts` 的 `HISTORY_CAP`、`sftp.ts:178` 的 `[sftp-debug]` console.error、`workspaceMode.ts` 里的运行时导出。
5. `sftp.ts:625` 的 10 秒上传守卫计时器**从未清除**；另 5 处计时器虽会清除但没 `.unref()`。
6. ja 词典里 `ja/settings.ts:265` 与 `:268` 用「端末」，而词典其余 40 处用「ターミナル」。

**Files:**
- Modify: `src/main/localPathGrants.ts:150-163`
- Modify: `tests/local-path-grants.mjs`
- Modify: `src/main/ipc.ts:63`
- Modify: `tests/ipc-guard.mjs`
- Modify: `src/main/pty.ts:155`、`:327-329`
- Modify: `src/shared/i18n/dicts/{zh-CN,zh-TW,en,ja}/main.ts:70`
- Modify: `src/main/sessionState.ts:75`、`src/main/shellIntegration.ts:109`/`:114`、`src/main/store.ts:79`、`src/main/sftp.ts:256`、`src/main/commands.ts:42`、`src/renderer/src/workspace/workspaceMode.ts`
- Modify: `src/main/sftp.ts:625`（+ `:108`/`:184`/`:454`）、`src/main/ssh.ts:109`/`:343`
- Modify: `src/shared/i18n/dicts/ja/settings.ts:265`、`:268`

**Interfaces:**
- Consumes: 无（全是既有模块内的改动）
- Produces: `src/shared/i18n/dicts/*/main.ts` 新增键 `'main.pty.tooManyPendingOpens'`（四语言）

- [ ] **Step 1: 修 `localPathGrants` 的悬空符号链接**

`src/main/localPathGrants.ts` 的 `writeTarget`（`:140-163`）现在是这样：

```ts
    const target = join(dirReal, fileName)
    let resolved: string
    try {
      resolved = realpathSync(target)
    } catch {
      // Not on disk yet: a fresh file created directly inside the granted dir.
      return target
    }
```

改成：

```ts
    const target = join(dirReal, fileName)
    // A symlink at this name is followed by the write, so it must be resolved
    // and containment-checked even when its target does not exist yet: a
    // DANGLING symlink makes realpath throw ENOENT — exactly like a fresh
    // file — and the write would then create the link's target wherever it
    // points, outside the granted directory.
    let leafIsLink = false
    try {
      leafIsLink = lstatSync(target).isSymbolicLink()
    } catch {
      // No leaf at all: a fresh file created directly inside the granted dir.
      return target
    }
    let resolved: string
    try {
      resolved = realpathSync(target)
    } catch {
      // The leaf exists but cannot be resolved (a dangling symlink): refuse
      // it rather than let the write follow it out of the granted directory.
      return leafIsLink ? null : target
    }
```

并把该文件的 `node:fs` import 补上 `lstatSync`（`import { ..., lstatSync, realpathSync } from 'node:fs'`）。

- [ ] **Step 2: 写悬空链接的测试**

在 `tests/local-path-grants.mjs` 末尾（`if (failed > 0) { … }` 之前）插入：

```js
// ---- a dangling symlink must not escape the granted directory -------------
console.log('[dangling symlink]')
{
  // realpath throws ENOENT for a dangling symlink exactly as it does for a
  // file that does not exist — so the write used to follow the link out of
  // the granted directory while still looking like it targeted it.
  const dir = mkdtempSync(join(tmpdir(), 'ot-grants-dangling-'))
  const outside = mkdtempSync(join(tmpdir(), 'ot-grants-outside-'))
  const link = join(dir, 'escape.txt')
  let created = true
  try {
    symlinkSync(join(outside, 'nowhere.txt'), link)
  } catch {
    // Windows needs developer mode (or admin) for symlinks; without it the
    // case cannot be exercised here.
    created = false
  }
  if (created) {
    ok(
      grants.writeTarget(dir, 'escape.txt') === null,
      'a dangling symlink inside the granted dir is refused'
    )
  } else {
    console.log('  skipped: this machine cannot create symlinks')
  }
  rmSync(dir, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
}
```

> 该文件的 import 行需要补 `symlinkSync`（`node:fs`）。`grants` 变量名以该文件现有写法为准（它导出 `grantPickedFiles` / `writeTarget` 等）；若实际导出的对象名不同，按文件里已有的调用方式改。
>
> **Windows**：没有开发者模式时 `symlinkSync` 抛 EPERM——用例必须优雅跳过（上面已按此写），不能变成假失败。

- [ ] **Step 3: 修 IPC 的 `file:` URL 主机名**

把 `src/main/ipc.ts:63` 的：

```ts
    return target.protocol === 'file:' && target.pathname === pathToFileURL(RENDERER_FILE).pathname
```

改成：

```ts
    // `file://evil-host/<same path>` has the same pathname — the host must be
    // empty for a local file URL, or a frame could pass itself off as the app
    // page.
    return (
      target.protocol === 'file:' &&
      target.host === '' &&
      target.pathname === pathToFileURL(RENDERER_FILE).pathname
    )
```

在 `tests/ipc-guard.mjs` 里补一条断言（该测试已通过真实的 `registerIpc` 注册路径驱动 sender guard，加在已有的 URL 判定用例旁）：

```js
ok(
  !isTrustedRendererUrl(`file://evil-host${new URL(pathToFileURL(RENDERER_FILE)).pathname}`),
  'a file URL with a host is not the app page'
)
```

> `RENDERER_FILE` / `pathToFileURL` 在该测试里是否已可用，按文件现有的 import 与常量写法调整；`isTrustedRendererUrl` 是 `src/main/ipc.ts` 的**导出**（`:55`），测试可以直接用。

- [ ] **Step 4: 给 `pendingOpens` 加上限**

在 `src/main/pty.ts:155` 的 `pendingOpens` 声明之后加：

```ts
/** Concurrent SSH opens. Each one spawns a real handshake, and the renderer can
 *  ask for as many as it likes — bound it so a runaway renderer cannot turn
 *  into a resource exhaustion. The exit map carries the same discipline. */
const MAX_PENDING_OPENS = 16
```

在 `:327-329` 的登记之前加：

```ts
  const tempId = randomUUID()
  if (pendingOpens.size >= MAX_PENDING_OPENS) {
    throw new Error(t('main.pty.tooManyPendingOpens'))
  }
  const pending: PendingOpen = { owner, aborted: false }
  pendingOpens.set(tempId, pending)
```

四语言词典各加一个键（`src/shared/i18n/dicts/<lang>/main.ts`，紧跟 `:70` 的 `'main.pty.serviceNotReady'`）：

```ts
  // zh-CN
  'main.pty.tooManyPendingOpens': '同时建立的 SSH 连接过多，请稍后重试',
  // zh-TW
  'main.pty.tooManyPendingOpens': '同時建立的 SSH 連線過多，請稍後重試',
  // en
  'main.pty.tooManyPendingOpens': 'Too many SSH connections are being established at once — try again shortly',
  // ja
  'main.pty.tooManyPendingOpens': '同時に確立する SSH 接続が多すぎます。しばらくしてからやり直してください',
```

- [ ] **Step 5: 删死代码**

逐条删除（每条都**只有定义、没有调用方**，已 grep 核实）：

| 文件 | 删什么 |
|---|---|
| `src/main/sessionState.ts:75` | `export function clearSessionSnapshot()` 整个函数 |
| `src/main/shellIntegration.ts:109` | `export function posixFallbackShell()` |
| `src/main/shellIntegration.ts:114` | `export const integrationHome = (): string => homedir()` |
| `src/main/store.ts:79` | `export function jsonFileIn()` |
| `src/main/sftp.ts:256` | `const FAKE_FS = new Set([...])`（`sysinfo.ts:32` 有自己的一份且**在用**，别动那份） |
| `src/main/commands.ts:42` | `const HISTORY_CAP = 500` |
| `src/main/sftp.ts:178` | `console.error(\`[sftp-debug] …\`)` 那一行 |
| `src/renderer/src/workspace/workspaceMode.ts` | `WORKSPACE_MODE_ORDER`、`WORKSPACE_GROUP_PREFIX`、`WORKSPACE_MARKER_ID`、`workspaceModeOfPanelId`、`workspaceModeOfParams` |

> **`workspaceMode.ts` 不能整文件删**：`Workspace.tsx:42` 还在 `import type { WorkspaceMode } from './workspaceMode'`。只保留 `export type WorkspaceMode = 'terminal' | 'ssh'`，其余运行时导出删除。若删完 `WorkspaceMode` 类型也没人用了，再连类型一起删——本仓它有使用者，**保留**。

删完后逐个核实没有残留引用：

```bash
grep -rn "clearSessionSnapshot\|posixFallbackShell\|integrationHome\|jsonFileIn\|WORKSPACE_MODE_ORDER\|WORKSPACE_GROUP_PREFIX\|WORKSPACE_MARKER_ID\|workspaceModeOfPanelId\|workspaceModeOfParams" src/ tests/
```

Expected: 无输出。

- [ ] **Step 6: 收尾计时器**

- `src/main/sftp.ts:625` 的 10 秒上传守卫**从未清除**（`Promise.race` 里那个 `setTimeout`）。改成持有句柄、race 决出后清掉：

```ts
            // The stall guard owns this wait (10s), so the close itself stays
            // unbounded-by-`bounded` — otherwise a timeout landing after the
            // race is decided would reject with nothing listening.
            let guard: NodeJS.Timeout | undefined
            try {
              await Promise.race([
                rawVoid(cb => sftp.close(handle, cb)),
                new Promise<void>((r) => {
                  guard = setTimeout(r, 10_000)
                })
              ])
            } finally {
              if (guard) clearTimeout(guard)
            }
```

- 其余 5 处（`sftp.ts:108`、`:184`、`:454`，`ssh.ts:109`、`:343`）**都会在 settle 时清除**（已核实 `clearTimeout` 齐全），只是没 `.unref()`。给每处 `setTimeout(...)` 的返回值补一行 `.unref?.()`——与 AGENTS.md「所有 timer 必须 `.unref()`」一致（主进程里不阻止 `app.quit()`，属一致性收尾，不是缺陷）。

- [ ] **Step 7: 统一 ja 的「端末 / ターミナル」**

把 `src/shared/i18n/dicts/ja/settings.ts:265` 与 `:268` 的「端末」改成「ターミナル」（与词典其余 40 处一致）。

- [ ] **Step 8: 全量验证**

Run: `npm run typecheck && npm test`
Expected: exit 0。i18n 四语言的键集合必须仍然完全一致（`tests/` 里没有专门的键集合测试，但 `npm test` 全绿 + 手工 `node -e` 比对一次）：

```bash
node -e "
const m = await import('./src/shared/i18n/index.ts');
" 2>/dev/null || true
```

> 更可靠的做法：把四份 `src/shared/i18n/dicts/<lang>/index.ts` 里的键抽出来排序比对，确认四个集合相等。**四条 i18n 键的新增必须让四个集合仍然相等**。

- [ ] **Step 9: 提交**

```bash
git add src/main/localPathGrants.ts src/main/ipc.ts src/main/pty.ts src/main/sessionState.ts src/main/shellIntegration.ts src/main/store.ts src/main/sftp.ts src/main/commands.ts src/main/ssh.ts src/renderer/src/workspace/workspaceMode.ts src/shared/i18n/dicts tests/local-path-grants.mjs tests/ipc-guard.mjs
git commit -m "fix(main): 收紧路径准入、IPC URL、并发上限并清理死代码"
```

---

## 验收清单（全部任务完成后）

```bash
npm run typecheck && npm test && node scripts/verify-deps.cjs
```

Expected：三条命令全部 exit 0。

**逐条复核本计划修掉的问题：**

| 原问题 | 修它的任务 | 复核方式 |
|---|---|---|
| 会话退出丢最后一段输出 | Task 1 | `tests/session-flush.mjs` |
| 选中分段按钮标签不可读（1.51–1.92:1） | Task 2 | `tests/primary-contrast.mjs` |
| 损坏模板杀死活会话 | Task 3 | `tests/template-apply.mjs` |
| `MAX_REPLAY_SEQUENCES` 无有效测试 | Task 4 | `tests/hl-rules.mjs` 的 `[replay sequence gate]` 段 + 变异验证 |
| 颜色扫描器三个绕过 | Task 5 | `tests/css-theme-vars.mjs` 的负向自测 |
| 升级丢 `basic`/`category` | Task 6 | `tests/settings-store.mjs` 的 `[preset upgrade metadata]` 段 |
| CSI 非字母 final 丢整行高亮 | Task 7 | `tests/hl-rules.mjs` 的 CSI 用例表 |
| SFTP 上传句柄泄漏 | Task 8 | `tests/sftp-timeout.mjs` 的 `[upload handle cleanup]` 段 |
| `--channel-only` 被 GitHub 拖死 | Task 9 | `tests/release-feeds.mjs` + 手工参数组合验证 |
| `options.theme` 反复赋值烧图集 | Task 10 | `tests/terminal-theme-deps.mjs` |
| 强调色无校验 / 依赖分类无闸门 / 无 engines | Task 11 | `tests/settings-store.mjs` + `scripts/verify-deps.cjs` |
| 弹窗误关 / 上传监听器丢 / TTL 双份 / 下载无超时 | Task 12 | 人工验证 + 全量测试 |
| 悬空符号链接 / IPC host / 并发上限 / 死代码 / 计时器 / ja 用词 | Task 14 | `tests/local-path-grants.mjs`、`tests/ipc-guard.mjs` + 死代码 grep 无输出 |
| 文档漂移 | Task 13 | 人工复核 |

**明确不在本计划范围内**（已知 backlog，不当作缺陷修）：
- **链接规则的导入/导出**（AGENTS.md「可点击链接规则」章末已声明尚未做）→ `docs/PLAN-2026-10-21-backlog.md` 的 **W2-1**。
- **zh-TW「密碼 / 口令」与 ja「フォルダ / フォルダー」的全局统一** → `docs/PLAN-2026-10-21-backlog.md` 的 **W2-3**（Task 13 只把 ja「端末 / ターミナル」这条新发现记进 ROADMAP，实际统一留给 W2-3 专项）。
- **autoWrap 固定列宽、OSC 标题跟随、内置等宽字体、webgl 数量上限降级** → ROADMAP 的功能待办，不属本次 review 结论。

**手工验收（发版前）**：启动应用 → 设置页确认语言与渲染模式的**选中段文字清晰可读**（深色 + 浅色主题各看一次）→ 终端里跑一条会立刻退出的命令（如 `echo done && exit`），确认**最后一行 `done` 没有消失** → 主题页拖动"背景压暗"与"背景透明度"滑块，确认无卡顿。
