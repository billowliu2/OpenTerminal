# OpenTerminal 官网

OpenTerminal 的产品介绍站点，部署在 GitHub Pages。
纯静态 HTML + CSS + 原生 JS，**无构建步骤、无第三方依赖**，改完即可发布。
支持四语言：简体中文（源码基准）、繁体中文、English、日本語。

## 线上地址

- GitHub Pages: `https://billowliu2.github.io/OpenTerminal/`

## 目录结构

```
website/
├── index.html          # 单页站点：功能介绍 / 下载 / 更新日志（文案挂 data-i18n 键）
├── .nojekyll           # 让 GitHub Pages 原样托管（跳过 Jekyll 处理）
└── assets/
    ├── style.css       # 全部样式（深色默认 / 浅色可切换，主题令牌在 :root 与 html[data-theme='light']）
    ├── i18n.js         # 四语言文案字典 window.OPENTERMINAL_I18N
    ├── i18n-apply.js   # 语言层：选定语言 → 写 DOM / <html lang> / title / meta，并绑定语言切换控件
    ├── fonts/          # 自托管 woff2：Space Grotesk 400/500/600/700、JetBrains Mono 400/500/600
    ├── shot-terminal.jpg   # 主界面截图（三路分屏并行 AI 编程 Agent，含背景图个性化）
    ├── shot-agents.png     # 多路 AI Agent 分屏截图（无背景图版）
    ├── shot-sftp.png       # SFTP 文件面板：列头、排序、用户/组、字体缩放
    ├── shot-sftp-menu.png  # 文件列表空白处右键菜单
    ├── shot-themes.jpg     # 主题设置页截图（背景图/不透明度/压暗层）
    ├── shot-lock.png       # 锁屏界面截图
    └── icon.png            # 应用图标（来自仓库 build/icon.png）
```

## 语言层（i18n）

**单文件 + 语言层**，不是复制四份 HTML：HTML 只有一份（文案是简体中文原文，同时作为缺键时的兜底），
所有可翻译文本通过 data 属性挂键，`assets/i18n.js` 提供四语言字典，`assets/i18n-apply.js` 在运行时写入。

### 三种挂键方式

| 属性 | 行为 | 例子 |
| --- | --- | --- |
| `data-i18n="k"` | 写 `textContent`（纯文本） | `<h2 data-i18n="dl.title">下载</h2>` |
| `data-i18n-html="k"` | 写 `innerHTML`（需要内联标签时） | `<h1 data-i18n-html="hero.title">…<br /><span class="accent">同一个</span>…</h1>` |
| `data-i18n-attr="attr:k"` | 写属性，多组用 `;` 分隔 | `<img data-i18n-attr="alt:hero.shot.alt" />` |

`<title>` 和三个 meta 也走同一套机制（`<title data-i18n="meta.title">`、`<meta … data-i18n-attr="content:meta.description">`），
所以「HTML 里出现的键」和「字典里的键」可以一次性机器比对，不存在漏网的特殊分支。

### 键命名

扁平命名，与 HTML 结构对应：

- `meta.*`、`a11y.skip`、`brand.*`
- `nav.*`（含 `nav.themeToLight` / `nav.themeToDark`，由页尾脚本在主题切换时取用）
- `hero.*`、`spec.*`
- `features.*`、`cap.NN.title` / `cap.NN.li.N`（8 张能力卡）、`cap.hint`
- 四个 feature-row：`fw.*`（Workbench / AI Agent）、`fs.*`（SFTP）、`fc.*`（Customize）、`fl.*`（Security）
- `dl.*`（下载表格与自动更新说明）、`cl.*`（更新日志小节）、`changelog.<版本>.li.N`（每条更新一条键）
- `footer.*`

产品名 `OpenTerminal`、版本号、命令、URL、快捷键（`Ctrl+L` / `Ctrl+F`）、技术名词（SSH / SFTP / WebGL / xterm.js / ZMODEM / MIT…）一律不译。
各节拉丁 eyebrow（`Capabilities` / `Workbench` / `SFTP` / `Customize` / `Security` / `Download` / `Changelog`）是刻意的排版元素，四语言保持一致。

### 加一条文案

1. 在 `index.html` 的对应元素上加 `data-i18n="新键"`，元素里保留简体中文原文（作为兜底）
2. 在 `assets/i18n.js` 的**四个语言块里都加上同名键**——键集合必须完全一致
3. 跑下面的「改完必跑」三条命令

漏加某个语言的键不会显示空白：`i18n-apply.js` 会回落到简体中文。但键集合不一致会让「键一致性」检查失败，属于必须修的。

### 语言选择与首帧防闪

选定语言优先级（`index.html` 头部内联脚本与 `i18n-apply.js` 用的是同一套判定）：

1. URL 参数 `?lang=xx`（一次性，不写 localStorage，便于分享指定语言的链接）
2. `localStorage['openterminal.lang']`
3. `navigator.languages` 前缀匹配（`zh-TW`/`zh-HK`/`zh-MO` → 繁中，其余 `zh*` → 简中，`ja*` → 日文，`en*` → 英文）
4. 默认 `zh-CN`

**首帧不闪中文**：HTML 源码是简体中文，若等脚本跑完再翻译，非中文用户会先看到一帧中文。
所以头部内联脚本在设置 `document.documentElement.lang` 的同时，非 `zh-CN` 时给 `<html>` 挂上 `data-i18n-pending`，
`style.css` 末尾的 `html[data-i18n-pending] body { visibility: hidden }` 把 body 先藏住；
页尾的 `i18n-apply.js` 应用完文案后立刻摘掉该属性（`finally` 里摘，异常也不会把页面藏死）。
另有一条 2.5s 兜底定时器（头部脚本里），保证脚本加载失败时页面最终一定可见。

导航栏 `.nav-right` 里的 `<select class="lang-select" id="lang-select">`（在主题按钮左侧）负责切换：
换语言 → 写 `localStorage` → 重写全部文案与 `<html lang>` → 派发 `openterminal:langchange` 事件，
页尾脚本收到事件后重刷主题按钮的 `aria-label` / `title`。全程不刷新页面。

## 发新版本时需要更新的地方

版本号与链接都是**硬编码在 `index.html`**（版本号本身不翻译，不进字典），需要改的地方：

1. `index.html` 中搜索旧版本号，替换为 `v<新版本>` / `<新版本>`：
   - hero 主按钮 `id="dl-exe"` 的直链（1 处）
   - hero-note 里的 `<span class="mono">`（1 处）
   - `spec-strip` 里的 `<strong class="mono">`（1 处）
   - 下载表格的 exe 文件名单元格与「下载」链接（2 处）
2. 下载表格里的文件大小（`.mono` 单元格，如 `109 MB`）
3. 「近期更新」小节：新增一条 `<article>`（最新的在最前面，结构保持
   `<h3><span class="mono">版本</span><span class="rel-date">日期</span></h3>` + `<ul><li>`），
   并删掉最旧的一条以控制长度（当前保留最近 5 条：1.0.25 / 1.0.24 / 1.0.23 / 1.0.22 / 1.0.21）
4. `assets/i18n.js`：给新版本加 `changelog.<新版本>.li.N` 键（**四个语言块都要加**），
   并删掉被移除那条的 `changelog.<旧版本>.li.*` 键（同样是四个语言块）

自 v1.0.22 起不再提供 MSI，只有 NSIS exe 一条直链：

```
https://github.com/billowliu2/OpenTerminal/releases/download/v<版本>/OpenTerminal-<版本>-setup.exe
```

注意：发布新版本时需同时把安装包资产上传到 GitHub release
（`HTTPS_PROXY=http://127.0.0.1:7897 node scripts/release.cjs <版本> --skip-gitea`），
否则直链 404。

### 改完必跑

```bash
# 1) 语法（在仓库根执行）
node --check website/assets/i18n.js
node --check website/assets/i18n-apply.js

# 2) 四语言键集合一致性（缺失 / 多余 / 同一语言内重复键）
node -e '
const fs=require("fs"); global.window={};
require("./website/assets/i18n.js");
const D=window.OPENTERMINAL_I18N, langs=Object.keys(D), base=new Set(Object.keys(D[langs[0]]));
let bad=false;
for (const l of langs) console.log(l, Object.keys(D[l]).length);
for (const l of langs.slice(1)) {
  const s=new Set(Object.keys(D[l]));
  const miss=[...base].filter(k=>!s.has(k)), extra=[...s].filter(k=>!base.has(k));
  if (miss.length||extra.length) { bad=true; console.log(l, "missing:", miss, "extra:", extra); }
}
console.log("键集合一致:", !bad);'

# 3) index.html 引用的键在字典里都存在（防漏键显示空白）
node -e '
const fs=require("fs"); global.window={};
require("./website/assets/i18n.js");
const D=window.OPENTERMINAL_I18N, langs=Object.keys(D);
const html=fs.readFileSync("website/index.html","utf8");
const keys=new Set();
for (const m of html.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)) keys.add(m[1]);
for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g))
  m[1].split(";").forEach(p=>{const i=p.indexOf(":"); if(i>0) keys.add(p.slice(i+1).trim());});
["nav.themeToLight","nav.themeToDark"].forEach(k=>keys.add(k));
const dict=new Set(); langs.forEach(l=>Object.keys(D[l]).forEach(k=>dict.add(k)));
const missing=[...keys].filter(k=>!dict.has(k));
const unused=[...dict].filter(k=>!keys.has(k));
console.log("HTML 引用键:", keys.size, "字典键:", dict.size);
console.log("缺失:", missing.length?missing:"无", "| 未引用:", unused.length?unused:"无");'
```

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

然后访问 `http://localhost:8080`。直接双击 `index.html` 也可以（无跨域资源）；
想看指定语言加参数即可，例如 `index.html?lang=ja`。

## 设计约定

- **深色为主**：默认深色（`#0b0e12` 底 + 终端绿强调色），右上角按钮可切浅色；两套主题共用同一份令牌，新增样式一律走 CSS 变量，不要写死颜色
- 主题选择存 `localStorage['openterminal.theme']`，语言选择存 `localStorage['openterminal.lang']`，两者都在首帧前由 `index.html` 头部的内联脚本定好，避免闪白/闪黑与闪中文
- 新增样式**只追加在 `style.css` 末尾**，不重排已有规则；语言切换控件（`.lang-select`）复用既有令牌，不改 `.theme-toggle` 的规则
- 全站只用**一个强调色**：深底 `#3fb950`、浅底 `#1a7f37`（对比度 ≥ 4.5:1）
- 字体自托管（`assets/fonts/`），不依赖 Google Fonts：展示字体 Space Grotesk、等宽 JetBrains Mono；中文回落到系统栈
- 「核心能力」是横向滚动卡片轨道（箭头翻页 + 拖拽 + 键盘方向键），不再用三栏等高卡片
- 截图来自真实运行界面，与应用内设置一致；涉及 IP / 主机名等敏感信息的截图必须打码后再放入 `assets/`
- 文案保持具体、平实，避免营销套话；四语言都按各语言习惯写，不做逐字直译
