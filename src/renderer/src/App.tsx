import { useEffect, useState } from 'react'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import zhTW from 'antd/locale/zh_TW'
import enUS from 'antd/locale/en_US'
import jaJP from 'antd/locale/ja_JP'
import Workspace from '@renderer/workspace/Workspace'
import { SettingsDialog } from '@renderer/settings/SettingsDialog'
import { TransferPanel } from '@renderer/sftp/TransferPanel'
import { LockScreen } from '@renderer/lock/LockScreen'
import { useSettingsStore } from '@renderer/settings/store'
import { getThemeById } from '@shared/theme'
import { DEFAULT_LANGUAGE, syncLanguage, type Language } from '@shared/i18n'
import type { LockSettingsState } from '@shared/ipc'
import { applyChromeTheme, applyTabAccent } from '@renderer/theme/chrome'
import appIconUrl from '../../../build/icon.png'

/** antd's own component texts (empty states, pagination, date pickers). */
const ANTD_LOCALES: Record<Language, typeof zhCN> = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  en: enUS,
  ja: jaJP
}

/** Custom window title bar: draggable strip themed with the active terminal
 *  theme; native min/max/close buttons come from BrowserWindow titleBarOverlay. */
function TitleBar(): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const theme = getThemeById(settings.terminal.themeId, settings.customThemes)
  return (
    <div
      className="app-titlebar"
      style={{ background: theme.colors.background, color: theme.colors.foreground }}
    >
      <img className="app-titlebar-icon" src={appIconUrl} alt="" draggable={false} />
      <span className="app-titlebar-title">OpenTerminal</span>
    </div>
  )
}

export default function App(): React.JSX.Element {
  const hydrate = useSettingsStore((s) => s.hydrate)
  const themeId = useSettingsStore((s) => s.settings.terminal.themeId)
  const customThemes = useSettingsStore((s) => s.settings.customThemes)
  const tabAccentColor = useSettingsStore((s) => s.settings.terminal.tabAccentColor)
  const storedLanguage = useSettingsStore((s) => s.settings.system.language ?? DEFAULT_LANGUAGE)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** Secure default: main may already hold a startup lock before this IPC
   *  resolves, so the shell must not become interactive while unknown. `null`
   *  means "not answered yet" and is kept distinct from "locked": the overlay
   *  is drawn only once main has spoken, otherwise every start would flash a
   *  lock panel — even for users who never configured a password. */
  const [lockState, setLockState] = useState<LockSettingsState | null>(null)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  // Lock state: pulled once (it may already be locked at startup) and then kept
  // in sync from main, which owns the state — the renderer never decides.
  useEffect(() => {
    let alive = true
    void window.api.getLockState().then(
      (state: LockSettingsState) => {
        if (alive) setLockState(state)
      },
      (err: unknown) => {
        console.error('[lock] getLockState failed', err)
        // Stay recoverable: fall back to "locked with no verifier" so the panel
        // (and its input) is reachable. Main unlocks an unconfigured app on the
        // first attempt, so the user is never stuck on the boot layer.
        if (alive) {
          setLockState({
            configured: false,
            enabled: false,
            autoLockMinutes: 0,
            lockAtStartup: false,
            locked: true
          })
        }
      }
    )
    const off = window.api.onLockStateChanged((state: LockSettingsState) => setLockState(state))
    return () => {
      alive = false
      off()
    }
  }, [])

  // Unknown counts as locked: main owns the state and may already be locked.
  const locked = lockState === null || lockState.locked

  // Locking is app-wide: close antd portals that live outside `.app-root`
  // (the settings modal otherwise stays focusable behind the opaque mask),
  // and expose the state to window-level hotkey listeners — they see 'true'
  // during the unknown window as well, which is the point.
  useEffect(() => {
    document.documentElement.dataset.locked = locked ? 'true' : 'false'
    if (locked) setSettingsOpen(false)
    // Portals (antd modals, dropdowns, tooltips) attach to document.body,
    // outside the inert `#root` subtree, so a keyboard user could still Tab
    // into whatever happened to be open when the lock engaged. Inert every
    // other body child while locked; the overlay itself lives inside #root,
    // above the inert `.app-root`, and stays reachable.
    const appRoot = document.getElementById('root')
    const inerted: Element[] = []
    if (locked) {
      for (const el of Array.from(document.body.children)) {
        if (el === appRoot) continue
        try {
          el.setAttribute('inert', '')
          inerted.push(el)
        } catch {
          // a node that refuses the attribute must not break the lock
        }
      }
    }
    return () => {
      for (const el of inerted) el.removeAttribute('inert')
    }
  }, [locked])

  // Interface language: t() reads the module-level language at render time, so
  // sync it before the tree renders — an effect would paint one frame late.
  // Silent on purpose: notifying subscribers during a render is what React
  // warns about; every language change re-renders App via the settings store.
  syncLanguage(storedLanguage)
  const language = storedLanguage
  useEffect(() => {
    document.documentElement.lang = language
  }, [language])

  // Sidebar / tab bars / dividers follow the active terminal theme.
  useEffect(() => {
    applyChromeTheme(getThemeById(themeId, customThemes).colors)
  }, [themeId, customThemes])

  // Active-tab accent color (rail indicator, tab outline, SSH badges).
  useEffect(() => {
    applyTabAccent(tabAccentColor)
  }, [tabAccentColor])

  return (
    <ConfigProvider locale={ANTD_LOCALES[language]}>
      <>
        {/* Locked: the shell goes inert (no focus, no pointer, hidden from
            assistive tech) but stays mounted — unmounting it would kill the
            local/SSH sessions and the transfer list behind the overlay.
            `inert` is listed before aria-hidden so focus leaves the subtree
            before the browser checks for a focused descendant. */}
        <div className="app-root" inert={locked || undefined} aria-hidden={locked || undefined}>
          <TitleBar />
          <Workspace onOpenSettings={() => setSettingsOpen(true)} />
          <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
          <TransferPanel />
        </div>
        {/* Unknown state paints the opaque layer alone: the shell stays hidden
            and no panel is shown, so startup cannot flash a lock screen. */}
        {lockState === null ? (
          <div className="lock-screen-boot" />
        ) : locked ? (
          <LockScreen state={lockState} onStateChange={setLockState} />
        ) : null}
      </>
    </ConfigProvider>
  )
}
