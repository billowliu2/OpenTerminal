import ReactDOM from 'react-dom/client'
import { useEffect } from 'react'
import { App as AntdApp, ConfigProvider, theme as antdTheme } from 'antd'
import type { AppApi } from '@shared/api'
import { DEFAULT_SETTINGS } from '@shared/settings'
import App from './App'
import { ErrorBoundary } from './ErrorBoundary'
import ZmodemOffers from './workspace/ZmodemOffers'
import { useSettingsStore } from './settings/store'
import './global.css'

// Dev convenience: allow opening the renderer in a plain browser (vite page)
// so layout/UX work doesn't require the electron shell. No-op under electron.
if (typeof window !== 'undefined' && !window.api) {
  const noop = (): void => undefined
  const stubId = (): string => `stub-${Math.random().toString(36).slice(2)}`
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
    saveSettings: async (s) => s,
    onSettingsChanged: () => noop,
    listFonts: async () => [],
    listLayouts: async () => [],
    getLayout: async () => null,
    saveLayout: async () => undefined,
    deleteLayout: async () => undefined,
    updateCheck: async () => ({ status: 'dev' as const, currentVersion: 'dev' }),
    updateDownload: async () => undefined,
    updateInstall: noop,
    updateChangelog: async () => [],
    onUpdateState: () => noop
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
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <ConfigProvider
    theme={{
      algorithm: antdTheme.darkAlgorithm,
      token: { colorBgContainer: '#1f1f1f', colorBgElevated: '#252525', borderRadius: 6 }
    }}
  >
    <AntdApp>
      <ErrorBoundary>
        <App />
        <ZmodemOffers />
        <FontHotkeyListener />
      </ErrorBoundary>
    </AntdApp>
  </ConfigProvider>
)
