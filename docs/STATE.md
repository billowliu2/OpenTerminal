# OpenTerminal 状态快照（上下文压缩续接文档）

> 用途：新会话/子代理从此文件恢复全部工作状态，无需对话历史。每次里程碑后更新。

## 当前版本与仓库

- v0.1.0（版本重置：作为全新开源项目从 0.1.0 起步），远程 `git.codingplan.site/admin/OpenTerminal.git`（国内仓）+ `github.com/billowliu2/OpenTerminal.git`（GitHub 镜像仓）；凭据存于 `.env`（已 git 忽略），凭据助手按 host 自动读取
- 开源协议：MIT（LICENSE）
- 更新通道 = `https://git.codingplan.site/api/packages/admin/generic/openterminal-update/stable/`（公网可读，含 latest.yml/exe/blockmap）
- 技术栈：Electron + electron-vite + React 19 + TS strict + antd 6（全局深色）+ zustand + dockview-react 8 + @xterm/xterm 6 + @lydell/node-pty + ssh2 + zmodem.js + electron-updater + electron-builder
- 契约先行约定：所有跨进程接口定义在 `src/shared/`，主/预载/渲染各自实现；新功能先改 shared 再派两端

## 里程碑状态（详见 ROADMAP.md）

| 阶段 | 状态 |
|---|---|
| M1 本地终端+分屏+主题/字体 | ✅ |
| M2 SSH+连接管理器+凭据加密+指纹校验 | ✅（真实服务器验收通过） |
| M2.5 关键词高亮+系统设置(自启/阻止休眠)+UI 深色化 | ✅ |
| M3 Terminal/SSH 分离+服务器监控（Wave 风格） | ✅（真实服务器验收通过） |
| M4 SFTP 文件管理+传输+权限/chmod/chown+监控图表化 | ✅（真实服务器验收通过） |
| M5 命令历史/命令库/补全+会话日志 | ✅ |
| M6 广播输入+ZMODEM+快捷输入面板+快捷键系统 | ✅（v0.6.0，UI 活体验收；ZMODEM 双向 e2e） |
| M7 打包分发（MSI+NSIS+自动更新） | ✅（v0.7.0 已发布 Release） |
| M8 工作区分离+底部文件面板+右键菜单+监控美化+补全修复 | ✅（v0.8.0） |
| M9 体验打磨（托盘+关闭行为+单实例+主题联动标题栏+布局菜单重做+补全修正+图标） | ✅ |

## M8 实现要点（v0.8.0，已落地）

- **工作区分离**：两个独立 Dockview 实例（terminal/ssh），切换 = 容器 display:none（状态保留）；workspaceModeStore（zustand+localStorage）；IconRail 双模式入口（选中高亮）；ConnectionSidebar 按模式只显示对应区块（终端：终端+命令；SSH：服务器+最近会话）；旧的「单 Dockview+marker 面板+setVisible 分组」方案已废弃删除
- **SSH 底部文件面板**（SshBottomPanel）：终端在上、文件浏览器在下、4px 可拖分隔条（120px~60%）；右侧栏只留监控（300px）
- **sftp.css 从未被 import 的隐藏 bug**：文件面板样式一直裸奔，FilePanel.tsx 补 `import './sftp.css'` 后才真正生效——教训：新增 css 文件必须确认被入口 import
- **文件右键菜单**：刷新/打开·下载/上传/重命名/新建文件夹/复制路径/文件权限/删除（复用现有 handler；「新建文件」因无 touch API 未做）
- **监控美化**：内存橙条、磁盘三列行、网络上下行进区块头（↓蓝 ↑金）、toFixed(4) 精度、tabular-nums
- **补全修复**：①Enter 也接受补全（Tab||Enter）；②丢字符根因=differenceWrite 只写差量而 lineBuf 与 shell 行缓冲失同步→改为接受时强制重写（\x15 Ctrl+U 清行+写全命令）+diffRewriteRef 让下一次 onData（shell 重画 echo）重置缓冲
- **chmod 无效 bug**：bitsToOctal 把八进制位按十进制拼数（dr-x--x--x → 329 而非 511），新旧相等致 chmod 根本没发→改字符串拼接；chown 只在 uid/gid 真变化时执行
- **弹层被侧栏盖住**：dockview 渲染层 `contain:layout paint; isolation:isolate` 形成独立层叠上下文，面板内 antd 弹层逃不出→图标栏布局菜单/广播 Popover/文件右键菜单三处 `getPopupContainer={() => document.body}`
- **图标栏瘦身**：分屏两项+模板两项收进「布局」主菜单
- **SSH 标签强化**（SshHostBadge）：hostLabel 胶囊+绿 accent；日志工具栏 hover 才显示（录制时常显）；侧栏终端列表 max-height 滚动

## M6/M7 实现要点（已落地）

- **广播输入**：渲染层 zustand（broadcastStore）维护 enabled/targets/sessions；TerminalView 全部写路径（onData/补全/粘贴/Workspace runCommand）走 writeBroadcast 扇出；目标 <2 自动禁用；tab 目标圆点 + 按钮计数徽标
- **ZMODEM**：主进程引擎（src/main/zmodem.ts，仅 SSH 会话；本地 pty 走 ConPTY 只给 UTF-8 字符串，二进制会损坏——不支持，注释已说明）；Sentry 常驻分流非 zmodem 字节；offer→渲染层选文件/目录→respond；传输期抑制 PTY_DATA/replay/日志并丢弃用户键入；offer 120s/传输 90s 看门狗；进度复用 TransferPanel（kind=zmodem-upload/download）；测试 tests/zmodem-e2e.mjs 用第二个 zmodem.js Sentry 模拟远端，双向内容一致性断言
- **快捷输入面板**：QuickInputPanel 右下 fixed 浮层（bottom:44 避让 TransferPanel），发送经 writeBroadcast（广播感知），列表打开沿刷新
- **快捷键**：Ctrl+=/-/0 字号（main.tsx capture 监听，xterm-helper-textarea 放行——隐藏 textarea 曾被误判为输入框导致终端聚焦时失效，已修）；globalShowHide accelerator（globalShortcuts.ts，设置页系统分区可配，注册失败仅 warn）；Ctrl+PgUp/PgDn 面板循环（Workspace capture 监听）
- **打包**：electron-builder.yml（msi 固定 upgradeCode 5ab9f79e-e4eb-4052-9df6-3af3a301ab0a + nsis；asarUnpack @lydell/node-pty + ssh2；npmRebuild false）；updater.ts（仅 packaged 启用，OT_UPDATE_URL/OT_UPDATE_TOKEN env，默认 feed=上述 generic package 地址）

## 发布流程（下一版本照抄）

1. package.json version 升位 → `npm run dist`（env：ELECTRON_MIRROR + ELECTRON_BUILDER_BINARIES_MIRROR=npmmirror；dist:dir 后先删 release/win-unpacked 避免占用 EPERM）
2. `git tag vX.Y.Z && git push origin main vX.Y.Z`
3. Gitea API 建发布：POST /api/v1/repos/admin/OpenTerminal/releases（中文 body 必须走 UTF-8 文件 --data-binary @file，shell 内联会坏）
4. 附件：POST .../releases/{id}/assets?name=（msi/exe/blockmap/latest.yml，实测 141MB 可传）
5. 更新通道：DELETE .../api/packages/admin/generic/openterminal-update/stable（旧版）→ PUT 同 URL 依次上传 latest.yml / exe.blockmap / exe
6. 校验：curl 无 token 拉 latest.yml 应 200 且 version 正确

## 测试（全部通过，改动后必跑）

```bash
npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json
npm run build
node tests/ssh-loopback.mjs
npx esbuild src/main/pty.ts --bundle --platform=node --format=cjs --outfile=tests/.session-e2e.cjs --external:@lydell/node-pty --external:ssh2 --alias:electron=./tests/electron-stub.cjs && node tests/ssh-session-e2e.mjs
node tests/sysinfo-e2e.mjs
npx esbuild tests/hl-split-smoke.mjs --bundle --platform=node --format=cjs --outfile=tests/.hl-split-smoke.cjs && node tests/.hl-split-smoke.cjs
node tests/commands-store.mjs
node tests/zmodem-e2e.mjs
# 真实服务器测试（需 JD 环境变量凭据，旧凭据已过期）：
# JD_HOST=... JD_USER=root JD_PASS=... node tests/sftp-real.mjs / tests/sftp-chmod.mjs
# 打包：npm run dist（产物 release/）
```

## 关键架构与已踩坑（勿重蹈）

1. **主进程 = 注入式**：pty.ts 的 sessions Map（local/ssh 统一数据面）；sysinfo/sftp/zmodem/日志均经 provider/configure 注入，保持 ssh.ts/commands.ts/zmodem.ts 无 electron 依赖
2. **JD 云服务器三个怪癖**：① SFTP SETSTAT 被静默忽略 → chmod/chown 走 SSH exec；② SFTP 写 ACK 惰性 → 窗口化流水线 + close 兜底；③ 每连接仅一个 SFTP 子系统通道 → 传输复用缓存通道
3. **esbuild CJS bundle 会让 ssh2 fastPut 回调不触发**（数据实际到达）→ 测试用 stat 轮询；真实应用 rollup 未复现
4. **antd Modal 必须包在 `<App>`+darkAlgorithm 内**，`.ant-app` 需 height:100%（高度链）
5. **xterm 清理**：IDisposable 只能 .dispose()，不可当函数调用
6. **zmodem.js 0.1.10**：Node 可 require 核心（Sentry/Session）；`on_input` 交付的是普通 Array 非 Uint8Array（需防御转换）；send_files 在 zmodem_browser.js:58（FileReader 版，已移植 fs 版）
7. ~~**MSI 无图标会链接失败**~~（已修复：build/icon.png 由程序生成，electron-builder 自动转 ico，MSI/NSIS 快捷方式已启用）
8. **electron-updater 不支持 MSI 自动更新** → 更新通道走 NSIS exe；MSI 仅分发
9. **命令库测试时间戳竞态**：saveLibraryItem 连续保存同一毫秒 createdAt 相同排序不稳 → 测试保存间 wait(2)
10. **JD 服务器测试凭据已过期**；凭据一律环境变量且不落盘

## 编排约定

- 主代理：契约先行 → 并行派遣子代理（每个带自审清单）→ **code-review 子代理** → 主代理集成验收（typecheck/build/测试/真实打包/UI 活体验证）→ 提交推送 + tag
- 主代理额度紧张时：契约与验收保持主代理，实现全部下沉子代理；GUI 验收（computer-use）必须主代理亲自做
- 自动化差异备忘：antd Popover 触发按钮与 portal 内按钮对 AXPress 不响应（真实鼠标点击正常）——验收一律用 event 策略坐标点击 + 精确 bounds

## 待办（按优先级）

1. ~~应用图标~~（已完成：build/icon.png，程序生成的原创图标）
2. 用户实测项：Ctrl+PgUp/PgDn 真实键盘（合成键盘无法验证修饰键）、真实服务器 rz/sz 一轮、全局唤起快捷键
3. 小项：autoWrap=false 固定列宽、OSC 标题跟随、内置 OFL 字体打包、WebGL 终端数上限降级、i18n（中英切换）、最近命令历史出现两条命令拼接的记录（广播键入时行捕获合并，低优先级修）
