# OpenTerminal 开发备忘

Electron + electron-vite + React 终端工具（本地终端 / SSH / SFTP）。

## 常用命令

- 开发：`npm run dev`（主进程改动不热重建，需重启）
- 类型检查：`npx tsc --noEmit -p tsconfig.web.json`
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

1. `package.json` 版本号 +1，写 `RELEASE_NOTES.md`（仓库根，已 gitignore）
2. `npm run dist` 构建
3. `node scripts/release.cjs <版本号>`，例如 `node scripts/release.cjs 1.0.2`
   - 依次完成：Gitea release（含 msi/exe 资产）→ Gitea 更新通道（`api/packages/admin/generic/openterminal-update/stable`，更新 latest.yml/blockmap/exe）→ GitHub release
   - 可用 `--skip-github` / `--skip-gitea` 跳过某步
   - 访问 GitHub API 不通时，设 `HTTPS_PROXY=http://127.0.0.1:7897` 再走代理
4. 验证更新通道：`curl https://git.codingplan.site/api/packages/admin/generic/openterminal-update/stable/latest.yml` 应返回新版本号
5. `git tag v<版本号>` 并推送两个远程

## 主题机制

- 终端主题由 xterm 主题派生 UI 配色：`src/renderer/src/theme/chrome.ts` 的 `applyChromeTheme` 写入 `--chrome-bg/-bg-deep/-border/-hover` CSS 变量，antd token 在 `main.tsx` ThemedConfigProvider 派生
- 标签强调色：`settings.tabAccentColor`（默认 `#3fb950`），经 `--tab-accent` CSS 变量生效
