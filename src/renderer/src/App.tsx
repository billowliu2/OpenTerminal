import { useEffect, useState } from 'react'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import zhTW from 'antd/locale/zh_TW'
import enUS from 'antd/locale/en_US'
import jaJP from 'antd/locale/ja_JP'
import Workspace from '@renderer/workspace/Workspace'
import { SettingsDialog } from '@renderer/settings/SettingsDialog'
import { TransferPanel } from '@renderer/sftp/TransferPanel'
import { useSettingsStore } from '@renderer/settings/store'
import { getThemeById } from '@shared/theme'
import { DEFAULT_LANGUAGE, syncLanguage, type Language } from '@shared/i18n'
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

  useEffect(() => {
    void hydrate()
  }, [hydrate])

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
      <div className="app-root">
        <TitleBar />
        <Workspace onOpenSettings={() => setSettingsOpen(true)} />
        <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        <TransferPanel />
      </div>
    </ConfigProvider>
  )
}
