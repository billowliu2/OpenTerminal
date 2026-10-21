# OpenTerminal 开发备忘

Electron + electron-vite + React 终端工具（本地终端 / SSH / SFTP）。本文只留硬规则与踩坑结论；完整背景见 `docs/`（ROADMAP / STATE / PLAN-*），历史细节看 git log。

## 常用命令

- 开发：`npm run dev`（主进程改动不热重建，需重启）。dev 实例用独立 `%APPDATA%\OpenTerminal-dev` + 独立单实例锁，可与正式版并存，测试数据不进真实配置
- 类型检查：`npm run typecheck`；渲染层单独：`npx tsc --noEmit -p tsconfig.web.json`
- 测试：`npm test`（pretest 先 typecheck → `tests/build-bundles.cjs` 重建 → 36 个离线测试，清单见 `package.json` 的 `test` 脚本）。渲染层纯函数测试用 Node 22.18+ 原生类型剥离直连 `.ts` 源文件，Node 20/22.17 以下报 `ERR_UNKNOWN_FILE_EXTENSION`；真实服务器测试需 `JD_*` 凭据，不在列
- 依赖分类：**只有 `src/main/`/`src/preload/` 实际 import 的包才能进 `dependencies`**；纯渲染层依赖一律 devDependencies（Vite 全量打包进 out/renderer，`externalizeDepsPlugin` 不作用渲染层）
- 打包：`npm run dist`（predist = verify-deps → npm test → build；build 后跑 `tests/worker-artifact.mjs` 防 `?nodeWorker` 产物静默丢失；末尾 `npm install --package-lock-only` 对齐 lockfile 根版本，**发布提交必须带 package-lock.json**）。CI（`.github/workflows/ci.yml`，windows-latest + Node 22）只验证不打包不发布
- 国内镜像：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ npm run dist`
- **改依赖版本后必须真实 `npm install`/`npm ci`**：lockfile 对齐 ≠ 树里换了包（`scripts/verify-deps.cjs` 会拦；v1.0.21 的 @xterm 回归正是此坑）。换机/重装后第一次打包前先 `npm ci`
- EPERM rename `win-unpacked.tmp` = 安全软件扫描持锁：`NODE_OPTIONS="--require $(pwd -W)/scripts/rename-retry-shim.cjs" npm run dist`；根治是把仓库目录加进安全软件信任区
- 下载量统计：`node scripts/download-stats.cjs`

## 仓库与远程

- `origin` = Gitea（主仓库 + 更新通道）；`github` = GitHub 镜像 + 备用更新源（具体 URL 看 `git remote -v`）
- ⚠️ Gitea upload-pack 故障，`git fetch origin` 报 `bad pack header`；查远端用 API 或 `git ls-remote`，推送正常
- 2026-09 远端旧历史（M3–M8，至 v0.8.0）被 force-push 覆盖，旧提交由 tag v0.6.0/v0.7.0/v0.8.0 保留

## 凭据

`.env`（已 gitignore）：`GIT_TOKEN`（Gitea）、`GH_TOKEN`（GitHub）；git 推送经 credential helper 用该令牌。

## 发布新版本

1. `package.json` 版本 +1，写 `RELEASE_NOTES.md`（可选 .zh-TW/.en/.ja 译文，缺译回退简体；`RELEASE_NOTES*.md` 已 gitignore，不随仓库提交）
2. `node scripts/sync-changelog.cjs` 并入 `CHANGELOG*.md` —— **必须在 dist 之前**（更新日志以 `?raw` 打进安装包，release.cjs 也校验）
3. `npm run dist` 构建
4. `node scripts/release.cjs <版本号>`（默认 Gitea + GitHub 一起发；同版本可重复跑，已传资产跳过）
   - 更新通道上传顺序：exe.blockmap → exe → release-notes.md → **latest.yml 最后**；新版全部传完才清上一版，中途失败不会打空通道
   - `--channel-only` 只补通道；`--skip-github` 跳 GitHub；`--skip-gitea-release` 只跳 release、通道照常；`--skip-gitea` 两者都跳（国内用户收不到，慎用）。**`--channel-only --skip-gitea` 组合直接 exit 1**
   - 防降级 `assertNoDowngrade()` **fail-closed**：通道版本更高 / 网络错误 / 解析失败一律中止发布，只有通道真空（404）才放行；pruneChannel 前那次探测是 best-effort（失败只跳过清理并打日志）
   - GitHub 走 `HTTPS_PROXY=http://127.0.0.1:7897`（脚本只对 GitHub 请求用它）；Gitea 通道直连不需要代理
5. 验证：`curl https://git.codingplan.site/api/packages/admin/generic/openterminal-update/stable/latest.yml` 应返回新版本号
6. `git tag v<版本号>` 并推两个远程。**tag 必须先推再跑 release.cjs**：否则 Gitea/GitHub 会在默认分支 HEAD 自动建错位 tag，事后要 `git push -f` 修正（v1.0.22 踩过）

## 诊断日志

- 落盘 `<userData>/logs/app-YYYY-MM-DD.log`（本地日期），保留 7 天（今天 + 前 7 天；启动清扫一次 + 每 24h unref 定时器再扫，长开机跨午夜也会清），只动 `app-*.log` 命名匹配的文件；会话录制日志是用户文件，永远不走这里
- 开关 `settings.system.diagnosticLog`（默认开）；关闭 = 什么都不记，但保留期清扫照常（只删不写）
- `appLog()` 走异步串行队列、失败静默、单行 2000 字符 —— **日志永远不能搞挂应用本身**
- 排障口径：`[main] event loop stalled` = 主进程阻塞；`renderer long task` = 渲染层真实长任务；`scheduler delay/unclassified` 只证明计时器迟到，**不是**卡死证据；再对照 `PERF fit` / `PERF write` / `PERF renderer` 判断 reflow、xterm 积压还是 WebGL 生命周期。所有字段是元数据，绝不含终端内容
- PERF 时间线只观测不改变执行行为；日志落盘时间是恢复时刻，行内 `window`/`est` 才是故障区间；`PERF fit` 超 `FIT_SLOW_LOG_MS=200` 才记且每 pane 30s 限频（带 suppressed=N），fit/write/webgl 共享每分钟 5 行预算，严重看门狗报告 urgent 不受预算吞掉

## 更新机制

- 检查顺序：**GitHub 优先**（前置 20s 连通探测 `probeGithub`，失败直接兜底不给挂起机会）→ Gitea 通道（强制直连）。electron-updater 用独立 session（partition `electron-updater`），代理模式在 `useFeed` 按源切换
- 每次 checkForUpdates 包 **30s 整体超时**；changelog / releases API fetch 带 `AbortSignal.timeout(15s)`
- 三种来源（启动 5s / 周期定时 / 手动）共用一条路径；周期 `settings.system.updateCheckIntervalHours` 白名单 `{0,4,12,24}` 默认 4，0 = 从不；**所有 timer 必须 `.unref()`**；已有在途检查返回同一 promise（`checkInFlight`）
- 调度器由 `index.ts` 注入（`settingsStore.setUpdateScheduleApplier`）避免 import 环；applier 幂等，**interval 未变不重建定时器**；启动检查 `startupArmed` 每进程只武装一次
- `autoUpdater.autoDownload` 恒 false，单一事实源在 settings（`autoDownloadUpdate` 默认关）；下载失败落 error 不重试；**绝不自动退出安装**，`autoInstallOnAppQuit` 只覆盖用户自己退出
- 差量下载已禁用（`disableDifferentialDownload`）：GitHub 资产多段 Range 返回 501、通道被 prune 只剩最新 blockmap、NSIS LZMA 固相漂移 —— 注定失败且流量近乎翻倍
- `actedRelease` 单槽去重（announced/fetchHandled/downloaded/downloadedAnnounced）；`downloaded` 与 `fetchHandled` 必须分开判「已完成」；手动检查无条件清空记录；`update-not-available`/`error` **不清空**；下载失败回滚该次 `fetchHandled`；`update-available` 时该版本已 `downloaded` 必须先 `setState` 等价 downloaded 状态再早退（裸 return 会让「关于」页永远转圈）
- 通知走托盘气泡：非 win32 / 无 tray / **有可见窗口**都不弹；自动下载时不弹「发现新版本」，手动下载完成也不弹
- 只走 NSIS exe（1.0.22 起无 MSI）；更新日志从通道 `release-notes.md` 读（直连 session），回退 releases API

## 主题机制

- 终端主题派生 UI 配色：`theme/chrome.ts` 的 `applyChromeTheme` 写 `--chrome-*` 并派生 `--ot-*` 语义变量 + `color-scheme`
- `theme/semantic.ts` 是**零 import 纯模块**（测试经 Node 原生类型剥离直连，加 import 前先想清楚）；深色分支锁 SEMANTIC 锚点原值，浅色分支 `darkenToRatio` 按 WCAG 派生（正文 ≥4.5:1，语义基色 ≥3:1）
- **单一命名体系**：`semanticVars()` 的键**就是**最终 CSS 自定义属性名（如 `'--ot-text-muted'`）；加变量时 `OtVarName` 联合与 `semanticVars()` 两个分支三处一起改。键名拼错在读取处是 TS 编译错；`tests/ot-var-names.mjs` 锁「CSS 引用名 = JS 写入名 = global.css 声明名」
- CSS 一律 `var(--ot-*, 锚点兜底)`，**禁止裸颜色字面量**（`tests/css-theme-vars.mjs` fail-closed 扫描）；**canvas 绘制吃不到 var()**，图表类用 `useResolvedTheme()` + `semanticVars()` 取实色
- 浅色主题：内置 ANSI 调色板 16 色 + fg 全部 ≥4.5:1（`tests/theme-contrast.mjs` 守门；改色用 `darkenToRatio` 统一算法，不许手挑）；`minimumContrastRatio` 矩阵 = 背景图 4.5｜浅色无图 4.5｜深色无图 1（构造 + 热更两处都改；正确拼写是 `minimumContrastRatio`）；浅色关 `drawBoldTextInBrightColors`；antd 浅色用 `defaultAlgorithm`（没有 lightAlgorithm）
- 背景图三铁律：① `.terminal-view.has-bg-image .terminal-view-dock` 底衬强制 `#0d1117`，不能用 `--chrome-bg`（浅色下会把图洗白）；② MCR 提到 4.5（xterm 把透明背景当黑色亮度，会自动提亮深色前景）；③ 压暗层 `settings.terminal.backgroundImageDim`（0–90，默认 0）纯黑 scrim 靠 DOM 序压图（z-index 同层、位于图后 xterm 前），dim=0 不渲染零成本
- 标签强调色：`settings.tabAccentColor`（默认 `#3fb950`）经 `--tab-accent` 生效；`--tab-accent-fg` 明暗自适应

## 终端字体

- 引号包裹在消费点做：`fontStack.ts` 的 `quoteFontStack`（幂等）只在传给 xterm（构造 + 热更）与预览 inline style 时调用，settings 存用户原文；CJK 回退槽位 `settings.terminal.cjkFontFamily` 在 `appendCjk` 里**先拼栈再 quote**（一次切分）；枚举端 `font-list` 的 `disableQuoting: true` 不动
- `@xterm/addon-unicode11@0.10.0-beta.301` **精确锁定**（peer 恰好接受 6.1.0-beta.304）；**升 xterm 必须同步重配 addon 版本**。加载后 `unicode.activeVersion = '11'`，addon 随 term.dispose 连带清理
- `rescaleOverlappingGlyphs: true` 仅 WebGL 渲染器有效（把超宽字形压回格内）
- 字体下拉等宽徽标：离屏 canvas `measureText` 逐字符采样，误判只会漏徽标不会错标

## 终端尺寸同步

- `scheduleFit`：fit 后 **100ms 去抖**再发 PTY，跳过相同尺寸（防全屏 TUI 中间尺寸反复重绘）；fit 本身 **150ms 节流**（`fitThrottle.ts`，拖动窗口防主线程占满）；**首次 fit 绝不等待**（PTY 以占位尺寸启动，shell 可能已在画），重绑时重置
- PTY 输出经 `WriteBatcher` 批量进 xterm（~16ms 窗口合并，顺序不变）。两个接线点别漏：`markDead` 先 `flushNow()` 再置 dead 标志（PTY_EXIT 在数据之后、flush 定时器之前到达）；effect cleanup 里 `batcher.dispose()`

## 性能与安全边界

- `TerminalView` 用 **5 组 `useShallow` 字段级订阅**（fontOpts/themeOpts/bgOpts/highlightOpts/toolbar + rendererMode），**不要回到整对象订阅**（主进程任何设置写入都会让所有 pane 重写 options + refit）；`useResolvedTheme` 同理 shallow + memo
- `TerminalView` 已无 imperative handle；要「外部聚焦/清屏」需重新引入
- `FilePanel` 虚拟化：行高/字号单一数据源在 `FilePanel.tsx`（`BASE_ROW_HEIGHT=26` × scale 0.8–1.8，`localStorage: openterminal.sftpFontScale`，写成 CSS 变量 `--sftp-row-h`/`--sftp-fs`/`--sftp-fs-meta`/`--sftp-scale`），`sftp.css` 只消费变量、不得写死行高字号；`box-sizing: border-box` 是有意的；**antd Dropdown 会把 `ant-dropdown-trigger` 类克隆到子元素本身，禁止写 `.xxx .ant-dropdown-trigger` 后代选择器**（特异性会顶掉 `display: grid`）；行与滚动容器各挂一个 contextMenu Dropdown，容器的 `onContextMenuCapture` 记录「是否点在行内」、`onOpenChange` 据此拒绝打开，防两个菜单叠加
- 每个 dockview pane 内有 `PanelErrorBoundary`，pane 崩溃只卸载自己
- **本地路径准入**（`localPathGrants.ts`）：SFTP/ZMODEM 的本地路径必须来自系统对话框授权（进程级内存注册表 + realpath/stat 双重校验）；新增「渲染层构造本地路径传主进程」的调用点必须过这道门，别绕
- `keyPath`（SSH 私钥）：realpath → stat → 普通文件且 ≤1MB 才读；`src/shared/reservedAccelerators.ts` 是设置录制器与主进程 `applyGlobalShortcut` **共用**的保留键表，加新全局快捷键两边自动一致
- SFTP 操作有 per-op 超时（`bounded()`：元数据 30s / 传输块 60s / open 10s），超时驱逐半死通道并重试一次；`setSftpTimeouts`/`setUpdateTimeouts` 是测试缝，生产无调用者，别接设置项
- **PTY_EXIT 一次性广播不重放**：晚绑定的窗格靠 `sessionState()` + `sessionExits`（FIFO 上限 512）补偿；SSH 飞行中连接登记 `pendingOpens`，`killPtysByOwner`/`killAllPtys` 靠它中止握手
- zmodem 接收路径背压靠 `pauseSource`/`resumeSource` 钩子（fs WriteStream 缓冲无上限）；`touchActivity` 只在写入被接受或 drain 恢复时计数，否则 stall 看门狗会把「堆在缓冲里」当进展；删除路径 ENOENT 一律视为已删成功（重跑必须容忍「目标已消失」）
- `webPreferences` 显式写死 `contextIsolation: true / nodeIntegration: false / webSecurity: true`
- 标签自动标题是**存储的显示文本**：`shared/terminalTitle.ts` 用全部 4 语言 pattern 反解（任何语言生成的都认出），渲染用当前语言；SSH 面板标题是用户起的连接名，永不动

## 锁屏

- 只用主窗口内不透明遮罩（`.lock-screen`，z-index 4000），**不建第二个窗口**；锁定时 `.app-root` 设 inert 并**保持挂载**（卸载会杀会话）；antd portal 挂 body 不在 `#root` 内，锁定时 body 下 `#root` 以外子节点也要 inert，且用 `MutationObserver` 盯新挂 portal 补 inert（observer 只在锁定时存在，解锁恢复）
- 密码 verifier 在 `<userData>/lock.json`（`lockStore.ts`）：scrypt(N=16384,r=8,p=1) + 每次写入重新生成盐 + `timingSafeEqual`，不存明文；格式不对当「未配置」，`version` 不认识每进程 warn 一次
- 锁状态由主进程独占（`lockController.ts`），salt/hash/密码永不出主进程；`lock-state.json` 每次变化立即写（强杀/崩溃重启仍锁）；恢复的 cooldownUntil 夹紧 now+30s 防时间回拨；冷却阶梯 1s→2s→5s→10s→30s；`setPassword`/`clearPassword`/`unlock` 走串行队列
- 闲置锁屏：`powerMonitor.getSystemIdleTime()` 15s 轮询，读不到当「不闲置」；`autoLockMinutes` 白名单 `{0,1,5,15,30,60}`，0 = 从不
- 清除密码会一并关 `settings.lock.enabled`/`lockAtStartup`（设置页文案承诺，别留着静默重新武装）
- 锁定期间：`before-input-event` 吞 F5/Ctrl+R、Ctrl+±0、Ctrl+Shift+I/J/C（判定抽在纯模块 `lockShortcuts.ts`，无 Electron 依赖可测）；**应用菜单整块置 null**（菜单项点击不走 before-input-event；启动恢复锁定由 index.ts 直接补一次）；渲染层 `dataset.locked` 守卫**只许 return 跳过自身逻辑，绝不 preventDefault**（窗口级 preventDefault 会把密码框输入杀掉，v1.0.17 回归）
- **Ctrl+L = 立即锁屏**：仅锁定真生效时才 preventDefault，未设密码保留给 shell 清屏；长按 auto-repeat 跳过；已锁定不再拦截；窗口藏托盘后无效（刻意取舍：全局注册会抢所有应用的键）；Ctrl+L 是保留键，录制器与主进程 `applyGlobalShortcut` **两侧都拒绝注册**
- 启动初值用 `null` + `.lock-screen-boot` 纯色层（防给无密码用户闪一帧锁屏）；`getLockState()` 失败落到「locked 且未配置」（主进程对无 verifier 的解锁直接放行）
- 测试：`node tests/lock-store.mjs` / `lock-controller.mjs` / `lock-shortcuts.mjs`

## 布局模板（工作区）

- 应用外来模板时 `fromJSON` 中途失败，dockview **先清空再抛错**——旧会话在抛错前已被 `onDidRemovePanel` 杀掉。失败路径：先 `toJSON()` 快照 → 只回灌**这次真的被 fromJSON 触碰的** dockview（回灌会清空，别灌没碰过的）→ `rebindRestoredPanels` → kill 没有面板引用的旧会话 → `message.error`；`JSON.parse` 失败同样要提示
- 会话计数不靠累加器：`releaseSession` 直接扫 `api.panels`（累加器与「updateParameters 原地换会话」「整块布局替换」脱节）
- 旧版（M6.1 前单 dockview）模板只喂 terminal dockview：rebind 与收尾 kill 按 `sshTouched`/`live` 门控，否则会把活 SSH 面板降级成终端再杀会话
- 主机密钥队列只渲染队头；TTL `DEFAULT_TIMEOUTS.prompt`（120s）超时后主进程不再广播，渲染层同 TTL 定时清扫（`HOST_KEY_PROMPT_TTL_MS`，两处必须同步改）；`respondHostKey` 等 IPC 调用**不得写进 setState updater**（React 可能重放）
- **tab 关闭二次确认**（`settings.terminal.confirmTabClose`/`confirmSshTabClose`，默认关）：dockview 8.2.0 没有可否决的关闭前钩子，杀会话在 `onDidRemovePanel` 之后无法回滚——所有用户关闭入口（× 按钮、右键菜单、Delete/Backspace）必须在 `api.close()` 之前过 `TerminalTab.requestClose`（键盘路径靠 `.dv-tab` 外壳上的原生捕获监听）；程序性路径（会话已死自动关、模板应用）不走

## 关键词高亮

- 预设 `DEFAULT_HIGHLIGHT_RULES`（22 条）在 `shared/settings.ts`，引擎 `highlightEngine.ts`；规则按 priority 升序，**先匹配先得 span**，重叠跳过
- 词边界是全部难点（改关键词跑 `node tests/.hl-rules.cjs`）：状态符号（✓✔✅✗❌⚠）不进 `\b` 组（`\b✓` 永不成立，写第二分支 + `\uFE0F?`）；状态类 priority 在 `shellkw` 之前（`done`/`if` 归属）；delop/createop 只列操作动词，shell 关键字仍归 shellkw；词干自带词尾（`DELET(?:E|ED|ES|ING|ION)`），不成词词干强制词尾；裸 3 位数 / MAC / 短哈希不能单独成规则（须上下文锚点）；lookbehind/lookahead **只圈关键词本身**（圈多了 bands 会读错数字，如 `HTTP/1.1 404` 只该着色 `404`）
- bands 数值分级：匹配里**第一个数字**定色，最后一个 `min <= 值` 胜出；`percent` priority 22 必须早于 `numbers`(25)
- 锚定：规则作用于转义序列之间的 text run，默认无 m flag，裸 `^` 锚 run 起点非行首；行首锚定用 `(?<=^|\s)` 或 `lineAnchor: true`（编译成 gm/gim）
- **SGR 回放四护栏**（全踩过坑，别拆）：① reset 判定必须解析参数（`ESC[0;32m` = 复位+设色，只认两种规范写法会让累积器逐行膨胀直至恢复永久失效）；② 回放闸门按序列条数 `MAX_REPLAY_SEQUENCES=3`，不是字节数（同义写法长度差 4 倍；`MAX_RESTORE_LEN=256` 只是累积器内存上限）；③ 恢复串只插在可见间隙（`MIN_GAP_FOR_RESTORE=3` 个可见字符）——每 span 都恢复会让密集真彩 TUI 膨胀 4.3x、渲染线程卡 18s，现在 3.05x；④ 改以上任何参数必须重跑 `tests/hl-rules.mjs` 的 `[restore cost budget]` 段（断言 < 3.2x）
- `ESCAPE_RE` 的 CSI 参数类必须含私有前缀与中间字节（`[0-9;:?<>=]*[ -/]*[A-Za-z]`）：漏了 `<>=` 会让 `ESC[>4;1m`（modifyOtherKeys）/`ESC[<0;1;2M`（SGR 鼠标）这类序列所在行之后的关键词全部失高亮（vim/tmux 正好发这些）
- 超长行降级：run 有 >4KB 行时按 `\n` 逐行，超长行原样透传不上色（该 run 放弃跨行匹配）；不变式：**任何 >4KB 的行不进用户正则**。性能护栏：`MAX_CHUNK` 512KB 整块跳过 / `MAX_LINE_LEN` 4KB / `MAX_PER_RULE` 300；实测全预设 4–9ms/块，最贵的是 http/percent/danger
- **ReDoS 三层别混**：① `isReDoSProne` 只是编辑器即时提示（有漏判误判，不当执行依据，文案只能说「通过当前探针」）；② 执行闸门在 `compileRules`/`compileLinkRules`——内置预设按 pattern+flags 精确命中白名单放行，自定义规则须 `RuleValidation.state='passed'` 且 **pattern/flags/probeVersion/runtime 四项全匹配**，pending/quarantined/失配一律跳过，编辑器预览与链接 provider 同一闸门无旁路；③ 动态校验 `redosValidator` + `redosProbeWorker`（`?nodeWorker` 产物）：24 条固定探针 ≤4KB、500ms 硬超时由主控计时并 terminate → quarantined，Worker 崩溃重试一次回 pending，不可用也回 pending；并发上限 2、同 key 去重、空闲回收；默认纯预设安装不启动 Worker。runtime 指纹由 `ruleRuntime` 安装、renderer 经 `AppInfo.runtimeKey` 对齐；validation 是规则内部元数据——导入的裁决不作数，导出剥离
- 模式三档 `highlightMode` all/basic/off（读取一律过 `highlightModeOf` 兜底）：basic 只跑 `basic: true` 的规则（预设 5 条：danger/secret/okstate/warnstate/badstate，用户可给自建规则打标；`basic` 集合必须是 safety+status 子集，有测试守）；off = **清空规则集**而不是绕过 `HighlightStream`（stream 会 hold 尾部文本，绕过丢字节）
- 开关键名：`highlightStats` / `highlightThemeColors` / `highlightPerHost`（均默认关）与 `highlightGroupByCategory`（只影响设置页分组展示，热路径不涉及）；分类集合 `safety|status|file|net|text|metric` 单表在 `PRESET_CATEGORIES`
- 按主机绑定：`HighlightProfile` 存 `AppSettings.highlightProfiles`（清洗在 `shared/highlightProfiles.ts`），`ruleIds` 空 = 全部规则；绑定存在 **connections.json**（`SshConnection.highlightProfileId`），`TerminalView` 只在 mount 查一次，改绑定要重开会话。**新增连接字段必须同时改三处**：`PUBLIC_KEYS`、`toPublic()`、`saveConnection()` 新记录字面量，漏一处该字段在某条路径静默丢失
- 跟随主题 `highlightColors.ts`：按**色相分桶**映射到当前主题 ANSI 调色板（不用最近色，防语义漂移），亮度决定普通/bright 色，饱和度 <0.15 中性色保持原样，**背景色不映射**；编译期一次完成，编辑器预览走同一函数
- 统计按 pane 实例聚合（`crypto.randomUUID()` 的 pane id，**不是 sessionId**）；sink 只在开关开时挂（默认路径不插桩），**每秒发一次快照**不是每块；卸载与关开关都注销，重绑定不注销；编辑器预览输入截断 2000 字符
- 导入/导出：`shared/highlightIO.ts` 管 JSON 信封（kind/version，外来 JSON 拒绝）；渲染层用剪贴板 + FileReader + Blob 下载，**不新增 IPC**；预览走 `previewSpans` 且带上当前其它规则（span 被抢走能看出来）
- `caseInsensitive: true` 编译成 `gi`；`okstate` 带 `(?<!not\s)` 把 `not ok` 让给 badstate
- 升级旧安装：`settingsStore.refreshBuiltinRules` 只升级**仍是出厂 pattern** 的内置规则（保留用户颜色/优先级/启停），且仅当规则集恰好等于旧预设集才追加新增；改预设 pattern 同步更新 `LEGACY_BUILTIN_PATTERNS`/`LEGACY_BUILTIN_IDS`（当前已含 `url: 'https?://[^\\s]+'`）

## 可点击链接规则

- 内置链接 `urlLinks.ts` 的 `findUrls`（4 条写死正则）**不动**；用户自定义规则叠加其上
- 引擎在 `shared/linkRules.ts`（可被 `tests/link-rules.mjs` 直连；它 import 共享 `ruleValidation.ts`/`redosProbes.ts`，说明符必须带 `.ts` + 局部 `@ts-expect-error TS5097`，**别复制闸门/常量造成分表**）：`sanitizeLinkRules`（id/pattern/template 必填、非法正则丢弃、模板空串丢弃、enabled 缺省 true、note 截断 60、上限 100 条）、`formatLinkTemplate`（`$0` 整段 / `$1`–`$9` 分组 / `$$` 字面，只吃一位数字，未参与分组展开为空串）、`compileLinkRules`/`findRuleLinks`/`mergeLinkSpans`
- **安全闸门**：① ReDoS 执行闸门——用户链接规则没有内置白名单，pending/quarantined 不编译；② `isSafeLinkTarget`——生成 span 时就把非 http/https 目标丢掉；主进程 `openExternal` 协议白名单是第三道
- 接线在 `TerminalView` link provider：`mergeLinkSpans(findRuleLinks(...), findUrls(...))`，**用户规则优先**，重叠的内置链接让位；hover 提示显示展开后的真实目标；热更走 `linkRulesRef`（只换 ref 指向，绝不重建终端）；`EMPTY_LINK_RULES` 是共享稳定空数组（选择器返回新建 `[]` 会让 zustand 每次拿到新身份）
- 性能护栏：`LINK_TEXT_MAX` 4KB 以上逻辑行整行跳过；每规则每行上限 200；能匹配空串的 pattern 强制 `lastIndex` 前进
- 设置字段 `AppSettings.linkRules?: LinkRule[]`（默认 `[]`）；接线三处照 highlightProfiles：settingsStore `deepMerge` + sanitize 调用 + `defaultSettings()`，渲染层 `setLinkRules` + persist 白名单
- UI 在 `HighlightTab.tsx` 底部 `ClickableLinkRules`；导入导出与 profile 联动**尚未做**，属后续可加
