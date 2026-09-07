# OpenTerminal 长期路线图

目标：以开源组件组合构建现代化的本地 + SSH 终端应用，按里程碑推进，每个里程碑可独立交付使用。

## 里程碑总览

| 阶段 | 内容 | 状态 |
|---|---|---|
| M1 | 本地终端 + 分屏 + 主题/字体 + 设置持久化 | ✅ 已完成（v0.1） |
| M2 | SSH 远程会话 + 连接管理器 | ✅ 已完成（v0.2） |
| M2.5 | 关键词高亮（提前自 M4）+ 系统设置（自启动/阻止休眠）+ UI 打磨 | ✅ 已完成（v0.2.1） |
| M3 | SSH 产品化：Terminal/SSH 分离 + 服务器硬件监控（Wave 风格） | ✅ 已完成（v0.3） |
| M4 | SFTP 文件管理 + 传输面板 + 权限/属主/chmod | ✅ 已完成（v0.4） |
| M5 | 命令历史/命令库/补全 + 会话日志 | ✅ 已完成（v0.5） |
| M6 | 广播输入 + ZMODEM + 快捷输入面板 + 快捷键系统 | ✅ 已完成（v0.6） |
| M7 | 打包分发（MSI + NSIS + 自动更新） | ✅ 已完成（v0.7，Release 已发布） |
| M8 | 工作区分离（Terminal/SSH 双工作区）+ SSH 底部文件面板 + 右键菜单 + 监控美化 + 补全修复 | ✅ 已完成（v0.8） |
| M9 | 体验打磨：系统托盘 + 关闭行为 + 单实例 + 主题联动标题栏 + 布局菜单重做 + 补全交互修正 + 应用图标 | ✅ 已完成 |

## M2 — SSH 远程会话 ✅

- [x] `src/main/ssh.ts`：ssh2 连接池（connect/shell/resize/close），PTY_DATA/PTY_EXIT 广播通道统一复用（本地与 SSH 会话同数据面）
- [x] 连接配置模型（`shared/connections.ts`）：host/port/username、密码 vs 私钥（keyPath/keyContent）vs Agent、keepalive
- [x] 凭据加密存储：safeStorage(DPAPI) + `plain:` 兜底；渲染层只见 savedAuth 标志
- [x] 连接管理器 UI：书签侧栏（分组手风琴）+ 新建/编辑对话框 + 双击连接
- [x] Host key 校验：known_hosts 固定、首次确认、变更告警、30s 超时拒绝
- [x] 测试：tests/ssh-loopback.mjs（ssh2 回环）+ tests/ssh-session-e2e.mjs（真实会话路由层 e2e）
- 待解锁后的 GUI 验收：双击书签连接、指纹弹窗交互、断线提示
- 已知限制：SSH 面板暂不支持作为分屏参照（总在新标签打开）；连接中 Modal 不可取消；agent 认证未在本机验证

## M3 — SSH 产品化：Terminal/SSH 分离 + 服务器硬件监控 ✅

### A. Terminal 与 SSH 功能分离（产品形态）

- [ ] 侧栏双分区：「终端」（本地）与「SSH 服务器」各自独立区块（独立折叠、独立头部、独立计数）
- [ ] SSH 会话标识：标签页带服务器图标/主机名前缀，本地与 SSH 标签视觉区分
- [ ] 新建入口分离：图标条「+」只建本地终端；SSH 会话仅从服务器列表发起（双击连接，右键：连接/编辑/删除/复制主机）
- [ ] SSH 区增加「最近会话」（按 lastConnectedAt 排序，一键重连）
- [ ] （可选增强）工作区模式：本地/SSH 两个独立工作区布局，互不混排
- 验收：不开侧栏也能一眼区分标签是本地还是 SSH；图标条「+」只出本地终端

### B. 服务器硬件监控（参考 Wave Terminal 的 sysinfo 块）

技术可行性：✅ 高，零部署方案已在真实服务器上验证。

- **零部署路线**：ssh2 `exec` 读 Linux 标准接口——CPU `/proc/stat`（双采样算占用率）、内存 `/proc/meminfo`、负载 `/proc/loadavg`、磁盘 `df -kP`、网络 `/proc/net/dev`（双采样算速率）、运行时间 `/proc/uptime`
- **增强路线（部署脚本）**：首次连接部署 `~/.openterminal/sysinfo.sh`（纯 shell 输出 JSON，Linux/macOS 通用），解锁进程 Top 列表

数据面：ssh2 `conn.exec` → stdout JSON → 主进程解析 → `STATS:{id, stats}` 广播 → 渲染层

- [ ] `src/main/sysinfo.ts`：按会话轮询（默认 3s，可配置），会话关闭/断线自动停止；解析容错
- [ ] 契约：`shared/sysinfo.ts`（SysinfoSample + STATS 通道 + 面板开关事件）
- [ ] UI：SSH 会话右侧可折叠监控面板——CPU 多核条形、内存/磁盘用量条、网络上下行、负载/运行时间
- [ ] （增强路线）进程 Top 列表 + 结束进程
- 验收：连接后 ≤3s 看到实时 CPU/内存；断开会话监控自动停止；服务器跑 `stress` 曲线明显上升

## M4 — SFTP 文件管理 ✅

- [ ] `src/main/sftp.ts`：ssh2 SFTP 封装（readdir/stat/rename/mkdir/rm/mv，大文件分块传输 + 进度事件）
- [ ] 双栏界面（本地 ↔ 远程）+ 拖拽上传/下载 + 传输面板（队列/暂停/取消）
- [ ] 右键菜单：压缩/解压（tar.gz）、编辑远程文件（Monaco，下载-编辑-回传）
- 验收：100MB 文件传输进度流畅、可取消续传

## M5 — 命令系统与会话日志 ✅

- [ ] 命令历史（sqlite + better-sqlite3，按会话去重）
- [ ] 命令库（分组 + 参数变量 `{{param}}` + 一键运行/粘贴）
- [ ] 终端补全：历史 + 命令库 + 内置命令表（内置命令文档可从 tldr 页面生成）
- [ ] 会话日志：手动启停、纯文本落盘、断线暂停指示
- [x] ~~关键词高亮~~（✅ 已提前完成：highlightEngine 流式 ANSI 注入 + 11 条预设 + 设置页管理，见 M2.5）
- 验收：补全 ↑↓ 选择 / Tab 接受 / Esc 关闭 / 回车直接执行，交互流畅

## M6 — 多终端协同 ✅

- [x] 广播输入（broadcastStore）：选中 ≥2 个会话同步键入；标签广播标记 + 按钮计数徽标；目标 <2 自动关闭
- [x] 快捷输入面板（Quick Input）：右下角浮层 = 命令输入 + 自动执行(\r) + 快捷命令 + 最近命令；广播感知发送
- [x] ZMODEM（rz/sz）：主进程引擎（zmodem.js，仅 SSH 会话；本地 ConPTY 不支持二进制），文件选择/保存目录对话框 + 传输面板进度 + 看门狗超时；双向 e2e（tests/zmodem-e2e.mjs）
- [x] 快捷键系统：Ctrl+=/-/0 字号（持久化）、Ctrl+PgUp/PgDn 切换终端、全局唤起/隐藏（设置页可配 globalShowHide）
- 验收：3 个分屏同步执行命令 ✅（活体验证：终端 3 键入扇出到终端 4）；rz 传输 ✅（e2e 双向内容一致；真实服务器 rz/sz 待用户复测）

## M7 — 打包与分发 ✅

- [x] electron-builder：**MSI**（固定 upgradeCode，手动/企业部署）+ NSIS（x64），`npm run dist` / `dist:dir`
- [x] 原生模块：@lydell/node-pty 预编译 + asarUnpack（node-pty/ssh2），npmRebuild=false，win-unpacked 冒烟通过
- [x] 自动更新（electron-updater，generic feed = Gitea generic package 稳定地址，公网可读；仅 packaged 启用，OT_UPDATE_URL/OT_UPDATE_TOKEN 可覆盖）
- [x] 应用图标（build/icon.png）已补齐，MSI/NSIS 桌面与开始菜单快捷方式已启用
- [ ] 代码签名（可选，未做）

## M9 — 体验打磨 ✅

- [x] 系统托盘：托盘图标 + 右键菜单（显示窗口/关闭行为/退出）；关闭按钮行为可设「每次询问/最小化到托盘/直接退出」，询问对话框支持记住选择（settings.closeAction）
- [x] 单实例运行：requestSingleInstanceLock，二次启动唤出已有窗口（托盘隐藏也可恢复）
- [x] 主题联动标题栏：titleBarOverlay 自定义标题栏，颜色跟随终端主题实时刷新；窗口背景同色
- [x] 布局菜单重做：弃用 antd Dropdown 传送门（与 dockview 全局指针处理冲突导致闪退），改为侧栏内联弹出面板
- [x] 补全交互修正：回车不再接受建议（此前会把建议拼接到已输入内容后，如 kimi → kimikimi）；与已输入完全相同的建议自动过滤；新增「输入建议」设置开关
- [x] 标签页视觉打磨：圆角胶囊 + 描边 + 独立关闭按钮
- [x] 本地 PTY 声明终端能力（TERM/COLORTERM/TERM_PROGRAM），TUI 程序不再降级配色

## 工程约定（贯穿各阶段）

1. **契约先行**：新增功能先在 `src/shared/` 定义通道与模型，再实现两端
2. **原生依赖**：优先选带预编译二进制的包（@lydell/node-pty 模式），避免用户机器装构建链
3. **测试**：main 进程服务（pty/ssh/sftp）用 vitest 单测；渲染层交互靠 dev 手测
4. **里程碑验收后打 git tag**

## 已知待办（M1 遗留）

- [x] ~~布局塌陷~~（v0.2.1 修复：antd `<App>` 包裹层 `.ant-app` 无高度导致百分比高度链断裂）
- [x] ~~关闭标签页整窗崩溃~~（v0.2.1 修复：xterm IDisposable 对象被当函数调用；并新增 ErrorBoundary 兜底 + 渲染层报错转发主进程日志）
- [x] ~~首启动空屏~~（v0.2.1：启动自动打开一个终端）
- [ ] autoWrap=false 的固定列宽模式（xterm.js 无原生 wrapMode，需自定义列数控制）
- [ ] 终端标题跟随 OSC 序列（窗格标题显示当前目录/命令）
- [ ] 内置等宽字体打包（OFL 许可：JetBrains Mono / Fira Code 等）
- [ ] rendererMode webgl 的终端数量上限自动降级（大量终端实例时回退 DOM 渲染）
- [ ] 会话数据在面板间拖拽迁移（dockview 原生支持面板拖动，已具备）
- [ ] 界面语言切换（中/英）：需先把全应用文案抽为 i18n 资源目录（一次完整重构），设置页预留「系统」分区
