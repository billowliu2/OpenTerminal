# 全局复审第二轮修复计划（2026-11-27）

> 依据：2026-11-27 全局 review 第二轮（4 个只读审查子代理 + 主代理逐条复核 + 真实 Electron/dockview 实证）。
> 状态：**待用户批准后执行**。执行方式：按 task-execute 流程派子代理实现，主代理逐轮独立核实。**全程不提交 git**（用户指令）。

## Context

第一轮全局 review 的 14 项修复已全部落地并通过 `npm test`（44 步全绿）。第二轮复审查出 **2 个必须先处理的问题**（都是"看起来实现了、实际没生效"）：

1. **模板应用失败会清空工作区且不恢复** —— `templateApply.ts` 只在 `fromJSON()` 正常返回后才标记"已触碰"，并假设抛错的 dockview 一定没被动过。真实 dockview 8.2.0 的行为是：根节点校验失败时先抛错后清空（安全），但**通过校验后**会在 `clear()` 之后于反序列化阶段抛错（`dockview-core.js:16698` → `:16773-16799`），此时布局已被清空。当前实现把这类 dockview 判为"未触碰"→ 不回灌快照 → 工作区空掉，且提示语仍写"已恢复原有布局"。真实实例对照：

   | | 失败后 | 恢复后 |
   |---|---|---|
   | 新逻辑 | ssh 面板被清空 | terminal 2，**ssh 仍是 0** |
   | 旧逻辑（HEAD） | ssh 面板被清空 | terminal 2，**ssh 恢复成 2** |

   这是本轮 T3 引入的回归（旧逻辑会恢复，新逻辑不会）。

2. **更新下载的停顿看门狗实际不起作用** —— `updater.ts:409-418` 超时只清掉应用层 `downloadInFlight`；electron-updater 6.8.9 内部有自己的 `downloadPromise`（`AppUpdater.js:442-445`），`downloadUpdate()` 在已有下载时**返回同一个 promise**，且调用时未传取消令牌（`updater.ts:402`）。因此：重试拿到的还是那个卡死的 promise；`fetchHandled` 未回滚使周期检查在 `updater.ts:205-207` 直接返回；界面停在"下载中"且该状态无重试按钮（`AboutTab.tsx:131-145`）。净效果与修复前无差别。

   真实 Electron 实证：
   ```
   下载中再次 downloadUpdate → 同一个 promise，未起第二份传输
   token.cancel()              → 真实下载中断，抛 CancellationError
   取消后再 downloadUpdate     → 启动新传输（与旧 promise 无关）
   ```
   即修法可行，只是当前没实现。

3. **新发现：第三类失败 —— 静默清空** —— 载荷内部自相矛盾时（如 `views` 指向不存在的面板、`root.data` 为空）dockview **不抛错**，但清空旧布局后按载荷重建不出来。此时 `fromJSON` 正常返回，代码认为成功，随后 `killSession` 把会话清掉，**用户看不到任何错误提示**。新旧逻辑表现相同，**不是本轮回归**，但与前两条同属"模板失败要能被察觉并恢复"的范畴，一并处理。

4. **次级问题**（均为小修）：文档测试数漂移（README 中/英各 3 处写 36、`STATE.md` 2 处与 `ci.yml` 注释写 19，实际 43 个测试文件）；`terminal-theme-deps.mjs` 的依赖断言太松（把 `bgOpts`/`contrastOpts` 加回依赖数组不会红）；`verify-deps.cjs` 会把注释/字符串当 import；sftp 计时器刻意不 `unref()` 的原因无处记录。

目标：把上述问题修到"失败可察觉、可恢复、不会被误报成功"，并让测试真正守住这些行为；不动与本轮无关的代码；**不提交 git**。

---

## 决策（已定，无需再问）

| 决策 | 选择 | 依据 |
|---|---|---|
| 模板失败后 SSH 工作区如何恢复 | **关闭被清空的 SSH 面板**（等同 `rebindSessionPanels` 的 `dropSsh=true` 语义），不保留幽灵面板 | 见下方"决策依据（已核实）"。保留面板是错的：被 kill 的会话在 `sessionState` 里是 `exists:false, exited:false`，`TerminalView` 不会置 `dead` → 面板既无内容也无"已退出"遮罩 |
| 更新器是否新增 `builder-util-runtime` 直接依赖 | **新增**，固定 `9.7.0` | 取消令牌类在该包；electron-updater 6.8.9 本身就精确依赖 `9.7.0`（`package.json` → `dependencies`，非 devDeps）。它是 `electron-updater` 的传递依赖，顶层已安装 |
| 静默清空如何检测 | **应用后校验面板数**：载荷声明的面板 id 集合 vs 应用后的实际面板 id 集合，不一致即视为失败 | 已在真实 dockview 上验证该集合比较能区分"清空"与"未清空"（9/9 用例符合预期） |
| 是否保留本轮已有的 `templateApply.ts` | **保留并重写**，不删 | 它是零 import 纯模块，符合项目测试约定；问题在判定规则，不在模块形态 |

---

## 决策依据（已核实，供复核）

**为什么 SSH 面板要"关闭"而不是"保留"**（这一条在计划自审时被推翻过一次，记录在此）：

- 模板失败 → dockview 被清空 → `onDidRemovePanel` 触发 → `releaseSession` → 会话被 kill。
- `killSession` **不**调用 `rememberSessionExit`（只有自然退出才记，`pty.ts:301` 与 `:470`；kill 路径在 `:525-552`），因此 `sessionState(id)` 对被 kill 的会话返回 `{ exists: false, exited: false, exitCode: null }`（`pty.ts:133-138`）。
- `TerminalView` 只在 `state.exited` 为真时置 `dead`（`TerminalView.tsx:1554-1558`），`dead` 才渲染"已退出"遮罩（`:1989-1994`）。
- 结论：恢复出来的 SSH 面板会绑定到一个已被 kill 的会话，**既没有内容，也没有退出提示**，是一个无法使用的幽灵面板。
- 因此失败路径对 SSH 侧采用与 `restoreFromSnapshot` 相同的 `dropSsh=true` 语义：关闭这些 SSH 面板（`Workspace.tsx:974-1008` 的 `rebindSessionPanels` 已支持该参数），而不是留一堆幽灵。
- 用户仍能从提示语知道"SSH 面板因模板失败被关闭"，并可手动重连。

**为什么 `rebindRestoredPanels` 不能用于 SSH 侧**：它最终走 `bindPanelSession` → `panel.updateParameters({ sessionId: nextSessionId, sessionKind: 'local' })`（`Workspace.tsx:947`），会把 SSH 面板改写成本地终端并新建本地 PTY —— 对 SSH 是错的（AGENTS.md「布局模板」一节已记录同一约束）。

---

### T1 —— 模板失败：按证据判定"是否被清空"，并静默清空检测

**文件**
- `src/renderer/src/workspace/templateApply.ts`（重写判定逻辑）
- `src/renderer/src/workspace/Workspace.tsx`（调用方）
- `src/shared/i18n/dicts/{zh-CN,zh-TW,en,ja}/workspace.ts`（新增提示键）
- `tests/template-apply.mjs`（重写）

**做法**
1. `templateApply.ts` 的接口从 `fromJSON/toJSON` 扩展为能观察面板集合：新增 `panels: ReadonlyArray<{ id: string }>` 到 `DockviewLike`，或在模块内用 `api.panels` 读 id 集合。
2. 判定规则（每侧独立）：
   - 调用前记录 `idsBefore`。
   - `fromJSON` 抛错 → 该侧记 `error`。
   - 调用后记录 `idsAfter`。
   - **是否被清空** := `idsBefore` 与 `idsAfter` 的 id 集合不同（真实 dockview 已验证：清空时 id 集合变为空，未清空时保持不变）。
   - **静默清空检测** := 未抛错，但载荷声明的面板 id 集合 ⊄ 应用后的实际 id 集合 → 视为失败（`error` 记为"载荷与结果不一致"）。
   - 载荷声明的面板 id 从该侧载荷的 `panels` 键取：双布局时是 `payload.terminal.panels` 与 `payload.ssh.panels`；旧版单布局时是 `payload.panels`（整个载荷就是 terminal 侧的）。dockview 序列化格式里 `data.panels` 是以面板 id 为键的映射（`grid.root.data` 是组，组内 `views` 指面板 id）。
3. 返回值语义改为：`{ terminal: { cleared: boolean; error?: unknown }, ssh: {...} }`，其中 `cleared` 表示"这一侧需要回灌快照"。
4. `Workspace.tsx` 失败路径：
   - 只对 `cleared === true` 的一侧回灌快照（`restoreLayoutSnapshot`）。
   - 回灌后**本地终端侧**调用 `rebindRestoredPanels`（新建本地会话，符合原语义）；**SSH 侧**调用 `rebindSessionPanels(sshApi, undefined, /* dropSsh */ true)` 关闭那些已失效的 SSH 面板（见上方"决策依据"），**不**把它们改写成本地终端。
   - `restoreLayoutSnapshot` 改为返回 `boolean`（恢复是否成功），失败时用另一条提示语，不再谎报"已恢复原有布局"。
   - 会话清理（`killSession`）逻辑保持：不在任何面板上的会话一律杀掉。
5. i18n：新增 `workspace.template.applyFailedRestored`（已有，需保留）与 `workspace.template.applyFailedNoRestore`（恢复也失败），四语言同步。

**验收标准**
- 载荷在根校验阶段失败 → 两侧 `cleared === false` → 不回灌、不重绑、活会话不受影响。
- 载荷在反序列化阶段失败（清空后抛错）→ 被清空的一侧 `cleared === true` → 回灌快照 → 面板回到应用前的样子。
- 载荷静默清空（不抛错但结果与载荷不符）→ 判定为失败 → 回灌 + 弹错误提示。
- 回灌自身失败 → 弹"未能恢复"提示，而不是"已恢复"。
- 被清空的 **SSH 面板被关闭**（不留幽灵面板：绑定已 kill 的会话时 `TerminalView` 既不显示内容也不显示退出遮罩）。
- 全部行为由 `tests/template-apply.mjs` 覆盖，且测试用 mock 必须能模拟"清空后抛错"和"静默清空"两种形态（当前 mock 只模拟"抛错但不改状态"，这是测试没守住生产接线的原因）。

**验证**
```bash
node tests/template-apply.mjs          # 必须 exit 0
npm run typecheck                      # 必须 exit 0
```

**风险与规避**
- dockview 面板 id 集合比较依赖 `api.panels` 的形状；`DockviewApi.panels` 返回 `IDockviewPanel[]`，含 `id`（已在 `component.api.d.ts:496` 确认）。实施时先在真实 dockview 上跑一遍该比较（本计划已用 Electron 实证 9/9）。
- 载荷声明的面板 id 取自 `payload.panels` 的键：dockview 序列化格式中 `data.panels` 是以面板 id 为键的映射（`dockview-core.js:16613` `Object.keys(data.panels)`、`:16722` `views.filter(child => panels[child])` 证实 views 指的就是这些键），实施时以该格式为准。
- SSH 侧关闭面板的调用点是 `rebindSessionPanels(api, snapshot?, dropSsh, renames?)`（`Workspace.tsx:974-1008`），现为 `useCallback`，失败路径要能拿到它 —— 实施时确认闭包可见性（它在同一组件内，应可直接用）。

---

### T2 —— 更新下载：真取消 + 世代号 + 回滚

**文件**
- `src/main/updater.ts`
- `package.json`（新增 `builder-util-runtime` 到 `dependencies`，版本 `9.7.0`）
- `package-lock.json`（真实 `npm install` 生成）
- `tests/updater-fallback.mjs`（新增看门狗用例）
- `tests/electron-updater-stub.cjs`（桩要能观察取消令牌）

**做法**
1. `package.json`：`dependencies` 新增 `"builder-util-runtime": "9.7.0"`（与 electron-updater 6.8.9 的精确依赖一致）。**必须真实执行 `npm install`**，不能只改 lockfile（AGENTS.md 硬规则）。
2. `updater.ts`：
   - `handleDownload` 里创建自己的 `CancellationToken`，传给 `autoUpdater.downloadUpdate(token)`。
   - 看门狗超时 → `token.cancel()`（真取消），而不是只清 `downloadInFlight`。
   - 取消后：`seen.fetchHandled = false`（回滚，让下个周期能重试）、`setState({ status: 'error', error: <明确的"下载停滞"文案> })`。注意 electron-updater 对 `CancellationError` **不派发** `error` 事件，所以文案必须我们自己给。
   - **世代号**：每次下载分配一个自增 id；`download-progress` / `update-downloaded` 事件只接受"当前世代"的事件，旧下载的迟到事件不得覆盖新下载的状态（否则旧版本会把新版本的进度显示成自己的）。
   - 清理：`release()` 里 `clearInterval(watchdog)` + `removeListener('download-progress', onProgress)` 保持不变；取消后要确保 `downloadInFlight` 被清掉，下一次 `handleDownload` 能起**新**传输（electron-updater 在 promise settle 后会把 `downloadPromise` 置 null，本计划已实证）。
   - `DOWNLOAD_STALL_MS` 走已有的 `setUpdateTimeouts` 测试缝（新增 `stall` 字段），使测试无需真等 120 秒。
3. `tests/updater-fallback.mjs`：用 `tests/electron-updater-stub.cjs` 的 `downloadUpdate` 桩新增用例——
   - **桩要先改造**：现有桩的 `downloadUpdate()` 不接参数（`tests/electron-updater-stub.cjs:61-64`），无法观察取消令牌；要改成 `downloadUpdate(token)` 并把令牌存进 `ctl()`，供断言"令牌被 cancel 了"。
   - 下载永不 settle → 到停滞预算后状态变 `error`、文案是"停滞"而不是泛化错误；
   - 停滞后下一次下载能真正发起（桩记录调用次数 + 收到取消令牌）；
   - 停滞后 `fetchHandled` 已回滚（下个周期 `update-available` 会再次触发下载）；
   - 旧世代的 `download-progress` 不覆盖新世代的状态。

**验收标准**
- 停滞超时后：UI 显示错误态且有"重新检查"按钮（`error` 态在 `AboutTab.tsx:131` 有按钮）；自动更新可在下个周期重试。
- 无停滞时行为与现在完全一致（现有 updater-fallback 全部用例仍绿）。
- 旧世代事件不污染新世代状态。

**验证**
```bash
npm install                             # 真实安装，写入 package-lock.json
node scripts/verify-deps.cjs            # 依赖分类闸门必须 exit 0
node tests/updater-fallback.mjs         # 必须 exit 0
npm run typecheck                       # 必须 exit 0
```

**风险与规避**
- 新增依赖会影响安装包体积（`builder-util-runtime` 已被 electron-updater 打进包，实际增量极小）。实施后必须跑 `node scripts/verify-deps.cjs` 确认分类闸门接受它（它会被 `src/main/updater.ts` 真实 import → 应在 `dependencies`）。
- 真实网络下的"停滞→取消→重新下载"无法离线测试（需真实 GitHub/Gitea 通道），只能靠桩 + 手工验证。**这条要如实标注为未自动验证**。

---

### T3 —— 文档数字统一

**文件**：`README.md`、`README.en.md`、`docs/STATE.md`、`docs/ROADMAP.md`、`.github/workflows/ci.yml`、`AGENTS.md`

**做法**
- 测试数统一为 **43**（`package.json` test 链 44 步，首步是 `tests/build-bundles.cjs`，不是测试）。
- 修 `README.md:26,35,98` 与 `README.en.md:26,35,98` 的 "36"。
- 修 `docs/STATE.md:66,80` 的 "19"。
- 修 `.github/workflows/ci.yml:40` 注释里的 "19"。
- `AGENTS.md:9` 的 "**44** 个离线测试" → 43（或改成"44 步（43 个测试 + 1 步 bundle 重建）"）。
- `docs/ROADMAP.md:30` 的"30s 超时拒绝" → 120s（代码 `src/shared/ipc.ts:11` 是 120_000）。
- `docs/ROADMAP.md:167` 把"下载无整体超时"整体划掉的做法要收回：改为"已加停顿检测与真取消"，并保留"慢速滴流无整体时限"为待办 —— 按 T2 实现后，停滞会被取消并可重试，但"始终在缓慢前进"的传输仍无总时限，措辞必须属实。

**验收标准**：`grep -rn "36 个\|19 个\|36 offline\|19 offline" README*.md docs/ .github/ AGENTS.md` 无残留；ROADMAP 措辞与代码事实一致。

---

### T4 —— 测试与守门加固

**文件**
- `tests/terminal-theme-deps.mjs`（收紧断言）
- `tests/session-flush.mjs`（补生产接线断言）
- `scripts/verify-deps.cjs`（改用 TypeScript AST）
- `tests/ipc-guard.mjs`（必要时补负向用例）

**做法**
1. `terminal-theme-deps.mjs`：当前只检查依赖数组里**不含** `minimumContrastRatio|backgroundImageOpacity|backgroundImageDim`，因此把 `bgOpts`/`contrastOpts` 加回依赖数组不会红（已实测）。改为断言主题 effect 的依赖**恰为** `themeOpts`、对比度 effect 的依赖**恰为** `contrastOpts`（按名字精确匹配，允许空白差异）。
2. `session-flush.mjs`：现在只测纯函数 `flushPendingOutput`，把 `markDead` 改回 `batcher.flushNow()` 测试照样绿。补一条针对 `src/renderer/src/terminal/TerminalView.tsx` 的结构断言：`markDead` 内、`deadRef.current = true` **之前**出现 `flushPendingOutput(`。
3. `verify-deps.cjs`：改用 TypeScript 编译器 API 解析 import/require/dynamic import，剔除注释与字符串误判（已实测当前正则会把 `knownHosts.ts` 的注释 `the file is there but we cannot read it` 当成导入名）。要点：
   - 用 `typescript`（已在 devDependencies ~5.9.0）的 `createSourceFile` 走 AST，取 `ImportDeclaration`/`ExportDeclaration` 的 `moduleSpecifier`、以及 `require(...)` / `import(...)` 调用；
   - **类型导入不算运行时导入**（`import type` / `importClause.isTypeOnly` 要排除）—— 但注意：本仓库现状是"类型导入"为零，且 `dependencies` 里没有纯类型依赖（已用 AST 跑过 dry-run：无误判），所以这条规则现在安全，将来若有人把纯类型包放进 `dependencies` 会被要求挪走，这是期望行为；
   - 只扫 `src/main` 与 `src/preload`；
   - 保留 `IGNORED = new Set(['electron'])` 与 `module.builtinModules` 跳过；
   - fail-closed：解析异常要报错退出，不能静默通过。
4. `ipc-guard.mjs`：现有负向用例已覆盖 `file://evil-host` 绕过；若 T1/T2 未触及此处则不改。

**验收标准**
- 把 `[themeOpts, bgOpts]` 加回主题 effect 的依赖 → `tests/terminal-theme-deps.mjs` 变红。
- 把 `markDead` 里的 `flushPendingOutput(...)` 删掉 → `tests/session-flush.mjs` 变红。
- 在 `src/main/knownHosts.ts` 里加一句 `// from 'some-pkg'` 的注释 → `verify-deps.cjs` 不再把 `some-pkg` 当成导入。

**验证**
```bash
node tests/terminal-theme-deps.mjs
node tests/session-flush.mjs
node scripts/verify-deps.cjs
```

---

### T5 —— 记录 sftp 计时器不 `unref()` 的原因

**文件**：`AGENTS.md`（或 `src/main/sftp.ts` 的 `bounded()` 注释）

**做法**：写清为什么 sftp 的 3 个超时计时器**刻意不** `unref()`：离线测试进程依赖它们阻止事件循环提前退出（`unref()` 后 `tests/sftp-timeout.mjs` 会以 EXIT=13 "Detected unsettled top-level await" 失败）；ssh 的 2 处与 updater 的定时器照常 `unref()`。避免以后有人"顺手补上"就踩坑。

**验收标准**：AGENTS.md 或代码注释里能查到这条原因，且与 `tests/sftp-timeout.mjs` 的实际行为一致。

---

### T6 —— 全量验收（主代理亲自跑）

**命令（必须串行）**
```bash
npm test                      # 44 步全绿
npm run typecheck             # exit 0
node scripts/verify-deps.cjs  # exit 0
```
注意：`npm test` 首步会重建共享 esbuild bundle，子代理**不得**并行跑全量套件，只跑自己的定向测试。

**额外变异验证（主代理亲自做，证明守门真的有效）**
- 把 `MAX_REPLAY_SEQUENCES` 从 3 改成 999 → `tests/hl-rules.cjs` 必须变红 → 改回。
- 把主题 effect 的依赖改回 `[themeOpts, bgOpts]` → `tests/terminal-theme-deps.mjs` 必须变红 → 改回。
- 把 `markDead` 里的 `flushPendingOutput(...)` 删掉 → `tests/session-flush.mjs` 必须变红 → 改回。

---

### T7 —— 真实实例回归验证（主代理亲自跑，用完即删）

用本机 Electron 44 + 真实 dockview 8.2.0 跑一遍 T1 的三种失败形态（根校验失败 / 清空后抛错 / 静默清空），确认：
- 根校验失败 → 活面板与会话不动；
- 清空后抛错 → 面板回到应用前；
- 静默清空 → 被判为失败并回灌。

脚本写在系统临时目录（不进仓库），跑完删除。**这条是 T1 的最终判据，不能只靠 mock 测试。**

---

## 范围边界（明确不做）

- 不做 git 提交（用户指令）。
- 不做 `npm run dist` / 打包 / 发版（用户指令），因此 `package-lock.json` 只随 `npm install` 更新，不进发布流程。
- 不修与本轮无关的历史问题（如 `ProxyAgent` 未销毁、`release.cjs` 未知 flag 静默忽略、README.en/ja 其它措辞）。
- 不改 `colorPrimary` 的全局影响面（`#0f66d8` 会改变全应用 antd 主色元素）—— 这属于设计取舍，只在最终报告里提示用户目视验证。
- 不重构 dockview 集成层。

## 假设（我自行决定，实施时按此执行并记录）

1. SSH 面板在模板失败后**被关闭**（`dropSsh=true` 语义），不保留幽灵面板、不改写成本地终端。依据见上方"决策依据（已核实）"。
2. `builder-util-runtime@9.7.0` 进 `dependencies`（与 electron-updater 的精确依赖一致），实施后必须真实 `npm install`。
3. 载荷声明的面板 id 集合取自 `payload.panels` 的键（dockview 序列化格式：`data.panels` 以面板 id 为键，`grid.root.data` 是组，组内 `views` 指面板 id）。
4. 静默清空的判定用"载荷声明 ⊄ 实际"（集合包含），允许载荷声明多于实际（部分丢失也算失败）。
5. 测试数量口径统一为 43（44 步链中的首步是 bundle 重建）。

## 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| T1 的 SSH 面板关闭路径要复用 `rebindSessionPanels` 的 `dropSsh` 参数 | 闭包可见性或参数位置写错 | 该回调与失败路径同在 `Workspace` 组件内；实施时先确认调用点 |
| T2 真实网络行为无法离线验证 | 看门狗在真实通道上的表现未经自动测试 | 桩测试覆盖逻辑，手工验证标注为待办 |
| 新增依赖影响安装包 | 体积微增 | electron-updater 已把它打进包，实际增量极小 |
| 子代理并行跑 `npm test` 造成 bundle 竞态 | 假失败 | 派发时明确"只跑定向测试"，全量由主代理串行跑 |

## 交付物

1. 上述 5 个代码/文档任务的实现（子代理做，主代理复核）。
2. T6 全量验收 + 3 次变异实验的证据。
3. T7 真实 Electron/dockview 回归证据。
4. 一份最终报告：做了什么、验证证据（主代理自己跑出来的）、遗留项、**未提交 git** 的状态说明。
