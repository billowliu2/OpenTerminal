# 主题系统全面改造（A+B+C）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or swarm waves as mapped in §11. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 浅色主题下终端与全部 UI 文字达到 WCAG AA 可读、底色柔化、194 处硬编码颜色全量收敛进语义变量层并以 fail-closed 测试锁死。

**Architecture:** `ThemeColors`（L0）→ `theme/semantic.ts`（纯色数学 + 锚点色 + `isLightTheme`）→ `chrome.ts` 运行时派生 `--ot-*` L2 变量（深色分支锁现值）→ CSS/TSX 消费；终端画布侧由调色板重做 + 动态 `minimumContrastRatio`/`drawBoldTextInBrightColors` + antd 算法切换兜底。

**Tech Stack:** Electron 渲染层（React + antd v6 + xterm.js 6.1.0-beta.304 + WebGL addon）。无新依赖。

**规格文档:** `docs/superpowers/specs/2026-10-16-theme-overhaul-design.md`（含对抗性审查记录 §11）

## Global Constraints（每个任务隐含遵守）

- 深色主题视觉零回归：语义色深色分支 = 现值锚点，逐值锁定（微差容忍：`#9a9a9a/#6a6a6a → #8a8a8a` 一档收敛视为可接受，见 T3 规则）。
- 背景图三铁律不破：`#0d1117` 深底衬、透明背景 `#00000000`、图模式下 MCR=4.5 不变。
- 无新 npm 依赖；不改 IPC/settings 结构；`customThemes` 无迁移。
- `.ts` 直连导入的测试（semantic-theme / theme-contrast）要求被测模块**零 import**（Node 22.18+ 原生类型剥离；参照 `tests/terminal-cwd.mjs` 头注释）。`semantic.ts` 因此**不得 import 任何东西**（类型就地声明）。
- 每任务一提交，提交信息用仓库惯例（中文、`类型(范围): 描述`）。
- 行号会漂移：一律按内容定位，不得盲信本文行号。
- `--tab-accent`/`--chrome-*` 现有机制与变量不动。
- 改动若与 AGENTS.md「主题机制」「终端尺寸同步」描述冲突，以本计划为准并在 T6 同步更新 AGENTS.md。

---

### Task 1（T1）: 语义层基座 `semantic.ts` + `chrome.ts` 派生 + 表测试

**Files:**
- Create: `src/renderer/src/theme/semantic.ts`
- Create: `tests/semantic-theme.mjs`
- Modify: `src/renderer/src/theme/chrome.ts`（整体重构：助手函数移入 semantic.ts，新增 L2 变量写入）
- Modify: `package.json`（test 链追加 `&& node tests/semantic-theme.mjs`，加在 `node tests/refit-throttle.mjs` 之后）

**Interfaces（后续任务依赖）:**
- `isLightTheme(background: string): boolean`
- `mix(a, b, t): string | null`、`luminance(color): number | null`、`contrast(a, b): number`（chrome.ts 原有，移至 semantic.ts 并从那里导出）
- `semanticVars(colors, light): Record<string, string>`（chrome.ts 逐个 `setProperty`；键不含 `--ot-` 前缀，写入时加）
- `SEMANTIC`（锚点色常量表，CSS 静态兜底与 TSX 内联取色共用）

- [ ] **Step 1: 写失败测试 `tests/semantic-theme.mjs`**（完整文件）

```js
/**
 * semantic.ts self-test. 该模块必须零 import（Node 原生类型剥离直连 .ts，
 * 同 tests/terminal-cwd.mjs 的约束）。锁三件事：
 *  1) isLightTheme 边界（>0.5 亮度为浅）；
 *  2) 深色分支 = SEMANTIC 锚点原值（零回归锁定）；
 *  3) 浅色分支全部达标：正文/fg ≥4.5，语义基色 ≥3.0。
 * Run: node tests/semantic-theme.mjs  (must exit 0)
 */
import { isLightTheme, semanticVars, SEMANTIC } from '../src/renderer/src/theme/semantic.ts'

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}

console.log('isLightTheme:')
ok(isLightTheme('#ffffff') === true, '#ffffff is light')
ok(isLightTheme('#fafafa') === true, '#fafafa is light')
ok(isLightTheme('#fdf6e3') === true, '#fdf6e3 is light')
ok(isLightTheme('#1e1e1e') === false, '#1e1e1e is dark')
ok(isLightTheme('#282a36') === false, '#282a36 is dark')

console.log('dark branch locks anchors (zero regression):')
const dark = semanticVars({ background: '#1e1e1e', foreground: '#cccccc' }, false)
ok(dark['muted'] === SEMANTIC.muted, 'muted = anchor')
ok(dark['success'] === SEMANTIC.success, 'success = anchor')
ok(dark['danger'] === SEMANTIC.danger, 'danger = anchor')
ok(dark['warning'] === SEMANTIC.warning, 'warning = anchor')
ok(dark['info'] === SEMANTIC.info, 'info = anchor')
ok(dark['scrollbar'] === SEMANTIC.scrollbar, 'scrollbar = anchor')
ok(dark['shadow'] === SEMANTIC.shadow, 'shadow = anchor')
ok(dark['colorScheme'] === 'dark', 'colorScheme dark')

console.log('light branch meets ratios:')
for (const bg of ['#f6f8fa', '#fafafa', '#fdf6e3']) {
  const v = semanticVars({ background: bg, foreground: '#383a42' }, true)
  // 借 semantic.ts 的 mix 造不出对比度函数——这里用重新实现校验关键值
  const L = (h) => {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
      .map((s) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4))
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  }
  const cr = (a, b) => {
    const x = L(a), y = L(b)
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
  }
  for (const key of ['muted', 'textSecondary', 'successFg', 'dangerFg', 'warningFg', 'infoFg']) {
    ok(cr(v[key], bg) >= 4.5, `${bg} ${key} ${v[key]} >= 4.5 (${cr(v[key], bg).toFixed(2)})`)
  }
  for (const key of ['success', 'danger', 'warning', 'info']) {
    ok(cr(v[key], bg) >= 3, `${bg} ${key} ${v[key]} >= 3.0 (${cr(v[key], bg).toFixed(2)})`)
  }
  ok(v['colorScheme'] === 'light', `${bg} colorScheme light`)
}

if (failed > 0) {
  console.error(`${failed} check(s) failed`)
  process.exit(1)
}
console.log('semantic-theme: all ok')
```

- [ ] **Step 2: 跑测试确认失败**：`node tests/semantic-theme.mjs` → 期望 `ERR_MODULE_NOT_FOUND`（semantic.ts 不存在）。

- [ ] **Step 3: 写 `src/renderer/src/theme/semantic.ts`**（完整文件；**零 import**）

```ts
/**
 * Semantic color layer for app chrome. PURE module: no imports (it is loaded
 * directly by tests/semantic-theme.mjs via Node's native TS type stripping),
 * no DOM access. chrome.ts turns semanticVars() into --ot-* CSS variables on
 * <html> whenever the terminal theme changes.
 *
 * Dark-branch values are LOCKED to the historical literals (zero visual
 * regression); light-branch values are derived per-theme by darkening the
 * same anchors until the WCAG ratio is met.
 */

interface ThemeLike {
  background: string
  foreground: string
}

function parseHex(color: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** WCAG relative luminance (0=black, 1=white); null for non-hex input. */
export function luminance(color: string): number | null {
  const c = parseHex(color)
  if (!c) return null
  const lin = c.map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}

function toHex(v: number): string {
  return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
}

/** t=0 → a, t=1 → b */
export function mix(a: string, b: string, t: number): string | null {
  const ca = parseHex(a)
  const cb = parseHex(b)
  if (!ca || !cb) return null
  return `#${toHex(ca[0] + (cb[0] - ca[0]) * t)}${toHex(ca[1] + (cb[1] - ca[1]) * t)}${toHex(ca[2] + (cb[2] - ca[2]) * t)}`
}

/** WCAG contrast ratio; 21 when either side is not parseable hex. */
export function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  if (la === null || lb === null) return 21
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

export function isLightTheme(background: string): boolean {
  return (luminance(background) ?? 0) > 0.5
}

/** Darken `color` toward black in 0.05 steps until contrast vs `bg` >= ratio.
 *  Returns the input unchanged when it already passes (or never parses). */
export function darkenToRatio(color: string, bg: string, ratio: number): string {
  if (contrast(color, bg) >= ratio) return color
  let t = 0
  let cur = color
  while (t < 0.85) {
    t = Math.round((t + 0.05) * 100) / 100
    const next = mix(color, '#000000', t)
    if (!next) return color
    cur = next
    if (contrast(cur, bg) >= ratio) return cur
  }
  return cur
}

/** Historical dark-chrome literals. The dark branch MUST keep these values. */
export const SEMANTIC = {
  muted: '#8a8a8a',
  success: '#3fb950',
  danger: '#f85149',
  warning: '#d29922',
  info: '#58a6ff',
  surfaceRaised: 'rgba(24, 26, 31, 0.85)',
  hover: 'rgba(255, 255, 255, 0.08)',
  borderStrong: 'rgba(255, 255, 255, 0.16)',
  scrollbar: 'rgba(125, 145, 170, 0.5)',
  scrollbarActive: 'rgba(150, 172, 200, 0.7)',
  shadow: 'rgba(0, 0, 0, 0.45)',
  focusRing: 'rgba(59, 142, 234, 0.2)'
} as const

/** Values for --ot-* variables (keys without the prefix). */
export function semanticVars(colors: ThemeLike, light: boolean): Record<string, string> {
  const bg = colors.background
  const fg = colors.foreground
  if (!light) {
    return {
      text: fg,
      textSecondary: mix(bg, fg, 0.78) ?? fg,
      muted: SEMANTIC.muted,
      surface: mix(bg, fg, 0.05) ?? bg,
      surfaceRaised: SEMANTIC.surfaceRaised,
      hover: SEMANTIC.hover,
      border: mix(bg, fg, 0.16) ?? bg,
      borderStrong: SEMANTIC.borderStrong,
      success: SEMANTIC.success,
      successFg: SEMANTIC.success,
      danger: SEMANTIC.danger,
      dangerFg: SEMANTIC.danger,
      warning: SEMANTIC.warning,
      warningFg: SEMANTIC.warning,
      info: SEMANTIC.info,
      infoFg: SEMANTIC.info,
      scrollbar: SEMANTIC.scrollbar,
      scrollbarActive: SEMANTIC.scrollbarActive,
      shadow: SEMANTIC.shadow,
      focusRing: SEMANTIC.focusRing,
      colorScheme: 'dark'
    }
  }
  return {
    text: darkenToRatio(fg, bg, 7),
    textSecondary: darkenToRatio(mix(bg, fg, 0.75) ?? fg, bg, 4.5),
    muted: darkenToRatio(SEMANTIC.muted, bg, 4.5),
    surface: mix(bg, fg, 0.04) ?? bg,
    surfaceRaised: mix(bg, '#000000', 0.045) ?? bg,
    hover: 'rgba(0, 0, 0, 0.06)',
    border: mix(bg, '#000000', 0.14) ?? bg,
    borderStrong: 'rgba(0, 0, 0, 0.22)',
    success: darkenToRatio(SEMANTIC.success, bg, 3),
    successFg: darkenToRatio(SEMANTIC.success, bg, 4.5),
    danger: darkenToRatio(SEMANTIC.danger, bg, 3),
    dangerFg: darkenToRatio(SEMANTIC.danger, bg, 4.5),
    warning: darkenToRatio(SEMANTIC.warning, bg, 3),
    warningFg: darkenToRatio(SEMANTIC.warning, bg, 4.5),
    info: darkenToRatio(SEMANTIC.info, bg, 3),
    infoFg: darkenToRatio(SEMANTIC.info, bg, 4.5),
    scrollbar: 'rgba(0, 0, 0, 0.28)',
    scrollbarActive: 'rgba(0, 0, 0, 0.45)',
    shadow: 'rgba(0, 0, 0, 0.15)',
    focusRing: SEMANTIC.focusRing,
    colorScheme: 'light'
  }
}
```

- [ ] **Step 4: 跑测试确认通过**：`node tests/semantic-theme.mjs` → `semantic-theme: all ok`。

- [ ] **Step 5: 重构 `chrome.ts`**
  - 删除 chrome.ts 内的 `parseHex/luminance/toHex/mix/contrast` 本地实现与 `chromeIsLight` 模块级变量，改为：
    ```ts
    import { isLightTheme, luminance, mix, semanticVars, contrast } from './semantic'
    export { mix, luminance, contrast } from './semantic' // 兼容既有导入方（main.tsx 等），T2 会迁走
    ```
  - `applyChromeTheme` 末尾（`applyTabAccent(tabAccent)` 之前）追加：
    ```ts
    const light = isLightTheme(colors.background)
    const vars = semanticVars(colors, light)
    for (const [key, value] of Object.entries(vars)) {
      if (key === 'colorScheme') style.setProperty('color-scheme', value)
      else set(`--ot-${key}`, value)
    }
    ```
  - `applyTabAccent` 里原 `chromeIsLight` 判断改用 `isLightTheme` 需要背景色——改为在 `applyChromeTheme` 里把 `light` 存进模块级 `let chromeIsLight`（保留原变量名，只是赋值来源换成 `isLightTheme(colors.background)`），`applyTabAccent` 逻辑不变。
  - `tabLabel` 助手保留（仍用 contrast）。

- [ ] **Step 6: 接入测试链**：`package.json` 的 `"test"` 值末尾（`node tests/refit-throttle.mjs` 之后）追加 ` && node tests/semantic-theme.mjs`。

- [ ] **Step 7: 验证**：`npm run typecheck` 通过；`node tests/semantic-theme.mjs` 通过。

- [ ] **Step 8: 提交**

```bash
git add src/renderer/src/theme/semantic.ts src/renderer/src/theme/chrome.ts tests/semantic-theme.mjs package.json
git commit -m "feat(theme): 语义变量层基座 --ot-*（深色锁现值/浅色按 WCAG 派生）+ 表测试"
```

---

### Task 2（T2）: M0 终端画布——调色板重做 + xterm 动态开关 + antd 算法

**Files:**
- Modify: `src/shared/theme.ts`（三套浅色主题调色板整体替换 + github-light 底色柔化）
- Modify: `src/renderer/src/terminal/TerminalView.tsx`（构造与热更两处选项）
- Modify: `src/renderer/src/main.tsx`（算法切换 + 兜底双色）
- Modify: `src/renderer/src/ErrorBoundary.tsx`（2 处内联色）
- Create: `tests/theme-contrast.mjs`
- Modify: `package.json`（test 链追加 `&& node tests/theme-contrast.mjs`）

**Interfaces:** 消费 T1 的 `isLightTheme`（`@renderer/theme/semantic`）。

- [ ] **Step 1: 写失败测试 `tests/theme-contrast.mjs`**（完整文件）

```js
/**
 * Builtin theme palette contrast gate. Light themes: foreground + all 16 ANSI
 * colors must reach 4.5:1 against the theme background (WCAG AA body text);
 * cursor must reach 3:1. Dark themes: only the foreground sanity check (>=4.5)
 * — dark palettes are locked aesthetics, not regression targets here.
 * Imports ../src/shared/theme.ts directly (zero-import module, Node >= 22.18).
 * Run: node tests/theme-contrast.mjs  (must exit 0)
 */
import { BUILTIN_THEMES } from '../src/shared/theme.ts'

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}
const L = (h) => {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((s) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
const cr = (a, b) => {
  const x = L(a), y = L(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
  'brightMagenta', 'brightCyan', 'brightWhite']
const isLight = (bg) => L(bg) > 0.5

for (const t of BUILTIN_THEMES) {
  const c = t.colors
  const light = isLight(c.background)
  console.log(`${t.id} (${light ? 'light' : 'dark'}, bg ${c.background}):`)
  ok(cr(c.foreground, c.background) >= 4.5, `foreground ${c.foreground} ${cr(c.foreground, c.background).toFixed(2)}`)
  ok(cr(c.cursor, c.background) >= 3, `cursor ${c.cursor} ${cr(c.cursor, c.background).toFixed(2)}`)
  if (!light) continue
  for (const k of ANSI) {
    ok(cr(c[k], c.background) >= 4.5, `${k} ${c[k]} ${cr(c[k], c.background).toFixed(2)}`)
  }
}

if (failed > 0) {
  console.error(`${failed} check(s) failed`)
  process.exit(1)
}
console.log('theme-contrast: all ok')
```

- [ ] **Step 2: 跑测试确认失败**：`node tests/theme-contrast.mjs` → 期望多条 FAIL（现三套浅色主题大量 <4.5）。

- [ ] **Step 3: 替换 `src/shared/theme.ts` 三套浅色主题**（算法生成：`mix(原值,#000,t)` 步进 0.05 至 ≥4.5，色相保留；`white/brightWhite` 同规则自动落到中灰）。**整体替换 `colors` 对象**，未列字段不变：

github-light（`background` 柔化 + `cursorAccent` 跟随）：
```
background: '#f6f8fa', foreground: '#4d4d4c', cursor: '#4d4d4c', cursorAccent: '#f6f8fa',
selectionBackground: '#dcdcdc',
black: '#3e3e3e', red: '#c91b00', green: '#007e00', yellow: '#777600',
blue: '#0225c7', magenta: '#bf2ebd', cyan: '#007677', white: '#6d6d6d',
brightBlack: '#676767', brightRed: '#b34c48', brightGreen: '#307d34', brightYellow: '#737331',
brightBlue: '#5860d9', brightMagenta: '#a64da6', brightCyan: '#2b7273', brightWhite: '#666666'
```
one-half-light（background/cursor/cursorAccent/selectionBackground 不变）：
```
black: '#383a42', red: '#c2493e', green: '#40813f', yellow: '#9a6a01',
blue: '#0177a9', magenta: '#a626a4', cyan: '#07798f', white: '#717171',
brightBlack: '#4f525e', brightRed: '#b3565e', brightGreen: '#5b7549', brightYellow: '#7e6a44',
brightBlue: '#3f729b', brightMagenta: '#955aa6', brightCyan: '#38767e', brightWhite: '#737373'
```
solarized-light（background/cursor/cursorAccent/selectionBackground 不变；**foreground `#657b83` → `#586e75`**——原 fg 对奶油底仅 4.13:1 不过 AA，`#586e75` 是 Solarized base01（与 cursor 同色），对底 4.99:1）：
```
black: '#073642', red: '#d1302d', green: '#647300', yellow: '#886700',
blue: '#2076b3', magenta: '#c8337c', cyan: '#207972', white: '#6b6860',
brightBlack: '#677171', brightRed: '#c14715', brightGreen: '#586e75', brightYellow: '#5b6f76',
brightBlue: '#626f71', brightMagenta: '#6166b0', brightCyan: '#677171', brightWhite: '#726f66'
```

- [ ] **Step 4: 跑测试确认通过**：`node tests/theme-contrast.mjs` → all ok。

- [ ] **Step 5: `TerminalView.tsx` 两处动态选项**
  顶部导入：`import { isLightTheme } from '@renderer/theme/semantic'`。
  构造 effect（约 :855-873，`theme: withChromeColors(...)` 一带）改为：
  ```ts
  const themeColors = getThemeById(themeOpts.themeId, themeOpts.customThemes).colors
  const lightTheme = isLightTheme(themeColors.background)
  ```
  （`theme:` 行改用 `themeColors as ITheme`）同对象内：
  ```ts
  drawBoldTextInBrightColors: !lightTheme,
  // 背景图模式保持 4.5（铁律）；无图时浅色主题开 4.5 兜底应用输出的低对比色，
  // 深色维持 1（现状）。拼写必须是 minimumContrastRatio（minContrastRatio 会被静默忽略）。
  minimumContrastRatio: bgOpts.image || lightTheme ? 4.5 : 1,
  ```
  热更 effect（约 :1261-1269）改为：
  ```ts
  const colors = getThemeById(themeOpts.themeId, themeOpts.customThemes).colors
  const lightTheme = isLightTheme(colors.background)
  term.options.theme = withChromeColors(colors as ITheme, bgOpts.image !== '')
  term.options.drawBoldTextInBrightColors = !lightTheme
  term.options.minimumContrastRatio = bgOpts.image || lightTheme ? 4.5 : 1
  ```

- [ ] **Step 6: `main.tsx` ThemedConfigProvider**
  导入改为 `import { isLightTheme, mix } from '@renderer/theme/semantic'`（先确认现 `mix` 的导入源并迁移；若 chrome.ts 的兼容 re-export 仍被别处使用则保留）。函数体：
  ```tsx
  const colors = getThemeById(themeId, customThemes).colors
  const light = isLightTheme(colors.background)
  ```
  ConfigProvider theme 对象内：
  ```tsx
  algorithm: light ? antdTheme.defaultAlgorithm : antdTheme.darkAlgorithm, // antd 无 lightAlgorithm，浅色即默认算法
  colorBgContainer: mix(colors.background, colors.foreground, 0.06) ?? (light ? '#f5f5f5' : '#1f1f1f'),
  colorBgElevated: mix(colors.background, colors.foreground, 0.1) ?? (light ? '#f5f5f5' : '#252525'),
  ```

- [ ] **Step 7: `ErrorBoundary.tsx`** 两处内联色：`color: '#cccccc'` → `'var(--ot-text, #cccccc)'`；`color: '#ff6b6b'` → `'var(--ot-danger-fg, #ff6b6b)'`。

- [ ] **Step 8: 接链 + 验证**：`package.json` test 链末尾追加 ` && node tests/theme-contrast.mjs`；`npm run typecheck` + `node tests/theme-contrast.mjs` + `node tests/semantic-theme.mjs` 全过。

- [ ] **Step 9: 提交**

```bash
git add src/shared/theme.ts src/renderer/src/terminal/TerminalView.tsx src/renderer/src/main.tsx src/renderer/src/ErrorBoundary.tsx tests/theme-contrast.mjs package.json
git commit -m "fix(theme): 浅色主题 ANSI 调色板重做到 WCAG AA + MCR/bold 动态开关 + antd 算法随亮度切换；github-light 底色柔化 #f6f8fa"
```

---

### Task 3（T3）: global.css + terminal.css 清扫

**Files:**
- Modify: `src/renderer/src/global.css`
- Modify: `src/renderer/src/terminal/terminal.css`

**Interfaces:** 消费 T1 变量（`var(--ot-*, 兜底)`，兜底一律用 T1 的 SEMANTIC 暗色锚点原值）。

**判定表（遇具体行按此选目标变量）：**

| 声明 | 目标 |
|------|------|
| `color:` 中性灰（#8a8a8a/#9a9a9a/#6a6a6a/#cccccc/#d0d0d0/rgba(255,255,255,x) 文本） | 弱化文本 `--ot-text-muted`；正文级 `--ot-text`；次要 `--ot-text-secondary`（按语境三选一，语境不明用 muted） |
| `color:` 语义色 | `--ot-success-fg` / `--ot-danger-fg` / `--ot-warning-fg` / `--ot-info-fg` |
| `color:#ffffff/#fff`（在深色底上，底也被本表替换时） | `--ot-text` |
| `background:` 白色半透明 .04–.1 | `--ot-hover` |
| `background:` 白色半透明 .16–.2 | `--ot-surface-raised` |
| `background:` 深色实底/深色半透明面板 | `--ot-surface-raised` |
| `border(-x/-y/-bottom/-top):` 半透明白/黑 | `--ot-border`；强调边框 `--ot-border-strong` |
| `box-shadow` 里的 `rgba(0,0,0,.4+)` | `--ot-shadow` |
| 滚动条色（scrollbar-color/thumb 背景） | `--ot-scrollbar` / active 态 `--ot-scrollbar-active` |
| 选区/焦点蓝 `rgba(59,142,234,x)` / `#3b8eea` | `--ot-focus-ring` |
| dockview sash `--dv-sash-color` | `--ot-border`；`--dv-active-sash-color` → `--ot-info` |

**铁律例外（terminal.css，保持硬编码）：** `:34` 的 `#0d1117`（`.has-bg-image .terminal-view-dock` 深底衬，AGENTS.md 铁律①）；`:390` 的 `#000`（`.term-bg-dim` 背景图压暗层，铁律③）；`:409-410` 的 `rgba(0,0,0,0.55)` + `#fff`（`.term-dead-mask` 死终端遮罩——有意为之的深色 scrim，浅色主题下同样成立）；所有 `#00000000` 透明色。

- [ ] **Step 1: global.css**
  `:root` 块（:3-15）现有 `--chrome-*` 静态兜底**保留不动**，其后追加（暗色默认， chrome.ts 启动后覆盖）：
  ```css
    --ot-text: #cccccc;
    --ot-text-secondary: rgba(204, 204, 204, 0.78);
    --ot-text-muted: #8a8a8a;
    --ot-surface: rgba(204, 204, 204, 0.05);
    --ot-surface-raised: rgba(24, 26, 31, 0.85);
    --ot-hover: rgba(255, 255, 255, 0.08);
    --ot-border: rgba(255, 255, 255, 0.16);
    --ot-border-strong: rgba(255, 255, 255, 0.16);
    --ot-success: #3fb950;
    --ot-success-fg: #3fb950;
    --ot-danger: #f85149;
    --ot-danger-fg: #f85149;
    --ot-warning: #d29922;
    --ot-warning-fg: #d29922;
    --ot-info: #58a6ff;
    --ot-info-fg: #58a6ff;
    --ot-scrollbar: rgba(125, 145, 170, 0.5);
    --ot-scrollbar-active: rgba(150, 172, 200, 0.7);
    --ot-shadow: rgba(0, 0, 0, 0.45);
    --ot-focus-ring: rgba(59, 142, 234, 0.2);
    color-scheme: dark;
  ```
  `:35/:48` 滚动条 → `var(--ot-scrollbar, rgba(125, 145, 170, 0.5))`；`:56` → `var(--ot-scrollbar-active, rgba(150, 172, 200, 0.7))`；`:137 #ff6b6b` → `var(--ot-danger-fg, #f85149)`。

- [ ] **Step 2: terminal.css 逐行替换**（除铁律例外外 0 硬编码残留）：
  `:43/:55` 滚动条、`:63` active、`:150 rgba(0,0,0,.4)` → `--ot-shadow`、`:213` 深色面板底 → `--ot-surface-raised`、`:237 #8a8a8a` → `--ot-text-muted`、`:243 #ffffff` + `:244` 白色半透明 → `--ot-text` + `--ot-hover`、`:281` → `--ot-shadow`、`:311 rgba(59,142,234,.18)` → `--ot-focus-ring`、`:312 #ffffff` → `--ot-text`、`:330 #9a9a9a` → `--ot-text-muted`、`:331` → `--ot-hover`、`:337` → `--ot-text-muted`、`:419`（`.term-dead-btn` 的 `#fff`，底是 `--chrome-accent`）→ `var(--tab-accent-fg, #fff)`；`:409/:410` 见上方铁律例外保留。
  注意：**只改颜色声明值，不动选择器/布局/盒模型**；替换后逐条目检上下文确保语义正确（尤其 :409-419 一带）。

- [ ] **Step 3: 验证**：`npm run typecheck`；对两文件跑残留扫描（见 §10 命令）应为 0（铁律例外除外）；`node tests/semantic-theme.mjs` 仍过。

- [ ] **Step 4: 提交**

```bash
git add src/renderer/src/global.css src/renderer/src/terminal/terminal.css
git commit -m "refactor(theme): global/terminal 硬编码颜色收敛进 --ot-* 语义变量（含滚动条/阴影/浮层）"
```

---

### Task 4（T4）: workspace.css + connections.css + commands.css 清扫

**Files:**
- Modify: `src/renderer/src/workspace/workspace.css`（22 处）
- Modify: `src/renderer/src/connections/connections.css`（26 处）
- Modify: `src/renderer/src/commands/commands.css`（8 处）

**Interfaces:** 同 T3 判定表与兜底规则。

- [ ] **Step 1: workspace.css**（22 处，逐行）：
  `:82 #1f1f1f` 实底 → `var(--ot-surface-raised, rgba(24, 26, 31, 0.85))`（若该选择器是弹层/工具条；读上下文，若是静态面板底改用 `--ot-surface`）；`:85` → `--ot-shadow`；`:96 rgba(255,255,255,.85)` 文本 → `--ot-text`；`:105 #ffffff` → `--ot-text`；`:180 --dv-sash-color` → `var(--ot-border, rgba(148, 163, 184, 0.28))`；`:181 --dv-active-sash-color` → `var(--ot-info, rgba(59, 142, 234, 0.75))`；`:279/:342/:556/:562/:661/:669/:725/:739 #8a8a8a` → `--ot-text-muted`；`:285 #6a6a6a` → `--ot-text-muted`；`:347 #ffffff` → `--ot-text`；`:348` 白色半透明 .1 → `--ot-hover`；`:705 #ff4d4f` → `--ot-danger-fg`；`:750 #4cc38a` → `--ot-success-fg`；`:751 rgba(76,195,138,.14)` → `color-mix(in srgb, var(--ot-success, #3fb950) 14%, transparent)`；`:754 #6aa9ff` → `--ot-info-fg`；`:755 rgba(106,169,255,.14)` → `color-mix(in srgb, var(--ot-info, #58a6ff) 14%, transparent)`。

- [ ] **Step 2: connections.css**（26 处，逐行）：
  所有 `#8a8a8a`(7 处)/`#9a9a9a`(3 处)/`#6a6a6a`(2 处) → `--ot-text-muted`；`:74/:147/:303/:374 rgba(255,255,255,.08)` 背景 → `--ot-hover`；`:81 rgba(255,255,255,.05)` 边框 → `--ot-border`；`:189` 边框 → `--ot-border`；`:166 #ffffff` + `:167` 白色半透明 .1 → `--ot-text` + `--ot-hover`；`:266 #ffffff` → `--ot-text`；`:196 rgba(255,255,255,.55)`、`:210 rgba(255,255,255,.88)`、`:215 rgba(255,255,255,.45)` ——**先读上下文**：若文本在语义色徽章/强调底上 → 对应 `--ot-*-fg`；普通底上 → `--ot-text-secondary`/`--ot-text-muted`；`:248/:64/:131 #cf6679` → `--ot-danger-fg`；`:335 rgba(121,121,121,.45)` 滚动条/滑块底 → `--ot-scrollbar`。

- [ ] **Step 3: commands.css**（8 处）：`#8a8a8a`(5 处) → `--ot-text-muted`；`#9a9a9a` → `--ot-text-muted`；`#cf6679`(2 处，含 `!important`) → `var(--ot-danger-fg, #cf6679) !important`（保留 !important）；`#f85149` → `--ot-danger-fg`。

- [ ] **Step 4: 验证**：typecheck + 残留扫描 0 + 语义测试过。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/src/workspace/workspace.css src/renderer/src/connections/connections.css src/renderer/src/commands/commands.css
git commit -m "refactor(theme): 工作区/连接侧栏/命令面板颜色语义变量化（徽章文本按 -fg 分流）"
```

---

### Task 5（T5）: sftp.css + monitor.css + MonitorPanel.tsx + settings.css + highlight.css + lock.css 清扫

**Files:**
- Modify: `src/renderer/src/sftp/sftp.css`（18 处）
- Modify: `src/renderer/src/monitor/monitor.css`（15 处）
- Modify: `src/renderer/src/monitor/MonitorPanel.tsx`（7 处内联）
- Modify: `src/renderer/src/settings/settings.css`（11 处）
- Modify: `src/renderer/src/settings/highlight.css`（6 处）
- Modify: `src/renderer/src/lock/lock.css`（2 处）

**Interfaces:** 同 T3 判定表；MonitorPanel 内联色从 `@renderer/theme/semantic` 导入 `SEMANTIC`。

**sftp 铁律（AGENTS.md）：** 不动 grid 模板/`--sftp-row-h` 系变量/`box-sizing: border-box`/`.ant-dropdown-trigger` 相关选择器——只改颜色值。

- [ ] **Step 1: sftp.css**（18 处）：`#8a8a8a`(10 处)/`#9a9a9a`/`#6a6a6a` → `--ot-text-muted`；`#e3b341` → `--ot-warning-fg`；`#3fb950`(2 处) → `--ot-success-fg`；`#f85149`(4 处) → `--ot-danger-fg`；`:155 rgba(59,142,234,.18)` → `--ot-focus-ring`；`:342` → `--ot-shadow`。

- [ ] **Step 2: monitor.css**（15 处）：`#8a8a8a`(9 处) → `--ot-text-muted`；`:22/:25 #f85149` → `--ot-danger-fg`；`:24 rgba(248,81,73,.12)` → `color-mix(in srgb, var(--ot-danger, #f85149) 12%, transparent)`；`:89 #3fb950` → `--ot-success-fg`；`:144 #d29922` → `--ot-warning-fg`；`:234 #58a6ff` → `--ot-info-fg`；`:238 #f0a55a` → `--ot-warning-fg`。

- [ ] **Step 3: MonitorPanel.tsx**（7 处内联；HistoryChart 是 **canvas 绘制**——`ctx.strokeStyle/fillStyle` 赋值不解析 CSS 变量串，必须传实色）：
  ```tsx
  import { useResolvedTheme } from '@renderer/settings/store'
  import { isLightTheme, semanticVars } from '@renderer/theme/semantic'
  ```
  组件内：
  ```tsx
  const theme = useResolvedTheme()
  const vars = semanticVars(theme.colors, isLightTheme(theme.colors.background))
  // #rrggbb + alpha → 'rgba(r, g, b, a)'（canvas 需要实色）
  const withAlpha = (hex: string, a: number) =>
    `rgba(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')}, ${a})`
  ```
  替换：usage 档位函数（约 :110-112）返回值 → `vars.dangerFg`/`vars.warningFg`/`vars.successFg`（**该函数若在组件外，移入组件或改为接收 vars 参数**）；`:237` `lineColor={vars.successFg} fillColor={withAlpha(vars.success, 0.15)}`；`:249` `color={vars.warningFg}`；`:298` `lineColor={vars.infoFg} fillColor={withAlpha(vars.info, 0.15)}`；`:299` `lineColor={vars.warningFg} fillColor={withAlpha(vars.warning, 0.15)}`。
  效果：图表色随主题明暗自动达标（浅色吃加深变体），文件内不再有颜色字面量、无需白名单。

- [ ] **Step 4: settings.css**（11 处）：`:203/:208 #fff` → 读上下文：强调底按钮上的文字 → `var(--tab-accent-fg, #fff)`，否则 `--ot-text`；`:302/:303 #3b8eea` → `--ot-focus-ring`（保留 inset box-shadow 结构）；`:336 rgba(59,142,234,.2)` → `--ot-focus-ring`；`:513 #3fd06a` → `--ot-success-fg`；`:517/:603 #f85149` → `--ot-danger-fg`；`:599 #3fb950` → `--ot-success-fg`；`:630 #d29922` → `--ot-warning-fg`；`:49` 注释里的 `#ffffff` 不动（T6 扫描器剥注释）。

- [ ] **Step 5: highlight.css**（6 处）：`#f85149`(4 处 color) → `--ot-danger-fg`；`:296/:301 border-color #f85149` → `--ot-danger`（描边用基色）；`:302 rgba(248,81,73,.2)` → `color-mix(in srgb, var(--ot-danger, #f85149) 20%, transparent)`。

- [ ] **Step 6: lock.css**（2 处）：`:40` → `--ot-shadow`；`:73 #f85149` → `--ot-danger-fg`。锁屏遮罩底色如为深色实底（读 lock.css 全文确认）**保持不动**（安全优先：锁屏必须不透明遮罩，z-index 4000 语义不变）。

- [ ] **Step 7: 验证**：typecheck + 残留扫描（白名单：MonitorPanel.tsx 若走锚点路线的两行 fillColor）+ 语义测试。

- [ ] **Step 8: 提交**

```bash
git add src/renderer/src/sftp/sftp.css src/renderer/src/monitor/monitor.css src/renderer/src/monitor/MonitorPanel.tsx src/renderer/src/settings/settings.css src/renderer/src/settings/highlight.css src/renderer/src/lock/lock.css
git commit -m "refactor(theme): SFTP/监控/设置/高亮/锁屏面板颜色语义变量化；MonitorPanel 图表色接 SEMANTIC 锚点"
```

---

### Task 6（T6）: fail-closed 防护测试 + 基线清零 + 文档同步

**Files:**
- Create: `tests/css-theme-vars.mjs`
- Modify: `package.json`（test 链追加 `&& node tests/css-theme-vars.mjs`）
- Modify: `AGENTS.md`（「主题机制」章节增补）
- Modify: `docs/STATE.md`（追加条目）

**Interfaces:** 无新接口；消费 T1-T5 的最终状态。

- [ ] **Step 1: 写 `tests/css-theme-vars.mjs`**（完整文件；先跑一次看当前残留并按实况填 `WHITELIST`，基线必须为「白名单外 0」）

```js
/**
 * Fail-closed guard: no raw color literals in renderer source outside the
 * whitelist. Scans .css/.tsx/.ts under src/renderer/src. Strips comments
 * first (terminal.css:16 etc. live in comments), ignores var() fallback
 * bodies except for the controlled-fallback check. Run: node tests/css-theme-vars.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve('src/renderer/src')
/** exact relative path -> Set of allowed lowercase literals ('#fff', 'rgba(0, 0, 0, 0.45)') */
const WHITELIST = {
  'theme/semantic.ts': null, // null = whole file exempt (it defines the anchors)
  'theme/chrome.ts': new Set(['#000000', '#ffffff']),
  'theme/editor/ThemeEditor.tsx': null, // theme data (DEFAULT_DARK seed)
  'settings/HighlightTab.tsx': null, // preset rule swatches = data
  'terminal/highlightEngine.ts': null, // rule engine data/docstring
  'terminal/TerminalView.tsx': new Set(['#3b8eea', '#2d2d2d', '#c77800', '#00000000']),
  'global.css': new Set(['#181818', '#cccccc', '#2d2d2d', '#3b8eea', '#2a2a2a', '#101418',
    '#98a2ab', '#d0d0d0', 'rgba(255, 255, 255, 0.04)', 'rgba(255, 255, 255, 0.07)',
    'rgba(255, 255, 255, 0.1)', 'rgba(255, 255, 255, 0.2)', '#8a8a8a', '#3fb950', '#f85149',
    '#d29922', '#58a6ff', 'rgba(125, 145, 170, 0.5)', 'rgba(150, 172, 200, 0.7)',
    'rgba(24, 26, 31, 0.85)', 'rgba(255, 255, 255, 0.16)', 'rgba(255, 255, 255, 0.08)',
    'rgba(204, 204, 204, 0.78)', 'rgba(204, 204, 204, 0.05)', 'rgba(0, 0, 0, 0.45)',
    'rgba(59, 142, 234, 0.2)']),
  'terminal/terminal.css': new Set(['#0d1117', '#00000000', '#000', '#fff', 'rgba(0, 0, 0, 0.55)'])
}
const FALLBACK_OK = new Set([
  '#cccccc', '#8a8a8a', '#9a9a9a', '#6a6a6a', '#d0d0d0', '#ffffff', '#fff', '#000', '#000000',
  '#3fb950', '#f85149', '#cf6679', '#ff6b6b', '#ff4d4f', '#d29922', '#e3b341', '#f0a55a',
  '#f2cc60', '#4cc38a', '#6aa9ff', '#3fd06a', '#58a6ff', '#3b8eea', '#1f1f1f', '#0d1117',
  '#f5f5f5', '#252525', '#2d2d2d', '#181818', '#101418',
  'rgba(255, 255, 255, 0.04)', 'rgba(255, 255, 255, 0.05)', 'rgba(255, 255, 255, 0.07)',
  'rgba(255, 255, 255, 0.08)', 'rgba(255, 255, 255, 0.1)', 'rgba(255, 255, 255, 0.16)',
  'rgba(255, 255, 255, 0.2)', 'rgba(0, 0, 0, 0.06)', 'rgba(0, 0, 0, 0.14)',
  'rgba(0, 0, 0, 0.22)', 'rgba(0, 0, 0, 0.28)', 'rgba(0, 0, 0, 0.45)',
  'rgba(24, 26, 31, 0.85)', 'rgba(125, 145, 170, 0.5)', 'rgba(150, 172, 200, 0.7)',
  'rgba(59, 142, 234, 0.18)', 'rgba(59, 142, 234, 0.2)', 'rgba(59, 142, 234, 0.75)',
  'rgba(148, 163, 184, 0.28)', 'rgba(121, 121, 121, 0.45)', 'rgba(248, 81, 73, 0.12)',
  'rgba(248, 81, 73, 0.2)', 'rgba(76, 195, 138, 0.14)', 'rgba(106, 169, 255, 0.14)',
  'rgba(204, 204, 204, 0.78)', 'rgba(204, 204, 204, 0.05)', 'rgba(63, 185, 80, 0.15)',
  'rgba(88, 166, 255, 0.15)', 'rgba(242, 204, 96, 0.15)', 'rgba(255, 255, 255, 0.55)',
  'rgba(255, 255, 255, 0.85)', 'rgba(255, 255, 255, 0.88)', 'rgba(255, 255, 255, 0.45)'
])

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    if (fs.statSync(p).isDirectory()) walk(p, out)
    else if (/\.(css|tsx|ts)$/.test(f)) out.push(p)
  }
  return out
}
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1')
const COLOR = /#[0-9a-fA-F]{3,8}\b(?![-\w])|rgba?\([^)]*\)/g

let violations = 0
for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file).replaceAll('\\', '/')
  const wl = WHITELIST[rel]
  if (wl === null) continue
  const raw = stripComments(fs.readFileSync(file, 'utf8'))
  const outsideVar = raw.replace(/var\([^)]*\)/g, '()')
  for (const m of outsideVar.matchAll(COLOR)) {
    const lit = m[0].toLowerCase()
    if (wl && wl.has(lit)) continue
    console.error(`RAW ${rel}: ${lit}`)
    violations++
  }
  for (const v of raw.matchAll(/var\(([^)]*)\)/g)) {
    const fb = v[1].split(',').slice(1).join(',').trim()
    if (!fb) continue
    if (fb.startsWith('var(') || fb.startsWith('color-mix(') || fb.startsWith('in srgb')) continue
    for (const m of fb.match(COLOR)) {
      if (!FALLBACK_OK.has(m[0].toLowerCase())) {
        console.error(`FALLBACK ${rel}: var(${v[1]}) -> ${m[0]}`)
        violations++
      }
    }
  }
}
// negative self-test: the matcher itself must catch literals and 3/4-digit hex
{
  const probe = stripComments('.a{color:#fff9;border:#abcd}') // comments gone, hex visible
  const hits = [...probe.matchAll(COLOR)].length
  if (hits < 2) {
    console.error('self-test failed: matcher did not catch probe literals')
    process.exit(1)
  }
}
if (violations > 0) {
  console.error(`css-theme-vars: ${violations} violation(s)`)
  process.exit(1)
}
console.log('css-theme-vars: all ok')
```

- [ ] **Step 2: 基线清零**：跑 `node tests/css-theme-vars.mjs`，对每条 RAW/FALLBACK 输出：属于遗漏清扫 → 回对应文件改掉（**不扩大白名单来逃课**；若确属主题数据/铁律 → 加进 WHITELIST 精确值并在此步骤记录理由）。目标：白名单外 0 违规。

- [ ] **Step 3: 接链 + 全量验证**：`package.json` test 链末尾追加 `&& node tests/css-theme-vars.mjs`；跑 **`npm test` 全链**（typecheck + 全部测试）必须全绿。

- [ ] **Step 4: AGENTS.md「主题机制」增补**（追加 bullet，保留既有内容）：

```markdown
- 语义变量层（2026-10 主题改造）：`src/renderer/src/theme/semantic.ts`（零 import 纯模块，`isLightTheme`/`mix`/`darkenToRatio`/`SEMANTIC` 锚点）→ `chrome.ts` 的 `applyChromeTheme` 随主题派生 `--ot-*` 变量并写 `color-scheme`；**深色分支锁 SEMANTIC 锚点（零回归），浅色分支 darkenToRatio 按 WCAG 派生**。CSS 一律 `var(--ot-*, 锚点兜底)`，新代码禁止再写裸颜色字面量——`node tests/css-theme-vars.mjs` fail-closed 扫描（先剥注释、忽略 var() 兜底但有受控清单，白名单按「文件+精确值」登记）
- 浅色主题可读性：内置浅色主题 ANSI 调色板已重做到 16 色+fg 全部 ≥4.5:1（`node tests/theme-contrast.mjs` 守门，改内置浅色主题必须过它）；`minimumContrastRatio` 按「背景图 4.5｜浅色无图 4.5｜深色无图 1」矩阵（构造+热更两处），`drawBoldTextInBrightColors` 浅色关闭——WebGL 渲染器同样执行 MCR（addon-webgl 自带对比度路径，已核实）；antd 算法随 `isLightTheme` 切 `defaultAlgorithm`/`darkAlgorithm`（**antd 没有 lightAlgorithm**）
- 内置主题调色板是「主题数据」不是 chrome 颜色：改浅色主题色值用统一加深算法（`darkenToRatio`），不许手挑色
```

- [ ] **Step 5: docs/STATE.md 追加条目**（一行式，随仓库现有格式）：主题系统 A+B+C 落地——语义变量层 + 浅色 AA 调色板 + 防护测试（semantic-theme/theme-contrast/css-theme-vars）。

- [ ] **Step 6: 提交**

```bash
git add tests/css-theme-vars.mjs package.json AGENTS.md docs/STATE.md
git commit -m "test(theme): 颜色字面量 fail-closed 守门 + 基线清零；AGENTS/STATE 同步主题语义层"
```

---

## §10 通用验证命令

```bash
# 残留扫描（T3-T5 各自跑，只看本任务文件）
node -e "const fs=require('fs');const t=fs.readFileSync(process.argv[1],'utf8').replace(/\/\*[\s\S]*?\*\//g,'').replace(/(^|[^:'\"])\/\/.*$/gm,'$1');const out=t.replace(/var\([^)]*\)/g,'()');console.log([...out.matchAll(/#[0-9a-fA-F]{3,8}\b(?![-\w])|rgba?\([^)]*\)/g)].map(m=>m[0]).join('\n')||'CLEAN')" <文件路径>

npm run typecheck          # 每任务必跑
node tests/semantic-theme.mjs
node tests/theme-contrast.mjs
npm test                   # T6 与最终把关必跑（全链）
```

## §11 Swarm 编排（依赖波次）

| 波次 | 任务 | 并行度 | 前置 |
|------|------|--------|------|
| W1 | T1 | 1 | — |
| W2 | T2、T3 | 2 | T1 |
| W3 | T4、T5 | 2 | T1（不依赖 T2/T3） |
| W4 | T6 | 1 | T1–T5 全部 |

文件冲突核对：T2 独占 theme.ts/TerminalView.tsx/main.tsx/ErrorBoundary.tsx；T3 独占 global.css/terminal.css；T4 独占 workspace/connections/commands.css；T5 独占 sftp/monitor/settings/highlight/lock.css + MonitorPanel.tsx；package.json 仅 T1/T2/T6 顺序触碰。每任务子代理完成后**必须自审**（typecheck + 本任务测试 + `git diff` 逐块重读 + 提交），主会话在 W4 后做总体把关（`npm test` 全链 + 全量 diff 审查 + 手工验收清单移交用户）。
