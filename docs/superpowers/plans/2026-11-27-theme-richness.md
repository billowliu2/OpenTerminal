# 主题丰富化计划（v1.0.37）

> **落地状态（2026-11-28 更新）**
>
> - **T1 已落地**：新增 7 款内置主题（catppuccin-mocha / catppuccin-frappe / catppuccin-latte /
>   tokyonight-night / everforest-dark-soft / one-dark-two / gruvbox-light），共 19 款。
> - **T2 已落地**：主题卡片真实预览（`src/renderer/src/theme/ThemePreview.tsx`，主题编辑器复用同一组件）。
> - **T3 已撤回**：强调色跟随主题做完后，用户反馈「按钮颜色都变了」「这个按钮变淡蓝了」，
>   已完整回滚（`semantic.ts` / `chrome.ts` / `main.tsx` / `settings.ts` / `settingsStore.ts` /
>   `ThemeSettingsTab.tsx` / 四个语言字典全部还原）。`--chrome-accent` 与 antd `colorPrimary`
>   仍是写死的蓝 —— 这是**已知取舍**，不是待办；要做的话先跟用户确认视觉预期。
> - **T4 未落地**（随 T3 一起撤回）：`tests/accent-contrast.mjs` 已删除。
> - 本轮顺带修掉了另一件事：高亮预览列在浅色主题下看不清（`ensureContrast`，
>   见 `AGENTS.md`「关键词高亮」一节）与「高亮覆盖程序自带配色」
>   （`settings.terminal.highlightRespectAppColor`）。

> 本计划由 2026-11-27 的主题系统现状审查得出，所有现状陈述均已对照源码核实（文件:行号见各项「现状」）。
> **本文件原为计划；上面的落地状态为准。**
>
> 前置背景：2026-10-16 的「主题系统全面改造（A+B+C）」已完成（`docs/superpowers/plans/2026-10-16-theme-overhaul.md` 全部勾选），
> 落地了 `--ot-*` 语义变量层、浅色主题 ANSI 调色板 AA 化、`css-theme-vars` / `ot-var-names` / `theme-contrast` 三道 fail-closed 守门。
> **本计划不重复那套基建**，只在其之上扩展「广度」与「贯穿度」。

---

## 一、结论：主题系统「还能更丰富」，但富的不是语义层

现有主题系统已经过了「配色一致性」的阶段：语义变量层、AA 调色板、fail-closed 守门都在。真正的短板有两条：

1. **贯穿度不足** —— 主题只换了终端画布和一部分 chrome，`--chrome-accent` 与 antd `colorPrimary` 仍是写死的蓝。
   这是「切了 Dracula 但整个 App 还是蓝的」这种违和感的唯一来源，也是本次最高价值的改动。
2. **广度不足** —— 12 个内置主题、只有 3 个浅色；主题卡片只显示 8 个色点，没有真实预览；自定义主题只能在本机
   `settings.json` 里手改，没有导入导出。

所以「更丰富」= **让主题真正贯穿整个应用 + 补齐热门主题与预览**，而不是再造一套语义层。

---

## 二、现状核实（文件:行号）

### 2.1 主题模型
- `src/shared/theme.ts:6-36`：`ThemeColors` = 20 个字段（bg/fg/cursor/cursorAccent/selection + ANSI 16 色）；
  `TerminalTheme` = `{ id, name, builtin, colors }`，**无作者/分类/预览等元数据**。
- `src/shared/theme.ts:67-377`：12 个内置主题 —— default-dark、dracula、one-half-dark、one-half-light、
  solarized-dark、solarized-light、gruvbox-dark、nord、monokai、github-light、afterglow、material-dark。
  **浅色仅 3 个**（one-half-light / solarized-light / github-light），缺 gruvbox-light / catppuccin / tokyo-night / one-dark / evergreen。

### 2.2 语义层与 chrome 层
- `src/renderer/src/theme/semantic.ts`：19 个 `--ot-*` + `color-scheme`；深色分支锁死历史字面量，浅色分支 `darkenToRatio` 派生。
  `SEMANTIC` 里的 success/danger/warning/info 是**常量**，不随主题色相走。
  **`darkenToRatio` 只会往黑里压**（`semantic.ts:61-73`），深色背景下要「提亮」没有现成函数。
- `src/renderer/src/theme/chrome.ts:31-79`：`applyChromeTheme()` 写 `--chrome-bg/fg/bg-deep/hover/border/tab-*` + 全部 `--ot-*`。
- **`src/renderer/src/theme/chrome.ts` 从未写 `--chrome-accent`** —— 该变量只有 `src/renderer/src/global.css:6` 的静态兜底
  `#3b8eea`，而渲染层有 **16 处 CSS 在用它**（`commands.css:173`、`global.css:178`、`highlight.css:390`、
  `settings.css:299`、`sftp.css:38`、`terminal.css:95/112/169/243` 等），其中 4 处是**前景色文本**
  （`sftp.css:38`、`terminal.css:112/169/243`）。
- `src/renderer/src/main.tsx:332`：antd `colorPrimary: PRIMARY_COLOR`（`semantic.ts:101` = `#0f66d8`）**全局写死**，
  主题切换不会变。但同一个组件的 `colorBgBase`/`colorBgContainer`/`colorTextBase`（`main.tsx:325-328`）**已经跟随主题**。
  → 主色是这套联动里唯一的缺口。

### 2.3 设置 UI
- `src/renderer/src/settings/ThemeSettingsTab.tsx`：暴露背景图 + 透明度(10-100) + 压暗(0-90) + 标签强调色 + 主题画廊 + 主题编辑器。
- 画廊卡片（`ThemeSettingsTab.tsx:143-157`）：背景色块 + 8 个 ANSI 圆点，**没有真实文字预览**。
- `src/renderer/src/theme/editor/ThemeEditor.tsx:204-219`：编辑器和画廊不共用预览组件；编辑器只有 name + 20 个色块，**无导入导出**。

### 2.4 已有能力（不要重复造）
- 终端侧外观已经很全：字体族/CJK 回退/字号/字重/粗体字重/字间距/行高/回滚/光标闪烁/光标形状/非活动光标形状/MCR 下限
  （`src/shared/settings.ts:73-160`）。
- `highlightThemeColors`：高亮色按色相跟随主题调色板（`src/renderer/src/theme/highlightColors.ts`）。
- 背景图 + 透明度 + 压暗 scrim。
- 标签强调色 `tabAccentColor`（`settings.ts:124`，默认 `#3fb950`）→ `--tab-accent` / `--tab-accent-fg`。

---

## 三、本轮范围

### 做
| 任务 | 内容 | 预估 |
|---|---|---|
| T1 | 新增 7 个内置主题（含 2 个浅色） | 1–2h |
| T2 | 主题卡片真实文字预览（编辑器与画廊共用组件） | 1h |
| T3 | 强调色跟随主题：`--chrome-accent` + antd `colorPrimary` | 3–4h |
| T4 | 新增 fail-closed 守门 `tests/accent-contrast.mjs` | 0.5h |

### 不做（明确划界，避免子代理越界）
- acrylic / mica 材质、窗口 vibrancy（Windows 上需 frameless + 透明背景，坑多、收益不确定）
- 每个标签 / 每个会话独立主题（要把全局 `useResolvedTheme()` 改成 per-panel，影响面超出「主题丰富化」）
- 主题语义色（success/danger/warning/info）按主题覆盖 —— `SEMANTIC` 是常量，要动就得扩 `TerminalTheme` 结构
- 主题导入导出 JSON（`highlightIO.ts` 已有先例，可复用，但独立一轮更干净）
- 主题商店 / 主题包
- 背景图模糊与适配模式（cover/contain/tile）

---

## 四、任务详述

### T1 — 新增内置主题

**改动文件**
- `src/shared/theme.ts`（新增 6 个主题对象）
- `scripts/gen-light-theme.mjs`（**新建**，一次性/复用工具，不进生产代码路径）

**做法**
1. **色值不要自己找** —— 见 **附录 A**：主代理已从上游核实并用仓库自己的 `darkenToRatio` 算法算好了
   7 个新主题的完整色值（含逐色对比度标注），直接采用附录 A 的值即可。
   附录 A 同时说明了上游来源与「与仓库既有 12 个主题同源」的反向校验证据。
2. 新增 7 个主题（深色 5 + 浅色 2）：
   Catppuccin Mocha、Catppuccin Frappe、Catppuccin Latte（浅）、TokyoNight Night、
   Everforest Dark Soft、One Dark Two、Gruvbox Light（浅）。
3. 新增 `scripts/gen-light-theme.mjs`：把附录 A 里的**上游原色表**作为输入，用
   `src/renderer/src/theme/semantic.ts` 的 `darkenToRatio` 复算出附录 A 的最终值并打印，
   供后续新增主题时复用。
   - 算法在渲染层模块里，而主题数据在 `src/shared/`（主进程也用）——**不把算法复制进 `shared/`**
     （AGENTS.md 对 linkRules 的警告：别复制闸门/常量造成分表）。
   - 脚本用 Node 原生类型剥离直连 `semantic.ts`（已实测本机 Node v24.15.0 可直连；
     注意 Windows 下 import 绝对路径要写 `file:///D:/...` 形式，否则报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`）。
   - 脚本**不接进 `npm test` 链**（它是工具，不是守门），但必须在仓库里留下，供后续加主题复用。
4. 每个新主题对象在 `src/shared/theme.ts` 里加一行注释，说明：色值来自哪个上游文件、
   浅色主题的 ANSI 色经 AA 压暗算法处理（避免后人误以为是上游原色）。

**验收标准**
- `node tests/theme-contrast.mjs` 退出 0，且输出覆盖全部 **19** 个主题；
  两个浅色主题的 ANSI 16 色与 fg 全部 ≥4.5:1、cursor ≥3:1。
- `node scripts/gen-light-theme.mjs` 的输出与附录 A 的值**逐项一致**（复算一致）。
- 12 个既有主题的色值**一字不改**（diff 里只应有新增块）。
- `npm run typecheck` 通过。

### T2 — 主题卡片真实预览

**改动文件**
- `src/renderer/src/theme/ThemePreview.tsx`（**新建**：从 `ThemeEditor.tsx:204-219` 抽出 `ThemePreviewSnippet`）
- `src/renderer/src/theme/editor/ThemeEditor.tsx`（改为引用新组件，行为不变）
- `src/renderer/src/settings/ThemeSettingsTab.tsx`（卡片内嵌预览）
- `src/renderer/src/settings/settings.css`（预览样式）

**做法**
- 画廊卡片在 8 个色点之外显示 3 行真实内容（复用预览的行数据：目录列表 / 版本号 / 提示符），
  用该主题自己的 ANSI 色渲染在主题背景上。
- 预览组件**不含任何颜色字面量**（全部取自 `colors` 对象）→ `tests/css-theme-vars.mjs` 必须仍过。
- 卡片点击行为、选中态、编辑/删除按钮**保持现状**。

**验收标准**
- 19 个主题卡片都显示真实预览；点击/编辑/删除行为与改动前一致。
- `node tests/css-theme-vars.mjs` 退出 0。

### T3 — 强调色跟随主题（核心）

**改动文件**
- `src/renderer/src/theme/semantic.ts`（新增 `lightenToRatio()` 与 `accentFor()`）
- `src/renderer/src/theme/chrome.ts`（`applyChromeTheme()` 写 `--chrome-accent`；`--chrome-on-primary` 改用实际填充色）
- `src/renderer/src/main.tsx`（`colorPrimary` 用派生值 + `colorTextLightSolid`）
- `src/shared/settings.ts`（新增 `terminal.accentColor: string`，`''` = 跟随主题）
- `src/main/settingsStore.ts`（校验 + 非法值回落，模式对齐 `tabAccentColor` 的既有处理 `settingsStore.ts:428-430`）
- `src/renderer/src/settings/ThemeSettingsTab.tsx`（强调色 ColorPicker + 「跟随主题」重置）

**算法**
```
accent 源 = 主题的 ANSI blue（colors.blue）
深色分支 = lightenToRatio(blue, bg, 5.5)   // 往白方向提亮
浅色分支 = darkenToRatio(blue, bg, 5.5)    // 往黑方向压暗
```
- 为什么是 **5.5:1** 而不是 4.5:1：
  - `src/renderer/src/settings/settings.css:339` 把 accent 以 `color-mix(in srgb, var(--chrome-accent) 55%, var(--chrome-fg))`
    混成文本色，混合后对比度低于原色 → 4.5:1 的 accent 经 55% 混合后只剩约 2:1。
  - 既有 `applyTabAccent()`（`chrome.ts:101`）浅色分支就用 5.5，与此保持一致。
- `lightenToRatio` 是**新增**函数：`semantic.ts:61` 的 `darkenToRatio` 只会往黑压，深色背景下要提亮没有现成实现。
  实现方式与 `darkenToRatio` 对称（`mix(color, '#ffffff', t)`，t 步进 0.05，上限 0.85）。

**antd 联动**
- `main.tsx` 的 `ConfigProvider` 已经订阅 `themeId` / `customThemes`（`main.tsx:315-317`），token 天然随主题重算，
  只需把 `colorPrimary: PRIMARY_COLOR` 换成派生值即可。
- 注意存在**两个** ConfigProvider：`main.tsx:314`（配 theme token）与 `App.tsx:168`（只配 `locale`）。
  内层不配 `theme` → 继承外层，改 `main.tsx` 生效；但不要误改 `App.tsx` 那个。
- **必须同时显式设 `colorTextLightSolid`**：antd 默认给 primary 填充配白字；派生主色变浅后白字可能不达标。
  复用 `semantic.ts:111` 的 `onPrimaryLabel()`，但**改成接受填充色参数** `onPrimaryLabel(fill)`。
- `--chrome-on-primary`（`chrome.ts:77`）同样要改用同一个 fill 派生，保证 CSS 与 antd 一致。
- `PRIMARY_COLOR` 常量本身保留（仍是 `--chrome-accent` 未生效时的兜底锚点），但不再直接喂给 antd。

**用户覆盖**
- `settings.terminal.accentColor`：非空 = 用户指定色（跳过派生，但仍需过对比度校验，不达标则回落）；
  空串 = 跟随主题。
- UI 上在「标签强调色」旁边加一行「应用强调色」，ColorPicker + 「跟随主题」重置按钮。

**兼容性**
- `src/renderer/src/global.css:6` 的 `--chrome-accent: #3b8eea` 静态兜底**保留不动**
  （JS 未跑时的深色兜底；`tests/css-theme-vars.mjs` 白名单 `global.css` 已含 `#3b8eea`，无需改白名单）。
- 既有 12 个主题的观感会变（accent 从固定蓝变成主题蓝）—— 这是本任务的目的，但要能靠 `accentColor` 覆盖回退。

**验收标准**
- 切到 Dracula / Nord / Solarized Dark / 一个浅色主题，`--chrome-accent` 与 antd 主色都跟随变化；
  focus ring、分段控件选中态、SFTP 文件名链接色同步。
- 浅色主题下 antd 主色上的文字 ≥4.5:1。
- `npm run typecheck` + `npm test` 全绿。

### T4 — 新增 fail-closed 守门

**改动文件**
- `tests/accent-contrast.mjs`（**新建**）
- `package.json`（`test` 脚本链末尾追加该测试）

**断言**
- 全部 19 个内置主题：派生 accent vs 主题背景 ≥5.5:1；`onPrimaryLabel(fill)` 在 fill 上 ≥4.5:1。
- 深色分支 `lightenToRatio`、浅色分支 `darkenToRatio` 都不返回未达标的值（达不到就返回最接近的并被断言抓住）。
- 负向自测：给一个低对比输入，断言守门会 FAIL（防止守门本身写成永远通过）。

---

## 五、验证命令（本机可跑，逐条）

```bash
node tests/theme-contrast.mjs      # 18 主题 AA 守门
node tests/semantic-theme.mjs      # 语义层深浅分支锁定
node tests/ot-var-names.mjs        # --ot-* 命名一致
node tests/css-theme-vars.mjs      # 无裸颜色字面量
node tests/accent-contrast.mjs     # 新增：强调色对比度守门
npm run typecheck                  # 主进程 + 渲染层类型检查
npm test                           # 全链（pretest 会 typecheck + 重建 bundle）
node scripts/verify-deps.cjs       # 依赖分类闸门
```

**并行禁忌**：`npm test` 首步 `tests/build-bundles.cjs` 会重建共享 bundle，`npm run typecheck` 会写根目录 `*.tsbuildinfo`
（composite:true）—— 两者并行会互相污染导致假失败。**同一时刻只允许一个进程跑这两条。**

---

## 六、范围边界（写给执行者）

- 只改上面列出的文件。确有必要的计划外改动，必须在报告里单独列出「文件 + 理由 + 为什么不能放进计划内」。
- 不碰 `semantic.ts` 的「零 import 纯模块」约束（`AGENTS.md` 硬规则）：新增的 `lightenToRatio` / `accentFor`
  必须是同文件内的纯函数，**不得 import 任何模块**。
- 不把 `darkenToRatio` / `contrast` 等算法复制到 `src/shared/`（防分表）。
- 不新增 `--ot-*` 变量（那要改三处约定 + `tests/ot-var-names.mjs`）；accent 走既有 `--chrome-accent`。
- 不改 `PRIMARY_COLOR` 的字面量，不删 `SEMANTIC` 的锚点值（`tests/semantic-theme.mjs` 锁死深色分支）。
- 不在 `main.tsx` 写任何颜色字面量（见 §7.2 第 3 条）。
- `onPrimaryLabel()` 改成接受填充色参数后，**两个调用点必须同源**：antd `colorTextLightSolid` 与 CSS
  `--chrome-on-primary`（见 §7.2 第 1 条）。
- 不做发布、不打 tag、不提交 git（提交与否由用户另行决定）。

---

## 七、自审记录（2026-11-27，写完计划后逐条回源码复核）

### 7.1 计划前提逐条核实
| 计划里的假设 | 核实结果 |
|---|---|
| T3 前提：主题切换会重新调用 `applyChromeTheme()` | ✅ 成立。`src/renderer/src/App.tsx:158-160` 的 `useEffect(..., [themeId, customThemes])` 每次主题变化都重跑 |
| T3 前提：antd token 随主题重算 | ✅ 成立。`main.tsx:315-317` 订阅 `themeId`/`customThemes`，`ConfigProvider` 的 `theme` prop 天然响应 |
| antd 只有一处 ConfigProvider 配 token | ⚠️ **实际有两处**：`main.tsx:314`（配 token）+ `App.tsx:168`（只配 `locale`，不配 `theme`）。内层不覆盖 `theme` → 继承外层，改 `main.tsx` 有效。**但执行者要知道有内层 ConfigProvider 存在** |
| T1 前提：Node 能直连 `semantic.ts` 取算法 | ✅ 成立。实测 `node -e "import('./src/renderer/src/theme/semantic.ts')"` 在本机 Node v24.15.0 成功（`darkenToRatio` 正常返回） |
| 四道守门测试当前是绿的（T1/T2/T3 的前置） | ✅ 实测全绿：`theme-contrast` / `semantic-theme` / `ot-var-names` / `css-theme-vars` 均 exit 0 |

### 7.2 计划漏洞与补正
1. **【重要】深色主题下派生主色会让 antd 白字不达标。**
   accent 要求 5.5:1 是相对**主题背景**；深色背景下这意味着填充色亮度被推高（如 Lum≈0.34），
   此时白字在填充色上只有约 2.7:1 —— **不达标**。
   补正：T3 必须把 `onPrimaryLabel()` 改成**接受填充色参数**（`onPrimaryLabel(fill)`，内部已有
   `contrast('#ffffff', fill) >= 4.5` 分支），并把结果同时喂给 antd 的 `colorTextLightSolid`
   与 CSS 的 `--chrome-on-primary`。两处必须同源，否则 CSS 与 antd 会出现两种标签色。
2. **`accentColor` 允许空串，校验模式与 `tabAccentColor` 不同。**
   `tabAccentColor` 是「必须 6 位 hex，否则回落默认」（`src/main/settingsStore.ts:428-430`）；
   `accentColor` 的语义是「空串 = 跟随主题」，所以校验应是
   `if (accentColor !== '' && !/^#[0-9a-f]{6}$/i.test(accentColor)) terminal.accentColor = ''`。
   执行者不要照抄 `tabAccentColor` 的写法。
3. **`main.tsx` 不得引入任何颜色字面量。**
   `tests/css-theme-vars.mjs` 对 `main.tsx` 的白名单是 `new Set(['#f5f5f5','#1f1f1f','#252525'])`（精确集，非整文件豁免）。
   派生值必须来自 `semantic.ts`（该文件整文件豁免），不能就地写 fallback 十六进制。
4. **T2 卡片预览要显式约束布局。**
   卡片宽度有限，预览块必须固定字号/行高 + `overflow: hidden`，否则会撑破 `.theme-card` 栅格。
5. **浅色主题的 ANSI 色被 `darkenToRatio` 压暗会偏离上游原貌**（如 Catppuccin Latte 的 yellow 会偏褐）。
   这是「守门优先于还原度」的自觉取舍，执行时在 `src/shared/theme.ts` 的新主题注释里写明
   「浅色变体经 AA 压暗算法处理」，避免后人误以为是上游原色。
6. **`SEMANTIC.surfaceRaised` 在深色分支是固定 `rgba(24,26,31,0.85)`**，在 Nord / Material Dark 这类
   非中性背景上会偏色。本轮**不修**（深色分支的锚点值被 `tests/semantic-theme.mjs` 锁死，
   改它等于零回归锁定失效）。记为已知遗留，不在本轮范围。

---

## 八、待用户决策项（不阻塞实现，按默认执行）

1. **accent 源用 ANSI blue**：也可以用 `selectionBackground` 或给 `TerminalTheme` 加可选 `accent` 字段。
   默认取 ANSI blue —— 通用、零结构变更。
2. **默认跟随主题还是默认保持现状蓝**：默认**跟随主题**（这才是「更丰富」的落点），并提供 `accentColor` 一键回退。
3. **新增主题的取舍清单**：默认按附录 A 的 7 个（Catppuccin Mocha / Frappe / Latte、TokyoNight Night、
   Everforest Dark Soft、One Dark Two、Gruvbox Light）；若用户有偏好主题可替换。

---

## 附录 A：新增主题的已核实色值（2026-11-27 由主代理核算）

**数据来源（已核实为仓库既有 12 个主题的同一上游）**：
`https://github.com/mbadolato/iTerm2-Color-Schemes` 的 `yaml/` 与 `kitty/` 目录。
反向校验：上游 `yaml/Dracula.yml` 与仓库现有 Dracula 主题逐色一致
（black `#21222c` / red `#ff5555` / blue `#bd93f9` / selection `#44475a` / background `#282a36`），
证明该上游就是仓库既有主题的数据源，**不是第二套色板来源**。

**处理规则（与仓库既有 12 个主题的既有约定一致）**：
1. 浅色主题（bg 亮度 > 0.5）的 ANSI 16 色一律经 `darkenToRatio(color, bg, 4.5)` 处理，
   与 2026-10-16 改造时对 one-half-light / solarized-light / github-light 的处理方式相同。
2. 浅色主题的 foreground 经 `darkenToRatio(fg, bg, 7)`；cursor 经 `darkenToRatio(cursor, bg, 3)`
   （守门要求 cursor ≥3:1；Catppuccin Latte 的原版 rosewater `#dc8a78` 只有 2.34，必须压暗）。
3. **selectionBackground 统一归一为 `mix(bg, fg, 0.16)`（浅色 `mix(bg, fg, 0.12)`）**，
   而不是直接用上游值 —— 上游 Catppuccin / TokyoNight / Everforest 的 selection 等于前景色
   （如 TokyoNight `#c0caf5`），会让被选中的文字完全看不见。
   仓库既有 12 个主题全部是这种「低对比选中块」约定（如 Dracula `#44475a`、Nord `#434c5e`）。
4. `cursorAccent` = 主题 background（与仓库既有主题一致）。

**以下色值已由主代理用仓库自己的 `semantic.ts` 算法算出并逐条标注对比度，执行者复算一致即可直接采用。**

  { id: 'catppuccin-mocha', name: 'Catppuccin Mocha', builtin: true, colors: {
    background: '#1e1e2e',
    foreground: '#cdd6f4',   // 11.34
    cursor: '#f5e0dc',   // 12.95
    cursorAccent: '#1e1e2e',
    selectionBackground: '#3a3b4e',   // 1.50
    black: '#45475a',   // 1.80
    red: '#f38ba8',   // 7.08
    green: '#a6e3a1',   // 11.03
    yellow: '#f9e2af',   // 12.91
    blue: '#89b4fa',   // 7.79
    magenta: '#f5c2e7',   // 10.74
    cyan: '#94e2d5',   // 11.01
    white: '#bac2de',   // 9.26
    brightBlack: '#585b70',   // 2.46
    brightRed: '#f7aec2',   // 9.21
    brightGreen: '#c2ecbf',   // 12.53
    brightYellow: '#fcd682',   // 11.78
    brightBlue: '#aeccfc',   // 10.03
    brightMagenta: '#f398da',   // 8.06
    brightCyan: '#b1eae1',   // 12.28
    brightWhite: '#a6adc8',   // 7.37
  } },   // min ANSI 1.80

  { id: 'catppuccin-frappe', name: 'Catppuccin Frappe', builtin: true, colors: {
    background: '#303446',
    foreground: '#c6d0f5',   // 8.06
    cursor: '#f2d5cf',   // 8.91
    cursorAccent: '#303446',
    selectionBackground: '#484d62',   // 1.47
    black: '#51576d',   // 1.72
    red: '#e78284',   // 4.65
    green: '#a6d189',   // 7.10
    yellow: '#e5c890',   // 7.62
    blue: '#8caaee',   // 5.34
    magenta: '#f4b8e4',   // 7.52
    cyan: '#81c8be',   // 6.41
    white: '#b5bfe2',   // 6.75
    brightBlack: '#626880',   // 2.23
    brightRed: '#eda0a2',   // 5.95
    brightGreen: '#b9dba2',   // 8.04
    brightYellow: '#ecd7ae',   // 8.74
    brightBlue: '#adc2f3',   // 6.91
    brightMagenta: '#f38ed8',   // 5.67
    brightCyan: '#98d2ca',   // 7.28
    brightWhite: '#a5adce',   // 5.55
  } },   // min ANSI 1.72

  { id: 'catppuccin-latte', name: 'Catppuccin Latte', builtin: true, colors: {
    background: '#eff1f5',
    foreground: '#4c4f69',   // 7.06
    cursor: '#bb7566',   // 3.17
    cursorAccent: '#eff1f5',
    selectionBackground: '#dbdee4',   // 1.19
    black: '#676a70',   // 4.80
    red: '#d20f39',   // 4.80
    green: '#307820',   // 4.84
    yellow: '#915c13',   // 4.96
    blue: '#1d61e9',   // 4.71
    magenta: '#984d84',   // 4.98
    cyan: '#12757a',   // 4.82
    white: '#5c5f77',   // 5.53
    brightBlack: '#676a72',   // 4.78
    brightRed: '#d00e39',   // 4.88
    brightGreen: '#317b21',   // 4.66
    brightYellow: '#946320',   // 4.57
    brightBlue: '#3066d1',   // 4.71
    brightMagenta: '#8f5981',   // 4.74
    brightCyan: '#13797e',   // 4.57
    brightWhite: '#67697e',   // 4.76
  } },   // min ANSI 4.57

  { id: 'tokyonight-night', name: 'TokyoNight Night', builtin: true, colors: {
    background: '#1a1b26',
    foreground: '#c0caf5',   // 10.59
    cursor: '#c0caf5',   // 10.59
    cursorAccent: '#1a1b26',
    selectionBackground: '#353747',   // 1.46
    black: '#15161e',   // 1.05
    red: '#f7768e',   // 6.46
    green: '#9ece6a',   // 9.35
    yellow: '#e0af68',   // 8.55
    blue: '#7aa2f7',   // 6.79
    magenta: '#bb9af7',   // 7.39
    cyan: '#7dcfff',   // 9.96
    white: '#a9b1d6',   // 8.10
    brightBlack: '#414868',   // 1.91
    brightRed: '#f7768e',   // 6.46
    brightGreen: '#9ece6a',   // 9.35
    brightYellow: '#e0af68',   // 8.55
    brightBlue: '#7aa2f7',   // 6.79
    brightMagenta: '#bb9af7',   // 7.39
    brightCyan: '#7dcfff',   // 9.96
    brightWhite: '#c0caf5',   // 10.59
  } },   // min ANSI 1.05

  { id: 'everforest-dark-soft', name: 'Everforest Dark Soft', builtin: true, colors: {
    background: '#293136',
    foreground: '#d3c6aa',   // 7.83
    cursor: '#e69875',   // 5.74
    cursorAccent: '#293136',
    selectionBackground: '#444949',   // 1.45
    black: '#7a8478',   // 3.40
    red: '#e67e80',   // 4.83
    green: '#a7c080',   // 6.61
    yellow: '#dbbc7f',   // 7.25
    blue: '#7fbbb3',   // 6.09
    magenta: '#d699b6',   // 5.73
    cyan: '#83c092',   // 6.25
    white: '#f2efdf',   // 11.46
    brightBlack: '#a6b0a0',   // 5.89
    brightRed: '#f85552',   // 4.04
    brightGreen: '#8da101',   // 4.56
    brightYellow: '#dfa000',   // 5.78
    brightBlue: '#3a94c5',   // 3.92
    brightMagenta: '#df69ba',   // 4.33
    brightCyan: '#35a77c',   // 4.39
    brightWhite: '#fffbef',   // 12.79
  } },   // min ANSI 3.40

  { id: 'one-dark-two', name: 'One Dark Two', builtin: true, colors: {
    background: '#21252b',
    foreground: '#e6e6e6',   // 12.33
    cursor: '#e6e6e6',   // 12.33
    cursorAccent: '#21252b',
    selectionBackground: '#414449',   // 1.57
    black: '#1d1f23',   // 1.07
    red: '#e27881',   // 5.31
    green: '#98c379',   // 7.64
    yellow: '#eac786',   // 9.54
    blue: '#71b9f4',   // 7.29
    magenta: '#c88bda',   // 5.98
    cyan: '#62bac6',   // 6.86
    white: '#c9ccd3',   // 9.57
    brightBlack: '#4a505a',   // 1.90
    brightRed: '#e68991',   // 6.12
    brightGreen: '#a8cc8e',   // 8.57
    brightYellow: '#edcf97',   // 10.24
    brightBlue: '#8dc7f6',   // 8.53
    brightMagenta: '#d3a2e2',   // 7.36
    brightCyan: '#78c4ce',   // 7.76
    brightWhite: '#e6e6e6',   // 12.33
  } },   // min ANSI 1.07

  { id: 'gruvbox-light', name: 'Gruvbox Light', builtin: true, colors: {
    background: '#fbf1c7',
    foreground: '#3c3836',   // 10.22
    cursor: '#3c3836',   // 10.22
    cursorAccent: '#fbf1c7',
    selectionBackground: '#e4dbb6',   // 1.23
    black: '#716c5a',   // 4.63
    red: '#cc241d',   // 4.82
    green: '#727114',   // 4.53
    yellow: '#8c6315',   // 4.73
    blue: '#3b7174',   // 4.87
    magenta: '#965372',   // 4.90
    cyan: '#4e7650',   // 4.59
    white: '#76695f',   // 4.68
    brightBlack: '#75695d',   // 4.70
    brightRed: '#9d0006',   // 7.60
    brightGreen: '#736e0d',   // 4.67
    brightYellow: '#915e10',   // 4.85
    brightBlue: '#076678',   // 5.82
    brightMagenta: '#8f3f71',   // 5.94
    brightCyan: '#3f7554',   // 4.77
    brightWhite: '#3c3836',   // 10.22
  } },   // min ANSI 4.53
