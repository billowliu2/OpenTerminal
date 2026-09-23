# OpenTerminal 开发备忘

Electron + electron-vite + React 终端工具（本地终端 / SSH / SFTP）。

## 常用命令

- 开发：`npm run dev`（主进程改动不热重建，需重启）
- dev 实例使用独立用户数据目录 `%APPDATA%\OpenTerminal-dev` 与独立单实例锁（`src/main/index.ts` 顶部 `!app.isPackaged` 分支），窗口标题带 `(dev)`：**可与已安装的正式版同时运行，互不干扰**，也不会把测试设置/会话写进真实配置
- 类型检查：`npm run typecheck`（tsconfig.node.json + tsconfig.web.json；只看渲染层可单跑 `npx tsc --noEmit -p tsconfig.web.json`）
- 测试：`npm test`（先 `node tests/build-bundles.cjs` 重建 esbuild bundle，再依次跑可离线运行的 7 个测试；真实服务器测试需 JD_* 凭据，不在此列）
- 打包：`npm run dist`，产物在 `release/`（msi + exe + latest.yml + blockmap）
  - 国内网络需镜像：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ npm run dist`

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
4. `node scripts/release.cjs <版本号> --skip-github`，例如 `node scripts/release.cjs 1.0.14 --skip-github`
   - **只发国内**（2026-09-15 起的产品决定）：Gitea release（msi + exe 资产）→ Gitea 更新通道（`api/packages/admin/generic/openterminal-update/stable`：exe.blockmap → exe → release-notes.md → **latest.yml 最后**）
   - 通道不再先删旧版：新版本文件全部传完、latest.yml 生效后才清掉上一版 exe/blockmap，中途失败不会把通道打空；同一版本可重复运行（release 复用、已传资产跳过）
   - 只补通道：`node scripts/release.cjs <版本号> --channel-only`（不建 release、不发 GitHub）
   - 国内通道全程直连，**不需要设代理**；代理只在显式补发 GitHub 时才用（`HTTPS_PROXY=http://127.0.0.1:7897`，脚本只把它用于 GitHub 请求）
   - GitHub 那一步的状态：`README` 与更新机制里仍保留 GitHub 作为更新回退源，但**release 资产不再随版本发布同步**；若某天需要补，跑一次 `node scripts/release.cjs <版本号> --skip-gitea` 即可
5. 验证更新通道：`curl https://git.codingplan.site/api/packages/admin/generic/openterminal-update/stable/latest.yml` 应返回新版本号
6. `git tag v<版本号>` 并推送两个远程（代码/tag 的镜像保持同步，仅 release 资产不发 GitHub）

## 更新机制

- 检查更新：先 Gitea 更新通道（强制直连，不走系统代理），失败回退 GitHub（走系统代理）。 electron-updater 用独立 session（partition `electron-updater`），代理模式在 `useFeed` 里按源切换
- 更新日志：Gitea 仓库是私有的（匿名 API 404），改为从更新通道的 `release-notes.md` 读取（直连 session `openterminal-update-direct`），再回退 Gitea/GitHub releases API
- electron-updater 不支持 MSI 自动更新，自动更新只走 NSIS exe

## 主题机制

- 终端主题由 xterm 主题派生 UI 配色：`src/renderer/src/theme/chrome.ts` 的 `applyChromeTheme` 写入 `--chrome-bg/-bg-deep/-border/-hover` CSS 变量，antd token 在 `main.tsx` ThemedConfigProvider 派生
- 标签强调色：`settings.tabAccentColor`（默认 `#3fb950`），经 `--tab-accent` CSS 变量生效

## 终端尺寸同步

- `TerminalView.scheduleFit`：fit 后**去抖 100ms** 再把 cols/rows 发给 PTY，并跳过与上次相同的尺寸。每次 ResizeObserver 都戳 PTY 会让全屏 TUI（Claude Code 等）在最大化/还原的中间尺寸上反复重绘，留下重复帧
- 拖动窗口期间 xterm 网格立即更新，PTY 尺寸在停止后 100ms 生效

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
- 总开关是**三档模式** `settings.terminal.highlightMode`（`all` / `basic` / `off`，读取一律过 `highlightModeOf` 兜底）：`basic` 只跑带 `basic: true` 的规则（danger/secret/okstate/warnstate/badstate 这 5 条），`off` 时 `TerminalView` 把规则集清空而不是绕过 `HighlightStream`——stream 会 hold 住尾部文本，绕过会丢字节；空规则集在 tokenize 之前就返回，几乎零成本
- 按主机绑定规则集（`settings.terminal.highlightPerHost`，默认关）：`HighlightProfile { id, name, ruleIds }` 存在 `AppSettings.highlightProfiles`（顶层数组，仿 `customThemes`），清洗在 `src/shared/highlightProfiles.ts`；`ruleIds` **为空 = 全部规则**，`rulesForProfile` 对未绑定 / 绑到不存在的 id / 空 profile 一律回落到全集，`excludedByProfile` 给设置页算「这个 profile 排除了哪些规则」。绑定存在 **`connections.json`**（`SshConnection.highlightProfileId`）而不是 settings，`TerminalView` 只在 mount 时查一次连接——改了绑定要重开会话才生效。新增连接字段时必须同时改三处：`PUBLIC_KEYS`（update 路径靠它回写）、`toPublic()`、`saveConnection()` 的新记录字面量，漏一处该字段会在某条路径上静默丢失
- 编辑器预览的输入要**截断**（前 2000 字符）：200KB 样本会产出 7000+ 个 span，React 每敲一个键重渲染会卡
- `caseInsensitive: true` 的规则编译成 `gi`（规则级开关，默认关闭）；预设里 `okstate` 带 `(?<!not\s)` 反向断言，把 `not ok` 让给 `badstate`
- 词边界是这套预设的全部难点：新增关键词后请跑 `node tests/.hl-rules.cjs`（`invalid` 不能点亮 `valid`、`disabled` 不能点亮 `enabled` 等）
- 升级旧安装：`settingsStore.refreshBuiltinRules` 只把**仍是出厂 pattern** 的内置规则升到新预设（保留用户的颜色/优先级/启停），且仅当规则集恰好等于旧预设集时才追加新增的内置规则——否则用户删掉的规则会每次加载都复活。改预设 pattern 时同步更新 `LEGACY_BUILTIN_PATTERNS` / `LEGACY_BUILTIN_IDS`
