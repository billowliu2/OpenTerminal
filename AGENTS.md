# OpenTerminal 开发备忘

Electron + electron-vite + React 终端工具（本地终端 / SSH / SFTP）。

## 常用命令

- 开发：`npm run dev`（主进程改动不热重建，需重启）
- dev 实例使用独立用户数据目录 `%APPDATA%\OpenTerminal-dev` 与独立单实例锁（`src/main/index.ts` 顶部 `!app.isPackaged` 分支），窗口标题带 `(dev)`：**可与已安装的正式版同时运行，互不干扰**，也不会把测试设置/会话写进真实配置
- 类型检查：`npm run typecheck`（tsconfig.node.json + tsconfig.web.json；只看渲染层可单跑 `npx tsc --noEmit -p tsconfig.web.json`）
- 测试：`npm test`（**npm 生命周期先自动跑 `pretest` 做类型检查**，再 `node tests/build-bundles.cjs` 重建 esbuild bundle，然后依次跑可离线运行的 18 个测试：ssh-loopback、commands-store、connections-store、settings-store、local-path-grants、lock-store、lock-controller、lock-shortcuts、hl-split-smoke、hl-rules、reserved-accelerators、ipc-guard、updater-fallback、log-sanitizer、sftp-timeout、terminal-title、zmodem-e2e、ssh-session-e2e、sysinfo-e2e；真实服务器测试需 JD_* 凭据，不在此列）
- 依赖分类规则：**只有 `src/main/`/`src/preload/` 实际 import 的包才能进 `dependencies`**（node-pty/ssh2/zmodem.js/font-list/electron-updater）；纯渲染层依赖一律 devDependencies（Vite 全量打包进 out/renderer，`externalizeDepsPlugin` 不作用渲染层）——这条让 asar 从 98MB 瘦到 8.1MB，加新依赖时别放错边
- 下载量统计：`node scripts/download-stats.cjs`（Gitea + GitHub release 资产的 download_count 汇总；GitHub 优先直连、失败自动回退 `HTTPS_PROXY`/本地 7897；更新通道无计数接口不计入）
- 打包：`npm run dist`（**生命周期先自动跑 `predist` → `npm test`，即类型检查 + 18 个离线测试全部通过后才 build/package**，typecheck 全程只跑一次；predist 末尾的 `npm install --package-lock-only` 会把 `package-lock.json` 根版本号对齐 `package.json`，**发布提交必须带上 package-lock.json**），产物在 `release/`（exe + latest.yml + blockmap）
  - GitHub Actions：`.github/workflows/ci.yml` 在 windows-latest + Node 22 上跑 `npm ci` / `npm test`（含 pretest typecheck）/ `npm run build`，只做验证，不打包安装器、不发布
  - 国内网络需镜像：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ npm run dist`
- 依赖一致性闸门：`predist` 开头跑 `node scripts/verify-deps.cjs`（逐条比对 `node_modules` 与 `package-lock.json` 的版本，跨平台 optional 依赖缺失跳过；不一致就 exit 1）——`npm install --package-lock-only` **只重算 lockfile、不碰 node_modules**（本版 npm 还会把 `node_modules/.package-lock.json` 一并重写成理想树，制造「已经装好了」的假象），所以**改动依赖版本后必须真实 `npm install` 或 `npm ci` 再构建**，别指望 lockfile 对齐就等于树里换了包；v1.0.21 的中文输入法回归正是这个坑（`@xterm/xterm` 锁 6.1.0-beta.304，树里还是 6.0.0，打进去的是旧代码）
- **换机/重装环境后第一次打包前必须先跑 `npm ci`**（verify-deps 会兜底拦截，但别浪费一次构建）；在任何机器上都先 `node scripts/verify-deps.cjs` 确认再 `npm run dist`
- electron-builder `rename win-unpacked.tmp` 撞 EPERM = 安全软件实时扫描新解压文件短暂持锁（实测约 4s，进程退出后数秒即可手动重命名）。应对：`NODE_OPTIONS="--require $(pwd -W)/scripts/rename-retry-shim.cjs" npm run dist`（注入重试垫片，stderr 会打印每次重试）；根治是把仓库目录加进安全软件信任区

## 仓库与远程

- `origin` = Gitea `https://git.codingplan.site/admin/OpenTerminal.git`（主仓库 + 更新通道）
- `github` = `https://github.com/billowliu2/OpenTerminal.git`（镜像 + 备用更新源）
- ⚠️ Gitea 的 upload-pack 有故障，`git fetch origin` 会报 `bad pack header`；查询远端状态用 API 或 `git ls-remote`。推送正常。
- 2026-09：远端 main 旧历史（M3–M8，至 v0.8.0 d3a628f）被 force-push 覆盖为当前历史，旧提交仍由 tag v0.6.0 / v0.7.0 / v0.8.0 保留。

## 凭据

- `.env`（已 gitignore）：`GIT_TOKEN`（Gitea）、`GH_TOKEN`（GitHub）等。git 推送通过 credential helper 使用该令牌。

## 发布新版本

1. `package.json` 版本号 +1，写 `RELEASE_NOTES.md`（仓库根，已 gitignore；可选 `.zh-TW/.en/.ja` 译文，缺译文回退简体）
2. `node scripts/sync-changelog.cjs` 把发布说明并入 `CHANGELOG*.md` —— **必须在 `npm run dist` 之前**：更新日志以 `?raw` 打进安装包（「关于」页离线读），`release.cjs` 也校验 `CHANGELOG.md` 已含该版本号
3. `npm run dist` 构建
4. `node scripts/release.cjs <版本号>`，例如 `node scripts/release.cjs 1.0.14`（**不带 skip 参数**，Gitea 与 GitHub 一起发）
   - Gitea：release（exe 资产）→ Gitea 更新通道（`api/packages/admin/generic/openterminal-update/stable`：exe.blockmap → exe → release-notes.md → **latest.yml 最后**）
   - GitHub：release 资产再次随版本同步发布（exe + exe.blockmap + latest.yml），electron-updater 标准 GitHub provider 直接吃 release 资产
   - 通道不再先删旧版：新版本文件全部传完、latest.yml 生效后才清掉上一版 exe/blockmap，中途失败不会把通道打空；同一版本可重复运行（release 复用、已传资产跳过）
   - 上传前先比通道版本：`assertNoDowngrade()` 读通道 latest.yml，若线上版本**高于**待发布版本就直接拒绝——三条本地护栏只比本地产物，旧分支发旧版本号会一路通过，覆盖 latest.yml 之后 `pruneChannel` 会把线上新版本的 exe/blockmap 删掉
   - 只补通道：`node scripts/release.cjs <版本号> --channel-only`（不建 release、不发 GitHub）
   - 国内通道全程直连，**不需要设代理**；GitHub 请求走 `HTTPS_PROXY=http://127.0.0.1:7897`（脚本只把它用于 GitHub 请求）
5. 验证更新通道：`curl https://git.codingplan.site/api/packages/admin/generic/openterminal-update/stable/latest.yml` 应返回新版本号
6. `git tag v<版本号>` 并推送两个远程（代码/tag 与 release 资产的镜像保持同步）。注意顺序坑：release.cjs 创建 release 时若远端尚无该 tag,Gitea/GitHub 会在**默认分支 HEAD** 自动建一个指向错误 commit 的 tag，第 6 步推送会被拒——要么先建 tag 推上去再跑 release.cjs，要么事后 `git push -f <远端> v<版本号>` 强制修正到 release commit(v1.0.22 即踩过）

## 更新机制

- 检查更新：**GitHub 优先**（走系统代理；前置 20 秒连通性探测 `probeGithub`——探测失败/超时直接兜底 Gitea，不给 electron-updater 挂起的机会），失败回退国内 Gitea 通用包通道（强制直连，不走系统代理）。 electron-updater 用独立 session（partition `electron-updater`），代理模式在 `useFeed` 里按源切换
- 更新日志：Gitea 仓库是私有的（匿名 API 404），改为从更新通道的 `release-notes.md` 读取（直连 session `openterminal-update-direct`），再回退 Gitea/GitHub releases API
- 自动更新只走 NSIS exe；自 v1.0.22 起不再构建 MSI 安装包（electron-updater 本就不支持 MSI 自动更新）
- 每次 checkForUpdates 都被 **30s 整体超时**包住（`withTimeout`）：electron-updater 自带的 60s 只是 socket 空闲超时，慢滴流响应能一直占住它。超时按普通失败走 GitHub→Gitea 回退，但**被放弃的检查取消不掉**，而 electron-updater 对并发检查去重（返回同一个 in-flight promise），所以兜底那次共用被放弃的 promise——它同样被超时兜住，最终落到错误态，不会永远停在「检查中」
- 更新日志 / releases API 的 fetch 都带 `AbortSignal.timeout(15s)`（`directFetch` 与 `fetchChangelog` 里的 `net.fetch`）：卡住的通道必须让位给下一个来源，不能把「关于」页吊住

## 主题机制

- 终端主题由 xterm 主题派生 UI 配色：`src/renderer/src/theme/chrome.ts` 的 `applyChromeTheme` 写入 `--chrome-bg/-bg-deep/-border/-hover` CSS 变量，antd token 在 `main.tsx` ThemedConfigProvider 派生
- 标签强调色：`settings.tabAccentColor`（默认 `#3fb950`），经 `--tab-accent` CSS 变量生效
- 背景图（`settings.terminal.backgroundImage`）：图片层 `.term-bg-image` 在 xterm 画布之下（`terminal.css`），xterm 背景设 `#00000000` 透明。**图片模式下的三条铁律**：① `.terminal-view.has-bg-image .terminal-view-dock` 强制深色底衬 `#0d1117`，不能用 `--chrome-bg`——浅色主题下它是白色，调低透明度会把图洗白而不是压暗；② `minimumContrastRatio` 从 1 提到 4.5（WCAG AA，与 VS Code 终端默认值一致；TerminalView 构造与设置热更两处都要改；注意正确拼写是 `minimumContrastRatio`，`minContrastRatio` 会被静默忽略），xterm 的对比度计算把透明背景当黑色亮度，会把浅色主题的深色前景自动提亮到可读。无图时保持 1 不动主题配色。③ 压暗层（`settings.terminal.backgroundImageDim`，0–90，**默认 0**）：`.term-bg-dim` 纯黑 scrim 在 DOM 序上位于 `.term-bg-image` 之后、xterm（z-index:1）之下（同在 z-index:0 层，靠 DOM 序压图），与透明度的区别是透明度把图与深色底衬混合、压暗在图之上叠黑（保饱和但整体变暗）；**dim=0 时 TerminalView 不渲染该层，零成本**

## 终端尺寸同步

- `TerminalView.scheduleFit`：fit 后**去抖 100ms** 再把 cols/rows 发给 PTY，并跳过与上次相同的尺寸。每次 ResizeObserver 都戳 PTY 会让全屏 TUI（Claude Code 等）在最大化/还原的中间尺寸上反复重绘，留下重复帧
- 拖动窗口期间 xterm 网格立即更新，PTY 尺寸在停止后 100ms 生效

## 性能与安全边界（M11 第二轮）

- `TerminalView` 用 **5 组 `useShallow` 字段级订阅**（fontOpts/themeOpts/bgOpts/highlightOpts/toolbar + rendererMode），**不要再回到整对象订阅**——主进程 `mutateSettings` 回推整个 settings 对象，任何写入都会变身份，整对象订阅会让所有 pane 重写 options + refit。`useResolvedTheme` 也是 shallow + memo 后的稳定引用
- `TerminalView` **已无 imperative handle**（`TerminalHandle`/forwardRef 全删，无人传 ref）；要加「外部聚焦/清屏」需重新引入
- `FilePanel` 虚拟化：自实现 windowing（>200 条目启用）。**行高与字号单一数据源在 `FilePanel.tsx`**：`BASE_ROW_HEIGHT = 26` × 缩放状态 `scale`（0.8–1.8，`localStorage` 的 `openterminal.sftpFontScale`）算出 `rowHeight`，经面板根元素 inline style 写成 CSS 变量 `--sftp-row-h` / `--sftp-fs` / `--sftp-fs-meta` / `--sftp-scale`；`windowStart(scrollTop, rowHeight)` 与 slice 计算都用这个动态值。**`sftp.css` 只消费变量、不得再写死行高或字号**（写死会让虚拟列表算术与真实行高脱节）。表头 `.sftp-head` 与 `.sftp-row` 共用同一套 grid 模板（列宽 `calc(Npx * var(--sftp-scale))`）才能对齐；行高写着 `box-sizing: border-box` 是有意的——本仓库没有全局 box-sizing reset，去掉会让 offset 算错。**别的坑**：antd 的 `Dropdown` 会把 `ant-dropdown-trigger` 类**克隆到子元素本身**（不是外面套一层），所以绝不能再写 `.sftp-list .ant-dropdown-trigger { display: block }` 这类后代选择器——特异性高于 `.sftp-row`，会把 `display: grid` 悄悄顶掉（旧代码正是如此）；行与滚动容器各挂一个 contextMenu Dropdown，容器的 `onContextMenuCapture`（capture 早于 antd 的冒泡 trigger）记录「是否点在行内」，`onOpenChange` 据此拒绝打开，避免两个菜单叠加
- 每个 dockview pane 内有 `PanelErrorBoundary`（`ErrorBoundary.tsx`）：pane 崩溃只卸载自己，根部边界仍兜底
- **本地路径准入**（`src/main/localPathGrants.ts`）：SFTP 上传/下载与 zmodem 收发的本地路径必须来自系统对话框授权（pickFiles/pickDirectory 是唯一授权源，进程级内存注册表、不落盘），realpath+stat 双重校验、Windows 大小写折叠、解析后的路径才是要打开的路径。新增「渲染层构造本地路径传给主进程」的调用点时**必须过这道门**，别绕
- `keyPath`（SSH 私钥）：realpath → stat → 普通文件且 ≤1MB 才读（防设备文件永久阻塞 UI 线程/符号链接逃逸）
- `src/shared/reservedAccelerators.ts`：设置页录制器与主进程 `applyGlobalShortcut` **共用同一张保留键表**（Ctrl+L、Ctrl+=/-/0/PgUp/PgDn），两处分表曾漂移出洞，加新全局快捷键时两边自动一致
- SFTP 操作有 per-op 超时（`sftp.ts` 的 `bounded()`：元数据 30s / 传输块 60s / open 10s），超时按 transport 错误驱逐半死通道并重试一次；`setSftpTimeouts`/`setUpdateTimeouts` 是**测试缝**，生产无调用者，别接设置项
- `webPreferences` 显式写死 `contextIsolation: true / nodeIntegration: false / webSecurity: true`（`index.ts` 唯一窗口创建点），防默认值被将来改动
- 终端标签自动标题（「终端 N」）是**存储的显示文本**（进布局模板/会话快照/广播注册），`src/shared/terminalTitle.ts` 负责两个方向：反解用**全部 4 语言**的 pattern（任何语言生成的都能认出编号），渲染用当前语言；语言切换/快照恢复/模板应用时 `retitleAutoTitles` 原地重渲染（SSH 面板标题是用户起的连接名，永不动）。需要指定语言渲染时用 i18n 的 `tFor(lang, key, vars)`

## 锁屏

- 只使用**主窗口内的不透明遮罩**（`src/renderer/src/lock/LockScreen.tsx` + `lock.css` 的 `.lock-screen`，z-index 4000），**不创建第二个 Electron 窗口**。锁定时 `App.tsx` 把 `.app-root` 设为 `inert` 并**保持挂载**——卸载会杀掉遮罩后面的本地/SSH 会话与传输列表；antd portal（Modal/Dropdown/Tooltip）挂在 `document.body` 上、不在 `#root` 内，锁定时**要把 body 下 `#root` 以外的子节点也设为 `inert`**，否则键盘 Tab 仍能走进遮罩后面的浮层。**这个一次性快照不够**：锁定之后才挂上的 portal 不在其中（典型场景是 SSH 连接发出后闲置自动锁屏，主机密钥弹窗此刻才弹出，antd 的 autoFocus 还会抢走密码框焦点），所以锁定期间 `App.tsx` 用 `MutationObserver` 盯着 `document.body` 的 childList，给新加的非 `#root` 子节点补 `inert`，解锁时断开 observer 并按记录恢复；observer 只在锁定时存在，平时零开销，且**锁屏遮罩自身在 `#root` 内，永远不参与 inert**
- 密码 verifier 在 `<userData>/lock.json`（`src/main/lockStore.ts` 的 `LockStore`）：scrypt(N=16384,r=8,p=1) + 每次写入重新生成的 16 字节 salt + `timingSafeEqual`，**不存明文**；缺 `version: 1`、salt/hash 尺寸不符一律当「未配置」（宁失效也不崩启动路径），但 `version` 不认识会**每进程 warn 一次**——将来改格式不许静默失锁
- 锁状态由主进程独占（`src/main/lockController.ts`）：`LockSettingsState` 只有 configured/enabled/autoLockMinutes/lockAtStartup/locked/cooldownMs，**salt/hash/密码永不出主进程**，渲染层从不自行判定锁定
- 锁标志落盘在 `<userData>/lock-state.json`（`LockStateStore`），**locked/failures/cooldownUntil 每次变化立即写**，所以托盘退出、任务管理器强杀、崩溃后重启仍然是锁的——`lockAtStartup` 只是额外一层。没有 verifier 时启动会删掉该文件；从磁盘恢复的 `cooldownUntil` 夹紧到 `now+30s`，防系统时间回拨导致永久锁死
- 冷却阶梯 1s→2s→5s→10s→30s，失败计数与冷却同样落盘；`setPassword`/`clearPassword`/`unlock` 走内部串行队列（`serialize`），否则并发调用会同时通过闸门绕过冷却
- 闲置锁屏：`powerMonitor.getSystemIdleTime()`，15s 轮询；读不到（无会话/工作站已锁）一律当「不闲置」。`settings.lock.autoLockMinutes` 是白名单 `{0,1,5,15,30,60}`（`src/shared/settings.ts` 的 `LOCK_AUTO_DELAYS`），0 = 从不
- **清除密码会一并把 `settings.lock.enabled`/`lockAtStartup` 置 false**（`LockControllerOptions.clearLockPreferences`，默认走 `mutateSettings`）：设置页文案承诺「清除后锁屏会一并关闭」，留着会让用户下次设密码时被静默重新武装
- 锁屏期间主进程在 `win.webContents.on('before-input-event')` 里吞掉 F5/Ctrl+R、Ctrl+±0（含 Shift 拼写）、Ctrl+Shift+I/J/C：遮罩是 DOM 层，拦不住浏览器进程处理的 Electron 默认菜单加速键，而重载会触发 `beforeunload` 把遮罩后面的会话全杀掉。**键盘判定抽在纯函数模块 `src/main/lockShortcuts.ts`（`isLockBlockedShortcut`/`isPanicLockChord`，无 Electron 依赖，表驱动测试 `tests/lock-shortcuts.mjs`）**——v1.0.17 的回归就是死在闭包里没法测。键盘之外还有鼠标路径：默认菜单按 Alt 就能唤出，菜单项点击不走 before-input-event，所以**锁定期间 `src/main/lockMenu.ts` 把整个应用菜单置 null（解锁时按 Electron 默认模板重建）**；菜单摘除挂在 `LockController` 的默认 publish 上，启动恢复锁定不经过 publish，由 `index.ts` 在 `initLockController()` 后按 `isLocked()` 直接补一次。渲染层的 `document.documentElement.dataset.locked` 守卫（字体快捷键、`Ctrl+PgUp/PgDn`）**只允许 `return` 跳过自身逻辑，绝不能 `preventDefault`**——keydown 的默认动作就是「往聚焦输入框插字符」，窗口级 preventDefault 会把锁屏密码框的全部输入杀掉（v1.0.17 就是这么坏的，v1.0.18 修复）
- **Ctrl+L = 立即锁屏**（同一 `before-input-event` 里捕获，终端里也生效——这正是它的意义）：仅在锁定真的生效时才 `preventDefault`，未设置密码的应用保留 Ctrl+L 给 shell 的清屏；已锁定时不再拦截。长按的自动重复要跳过（`input.isAutoRepeat`），否则未配置密码时每次重复都同步读 lock.json + settings.json。**Ctrl+L 是保留键**：全局唤起快捷键的录制器（`SettingsTabs.tsx` 的 `RESERVED_EXACT_ACCELERATORS`）拒绝它——globalShortcut 在 OS 层拦截，绑上去会让锁屏快捷键静默失效。窗口藏进托盘后 Ctrl+L 无效（before-input-event 只对聚焦窗口触发），这是刻意的取舍：全局注册会从所有应用手里抢走这个组合键。**主进程侧也拒绝注册它**：`applyGlobalShortcut`（globalShortcuts.ts）对 `Control+L` / `Ctrl+L` / `CommandOrControl+L`（大小写、修饰键别名都不敏感）直接跳过并 warn——录制器只拦得住它上线之后录入的值，老版本存下的 `Control+L` 仍会走到注册这一步
- 启动时**不要**用 `locked: true` 作渲染层初值再直接画锁屏：`App.tsx` 用 `null` 表示「主进程还没答复」，此时只画 `.lock-screen-boot` 纯色层，否则每次启动都会给没设密码的用户闪一帧锁屏。`getLockState()` 失败时要落到「locked 且未配置」的状态，让输入框可达（主进程对无 verifier 的解锁请求直接放行）
- 相关测试：`node tests/lock-store.mjs`（verifier + 状态存储）、`node tests/lock-controller.mjs`（冷却阶梯、并发串行化、落盘恢复、闲置触发、清除联动）、`node tests/lock-shortcuts.mjs`（键盘分类器表驱动用例）

## 布局模板（工作区）

- 应用模板（`Workspace.handleApplyTemplate`）读的是**外来 JSON**。`fromJSON` 一旦中途失败（别的版本写的模板、面板组件已不存在），dockview 会**先把目标 dockview 清空再抛错**（`failed to deserialize layout. Reverting changes`）。清空是逐面板走 `onDidRemovePanel` 的，所以**旧会话在抛错之前就已经被 `killSession` 杀掉了**——恢复出来的面板接不回它们，必须换新会话
- 失败路径：应用前 `toJSON()` 快照两个 dockview → 抛错时只对**这次真的调用过 `fromJSON` 的** dockview 回灌快照（回灌本身会清空该 dockview；把快照灌进没被碰过的那个会连带杀掉它活着的会话）→ 对恢复出来的面板跑 `rebindRestoredPanels` → 再把「没有任何面板引用的 `previousSessions`」kill 掉 → `message.error`。`JSON.parse` 失败同样要提示，不能静默 return
- 会话计数不靠累加器：`releaseSession` 直接扫 `api.panels` 判断还有没有面板在显示该会话——累加器与「`updateParameters` 原地换会话」「整块布局替换」这类无事件变化脱节，会漏杀或误杀

## 关键词高亮

- 预设规则表在 `src/shared/settings.ts` 的 `DEFAULT_HIGHLIGHT_RULES`（22 条），引擎在 `src/renderer/src/terminal/highlightEngine.ts`；规则按 priority 升序应用，**先匹配到的 span 归先跑的规则，后续规则遇到重叠直接跳过**
- 状态类预设（danger/okstate/warnstate/badstate）priority 排在 `shellkw` **之前**：`done` 既是 shell 关键字又是成功词、`if` 还在 `dd if=` 里，先跑谁就由谁着色
- 状态符号（`✓ ✔ ✅ ✗ ✘ ✖ ❌ ⚠`）**不能放进 `\b…\b` 组**：`\b✓` 永不成立。预设把它们写在 `\b(?:…)\b|[✓✔✅]\uFE0F?` 的第二个分支里，尾随的 `\uFE0F?` 是为了把 emoji 变体选择符一起圈进着色范围
- 严重级别按颜色拆开：成功（okstate 绿）/ 警告（warnstate 黄）/ 错误·致命（badstate 红，含 `CRITICAL`、`FATAL`、`PANIC`）/ 删除·移动·覆盖（delop 橙）/ 新建·创建·安装（createop 亮绿）；`badstate` 里的 `NOT …` 分支负责 `not ok` / `not found`，`okstate` 的反向断言保证它不会被染绿
- delop/createop 只列**操作动词**（delete/remove/rm/mkdir/touch/add/install/clone/…），`export` 等 shell 关键字仍归 `shellkw`，别把两边都写进去抢 span
- **数值分级（`bands`）**：匹配里的第一个数字决定颜色（最后一个 `min <= 值` 的分级胜出），无数字或低于最小分级时回落到 `color.fg`；预设 `percent` 用它做百分比（<20% 红 / 20–50% 黄 / 50–80% 浅绿 / ≥80% 绿）。它的 priority 22 **必须早于 `numbers`(25)**，否则 `45%` 会先被数字规则整段吃掉；`numbers` 规则本身不含百分比分支
- 词干要自带词尾（`DELET(?:E|ED|ES|ING|ION)` 而非 `DELETE(?:D|S|ING)?`，否则漏 `deleting`）；不成词的词干（MOV/SAV/CLON/PURG/ERAS/WIP/REVOK）必须强制要求词尾
- 上下文敏感的规则用 **lookbehind/lookahead 只圈住关键词本身**，否则分级会读到错误的数字：`(?<=\bHTTP/\d(?:\.\d)?\s)[1-5]\d\d\b` 让 `HTTP/1.1 404` 只着色 `404`（若把 `HTTP/1.1` 一起匹配，bands 会读到版本号 `1`）。同理 `[1-5]\d\d(?=\s+OK|…)` 靠先行断言限定"后面跟原因短语"才算状态码，避免把 `123` 这类普通数字当成 404
- 裸 3 位数（`[1-5]\d\d`）**不能单独成规则**，必须有上下文锚点；同理 MAC、短哈希这类高误伤模式不进预设
- 导入 / 导出与实时预览：`src/shared/highlightIO.ts` 管 JSON 信封（`kind`/`version`，外来 JSON 直接拒绝）与 replace/append 合并；渲染层用剪贴板 + FileReader + Blob 下载完成，**不新增 IPC**。编辑器预览走引擎的 `previewSpans`（跑真实高亮再解析它自己的 SGR 输出），并且**带上当前其它规则**，这样 span 被别的规则抢走时能一眼看出来
- 分类（`category`，`safety|status|file|net|text|metric`）：预设的分类放在 `PRESET_CATEGORIES` 一张表里，`basic` 集合必须始终是 safety+status 的子集（有测试守）；`settings.terminal.highlightGroupByCategory` 只影响设置页（加分类列 + 按分类聚簇，组内仍按 priority），**热路径完全不涉及**
- 跟随主题（`settings.terminal.highlightThemeColors`，默认关）：`src/renderer/src/theme/highlightColors.ts` 按**色相分桶**把规则颜色映射到当前主题的 ANSI 调色板（不用"最近色"，否则语义会漂移），亮度决定用普通色还是 bright 色（这样 percent 的两档绿仍能区分）；饱和度低于 0.15 的中性色保持原样；**背景色不映射**（它是文字底块，不是语义信号）。映射在编译期一次性完成，热路径零成本；编辑器预览走同一函数，否则预览会与终端不一致
- 统计（`settings.terminal.highlightStats`，默认关）：引擎的 `applyHighlights`/`HighlightStream` 接受可选 `StatsSink`，**只在传了 sink 时才计数与计时**（默认路径不插桩）；`TerminalView` 只在开关打开时挂 sink，并**每秒发布一次快照**（不是每块），否则忙碌的终端会把设置页重渲染到卡死；设置页通过 `subscribeHighlightStats` 订阅，多出「命中/耗时」两列（耗时按 µs/ms 格式化）
- 性能护栏（别拆）：`MAX_CHUNK` 512KB 整块跳过、`MAX_LINE_LEN` 4KB 超长行不跑规则（挡 `(a+)+b` 这类回溯）、`MAX_PER_RULE` 300 每条规则每块上限。实测 180–200KB 混合输出：**全预设 4–9ms/块**（0.02–0.05ms/KB，取决于转义序列密度；典型 4KB chunk ≈ 0.05–0.26ms）、**basic 档 ~1.3ms/块（≈49µs/chunk）**、**off 档 0**；单条规则最贵的是 `http`(0.82ms)、`percent`、`danger`
- 总开关是**三档模式** `settings.terminal.highlightMode`（`all` / `basic` / `off`，读取一律过 `highlightModeOf` 兜底）：`basic` 只跑带 `basic: true` 的规则（预设里是 danger/secret/okstate/warnstate/badstate 这 5 条；用户可在规则编辑器里用「基础规则」开关给自建规则打标），`off` 时 `TerminalView` 把规则集清空而不是绕过 `HighlightStream`——stream 会 hold 住尾部文本，绕过会丢字节；空规则集在 tokenize 之前就返回，几乎零成本
- 按主机绑定规则集（`settings.terminal.highlightPerHost`，默认关）：`HighlightProfile { id, name, ruleIds }` 存在 `AppSettings.highlightProfiles`（顶层数组，仿 `customThemes`），清洗在 `src/shared/highlightProfiles.ts`；`ruleIds` **为空 = 全部规则**，`rulesForProfile` 对未绑定 / 绑到不存在的 id / 空 profile 一律回落到全集，`excludedByProfile` 给设置页算「这个 profile 排除了哪些规则」。绑定存在 **`connections.json`**（`SshConnection.highlightProfileId`）而不是 settings，`TerminalView` 只在 mount 时查一次连接——改了绑定要重开会话才生效。新增连接字段时必须同时改三处：`PUBLIC_KEYS`（update 路径靠它回写）、`toPublic()`、`saveConnection()` 的新记录字面量，漏一处该字段会在某条路径上静默丢失
- 编辑器预览的输入要**截断**（前 2000 字符）：200KB 样本会产出 7000+ 个 span，React 每敲一个键重渲染会卡
- `caseInsensitive: true` 的规则编译成 `gi`（规则级开关，默认关闭）；预设里 `okstate` 带 `(?<!not\s)` 反向断言，把 `not ok` 让给 `badstate`
- 词边界是这套预设的全部难点：新增关键词后请跑 `node tests/.hl-rules.cjs`（`invalid` 不能点亮 `valid`、`disabled` 不能点亮 `enabled` 等）
- 升级旧安装：`settingsStore.refreshBuiltinRules` 只把**仍是出厂 pattern** 的内置规则升到新预设（保留用户的颜色/优先级/启停），且仅当规则集恰好等于旧预设集时才追加新增的内置规则——否则用户删掉的规则会每次加载都复活。改预设 pattern 时同步更新 `LEGACY_BUILTIN_PATTERNS` / `LEGACY_BUILTIN_IDS`
