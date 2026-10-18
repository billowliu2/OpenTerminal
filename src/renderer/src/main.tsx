import ReactDOM from 'react-dom/client'
import { useEffect, type ReactNode } from 'react'
import { App as AntdApp, ConfigProvider, theme as antdTheme } from 'antd'
import type { AppApi } from '@shared/api'
import type { LockSettingsState } from '@shared/ipc'
import { PROBE_VERSION } from '@shared/redosProbes'
import { DEFAULT_SETTINGS, FONT_LIMITS } from '@shared/settings'
import { getThemeById } from '@shared/theme'
import App from './App'
import { ErrorBoundary } from './ErrorBoundary'
import ZmodemOffers from './workspace/ZmodemOffers'
import { useSettingsStore } from './settings/store'
import {
  classifyWatchdogLag,
  emitPerfLog,
  formatWatchdogReport,
  LongTaskRing,
  setPerfLogSink,
  snapshotPanes
} from './terminal/perfDiagnostics'
import { mix } from './theme/chrome'
import { isLightTheme } from './theme/semantic'
import './global.css'

// Diagnostics: report renderer main-thread freezes after recovery. console.error
// is surfaced into the dev terminal by the main process's console-message hook,
// and the same line goes through APP_LOG into the on-disk diagnostic log, so a
// packaged build's "卡死又恢复" report also tells us which process stalled and
// for how long.
//
// The old version had one flaw: a late 2s tick was called a stall no matter what
// caused it. Timer throttling (hidden page, OS suspension, system sleep) and a
// real main-thread long task produce the same "the timer fired late" symptom,
// so the log could not be read as evidence of anything. The first phase of the
// stall timeline (docs/PLAN-2026-10-17-font-highlight.md, 独立方案 B §B2) adds a
// feature-detected `longtask` observer: a late tick only counts as a renderer
// long task when an observed long task actually overlaps that window, and
// everything else is reported as scheduler delay with the unexplained
// remainder spelled out.
// Observation only — nothing here changes how anything runs.
{
  const WATCHDOG_INTERVAL_MS = 2000

  const logEnabled = (): boolean =>
    useSettingsStore.getState().settings.system.diagnosticLog !== false

  // One sink for every PERF producer (watchdog, fit lines, WebGL lifecycle,
  // slow xterm writes). Severe watchdog reports pass the budget as urgent; the
  // rest share a 5 lines/minute cap so a busy terminal cannot flood the file.
  setPerfLogSink((line, ctx) => {
    if (!logEnabled()) return
    if (ctx.urgent) console.error(`[renderer] ${line}`)
    else console.warn(`[renderer] ${line}`)
    window.api?.appLog?.(line)
  })

  // Recent long tasks (startTime/duration in performance.now() space). A ring,
  // not a log: 50 entries is roughly the last several seconds of blocking.
  const longTasks = new LongTaskRing()
  try {
    if (typeof PerformanceObserver !== 'undefined') {
      const observer = new PerformanceObserver((list) => {
        try {
          for (const entry of list.getEntries()) {
            longTasks.push({ startTime: entry.startTime, duration: entry.duration })
          }
        } catch {
          /* a diagnostics callback must never throw into the observer */
        }
      })
      observer.observe({ entryTypes: ['longtask'] })
    }
  } catch {
    // No longtask support (plain-browser stub, older Chromium): the watchdog
    // still runs and reports every late tick as scheduler delay/unclassified —
    // which is exactly what it can prove without the observer.
  }

  let lastTick = performance.now()
  // Reset rather than log after the page comes back: a hidden page is throttled
  // to roughly one timer a minute, and waking up from sleep leaves an hourly
  // "lag" that says nothing about the renderer. `focus` covers OS-level
  // suspension where the visibility flag never changed.
  const resetTick = (): void => {
    lastTick = performance.now()
  }
  document.addEventListener('visibilitychange', resetTick)
  window.addEventListener('pageshow', resetTick)
  window.addEventListener('focus', resetTick)

  setInterval(() => {
    const now = performance.now()
    const elapsed = now - lastTick
    const lag = elapsed - WATCHDOG_INTERVAL_MS
    lastTick = now
    // A hidden window has nothing user-visible to freeze; reporting it would
    // only ever describe the throttler.
    if (document.hidden) return
    const verdict = classifyWatchdogLag({
      lagMs: lag,
      windowStart: now - elapsed,
      windowEnd: now,
      longTasks: longTasks.all()
    })
    if (verdict === null) return
    const line = formatWatchdogReport(verdict, snapshotPanes(now), {
      now,
      wallNow: Date.now(),
      recentLongTasks: longTasks.all()
    })
    // Urgent: the one line that must never be dropped by the PERF budget.
    emitPerfLog(line, { urgent: true, now })
  }, WATCHDOG_INTERVAL_MS)
}

// Dev convenience: allow opening the renderer in a plain browser (vite page)
// so layout/UX work doesn't require the electron shell. No-op under electron.
if (typeof window !== 'undefined' && !window.api) {
  const noop = (): void => undefined
  const stubId = (): string => `stub-${Math.random().toString(36).slice(2)}`
  /** Browser stub: never configured and never locked, so the lock overlay
   *  stays out of the way of layout work done in a plain vite page. */
  const stubLockState = (over?: Partial<LockSettingsState>): LockSettingsState => ({
    configured: false,
    enabled: false,
    autoLockMinutes: 0,
    lockAtStartup: false,
    locked: false,
    ...over
  })
  const api: AppApi = {
    // A plain browser has no main process, so there is no validator and no
    // runtime fingerprint: every custom rule reads as pending, which is exactly
    // what the real app does when its worker cannot start.
    appInfo: async () => ({ platform: 'browser', appVersion: 'dev', homeDir: '', runtimeKey: '' }),
    appLog: noop,
    createPty: async () => ({ id: stubId(), shell: 'stub', cwd: '' }),
    openSession: async () => ({ id: stubId() }),
    getSessionReplay: async () => '',
    getSessionLiveState: async () => ({ exists: false, exited: false, exitCode: null }),
    writePty: noop,
    resizePty: noop,
    killPty: noop,
    onPtyData: () => noop,
    onPtyExit: () => noop,
    sysinfoStart: noop,
    sysinfoStop: noop,
    onSysinfoMeta: () => noop,
    onSysinfoSample: () => noop,
    listRemote: async () => [],
    mkdirRemote: async () => undefined,
    renameRemote: async () => undefined,
    deleteRemote: async () => undefined,
  chmodRemote: async () => undefined,
  chownRemote: async () => undefined,
    uploadRemote: async () => stubId(),
    downloadRemote: async () => stubId(),
    cancelTransfer: noop,
    onTransferProgress: () => noop,
    pickFiles: async () => [],
    pickDirectory: async () => '',
    recordCommand: async () => undefined,
    listHistory: async () => [],
    clearHistory: async () => undefined,
    listLibrary: async () => [],
    saveLibraryItem: async (item) => item,
    deleteLibraryItem: async () => undefined,
    logStart: async (sessionId) => ({
      sessionId,
      file: '',
      fileName: '',
      startedAt: Date.now()
    }),
    logStop: async () => undefined,
    listSessionLogs: async () => [],
    openLogsDir: noop,
    openDirectory: async () => false,
    listConnections: async () => [],
    saveConnection: async (input) => ({
      id: input.id ?? stubId(),
      name: input.name,
      group: input.group,
      host: input.host,
      port: input.port,
      username: input.username,
      auth: input.auth,
      askPasswordAtConnect: input.askPasswordAtConnect,
      askPassphraseAtConnect: input.askPassphraseAtConnect,
      keyPath: input.keyPath,
      keepaliveIntervalSec: input.keepaliveIntervalSec,
      highlightProfileId: input.highlightProfileId,
      createdAt: Date.now(),
      savedAuth: { hasPassword: false, hasKeyContent: false, hasPassphrase: false }
    }),
    deleteConnection: async () => undefined,
    onZmodemOffer: () => noop,
    zmodemRespond: noop,
    onZmodemDone: () => noop,
    onHostKeyPrompt: () => noop,
    respondHostKey: noop,
    getSettings: async () => DEFAULT_SETTINGS,
    saveSettings: async (s) => ({ ...DEFAULT_SETTINGS, ...s }),
    onSettingsChanged: () => noop,
    listFonts: async () => [],
    // No worker exists in a plain browser page, so the stub reports the feature
    // as unavailable and every draft as pending rather than pretending a probe
    // ran. The settings page then shows its real "validator unavailable" state.
    validateRules: async ({ items }) => ({
      runtime: '',
      probeVersion: PROBE_VERSION,
      workerAvailable: false,
      truncated: false,
      results: items.map((item) => ({ id: item.id, state: 'pending' as const }))
    }),
    getRuleValidationState: async () => ({
      runtime: '',
      probeVersion: PROBE_VERSION,
      workerAvailable: false,
      pending: 0,
      quarantined: 0
    }),
    onRuleValidationState: () => noop,
    listLayouts: async () => [],
    getLayout: async () => null,
    saveLayout: async () => undefined,
    deleteLayout: async () => undefined,
    updateCheck: async () => ({ status: 'dev' as const, currentVersion: 'dev' }),
    getUpdateState: async () => ({ status: 'dev' as const, currentVersion: 'dev' }),
    updateDownload: async () => undefined,
    updateInstall: async () => undefined,
    updateChangelog: async () => [],
    onUpdateState: () => noop,
    getSessionState: async () => null,
    saveSessionState: async () => null,
    resolveCwd: async () => null,
    reportCwd: async () => null,
    getLockState: async () => stubLockState(),
    setLockPassword: async (input) => ({
      ok: true,
      state: stubLockState({ configured: (input.newPassword ?? '').length > 0 })
    }),
    clearLockPassword: async () => ({ ok: true, state: stubLockState() }),
    unlockLock: async () => ({ ok: true, state: stubLockState() }),
    lockNow: async () => stubLockState(),
    onLockStateChanged: () => noop
  }
  ;(window as unknown as { api: AppApi }).api = api
}

const MIN_FONT = FONT_LIMITS.fontSize.min
const MAX_FONT = FONT_LIMITS.fontSize.max
const RESET_FONT = 14

/**
 * Window-level font-size hotkeys (Ctrl+Equal/+ / Ctrl+Minus/- / Ctrl+Digit0).
 * Uses the same updateTerminal store path as the settings dialog so TerminalView
 * re-renders immediately. Skipped while typing in an input/textarea/contentEditable.
 */
function FontHotkeyListener(): null {
  const updateTerminal = useSettingsStore((s) => s.updateTerminal)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // While locked, skip only this listener's own logic — and NEVER call
      // preventDefault here. The default action of a keydown is inserting the
      // character into the focused field, and it runs after the whole dispatch:
      // preventing it at window level kills every keystroke the lock screen's
      // password field would receive (shipped broken in v1.0.17). The menu
      // accelerators are stopped in main, on before-input-event, instead.
      if (document.documentElement.dataset.locked === 'true') return
      if (!e.ctrlKey || e.metaKey) return
      const target = e.target as HTMLElement | null
      const isXtermHelper =
        target instanceof HTMLTextAreaElement && target.classList.contains('xterm-helper-textarea')
      if (
        target &&
        !isXtermHelper &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return
      }

      let delta: number | undefined
      if (e.key === '=' || e.key === '+') delta = 1
      else if (e.key === '-') delta = -1
      else if (e.key === '0') delta = 0

      if (delta === undefined) return
      e.preventDefault()
      e.stopPropagation()

      const current = useSettingsStore.getState().settings.terminal.fontSize
      const next =
        delta === 0
          ? RESET_FONT
          : Math.min(MAX_FONT, Math.max(MIN_FONT, current + delta))
      void updateTerminal({ fontSize: next })
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [updateTerminal])

  return null
}

// antd <App> provides the context that App.useApp() consumers (workspace
// message/notification) rely on; without it they get empty stubs and crash.
// ErrorBoundary keeps any render crash from black-screening the whole window.

/** antd surfaces (settings dialog, menus, popovers) follow the terminal theme:
 *  base/container/elevated backgrounds derive from the theme's background. */
function ThemedConfigProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const themeId = useSettingsStore((s) => s.settings.terminal.themeId)
  const customThemes = useSettingsStore((s) => s.settings.customThemes)
  const colors = getThemeById(themeId, customThemes).colors
  const light = isLightTheme(colors.background)
  return (
    <ConfigProvider
      theme={{
        // antd has no lightAlgorithm — light is the default algorithm.
        algorithm: light ? antdTheme.defaultAlgorithm : antdTheme.darkAlgorithm,
        token: {
          colorBgBase: colors.background,
          colorBgContainer: mix(colors.background, colors.foreground, 0.06) ?? (light ? '#f5f5f5' : '#1f1f1f'),
          colorBgElevated: mix(colors.background, colors.foreground, 0.1) ?? (light ? '#f5f5f5' : '#252525'),
          colorTextBase: colors.foreground,
          borderRadius: 6
        }
      }}
    >
      {children}
    </ConfigProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <ThemedConfigProvider>
    <AntdApp>
      <ErrorBoundary>
        <App />
        <ZmodemOffers />
        <FontHotkeyListener />
      </ErrorBoundary>
    </AntdApp>
  </ThemedConfigProvider>
)
