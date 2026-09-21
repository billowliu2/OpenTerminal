# OpenTerminal 官网

OpenTerminal 的产品介绍站点，部署在 GitHub Pages。
纯静态 HTML + CSS，**无构建步骤、无第三方依赖**，改完即可发布。

## 线上地址

- GitHub Pages: `https://billowliu2.github.io/OpenTerminal/`

## 目录结构

```
website/
├── index.html          # 单页站点：功能介绍 / 下载 / 更新日志
├── .nojekyll           # 让 GitHub Pages 原样托管（跳过 Jekyll 处理）
└── assets/
    ├── style.css       # 全部样式（企业风浅色主题，单一强调色）
    ├── shot-terminal.png   # 主界面截图（四路分屏）
    ├── shot-themes.png     # 主题设置页截图
    └── icon.png            # 应用图标（来自仓库 build/icon.png）
```

## 发新版本时需要更新的地方

`index.html` 中搜索 `1.0.15`，共 3 处下载链接（hero 主按钮、下载表格 exe、msi）。
下载链接格式（CodingPlan.Site 国内直连通道）：

```
https://git.codingplan.site/admin/OpenTerminal/releases/download/v<版本>/OpenTerminal-<版本>-setup.exe
https://git.codingplan.site/admin/OpenTerminal/releases/download/v<版本>/OpenTerminal-<版本>-setup.msi
```

同时更新「近期更新」小节（与 RELEASE_NOTES.md 内容保持一致）和下载表格里的文件大小。

## 部署方式

GitHub Actions 工作流 `.github/workflows/deploy-website.yml`：
push 到 `main` 且 `website/` 下有改动时，自动把 `website/` 目录发布到 GitHub Pages。
Gitea（git.codingplan.site）只同步代码，Pages 由 GitHub 侧托管。

首次部署需要在 GitHub 仓库设置里确认：Settings → Pages → Source 选择
"GitHub Actions"（工作流已声明 `pages: write` 与 `id-token: write` 权限）。

## 本地预览

无构建步骤，任选其一：

```bash
# Python
python -m http.server 8080 --directory website

# Node
npx serve website
```

然后访问 `http://localhost:8080`。直接双击 `index.html` 也可以（无跨域资源）。

## 设计约定

- 浅色企业风，避免营销站常见的霓虹/渐变装饰
- 强调色仅一个：`#1a7f37`（应用品牌绿 #3fb950 的深色化，保证浅底对比度 ≥ 4.5:1）
- 截图来自真实运行界面，与应用内设置一致
- 中文为主要语言；字体使用系统栈（Segoe UI / 微软雅黑），不加载外部字体
