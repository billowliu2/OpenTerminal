import { useEffect, useState } from 'react'
import Workspace from '@renderer/workspace/Workspace'
import { SettingsDialog } from '@renderer/settings/SettingsDialog'
import { TransferPanel } from '@renderer/sftp/TransferPanel'
import { useSettingsStore } from '@renderer/settings/store'
import { getThemeById } from '@shared/theme'

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
      <span className="app-titlebar-title">OpenTerminal</span>
    </div>
  )
}

export default function App(): React.JSX.Element {
  const hydrate = useSettingsStore((s) => s.hydrate)
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  return (
    <div className="app-root">
      <TitleBar />
      <Workspace onOpenSettings={() => setSettingsOpen(true)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <TransferPanel />
    </div>
  )
}
