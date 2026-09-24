import ReactDOM from 'react-dom/client'
import { useEffect, type ReactNode } from 'react'
import { App as AntdApp, ConfigProvider, theme as antdTheme } from 'antd'
import type { AppApi } from '@shared/api'
import type { LockSettingsState } from '@shared/ipc'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { getThemeById } from '@shared/theme'
import App from './App'
import { ErrorBoundary } from './ErrorBoundary'
import ZmodemOffers from './workspace/ZmodemOffers'
import { useSettingsStore } from './settings/store'
import { mix } from './theme/chrome'
import './global.css'

// Diagnostics: report renderer main-thread freezes after recovery. console.error
// is surfaced into the dev terminal by the main process's console-message hook,
// so a "卡死又恢复" report tells us which process stalled and for how long.
{
  let lastTick = performance.now()
  setInterval(() => {
    const now = performance.now()
    const lag = now - lastTick - 2000
    // Chromium throttles timers in a hidden page down to roughly one per
    // minute (intensive throttling), which this watchdog would otherwise
    // report as a ~58s "stall" on every tick while the window sits in the
    // tray. A hidden window also has nothing user-visible to freeze, so the
    // report is skipped until the page is visible again.
    if (lag > 3000 && !document.hidden) {
      console.error(`[renderer] main thread stalled ~${Math.round(lag)}ms`)
    }
    lastTick = now
  }, 2000)
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
    appInfo: async () => ({ platform: 'browser', appVersion: 'dev', homeDir: '' }),
    createPty: async () => ({ id: stubId(), shell: 'stub', cwd: '' }),
    openSession: async () => ({ id: stubId() }),
    getSessionReplay: async () => '',
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

const MIN_FONT = 8
const MAX_FONT = 40
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
      // The lock overlay leaves Workspace mounted; window-capture hotkeys must
      // not mutate font size on a shell hidden behind it. preventDefault matters
      // here: returning alone lets the chord reach Electron's default menu
      // accelerators (zoomIn/zoomOut/resetZoom), which rescale the whole UI
      // behind the opaque mask and make Chromium persist that zoom per origin.
      if (document.documentElement.dataset.locked === 'true') {
        e.preventDefault()
        return
      }
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
  return (
    <ConfigProvider
      theme={{
        algorithm: antdTheme.darkAlgorithm,
        token: {
          colorBgBase: colors.background,
          colorBgContainer: mix(colors.background, colors.foreground, 0.06) ?? '#1f1f1f',
          colorBgElevated: mix(colors.background, colors.foreground, 0.1) ?? '#252525',
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
