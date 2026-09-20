import { useEffect, useMemo, useState } from 'react'
import { Button, Modal, Tabs } from 'antd'
import type { TabsProps } from 'antd'
import { t } from '@shared/i18n'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { useSettingsStore } from './store'
import { CursorSettingsTab, FontSettingsTab, RenderSettingsTab, SystemSettingsTab } from './SettingsTabs'
import { ThemeSettingsTab } from './ThemeSettingsTab'
import { HighlightTab } from './HighlightTab'
import { AboutTab } from './AboutTab'
import { ThemeEditor } from '../theme/editor/ThemeEditor'
import './settings.css'

export interface SettingsDialogProps {
  open: boolean
  onClose: () => void
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps): React.JSX.Element {
  const updateTerminal = useSettingsStore((s) => s.updateTerminal)
  const [editorState, setEditorState] = useState<{ open: boolean; themeId?: string }>({
    open: false
  })
  // Dialog size: proportional to the main window by default, user-draggable
  // afterwards. `null` means "use the proportional default". While the dialog
  // is open, a main-window resize re-derives that default in real time.
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [winSize, setWinSize] = useState({ w: window.innerWidth, h: window.innerHeight })
  useEffect(() => {
    if (open) setSize(null)
  }, [open])
  useEffect(() => {
    if (!open) return
    const onResize = (): void => setWinSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open])

  const clampToWindow = (w: number, h: number): { w: number; h: number } => ({
    w: Math.max(720, Math.min(w, winSize.w - 96)),
    h: Math.max(440, Math.min(h, winSize.h - 140))
  })
  const dialogSize = size
    ? clampToWindow(size.w, size.h)
    : clampToWindow(Math.round(winSize.w * 0.7), Math.round(winSize.h * 0.7))
  // The modal chrome (header + footer + paddings) is ~132px; the body takes the rest.
  const bodyHeight = Math.max(360, dialogSize.h - 132)

  const startResize = (e: React.MouseEvent<HTMLSpanElement>): void => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startY = e.clientY
    const base = dialogSize
    const onMove = (ev: MouseEvent): void => {
      const w = Math.max(720, Math.min(window.innerWidth - 96, base.w + (ev.clientX - startX)))
      const h = Math.max(440, Math.min(window.innerHeight - 140, base.h + (ev.clientY - startY)))
      setSize({ w, h })
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'nwse-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const tabItems: TabsProps['items'] = [
    { key: 'font', label: t('settings.tabs.font'), children: <FontSettingsTab /> },
    { key: 'cursor', label: t('settings.tabs.cursor'), children: <CursorSettingsTab /> },
    { key: 'render', label: t('settings.tabs.render'), children: <RenderSettingsTab /> },
    { key: 'highlight', label: t('settings.tabs.highlight'), children: <HighlightTab /> },
    {
      key: 'theme',
      label: t('settings.tabs.theme'),
      children: (
        <ThemeSettingsTab
          onEditTheme={(themeId) => setEditorState({ open: true, themeId })}
          onCreateTheme={() => setEditorState({ open: true, themeId: undefined })}
        />
      )
    },
    { key: 'system', label: t('settings.tabs.system'), children: <SystemSettingsTab /> },
    { key: 'about', label: t('settings.tabs.about'), children: <AboutTab /> }
  ]

  const closeEditor = (): void => setEditorState((prev) => (prev.open ? { ...prev, open: false } : prev))

  const handleResetDefaults = (): void => {
    void updateTerminal({ ...DEFAULT_SETTINGS.terminal })
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      centered
      width={dialogSize.w}
      title={t('settings.title')}
      footer={
        <div className="settings-footer">
          <Button onClick={handleResetDefaults}>{t('common.reset')}</Button>
          <Button type="primary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      }
    >
      <div className="settings-body" style={{ height: bodyHeight }}>
        <Tabs tabPosition="left" defaultActiveKey="font" items={tabItems} />
      </div>
      {/* Drag corner: resizes the dialog until it is closed. */}
      <span
        className="settings-resize"
        title={t('settings.resizeHandle')}
        aria-label={t('settings.resizeHandle')}
        onMouseDown={startResize}
      />
      <ThemeEditor
        open={editorState.open}
        onClose={closeEditor}
        themeId={editorState.themeId}
      />
    </Modal>
  )
}