# 字体与关键词高亮改进计划（2026-10-17）

基于 2026-10-17 的专项调研（字体两轮 + 高亮两轮，子代理实测探针交叉印证，主模型复核关键结论）。所有问题均给出证据位置与验收口径，按批次执行。

## 调研结论摘要

**字体**：能力面已全（family/字号/字重/粗体字重/字间距/行高 + 预览 + 热更 + 热键），WebGL 字形图集在字体变化时自动重建（无缺陷，不需要 `clearTextureAtlas`）。核心短板：默认字体栈无 CJK 字体、无 unicode11 宽度表、无 `rescaleOverlappingGlyphs`，中文环境列对齐无保障；字体下拉是系统全量字体且无等宽标记，与「系统等宽字体」文案矛盾。

**高亮**：引擎与规则体系在「用户自定义正则高亮」层领先 VS Code / Windows Terminal；性能实测 200 条规则 × 135KB 文本 ≈ 11ms，规则数量非瓶颈。核心短板：两个现成 bug（`perm` 预设锚定失效、注入的 `\x1b[0m` 清掉应用自身样式）；「匹配后动作」能力为零（secret 只上色不设防）；`m` flag 不可用；预设升级机制只覆盖 2 条旧 pattern。

---

## P0 正确性修复（bug，优先做）

### P0-1 `perm` 预设锚定失效（本轮实施：Qwen 任务 A）

- **问题**：`src/shared/settings.ts:299` 的 `^[-dlbcps][rwxstST-]{9}` 中 `^` 锚定的是「转义序列之间的 text run 起点」而非行首。`ls -l` 多行输出只有第一行权限位上色；带颜色的 `ls`（run 以 `\x1b[32m` 切开）完全不触发。`tests/hl-rules.mjs` 无 perm 用例。
- **方案**：pattern 改为 `(?<=^|\s)[-dlbcps][rwxstST-]{9}(?![rwxstST-])`（lookbehind 锚定行首/空白边界；trailing 用负向前瞻拒绝「再跟一个权限字符」——不能用 `(?=\s|$)`，会把 ACL/SELinux `+`、macOS `@` 后缀的真实 `ls -l` 输出挡掉，这是审核轮抓到的回退）；旧 pattern 登记 `src/main/settingsStore.ts` 的 `LEGACY_BUILTIN_PATTERNS`，让存量安装升级；补 perm 测试用例（多行 `ls -l`、带色输出、单词内不误配、11 字符不截断、ACL `+`/macOS `@` 后缀仍染色）。
- **验收**：`npm test` 全绿；新增用例覆盖上述场景。
- **风险**：10 个连续连字符（markdown 分隔线 `----------`）会误配——触发面极窄，接受；已知带 ACL/SELinux 后缀的权限串不再染色的问题已由负向前瞻写法解决。
- **状态**：✅ 已完成（Qwen3.8-27B 实施 → flash 审核发现 ACL 回退 → 主模型定稿 pattern `(?![rwxstST-])` 并补 2 个后缀用例，`npm test` 全绿）。

### P0-2 注入的 `\x1b[0m` 清掉应用自身 SGR 样式

- **问题**：`src/renderer/src/terminal/highlightEngine.ts` 的 `wrap` 给每个命中 span 固定追加 `\x1b[0m`。实测 `\x1b[33mWARNING tail` → `tail` 丢失应用的黄色。
- **方案**：tokenize 时跟踪当前活跃 SGR 状态（进入 span 前记录自上次转义以来的 SGR 序列，span 结束后重放而非裸 reset）。只对 text→seq 边界内做，保持 `hl-split-smoke` 逐字节兼容。
- **验收**：新增引擎用例：`\x1b[33mWARNING tail` 染色后 `tail` 仍为黄色；`hl-split-smoke` 全绿。
- **⚠ 实施后的性能回归与修正（2026-10-17 实测）**：初版只设 `MAX_RESTORE_LEN=256`（累积器上限），结果恢复串在**每个 span 后**都重放，代价是 `串长 × span 数`。Kimi 这类全彩 TUI 一行 ~19 个 span，19 字节真彩色串使 9.5KB 输出膨胀到 40.8KB（**4.30x**，改动前 2.78x）；叠加用户配置（背景图 + WebGL + 高亮 all 档，MCR=4.5 逐字形算对比度且真彩色令缓存全 miss），渲染线程卡 **18.4 秒**（日志 `[renderer] main thread stalled ~18384ms`，用户报「输入 kimi 要很久才加载出来」）。**修正**：新增独立成本闸门 `MAX_REPLAY_COST=11` 字节（按「收益能否覆盖长度×span 数」，而非串本身的绝对长度），≤11 字节（单色/单属性）仍回放、更长退回裸 reset 即改动前行为。实测膨胀回到 2.78x（与改动前一致），收益场景 `\x1b[33m` 仍正确保留。教训：**功能性用例全绿不代表热路径没回归，改这段必须跑 TUI 密集输出的膨胀基准**

### P0-3 多窗格统计「最后写入者赢」

- **问题**：`src/renderer/src/terminal/highlightStats.ts` 的模块级 `totals` 被每个 pane 的 1s 周期发布覆盖，设置页数据在窗格间跳动。
- **方案**：按 pane 汇总（key 为 session/pane id）或改为累加合并；设置页展示汇总值。
- **验收**：两个 pane 同时输出时统计稳定不跳动。

### P0-4 字体死代码：`automaticFontFallback`（本轮实施：Qwen 任务 B）

- **问题**：`src/renderer/src/terminal/TerminalView.tsx:878` 的 `automaticFontFallback: true` 在 @xterm/xterm 6.1.0-beta.304 中不存在（typings 与 lib 均无），是空操作，且靠 `as Terminal['options'] & object` 绕过了类型检查，误导维护者。
- **方案**：删除该行；若该 as-cast 仅为容纳此未知选项而存在则一并删除。`tsc -p tsconfig.web.json` 验证。

### P0-5 `disableQuoting: true` 去掉字体名引号保护

- **问题**：`src/main/ipc.ts:224` 显式关闭 font-list 的引号包裹，含 `()`/`+`/数字开头/等于 CSS 关键字的字体名在 CSS/canvas 解析中可能失败。
- **方案**：保持枚举原样，渲染层消费点（写入 settings 前或传给 xterm 前）对字体栈逐段 `JSON.stringify` 包裹非法标识符段（实现为纯函数，两端复用）。

### P0-6 `overviewRuler` 顶层写法无效 + `as` 断言可绕过任何伪造选项（审核轮新发现）

- **问题**：`TerminalView.tsx` 构造 Terminal 时顶层的 `overviewRuler: { width: 9, ... }` 不是 6.1.0-beta.304 的顶层选项——它属于 `IScrollbarOptions`，正确写法是 `scrollbar: { width: 9, overviewRuler: {...} }`。顶层键会被 OptionsService 构造**静默丢弃**（实跑验证 `new Terminal({overviewRuler}).options.overviewRuler === undefined`），当前滚动条宽度实为 xterm 默认值。另外 `as Terminal['options'] & object` 断言能让**任何**伪造键通过 tsc（审核实测 `totallyBogusOption` 也能过）。
- **方案**：决定产品意图——若想要 9px 滚动条 + overview ruler，改写为 `scrollbar: {...}` 并验证视觉效果；否则删除。删除后 `as` 断言可一并移除（审核实测：去掉 overviewRuler 后无断言也能过类型检查）。注意 `withChromeColors` 里的 `overviewRulerBorder` 是 `ITheme` 合法键，**有效，不要误删**。
- **验收**：tsc 零错误；若启用 `scrollbar.overviewRuler`，视觉验证滚动条与 ruler 表现。

---

## P1 高价值低成本

### P1-1 编辑器「按行匹配」开关（暴露 `m` flag）

- 引擎 `compileRules` 只拼 `g`/`gi`（`highlightEngine.ts:131`）。规则 schema 加 `lineAnchor?: boolean`，编译时追加 `m`；编辑器加开关。顺手化解 P0-1 类问题对用户自写 `^...$` 规则的困扰。

### P1-2 CJK 宽度与对齐三件套（字体侧最大用户价值）

1. 安装 `@xterm/addon-unicode11`（**先验证与 6.1.0-beta.304 兼容**；渲染层依赖 → devDependencies，遵守仓库依赖分类规则）+ `term.unicode.activeVersion = '11'`
2. 开 `term.options.rescaleOverlappingGlyphs = true`（仅 WebGL 有效，DOM 渲染器下无效需在文档/UI 标注）
3. `fontFamily` 支持独立 CJK 回退槽位（设置新增「中文字体」，拼接在字体栈尾）

### P1-3 字体下拉等宽徽标

- 渲染层 canvas `measureText` 检测字符步进一致性（采样 `i l 1 W m 0` 等字符宽度），列表加「等宽」徽标 + 默认等宽优先排序；同步修正「系统等宽字体」文案（现为误导）。

### P1-4 `MAX_LINE_LEN` 按行跳过（而非整段 run 跳过）

- 现状：一条 >4KB 的行让整个 text run（含其中的 `ERROR`）全部失去高亮，且无提示（`highlightEngine.ts:229-237`）。改为按行切分后只跳过超长行。`MAX_PER_RULE` 截断同理考虑提示（i18n 四语）。

### P1-5 字体预览补 CJK 混排样例（本轮实施：Qwen 任务 B 一并做）

- `TerminalPreview` 样例只有拉丁 `ls -la`。补中文文件名 + 权限位混排行，让用户选字体时即可暴露 CJK 错位。

---

## P2 功能演进（高亮的「匹配后动作」层）

### P2-1 引擎匹配事件出口（前置基建，性价比最高的新能力）

- 复用 `StatsSink` 注入模式：`applyHighlights` 接受可选事件 sink，命中时上报 `(ruleId, matchText, pane)`，默认路径零成本。这是解锁 P2-2/P2-3/P2-4 的钥匙。
- 难点：动作要跨到主进程/托盘（现有 `notifyUpdate` 只服务更新器）；需按规则去重限流（忙碌日志每秒上千命中）。

### P2-2 secret 命中设防

- 依托 P2-1：secret 规则命中时可选「弹提醒 / 会话内打码 / 复制前警告」。现状 secret 与普通红字无区别，而它是 5 条 basic 规则之一。

### P2-3 用户自定义可点击链接规则（WezTerm hyperlink_rules 式）

- link provider 与「文本偏移→单元格坐标」映射已有（`TerminalView.tsx:1019-1047`，现仅 4 条写死 URL 正则）。接上「正则 + URL 模板（`$0/$1`）」即可，架构成本低。

### P2-4 关键词命中通知 / tab 标记（iTerm2 Triggers 子集）

- 依托 P2-1：匹配到指定模式时托盘通知（复用锁屏/托盘链路）、标签加红点。定位「跑长任务时人不在终端前」的场景。

---

## P3 打磨（按需排期）

| 项 | 内容 | 位置 |
|---|---|---|
| 归因诊断 | 编辑器显示草稿规则命中 N 处、被哪条规则抢走 | `HighlightTab.tsx` 预览扩展 |
| 规则管理 | 表格文本搜索、批量启停、命中 0 次提示 | `HighlightTab.tsx` |
| 主题色引用 | 规则颜色支持 `@green` 等主题 ANSI 引用 + per-rule「不跟随主题」 | `highlightColors.ts`、schema |
| 正则校验统一 | 主进程 `coerceRule` 补 `new RegExp` 校验（现编辑器/导入拦、主进程不拦、引擎静默跳过） | `settingsStore.ts:50-138` |
| 预设升级机制重建 | `LEGACY_BUILTIN_PATTERNS` 只覆盖 2 条旧 pattern，后续预设改动无法下发老用户 | `settingsStore.ts:145-163` |
| 16ms flush 建模 | `hl-split-smoke` 补应用层 16ms carry flush 的跨块场景（现为测试盲区） | `tests/hl-split-smoke.mjs` |
| 字体名双语 | 枚举优先 zh-cn 本地名，用户对不上 Consolas 等拉丁名；改双列显示 | `ipc.ts`、`SettingsTabs.tsx` |
| 主进程数字钳制 | fontSize/letterSpacing/lineHeight 仅 UI 钳制，主进程清洗放行任意值 | `settingsStore.ts:325-337` |
| SGR 跨转义匹配 | 被 SGR 打断的 token（如真彩色着色的 URL）匹配不到——低频，与 P0-2 同区域，可一并评估 | `highlightEngine.ts` tokenize |

---

## 执行批次

| 批次 | 内容 | 执行者 | 状态 |
|---|---|---|---|
| 本轮-1 | P0-1 perm 锚定修复（含审核轮 ACL 后缀修正） | Qwen3.8-27B 实施 + flash 审核 + 主模型定稿 | ✅ 完成 |
| 本轮-2 | P0-4 字体死代码删除 + P1-5 预览 CJK 样例 | Qwen3.8-27B 实施 + flash 审核 | ✅ 完成 |
| 本轮-审核 | 两个任务的代码审核（含独立探针复验） | flash（默认模型）子代理 | ✅ 完成（发现 1 处回退，已修；新增 P0-6） |
| 本轮-把关 | 测试全量回归 + 计划定稿 | 主模型 | ✅ 完成（`npm test` 29 测试全绿） |
| 第二批-波1 | P0-2 SGR 恢复 + P1-4 按行护栏（引擎）/ P0-3 统计聚合 + P0-6 死代码清理 | flash 实施 ×2 并行 + 主模型把关 | ✅ 完成（各 19/9/11 项新断言；pane key 用实例 UUID 规避 SSH 分屏同 session） |
| 第二批-波2 | P0-5 字体名引号包裹 / P1-1 按行匹配开关（m flag） | flash 实施 ×2 并行 + 主模型把关 | ✅ 完成（新增 tests/font-stack.mjs，测试数 29→30；i18n 四语 +2 key） |
| 第三批 | P1-2 CJK 三件套 + P1-3 等宽徽标 | flash 实施 ×2 并行（文件不相交、契约字段钉死）+ 主模型把关 | ✅ 完成（unicode11 装的是 0.10.0-beta.301，peer 精确接受 beta.304；`cjkFontFamily` 默认空=零行为变化；等宽检测 canvas 采样容差 0.01） |
| 远期 | P2-1 → P2-2/3/4 依次解锁 | flash 实施 ×2（串行两波）+ 主模型把关 | ✅ 完成（2026-10-17 第二轮） |

### P2 执行记录（2026-10-17 第二轮）

- **P2-1 引擎事件出口**：`applyHighlights` 第 5 参 `onMatch?: (ruleId, text) => void`，仅「真的画上屏」的 span 上报（被抢占/预算耗尽/超长行跳过都不报）；`HighlightStream` 6 个 `applyHighlights` 调用点全透传；未传时零开销。测试 `[match events]` 段 7 断言（含 301 命中恰好 300 次上报的预算边界、跨切分只报一次）
- **P2-2 secret 命中提醒（产品取舍：应用内提醒，不打码）**：规则级 `notify?: boolean` 字段 + 编辑器「命中时提醒」开关；消费端 60s 冷却去重（per pane per rule）；antd notification 提醒**只显示规则名、绝不渲染匹配原文**（secret 原文就是密钥）；`notifyRules` 从 mode/profile 过滤后的实际规则集派生，被排除的规则不报警。**secret 预设默认 `notify: true`（仅新装；存量不静默升级**——把会产生弹窗的新行为塞进 refreshBuiltinRules 等于替用户做了「以后会被打断」的决定，用户可手动开）
- **P2-3 自定义可点击链接（WezTerm hyperlink_rules 式）**：`AppSettings.linkRules`（默认空）+ `src/shared/linkRules.ts` 纯模块（sanitize/formatLinkTemplate `$0`–`$9`/`compileLinkRules`/`mergeLinkSpans`）+ HighlightTab 底部编辑器（pattern/template/note/enabled，非法正则内联报错）+ link provider 叠加在内置 URL 之上（用户规则优先，热更走 ref 不重建终端）。**安全闸门**：`isSafeLinkTarget` 在生成 span 时就丢弃非 http/https 目标（`file://`/`javascript:` 连下划线都不出现），主进程 openExternal 协议白名单兜底。性能护栏：>4KB 行跳过用户规则、每规则每行 200 上限、零宽匹配强制前进。测试 `tests/link-rules.mjs` 86 断言（**测试数 30→31**）
- **P2-4 关键词命中通知/tab 标记**：通知子集已由 `notify` 字段覆盖（任何规则可开）；**tab 红点标记搁置**——需 dockview 面板参数联动与面板生命周期管理，复杂度高且与通知重叠，待真实需求再评估
- 最终把关：`npm test` 31 个测试全绿、`verify-deps` 448 包一致、`npm run build` 通过、AGENTS.md 已同步（测试数 31、「可点击链接规则」新章）
- 未做 git 提交（用户要求）

### 进度记录（2026-10-17）

- P0 六项全部完成：P0-1 perm（含 ACL `+`/macOS `@` 后缀）、P0-2 SGR 恢复（`SgrState`，`MAX_RESTORE_LEN=256` 降级）、P0-3 统计按 pane 聚合、P0-4 死代码删除、P0-5 `quoteFontStack`（settings 存原样、消费点包裹）、P0-6 overviewRuler/as 断言清理（产品决定：不启用 scrollbar ruler，维持现状视觉）
- P1 五项全部完成：P1-1 `lineAnchor`（gm/gim + 编辑器开关 + `^$` 徽标）、P1-2 CJK 三件套（unicode11 0.10.0-beta.301 精确锁定 / `rescaleOverlappingGlyphs` / `cjkFontFamily` 槽位）、P1-3 等宽徽标 + 误导文案修正、P1-4 超长行按行降级、P1-5 预览中文混排样例
- 最终把关：`verify-deps` 448 包一致、`npm test` 30 个测试全绿、`npm run build` 通过、AGENTS.md 已同步（测试数、终端字体新章、高亮锚定/SGR/降级/统计四条铁律）
- 未做 git 提交（用户要求）；工作区含全部改动

## 复查轮（2026-10-17 晚）：完整 review 与修复

用户报「行高调到 0.95 后所有窗格崩溃」后做了一次全量复查，发现并修复以下问题（全部实测复现）。**行高只是冰山一角：核心缺陷是「UI 允许的值 / 配置能写的值 与 xterm 硬约束不一致，而主进程不做校验」。**

### 已修（P0）

| 问题 | 后果 | 修复 |
|---|---|---|
| `lineHeight < 1` | xterm 抛错 → 错误边界卸掉整个窗格；坏值落盘后每次启动都崩 | UI 下限 0.8→1 + 主进程钳制 + `healClampedFontSettings()` 回写自愈 |
| `cursorStyle` 非法值 | **更糟**：构造期静默吞错、热更期抛错，所以「重试」按钮永远无效，窗格死循环 | `CURSOR_STYLES` 白名单（shared 层单一来源） |
| `scrollback < 0` | 同上，热更抛错 | 纳入 `FONT_LIMITS` 钳制 100–100000 |
| `cursorInactiveStyle` / `rendererMode` 非法值 | 静默失效（失焦不画光标 / 误以为选了 DOM 却走 WebGL） | 同款白名单化 |
| **ReDoS** | pattern 无长度限制且预览每键跑一次：`(a+)+$` 配 30 字符实测卡 **8.2 秒**，25 字符翻倍。`MAX_LINE_LEN=4KB` 限的是长度不是回溯成本 | `MAX_PATTERN_LEN=500` + 编辑器 `maxLength` + `backtracksBadly()` 探测（4 组诱发输入实跑，超 50ms 即警告）。**根因未除**：正解需 Worker + 超时，列为待办 |
| **SGR reset 只认两种写法** | `ESC[00m`/`ESC[0;0m`/`ESC[0;32m`（Go/Java 日志库常写）被当作可累积序列**追加**，累积器逐行增长直到撞上限，之后所有 span 恢复永久失效 | 改为解析参数：全 0/空 = 全量复位；`0;…` 前缀先清空再记录 |
| **CSI 私有参数不识别** | `ESC[>4;1m`(modifyOtherKeys) / `ESC[<0;1;2M`(SGR 鼠标) / `ESC[=1;1$y`(DECRQM) 让整行成含裸 ESC 的文本，**该行之后所有关键词失去高亮**；vim/tmux 常发 | `ESCAPE_RE` 补 `<>=` 与中间字节区间 `[ -/]*` |
| `quoteFontStack` 不转义反斜杠 | 尾部反斜杠使 CSS 字符串不闭合，字体静默回落默认 | `replace(/[\\"]/g, '\\$&')` |

### 关键自我修正（两个判断失误，均已落成 AGENTS.md 铁律）

1. **回放闸门按字节数是错维度**：`MAX_REPLAY_COST=11` 会砍掉真彩色（13–19B）却放过索引色（11B）——同一个「单个前景色」语义待遇不同。改为按 **序列条数**（`MAX_REPLAY_SEQUENCES=3`）。
2. **恢复串不必每个 span 都重放**：只有「可见间隙」（≥3 个可见字符）和最后一个 span 之后才需要。改为按间隙插入后，密集 TUI 膨胀从 **4.30x 降到 3.05x**，长间隙着色仍正常（实测 12 处间隙正确恢复）。

### 待办（P1，本轮未做）

- **ReDoS 根治**：预览编译/执行挪进 Web Worker + 超时；可选引入 `re2`。现有长度上限只是止血
- `fontWeight`/`boldFontWeight` 越界被 xterm 静默改写（手改 json 才会遇到，纯体验问题）
- `resizePty` 的 `cols`/`rows` 完全信任渲染层（低危，靠自家 fit 逻辑兜底）
- 链接规则的导入/导出、profile 联动


## 约束提醒（对实施者）

- 高亮引擎改动必须过 `node tests/.hl-rules.cjs`（bundle 经 `node tests/build-bundles.cjs` 重建）与 `tests/hl-split-smoke`；改预设 pattern 必须同步 `LEGACY_BUILTIN_PATTERNS`，否则存量安装拿不到修复
- i18n 新文案四语齐备（zh-CN/zh-TW/en/ja，缺译回退简体）
- 渲染层新依赖一律 devDependencies；`@xterm/*` 版本必须与锁定的 6.1.0-beta.304 体系兼容，改依赖后必须真实 `npm install` 并跑 `node scripts/verify-deps.cjs`
- 改动若触碰 AGENTS.md 已记载的行为，同步更新 AGENTS.md

## 最终 review 结论（2026-10-17 收尾）

对 `c6aca15` 做了独立复查，**发现 ReDoS 静态检测不可靠，已从「拒绝闸门」降级为「编辑器提示」**。

### 实测漏判（危险规则仍会进热路径）
| pattern | 静态检测 | 实测耗时 |
|---|---|---|
| `[(](a+)+$` | 放行 | 30 字符 **4065ms** |
| `(?:a|a)+$` | 放行 | 26 字符 **7547ms** |
| `((a|a))+$` | 放行 | 24 字符 **16212ms** |
| `(\w|\d)+$` | 放行 | 26 字符 **14451ms** |

根因：外层扫描不跟踪字符类状态（`[(` 里的 `(` 被当组起始）、遇到不闭合组时整个函数提前返回、分支比较只做字面相等。

### 实测误判（合法规则被拒）
`(?:a{2,3})+`、`(?:\d{2})+` —— 把 `{n,m}` 范围重复当成 `{n}` 固定重复。

### 尝试修复但失败
补字符类状态后又误杀 `(?:\d{2})+` 与 `ipv4` 预设。**每修一处引入新问题**，证明手写正则语法扫描有本质缺陷。

### 否决的三个替代方案
1. **运行时熔断**（循环里查时钟）：**原理上无效**。实测单次 `exec` 阻塞 **28426ms**，时钟检查根本执行不到
2. **re2**：不支持 lookbehind，`perm`/`okstate`/`http` 三条预设依赖它
3. **Worker + 超时**：**可靠**（6/6 危险全抓、主线程 806ms 内 tick 51 次未阻塞），但往返 0.11ms/块 vs 直接 0.035ms。**只适合规则异步校验，不适合热路径**

### 当前状态与遗留
`isReDoSProne` 保留为**编辑器提示**（漏判不比改动前差，误判只是多一个警告而非禁用规则）。热路径边界仍是 `MAX_LINE_LEN`（>4KB 行不进用户正则）+ `MAX_PER_RULE`。

**未完成**：真正解法是 Worker 异步校验 + 规则存盘前把关。工作量中等，需单独排期。
