# 主题系统全面改造（A+B+C）设计文档

> ⚠️ **已归档（2026-10-21）**：本设计已随「主题系统全面改造」实施完毕并发布，仅作历史记录，不再维护。后续工作见 [`docs/PLAN-2026-10-21-backlog.md`](../../PLAN-2026-10-21-backlog.md)。

- 日期：2026-10-16
- 状态：已实施（已归档）
- 范围：浅色主题可读性（A）+ 底色柔化（B）+ 全量 CSS/TSX 颜色变量化（C）
- 关联：`docs/ROADMAP.md`、AGENTS.md「主题机制」章节（M4 需同步更新）

## 1. 背景与问题

用户主诉：白色主题下整体刺眼，终端内大量文字看不清（截图为 GitHub Light 下运行 Claude Code 的实际效果）。

### 1.1 根因清单

| # | 根因 | 位置 | 影响 |
|---|------|------|------|
| R1 | 内置浅色主题 ANSI 调色板是暗底色直接搬来的 | `src/shared/theme.ts` | 终端内 16 色大半不可读 |
| R2 | `drawBoldTextInBrightColors: true` 写死 | `TerminalView.tsx:864` | 粗体强制跳到 bright 变体，放大 R1 |
| R3 | `minimumContrastRatio` 仅背景图模式开 4.5，平时恒 1 | `TerminalView.tsx:869,1268` | xterm 渲染时对比度兜底完全关闭 |
| R4 | antd 写死 `darkAlgorithm` | `main.tsx:227` | 浅色下弹层/边框/hover 按暗色派生 |
| R5 | CSS/TSX 194 处真硬编码颜色（另有 122 处 var() 兜底值） | 见 §3 清单 | 白底白字、灰字对比不足、深色面板突兀 |
| R6 | GitHub Light 纯 `#ffffff` 铺满终端+chrome+antd 表面 | `theme.ts:298` | 刺眼 |
| R7（外部） | Claude Code 等 TUI 经 ConPTY 拿不到真实底色，按暗色出图 | 应用侧，不可控 | 只能靠 R3 的渲染时兜底 |

### 1.2 关键实测数据（WCAG 对比度）

GitHub Light（bg `#ffffff`）16 色中 **10 个 < 3:1**：brightWhite 1.00（白字白底）、brightYellow 1.06、brightCyan 1.24、brightGreen 1.38、white 1.69、yellow 1.85、brightMagenta 2.26、green 2.41、brightRed 2.75、brightBlue 3.89。仅 fg/black/blue/red/brightBlack 达到 4.5。

One Half Light（bg `#fafafa`）ANSI 15 色中 **7 个 < 3:1**（white 1.00、brightWhite 1.04、brightYellow 1.65、brightGreen 1.93、brightBlue 2.26、brightCyan 2.27、brightMagenta 2.82），**13 个 < 4.5:1**（另含 red/green/yellow/cyan/brightRed 3.0–3.5）；仅 magenta、brightBlack 达标（fg/black 同为 `#383a42` 达标）。

Solarized Light 未逐色测，其 bright 系列为 Solarized 体系的去饱和色，预计大部分达标；`white #eee8d5` vs bg `#fdf6e3` 明显不足，需纳入统一修复。

## 2. 目标与非目标

**目标**
1. 三套内置浅色主题下，终端与应用全部文字达到 WCAG AA（正文 ≥4.5:1，大字/图形 ≥3:1），以脚本验证。
2. 浅色主题不再刺眼（柔化底色，见 §5.3）。
3. 深色主题视觉零回归（语义色深色分支逐值对齐现状）。
4. 建立语义 token 层 + fail-closed 防护测试，杜绝硬编码颜色再次积累。
5. 主题切换时全 UI（终端、chrome、antd 弹层）一致跟随。

**非目标**
- 不新增主题/柔化强度设置项（YAGNI）。
- 不改关键词高亮引擎的着色算法（`highlightThemeColors` 跟随主题机制已存在，默认关，维持现状；预设颜色本身在浅色下的对比度由 R3 兜底，不单独重调）。
- 不动 `node_modules` 内 xterm.css。
- 不新增内置主题。

## 3. 现状盘点

### 3.1 硬编码分布（raw = 规则内真硬编码；fallback = `var(x, 兜底)` 内的值）

| 文件 | raw | fallback | 备注 |
|------|----:|----:|------|
| connections.css | 26 | 1 | 最大真硬编码户 |
| workspace.css | 22 | 42 | fallback 多为 `--chrome-*` 旧兜底 |
| terminal.css | 20 | 0 | 含白底隐形文字（:243/:312 `#ffffff` on 白）与深色工具条 |
| sftp.css | 18 | 17 | |
| global.css | 16 | 0 | |
| theme/chrome.ts | 16 | 0 | 混色锚点 `#000`/`#fff`，属算法参数，入白名单 |
| monitor.css | 15 | 12 | |
| settings.css | 11 | 25 | |
| MonitorPanel.tsx | 10 | 0 | 内联语义色 |
| TerminalView.tsx | 10 | 0 | 搜索高亮色 + 背景图深底衬 `#0d1117`（AGENTS.md 铁律，保留） |
| HighlightTab.tsx | 9 | 0 | 预设规则色板，属数据非 chrome，入白名单 |
| commands.css | 8 | 0 | |
| highlight.css | 6 | 18 | |
| ErrorBoundary.tsx | 2 | 0 | |
| lock.css | 2 | 7 | |
| main.tsx | 2 | 0 | antd token 的 mix() 失败兜底（暗色偏置，需顺手修正） |
| highlightEngine.ts | 1 | 0 | 规则默认色，属数据，入白名单 |
| **合计** | **194** | **122** | |

### 3.2 颜色族归类（按出现频次）

| 族 | 代表值 | 处数级 | 去向 |
|----|--------|--------|------|
| 中性灰文本 | `#cccccc` `#8a8a8a` `#9a9a9a` `#6a6a6a` `#d0d0d0` | ~120（含 fallback） | 文本层级变量 |
| GitHub 暗色语法色 | `#3fb950` `#f85149` `#d29922` `#58a6ff` `#e3b341` `#f0a55a` `#3fd06a` | ~70 | 语义色变量 |
| 白色半透明叠加 | `rgba(255,255,255,.04–.2)` | ~20 | hover/overlay 变量 |
| 深色面板 | `rgba(24,26,31,.85)` `#101418` `#181818` | 少量 | surface 变量 |
| 滚动条 | `rgba(125,145,170,.5)` | 4 | scrollbar 变量 |
| 阴影 | `rgba(0,0,0,.4–.55)` | 少量 | shadow 变量 |

### 3.3 失败模式

1. **白底白字**：`terminal.css:243,312` 的 `color:#ffffff` + 半透明白底、`#8a8a8a` 级灰字在浅色下 < 3.5:1。
2. **暗底语法色硬上浅底**：语义色全部取自 GitHub 暗色系（`#3fb950` 对白底 2.5:1）。
3. **深色构件不随主题**：搜索面板/工具条深色底在浅色窗口里成黑块（观感问题，可接受项，但颜色值需收敛进变量才可调）。

## 4. 总体架构

```
ThemeColors (L0 主题原始色, theme.ts)
  └─ chrome.ts (L1 派生: --chrome-* 现有 8 个 + 新增 L2 语义变量 --ot-*)
       ├─ global.css / 各 *.css 消费语义变量（本改造主体）
       ├─ main.tsx ThemedConfigProvider（按亮度切 antd algorithm）
       └─ semantic.ts（TS 常量，供 TSX 内联样式与 chrome.ts 共用单一来源）
```

- 亮度判定抽为共享纯函数 `isLightTheme(colors)`（chrome.ts 内已有 `chromeIsLight` 私有逻辑，抽出导出，配表驱动测试）。
- 语义变量一律带 fallback 写法（`var(--ot-text-muted, #8a8a8a)`），fallback 值收敛到受控常量清单（见 §7）。

## 5. 设计细节

### 5.1 L2 语义变量（新增，`--ot-` 前缀）

| 变量 | 用途 | 深色分支（=现值，零回归） | 浅色分支 |
|------|------|--------------------------|----------|
| `--ot-text` | 正文 | 主题 foreground | 混黑加深至 ≥7:1 |
| `--ot-text-secondary` | 次要文本 | fg 78% 透明（现 `color-mix` 值） | 同式，校验 ≥4.5:1 |
| `--ot-text-muted` | 弱化文本（`#8a8a8a` 族） | `#8a8a8a` | `mix(bg,#000,0.55)` 级，≥4.5:1 |
| `--ot-surface` | 面板底 | 现 `color-mix(fg 4–6%, bg)` | 同式反向 |
| `--ot-surface-raised` | 浮层/工具条底 | `rgba(24,26,31,.85)` 等 | `rgba(255,255,255,.9)` 级 |
| `--ot-hover` | 控件/行 hover 叠加 | `rgba(255,255,255,.04–.1)` | `rgba(0,0,0,.04–.1)` |
| `--ot-border` / `--ot-border-strong` | 边框 | 现 `--chrome-border` 族 | 同式 |
| `--ot-success`(+`-fg`) | 成功/运行态（`#3fb950` 族） | `#3fb950`（fg 亮化） | 加深变体 ≥3:1（fg ≥4.5:1） |
| `--ot-danger`(+`-fg`) | 危险（`#f85149` 族） | 同上策略 | 同上 |
| `--ot-warning`(+`-fg`) | 警告（`#d29922`/`#e3b341`） | 同上策略 | 同上 |
| `--ot-info`(+`-fg`) | 信息/链接（`#58a6ff`/`#3b8eea`） | 同上策略 | 同上 |
| `--ot-scrollbar` / `--ot-scrollbar-active` | 滚动条 | 现 `rgba(125,145,170,*)` | `rgba(0,0,0,.25/.4)` 级 |
| `--ot-shadow` | 浮层阴影 | `rgba(0,0,0,.4–.55)` | `rgba(0,0,0,.12–.2)` |
| `--ot-focus-ring` | 焦点环 | 现 `rgba(59,142,234,.18)` | 同值（蓝环两底均可读） |

规则：
- 语义色**不是**深浅共用一个值：深色分支锁定现值（零回归），浅色分支用 `mix(现值, #000, t)` 自动加深并经对比度脚本校验，t 在 `semantic.ts` 里按色相手调一次后固化。
- `--tab-accent` 机制不动（已有 `-fg` 明暗适配）。
- `:root` 同步写 `color-scheme: dark | light`（chrome.ts 按分支写入）：原生滚动条、表单控件、`::selection` 等跟随明暗，避免变量化了的部分被原生控件的不跟随出卖。

### 5.2 A：终端画布可读性（M0）

1. **浅色调色板重做**（`theme.ts` 三套）：
   - 规则：16 色逐个过对比度脚本，<4.5:1 的用 `mix(原值, #000, t)` 加深至达标（保留色相，t 固化进表）；`white`/`brightWhite` 在浅色主题一律重映射为中灰（提案：github-light brightWhite → `#57606f`，其余主题按各自 fg 深度取灰），**不允许任何颜色与背景对比 < 4.5:1**。
   - 达标用新增 `tests/theme-contrast.mjs` 固化（见 §7），调色板具体数值在实现期以脚本为准微调，本设计只锁规则与阈值。
2. **`minimumContrastRatio`（MCR）动态化**——按「背景图 × 主题亮度」矩阵取值：

   | 场景 | 现值 | 新值 |
   |------|------|------|
   | 背景图模式（任意主题） | 4.5 | **4.5（不变，铁律）** |
   | 无图 · 浅色主题 | 1 | **4.5** |
   | 无图 · 深色主题 | 1 | **1（不变）** |

   构造（`TerminalView.tsx:869`）与热更（`:1268`）两处同步改；拼写用 `minimumContrastRatio`（AGENTS.md 已记 `minContrastRatio` 静默失效的坑）。此项是对 R7（应用输出 arbitrary truecolor 低对比色）的唯一渲染时兜底，浅色必须开。已验证（2026-10-16，node_modules 实查）：WebGL 渲染器自带完整对比度执行路径（`addon-webgl.mjs` 的 `_getMinimumContrastColor` → `ensureContrastRatio`，含 dim 的 halfContrastCache），且 `drawBoldTextInBrightColors`/`minimumContrastRatio` 变更会随 options 同步进 webgl 配置；`rendererMode` 默认 `auto`（webgl 优先、dom 回退），两条路径均执行 MCR，无死角。
3. **`drawBoldTextInBrightColors`**：浅色 false、深色 true（维持现状），两处同改。
4. **antd algorithm**（`main.tsx`）：按 `isLightTheme` 切 `defaultAlgorithm`/`darkAlgorithm`——**antd（含 v6）没有 `lightAlgorithm`，浅色就是 `defaultAlgorithm`**（已在 node_modules/antd/es/theme/index.js 核实导出仅有 default/dark/compact 三种）；`colorBgContainer`/`colorBgElevated` 的 mix() 失败兜底改为按亮度取 `#f5f5f5`/`#1f1f1f` 两套。

### 5.3 B：底色柔化（M0）

- GitHub Light `background #ffffff` → `#f6f8fa`（GitHub 官方 light canvas 色），`cursorAccent` 同步；其余 15 色按 §5.2.1 重算。
- One Half Light `#fafafa`、Solarized Light `#fdf6e3` 本身带色调，**不动**（避免拍脑袋改两套成熟主题的观感）。
- 不加「柔化强度」设置。

### 5.4 C：清扫批次（M1–M3，每批独立提交、独立可回滚）

映射规则（机械执行）：

| 现值模式 | 替换为 |
|----------|--------|
| `#8a8a8a`/`#9a9a9a`/`#6a6a6a` 文本 | `var(--ot-text-muted, …)` |
| `#cccccc`/`#d0d0d0` 文本 | `var(--ot-text, …)` 或 `-secondary`（按语境） |
| `color-mix(fg x%, …)` 文本 | `var(--ot-text-secondary/muted)` |
| `#3fb950` 族 | `var(--ot-success)` / `-fg` |
| `#f85149` 族 | `var(--ot-danger)` / `-fg` |
| `#d29922`/`#e3b341`/`#f0a55a` | `var(--ot-warning)` / `-fg` |
| `#58a6ff`/`#3b8eea`/`#3fd06a`(链接) | `var(--ot-info)` / `-fg` |
| `rgba(255,255,255,.04–.1)` 控件 hover | `var(--ot-hover)` |
| `rgba(255,255,255,.16–.2)` / 成块白色半透明面板 | `var(--ot-surface-raised)` / `var(--ot-border-strong)`（按语境：描边用后者） |
| `rgba(125,145,170,*)` | `var(--ot-scrollbar*)` |
| `rgba(0,0,0,.4+)` 阴影 | `var(--ot-shadow)` |

批次：
- **M1 基座**：`semantic.ts` + chrome.ts 写 L2 变量 + `isLightTheme` 导出 + global.css + terminal.css + TerminalView.tsx 内嵌色 + ErrorBoundary.tsx + main.tsx 兜底。
- **M2 主工作区**：workspace.css + connections.css + commands.css。
- **M3 功能面板**：sftp.css + monitor.css + MonitorPanel.tsx + settings.css + highlight.css + lock.css。

白名单（防护测试豁免，§7）：**semantic.ts 自身**（它是语义色的定义处，扫描它等于扫描标尺）；**theme.ts**（内置调色板是主题数据）；**global.css 的 `:root` 静态兜底块**（chrome.ts 变量缺失时的暗色默认值）；chrome.ts 混色锚点（`#000000`/`#ffffff`，属算法参数）；TerminalView 的 xterm ITheme 搜索色（主题数据）、背景图深底衬 `#0d1117` 与 `#00000000` 透明色（铁律）；HighlightTab.tsx/highlightEngine.ts 的规则色（数据）。扫描器必须**先剥离注释再匹配**（terminal.css:16、highlightEngine.ts:17 的命中都在注释里），且正则覆盖 3/4 位 hex（`#fff`）。

### 5.5 兼容性

- 用户自建 `customThemes` 不受影响（L2 从 ThemeColors 派生，无需迁移）。
- ThemeEditor 只能编辑/新建 customThemes（已核实 `ThemeEditor.tsx:70-74`），改内置主题颜色无兼容负担；想要旧色的用户可在编辑器里以旧值建副本。
- `getThemeById` fallback（DEFAULT_DARK）不变。
- 纯渲染层改动，无 IPC/settings 结构变更；`settings.terminal.themeId` 语义不变。

## 6. 测试与验收

### 6.1 新增测试（fail-closed，沿用仓库表驱动风格）

1. `tests/theme-contrast.mjs`：直接 `import '../src/shared/theme.ts'`（Node 22.18+ 原生类型剥离，同 terminal-cwd 等三测试的既有做法）。对每套内置主题：计算全部 16 色对 background 的对比度，**浅色主题（isLight=true）每色 ≥4.5，深色主题仅断言 foreground ≥4.5**（不约束暗色系既定美学）。另覆盖 `isLightTheme` 判定表。
2. `tests/css-theme-vars.mjs`：扫描 `src/renderer/src` 全部 `.css/.tsx/.ts`，正则提取色字面量，白名单外一律 exit 1；`var()` 内 fallback 必须命中受控常量清单。**接入 `package.json` `test` 脚本链**（纯文件扫描，无需 esbuild bundle）。

### 6.2 既有回归

`npm test`（pretest typecheck + 22 个离线测试）全绿。

### 6.3 手工验收清单（每批 M1–M3 + M0 各跑一次）

三套浅色主题 × {终端（含 Claude Code 实跑）、设置弹层/下拉/Tooltip、SFTP 面板、监控面板、锁屏（含 `.lock-screen-boot` 启动闪层）、命令面板、连接侧栏、zmodem 传输弹层}；深色主题抽查同清单确认零观感变化；背景图模式抽查（深底衬铁律不破）；运行中明暗主题热切换各一次（chrome/antd/xterm 三路同步）。

### 6.4 性能

`minimumContrastRatio=4.5` 生产先例即背景图模式（已在线上跑）；实现时用诊断日志对比开关前后的渲染层 stall 事件与高频输出场景，数据记入 PR 描述。

## 7. 防护测试细则

- 扫描正则：`#[0-9a-fA-F]{3,8}\b` 与 `rgba?\(`；`var(...)` 内命中归 fallback 规则，其余归 raw 规则。
- 白名单按「文件 + 值」二元组维护在测试内（表驱动用例风格）。
- 受控 fallback 清单：`semantic.ts` 导出的常量表，测试同时校验「CSS 里出现的 fallback ⊆ 清单」与「清单无死值」双向一致。
- 里程碑 M4 收尾时把扫描基线清零：除白名单外 raw 计数必须为 0，此后新增硬编码直接红。

## 8. 里程碑与提交切分

| 里程碑 | 内容 | 提交 | 验收 |
|--------|------|------|------|
| M0 | §5.2 + §5.3（调色板、两开关、antd 算法、柔化）+ theme-contrast 测试 | 1 个 | 主诉立解；深色零回归 |
| M1 | 语义层基座 + global/terminal + TSX 内嵌 | 1 个 | 手工清单浅色全过 |
| M2 | workspace/connections/commands | 1 个 | 同上 |
| M3 | sftp/monitor/settings/highlight/lock | 1 个 | 同上 |
| M4 | css-theme-vars 测试 + 基线清零 + AGENTS.md「主题机制」重写 + docs/STATE.md 更新 | 1 个 | npm test 全绿含新测试 |

每个里程碑独立可回滚；M0 可单独先行发版验证效果。

## 9. 风险与缓解

| 风险 | 缓解 |
|------|------|
| WebGL 渲染器不执行 MCR | **已排除**（2026-10-16 实查 addon-webgl 源码，见 §5.2.2） |
| MCR=4.5 渲染性能 | 背景图模式生产先例；诊断日志实测；不行则浅色降 3.5 并记录取舍（4.5 仍为目标值） |
| 深色回归 | 语义色深色分支锁现值 + 每批手工清单深色抽查 + diff 审查 |
| 加深算法破坏色相辨识（如 red 混成棕） | t 按色相手调固化，不许纯算法一路推到底；脚本只做下限校验 |
| 用户依赖旧浅色配色 | 主题编辑器可建副本还原；CHANGELOG 注明 |
| 大批量 CSS 改动引入选择器/特异性事故 | 只改颜色声明值，不动布局/盒模型属性；AGENTS.md 已记 sftp grid 教训 |

## 10. 待拍板问题（交叉审核请逐条确认）

1. 语义变量命名空间 `--ot-*`（提案）还是并入现有 `--chrome-*`？
2. GitHub Light 柔化目标 `#f6f8fa` 是否接受？
3. 深色主题是否也统一开 MCR 4.5（提案：维持 1，最小改动）？
4. `var()` fallback 是否按 §7 收敛为受控清单（提案：是，M4 落地）？
5. One Half Light / Solarized Light 底色维持不动（提案）？
6. M0 是否单独先行发版，还是 M0–M4 一起发？

## 11. 对抗性审查记录（2026-10-16）

审查执行：独立审查子代理（环境故障未产出有效报告）+ 主会话逐项自行验证。以下发现已全部落入正文：

| # | 发现 | 级别 | 处置 |
|---|------|------|------|
| 1 | antd 无 `lightAlgorithm`，浅色应为 `defaultAlgorithm` | Important（真实错误） | §5.2.4 已改 |
| 2 | §5.2.2「深色 1（维持现状）」与背景图模式现状（深色+图=4.5）表述冲突 | Important | §5.2.2 改为显式矩阵 |
| 3 | WebGL 渲染器是否执行 MCR 未验证（承重假设） | Critical（假设） | **已实查源码排除**：addon-webgl 有完整对比度路径，§5.2.2 记录证据 |
| 4 | 两 xterm 选项运行时热设未验证 | Important（假设） | 已核实：options 同步进 webgl 配置；生产代码本就在热设 MCR |
| 5 | 防护测试扫描器会误伤 semantic.ts/theme.ts/global.css 兜底块自身 | Important | §5.4 白名单已显式枚举 |
| 6 | 扫描器须剥注释、覆盖 3/4 位 hex | Minor（实现细节） | §5.4 已写明 |
| 7 | One Half Light「9 个 <3:1」计数错误（实为 7 个） | Minor（数据错误） | §1.2 已改 |
| 8 | 原生控件（滚动条等）不随明暗 | Minor（遗漏） | §5.1 增 `color-scheme` |
| 9 | 锁屏启动闪层、zmodem 等面板浅色表现未入验收清单 | Minor | 已入 §6.3 手工清单 |
