# OpenTerminal

开源的现代化终端应用：本地终端 + SSH 远程会话 + 分屏管理 + 主题/字体定制。Electron + React + TypeScript，从 0 到 1 独立开发。

## 快速开始

```bash
npm install        # 已安装可跳过
npm run dev        # 开发模式（热更新）
npm run build      # 生产构建到 out/
npm run typecheck  # 全量类型检查
```

> Electron 二进制下载失败时：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`

## 功能

**终端核心**
- 本地终端（node-pty，Windows PowerShell / macOS zsh / Linux bash 自动探测），自动声明 256 色与真彩能力
- xterm.js 渲染：WebGL 高性能模式，加载失败/上下文丢失自动降级 DOM
- 会话生命周期：退出遮罩显示退出码；窗口关闭时回收全部会话
- 搜索（Ctrl+F 内嵌搜索条、全部高亮、n/N 计数）
- 剪贴板（Ctrl+Shift+C/V、可选选中即复制）
- 粘贴风险确认（多行/长文本需手动确认，可关闭）
- 字体/字号/字重/字距/行高/回滚行数/光标样式实时生效
- 关键词高亮：11 条内置规则（权限、路径、错误状态、IP、URL 等），支持自定义正则规则

**SSH 远程会话**
- ssh2 实现：密码 / 私钥（文件路径或粘贴内容）/ SSH Agent 三种认证
- 连接管理器：左侧书签栏（分组手风琴）、双击连接、新建/编辑/删除对话框
- 凭据安全：密码/私钥/口令经 Electron safeStorage（DPAPI）加密后落盘，渲染层永远接触不到明文密钥；支持「连接时询问密码」模式
- 主机指纹校验（known hosts 固定）：首次连接确认、指纹变更红色告警、30s 无响应自动拒绝
- 服务器硬件监控：CPU / 内存 / 磁盘 / 网络实时面板（无需在服务器部署任何脚本）
- SFTP 文件管理：双栏浏览、拖拽传输、队列/进度/取消、权限与属主修改
- ZMODEM（rz/sz）文件传输
- 会话数据面与本地终端完全统一（写/缩放/关闭/退出事件同通道）

**分屏与布局**
- dockview 标签系统：水平/垂直分屏、拖拽重排、标签右键菜单
- 布局模板：把当前分屏保存为模板、一键应用（自动重建会话）、可删除
- Terminal / SSH 双工作区，互不混排

**效率工具**
- 广播输入：勾选 ≥2 个终端后同步键入，标签带广播标记
- 快捷输入面板：右下角浮层，命令历史 + 命令库（支持 `{{param}}` 变量）+ 一键执行
- 输入建议：历史 + 命令库来源，Tab 接受、回车始终直接执行（可在设置中整体关闭）
- 会话日志：手动启停、纯文本落盘
- 快捷键：Ctrl+=/-/0 字号、Ctrl+PgUp/PgDn 切换面板、全局唤起/隐藏（可配）

**外观与窗口**
- 12 款内置主题（Dracula / One Half / Solarized / Gruvbox / Nord / Monokai / GitHub 等）
- 自定义主题编辑器：16 色 ANSI 调色板 + 前景/背景/光标/选区色，实时预览
- 窗口标题栏与背景跟随终端主题
- 系统托盘：关闭按钮可设「每次询问 / 最小化到托盘 / 直接退出」，托盘菜单可切换
- 单实例运行：重复启动唤出已有窗口
- 设置持久化（userData/settings.json，原子写入）+ 多窗口实时同步

**测试**
- `node tests/ssh-loopback.mjs` — ssh2 客户端/服务端回环（认证、shell、数据、resize、指纹）
- `node tests/ssh-session-e2e.mjs` — 真实会话路由层端到端（需先跑 esbuild 打包命令，见脚本头注释）

## 架构

```
src/
├── shared/            # 主/渲染进程共享契约（IPC 通道、设置、主题模型）
│   ├── ipc.ts         #   通道名 + 负载类型
│   ├── api.ts         #   window.api 接口（preload 暴露面）
│   ├── settings.ts    #   AppSettings / 默认值
│   └── theme.ts       #   TerminalTheme / 内置主题
├── main/              # 主进程
│   ├── pty.ts         #   PTY 会话池（node-pty）→ 广播 PTY_DATA/PTY_EXIT
│   ├── settingsStore.ts # JSON 持久化 + 深合并兜底
│   ├── layouts.ts     #   布局模板存储（userData/layouts/*.json）
│   ├── tray.ts        #   系统托盘 + 关闭行为
│   └── ipc.ts         #   全部 ipcMain 注册
├── preload/index.ts   # contextBridge → window.api
└── renderer/src/
    ├── terminal/      # TerminalView：xterm 封装（渲染器/搜索/剪贴板/粘贴确认）
    ├── workspace/     # dockview 工作区：工具栏/分屏/会话生命周期/布局模板
    ├── settings/      # zustand store + 设置对话框
    └── theme/editor/  # 自定义主题编辑器
```

关键设计：**契约先行** —— `src/shared/` 是唯一契约源，主/预载/渲染三端各自实现，模块间零横向依赖（terminal 不感知 workspace，settings 不感知 terminal）。

## 数据位置

- 设置：`%APPDATA%/OpenTerminal/settings.json`
- 布局模板：`%APPDATA%/OpenTerminal/layouts/*.json`
- SSH 连接书签：`%APPDATA%/OpenTerminal/connections.json`（密钥字段 DPAPI 加密）
- 主机指纹：`%APPDATA%/OpenTerminal/ssh_known_hosts.json`

## License

[MIT](LICENSE)
