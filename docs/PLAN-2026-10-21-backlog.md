# OpenTerminal 下一轮迭代计划（v1.0.32+ 待办整理）

> 本计划整理自 2026-10-21 的三路代码审查（路线图梳理 / 代码缺口扫描 / 竞品对标），
> 所有条目均经源码逐一核实（文件:行号见各项「现状」）。**本文件只是计划，不代表任何代码改动已开始。**
> 执行时按波次进行，每个波次一个版本号；条目内的勾选框在执行阶段回填。
>
> 核实记录（2026-10-21 二轮）：文档初稿写完后又逐条回源码验证，修正了 6 处凭印象写错的细节——
> ① `pendingOpens` 在 `pty.ts` 而非 ssh.ts；② ssh2 无官方类型、项目用手写 shim `ssh2.d.ts` 且未声明
> `forwardOut`；③ 本地 PTY 路径没有 ZMODEM sentry（W2-4 需新写检测而非复用）；④ 剪贴板图片落临时文件
> 不经过 `localPathGrants`（它只授权对话框选中的路径）；⑤ 官网 SFTP 区并无「双栏」宣传；⑥ zh-TW
> 「密碼」32 处 vs「口令」5 处（统一方向确认）。所有测试基建文件名（updater-fallback / settings-store /
> link-rules / zmodem-e2e / ssh-loopback）已确认存在。

## 总览

| 波次 | 主题 | 内容 | 预估工作量 |
|---|---|---|---|
| W0 | 文档债清理 | 计划 checkbox 回填、ROADMAP 过期条目 | 0.5h |
| W1 | 修复：更新器 + 发布脚本 + 预设升级 | 4 项小修，其中 2 项影响存量用户 | 1 天 |
| W2 | 捡漏功能（半成品补全） | 链接规则导入导出、命令库参数、i18n 统一、ZMODEM 提示 | 1–2 天 |
| W3 | 剪贴板与命令感知 | OSC 52、图片粘贴、OSC 133 marks、完成通知 | 2–3 天 |
| W4 | Shell 与 SSH 迁移链 | 本地 shell 配置档、ssh_config 导入、ProxyJump + 端口转发 | 3–5 天 |
| W5 | 差异化（择期） | 远程文件编辑、应用命令面板、终端内 AI 助理 | 各 2–4 天 |
| — | 需决策的取舍项 | 代码签名、多窗口、双栏 SFTP、传输暂停续传 | 见 §6 |

**波次间的依赖**：W3 的「完成通知」依赖同波次的 OSC 133 marks；W4 的 ProxyJump 与端口转发共用 ssh2 通道基建必须同一波次；W5 各项独立。

---

## W0：文档债清理（无代码改动）

### W0-1 回填两份 superpowers 计划的 checkbox
- 现状：`docs/superpowers/plans/2026-10-20-mode-button-double-click-sidebar.md` 12 个、
  `docs/superpowers/plans/2026-10-16-theme-overhaul.md` 40 个 `- [ ]` 全部未勾，但对应代码、测试、
  CHANGELOG 均已落地（v1.0.29 / v1.0.31）。
- 动作：逐项核对后勾上。

### W0-2 修正 ROADMAP 过期陈述
- 现状：`docs/ROADMAP.md:33`「SSH 面板暂不支持作为分屏参照」已过时——
  `src/renderer/src/workspace/Workspace.tsx:880` 起的 `handleSplit` 已实现 SSH dockview 内分屏。
- 动作：删掉该条已知限制；顺带勾掉 M3-A / M5 已完成项的 checkbox，把 M4 真正未做的三项
  （双栏 / 压缩解压 / 远程编辑）单列。

---

## W1：修复（目标版本 v1.0.32）

### W1-1 更新器周期定时器不再被高频设置写入重置
- 现状（已核实调用链）：每次设置保存走 `mutateSettings`（settingsStore.ts:732）→ `applySystemSettings`（:736）→
  `updateScheduleApplier?.(system)`（:575）→ `applyUpdateSchedule`，而后者（`updater.ts:533-537`）无条件
  `clearInterval` + 重建。拖 ColorPicker / 打字会把 4h 倒计时无限推迟。
- 改动：`applyUpdateSchedule` 记忆当前 interval 值，仅当 `updateCheckIntervalHours` 实际变化时重建定时器。
- 测试：`tests/updater-fallback.mjs` 已有 schedule 测试段（第 10 节，:586 起），在其内补「连续调用不改变倒计时起点」用例。

### W1-2 「启动检查」中途拨开语义修正
- 现状（已核实文案）：设置页开关标签为「启动时自动检查」（`src/shared/i18n/dicts/zh-CN/settings.ts:357`），
  但 `updater.ts:543-547` `startupArmed` 只在首次武装时置位——启动时关闭过该开关的用户在会话中途打开，
  会在 5s 后立刻跑一次 `runCheck('startup')`，与「启动时」的文案语义矛盾。
- 改动：启动时无论开关状态都消费 `startupArmed`（记录「启动检查已过」），
  中途打开只影响周期定时器。

### W1-3 修复 `--channel-only --skip-gitea` 静默上传
- 现状：`scripts/release.cjs:437-441` `CHANNEL_ONLY` 分支在 `SKIP_GITEA` 警告（:442-446）之前 return——
  两个参数同用时警告永不打印，且 channel 照样上传，与操作者预期相反。
- 改动：参数解析处直接拒绝该组合（`--channel-only` 的定义就是国内通道，叠加 `--skip-gitea` 无意义），
  或把警告移到分支之前并显式确认。
- 测试：`release.cjs` 无测试基建，人工跑一次参数组合验证输出即可。

### W1-4 高亮预设升级机制补全（**影响存量用户，本波次重点**）
- 现状（已核实判定链，settingsStore.ts:243-267）：`refreshBuiltinRules` 只在
  `LEGACY_BUILTIN_PATTERNS[rule.id].includes(存储pattern)` 成立时把规则升级到新 preset；
  该表（:208-213）目前只有 perm/okstate/badstate 三条旧 pattern。追加新预设另有闸门
  `LEGACY_BUILTIN_IDS`（:215 起）的「存储集合恰好等于旧预设集」判定。结论：今后改任何预设的 pattern，
  若不在改动同时把旧 pattern 登记进 `LEGACY_BUILTIN_PATTERNS`，老用户将永远停在旧 pattern。
- 改动：把历次发布过的预设 pattern 全量补进 `LEGACY_BUILTIN_PATTERNS`（从 git 历史逐版本提取），
  并在文档里写明「改预设 pattern 时必须同步登记旧 pattern」的规则（AGENTS.md 高亮一节）。
- 测试：`tests/settings-store.mjs` 表驱动补「旧版 pattern 规则 → 升级到新 pattern、保留用户颜色/启停」用例。

---

## W2：捡漏功能（目标版本 v1.0.33）

### W2-1 可点击链接规则的导入 / 导出 + profile 联动
- 现状：`src/renderer/src/settings/HighlightImportExport.tsx:44,52,155` 只处理 `highlightRules`；
  AGENTS.md「可点击链接规则」章末明确「尚未做，属后续可加」。
- 改动：`src/shared/highlightIO.ts` 的信封机制扩展 `kind`（或新建 `linkRulesIO.ts` 同构模块），
  UI 侧在 `ClickableLinkRules` 区块复用剪贴板 + FileReader + Blob 方案，**不新增 IPC**；
  profile 联动参考 `excludedByProfile` 的现有做法。
- 测试：`tests/link-rules.mjs` 补信封/合并用例。

### W2-2 命令库 `{{param}}` 参数变量落地
- 现状（已核实执行链）：`src/shared/commands.ts:11` 定义了 `params?: string[]`，全仓无消费代码。
  命令的实际执行路径是 `Workspace.tsx:1215` 的 `runCommand` → `writeBroadcast(sid, \`${cmd}\r\`)`（:1227）
  → 激活面板。参数替换应发生在 `runCommand` 入口处，替换产物继续走 `writeBroadcast`，
  各 pane 的 line buffer 语义自然保持。
- 改动：执行命令时若含 `{{name}}` 占位，弹参数输入（antd Modal 表单），替换后写入终端。
- 测试：替换逻辑抽纯函数 + 表驱动测试（占位符转义、未填参数、含 `$` 字符等）。

### W2-3 i18n 两个统一专项
- 现状（已核实计数）：zh-TW 词典「密碼」32 处（settings.ts 26 + ssh.ts 4 + workspace.ts 2）为压倒性多数，
  「口令」仅 `dicts/zh-TW/ssh.ts` 5 处，统一为「密碼」并通读 指令/命令、伺服器/服务器、預設/默认；
  ja `dicts/ja/ssh.ts` 用「フォルダ」而 `settings.ts`/`terminal.ts` 用「フォルダー」。
- 改动：纯文案批量替换 + 通读；不动键名。
- 测试：无测试基建，四语言界面各过一遍设置页与 SSH 面板目检。

### W2-4 本地终端运行 rz/sz 的用户提示
- 现状（已核实数据路径）：ZMODEM sentry 只挂在 SSH 流上（`pty.ts:433-438` `handle.stream.on('data')` →
  `feedZmodem`）；本地 node-pty 会话的数据路径**没有任何 chunk 检测**。本地终端跑 `rz/sz` 只会静默卡住。
- 改动：在本地 PTY 数据路径加轻量 ZMODEM 头检测（只在看到 `rz`/`sz` 启动帧时生效，常态零开销），
  命中时在终端里输出一行醒目的不支持说明（走终端数据面，i18n 四语）；不要接入完整 sentry。
- 测试：`tests/zmodem-e2e.mjs` 补「本地会话触发 → 提示且不进入传输态」。

---

## W3：剪贴板与命令感知（目标版本 v1.0.34，对位「AI Agent 工作台」核心场景）

### W3-1 OSC 52 远程写剪贴板
- 现状：只装了 fit/search/unicode11/webgl 四个 addon；远程 tmux/vim 复制无法直达本机剪贴板。
- 改动：`term.parser.registerOscHandler(52, ...)` 自实现（比引 `@xterm/addon-clipboard` 可控）：
  base64 → **UTF-8 安全解码**（`atob` 裸解中文会乱码，用 TextDecoder）→ `navigator.clipboard.writeText`；
  新增设置开关「允许远程程序写入剪贴板」（默认开，设上限如 1MB）。
- 测试：解码函数抽纯模块，表驱动测中文/emoji/base64 边界。
- 注意：新依赖规则——自实现则零依赖；若引 addon，渲染层依赖进 devDependencies。

### W3-2 剪贴板图片粘贴进终端
- 场景：截图直接喂给 Claude Code / Kimi Code 这类支持贴图的 AI CLI。
- 改动：渲染层拦截粘贴（现有粘贴逻辑在 `TerminalView.tsx:99-124` 确认弹窗与 :943-946 的 xterm paste 通道），
  剪贴板为图片时经 IPC 让主进程 `clipboard.readImage()` → 落临时 PNG（`os.tmpdir()`，定期清理）→
  把路径文本写入终端。**不涉及 `localPathGrants`**：该注册表只授权「系统对话框选中的路径」
  （`grantPickedFiles`/`grantPickedDirectory`，localPathGrants.ts:110,119），临时文件由主进程自己写入、
  应用自身不读它，无需授权。
- 测试：临时文件命名/清理逻辑的单测；实际粘贴行为列入发版手测清单。

### W3-3 OSC 133 命令块感知（marks）
- 现状：`src/main/shellIntegration.ts:8,39,60` 已注入 OSC 7（bash/zsh/PowerShell 三个适配器）——
  扩到 133 是同一处注入脚本 + xterm 侧 mark 注册。
- 改动：注入脚本补 `OSC 133;A/B/C/D`（prompt start / command start / output start / finished+exitcode）；
  渲染层监听 mark 事件建「命令块索引」，提供：
  - 滚动条刻度（marks gutter）
  - 快捷键跳上/下一条命令
  - 「复制本次命令输出」（整块选中复制——整段取 AI agent 输出是核心诉求）
- 测试：注入脚本的字面量生成有现有测试模式可仿；mark 索引纯函数表驱动。
- 风险：OSC 133 在不同 shell/嵌套 tmux 下行为差异大，首版只承诺 bash/zsh/pwsh，tmux 内标注「依赖外层终端透传」。

### W3-4 长任务完成通知（依赖 W3-3）
- 场景：多路分屏跑 AI agent，跑完切走被叫回来——本产品核心场景。
- 改动：OSC 133 D（命令结束）到达且该 pane **不可见**且命令耗时 > 阈值（设置项，默认 10s）时：
  托盘气泡（复用 `tray.ts notifyUpdate` 的通道）+ 标签强调态。退出码非零时气泡文案区分成功/失败。
- 测试：判定逻辑抽纯函数（耗时阈值、可见性、退出码），表驱动。

---

## W4：Shell 与 SSH 迁移链（目标版本 v1.0.35，获客向）

### W4-1 本地 Shell 配置档
- 现状：`src/main/pty.ts:220-228` win32 硬编码 `powershell.exe`；`createPty` 的 `opts.shell`/
  `opts.shellArgs` 已存在但**无任何调用方传参**——只差最后一公里。
- 改动：设置新增「默认 Shell」下拉（自动探测：`wsl.exe -l -q` 枚举发行版、`git-bash.exe` 常见路径、
  cmd/pwsh/powershell），`Workspace.tsx` 的 `createPty()` 调用点传入；工作区「+ 新建终端」沿用默认，
  侧栏可提供「以其它 shell 新建」次级菜单。
- 测试：探测函数接受注入的枚举源（测试缝），表驱动覆盖各解析分支；真实 WSL/Git Bash 列入手测清单。

### W4-2 `~/.ssh/config` 导入
- 现状：无任何 ssh_config 解析代码；国内用户从 Xshell/PuTTY 迁移时「几十台机器重录」是弃用理由之首。
- 改动：解析器抽纯模块（Host/HostName/User/Port/IdentityFile/ProxyJump，多 Host 与通配 Host `*`），
  映射到 `SshConnection` 并批量追加进 `connections.json`（新增字段时同步三处：
  `PUBLIC_KEYS` / `toPublic()` / `saveConnection()` 新记录字面量——AGENTS.md 明确要求）。
  ProxyJump 字段在 W4-3 之前先存起来不生效。
- 测试：解析器表驱动（注释、大小写、引号、通配、Include 提示不支持）。

### W4-3 SSH ProxyJump + 端口转发（同一波次，共用通道基建）
- 现状（已核实）：`forwardOut|ProxyJump|jumpHost` 全仓零命中；企业内网 bastion 是刚需。
  **两个核实到的前置事实**：① 飞行中连接登记表 `pendingOpens` 在 `src/main/pty.ts:155,329,360`
  （不在 ssh.ts）；② ssh2 不带类型定义，项目用手写 shim `src/main/ssh2.d.ts`，
  其中**只声明了 `connect()`，没有 `forwardOut`**（:85-86）——必须扩 shim。
- 改动：
  - 连接模型：`SshConnection` 增加 `jumpHostId`（引用另一条连接）与 `forwards[]`（本地/远程/SOCKS）。
  - 主进程：`ssh2` 先连跳板 → `forwardOut` 建通道 → 在通道上再握手目标机；复用
    `pendingOpens` 的中止与超时体系（每跳独立超时）；主机指纹逐跳走现有 host key 队列。
  - 类型：扩展 `src/main/ssh2.d.ts` 补 `forwardOut` 等声明。
  - 端口转发：连接建立后按 `forwards[]` 起本地监听，断开/失败时面板给出醒目状态。
- 测试：ssh-loopback 测试基建可起两级跳板做端到端；真实服务器场景列入手测清单。
- 风险：这是本计划里架构风险最高的一项，建议单独立项评审后再动。

---

## W5：差异化（择期，各独立立项）

### W5-1 远程文件内置编辑器
- 双击 SFTP 文件 → 面板内打开编辑（轻量 textarea 起步，Monaco 体积与零依赖取向冲突需另行评估）；
  保存自动回写；处理编码（UTF-8 优先）、CRLF、无写权限提示。改动点：`FilePanel.tsx` +
  `sftp.ts` 新增 read/write 文件 IPC（走 per-op 超时 `bounded()`）。

### W5-2 应用级命令面板 + 可自定义快捷键
- `Ctrl+Shift+P`（已核实全仓无占用）动作注册表 + antd 模糊搜索 Modal；快捷键录制器复用
  `src/shared/reservedAccelerators.ts` 保留键表（`acceleratorParts`/`isReservedAccelerator`，防抢 Ctrl+L/Ctrl+F）。
  价值：功能密度已高，这是「后续功能不再堆 UI」的前置投资。

### W5-3 终端内 AI 助理
- OpenAI 兼容端点（DeepSeek/Kimi/智谱均可接入），「`#` 开头自然语言 → 建议命令」，
  **默认只生成、回车前必须人工确认**；报错解释走显式按钮。**红线：任何终端内容不外发**，
  与现有「诊断日志不含内容」的隐私原则保持一致。
- 注意：引入网络请求路径，需过安全评审；不绑账号、无云同步（相对 Warp 的国内优势）。

---

## §6 需决策的取舍项（不排期，等拍板）

| 项 | 取舍点 | 建议 |
|---|---|---|
| 代码签名证书 | 外部成本（~数百美元/年）；无签名则 SmartScreen 拦截 + 通道完整性缺口 | 用户量到一定规模再做 |
| 多窗口 / 标签拖出 | 与单实例设计冲突，`sessionState`/owner 归属需重构 | 等真实多显示器用户反馈 |
| SFTP 本地↔远程双栏 | 大工程（本地文件树模型 + 传输层重做）；官网 SFTP 区从未宣传「双栏」（i18n fs.* 文案只讲远程面板 + 上传下载），无宣传口径包袱 | 观望；拖拽上传先满足大半诉求 |
| 传输暂停/续传 | `TransferState` 无 `paused` 态，需断点续传协议层 | 观望 |
| 性能优化第二阶段（B3/B4） | 项目自定规则：没拿到真实 PERF 日志前不许凭感觉动 | 维持观测，等数据 |
| xterm 解 pin 回 `^` | 锁 `6.1.0-beta.304` 因 IME 修复；解 pin 需同步 addon-unicode11 peer 并重测中文输入法 | 等上游 6.1.0 stable |
| autoWrap=false 固定列宽 | xterm 无原生支持，等于自写列裁剪层 | 不做 |

## 执行约束（所有波次通用，摘自 AGENTS.md 铁律）

1. 新增纯逻辑一律抽零 import 纯模块 + Node 原生类型剥离表驱动测试，测试数随 AGENTS.md 清单同步更新
2. 依赖分类：`src/main|preload` 实际 import 的才进 dependencies；渲染层一律 devDependencies
3. i18n 四语言键必须同步（zh-CN/zh-TW/en/ja），缺键回落简中但属必须修
4. 新增「渲染层构造本地路径传主进程」的调用点必须过 `localPathGrants`
5. CSS 一律 `var(--ot-*)`，新代码禁止裸颜色字面量（`tests/css-theme-vars.mjs` 守门）
6. 每个发版 commit 必须带 `package-lock.json`；发布流程照 AGENTS.md「发布新版本」六步
7. 改 AGENTS.md 已文档化的行为时，同步更新 AGENTS.md
