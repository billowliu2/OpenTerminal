import { useMemo, useState } from 'react'
import { Button, Modal, Tabs } from 'antd'
import type { TabsProps } from 'antd'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { useSettingsStore } from './store'
import { CursorSettingsTab, FontSettingsTab, RenderSettingsTab, SystemSettingsTab } from './SettingsTabs'
import { ThemeSettingsTab } from './ThemeSettingsTab'
import { HighlightTab } from './HighlightTab'
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

  const tabItems: TabsProps['items'] = [
    { key: 'font', label: '字体', children: <FontSettingsTab /> },
    { key: 'cursor', label: '光标与滚动', children: <CursorSettingsTab /> },
    { key: 'render', label: '渲染与行为', children: <RenderSettingsTab /> },
    { key: 'highlight', label: '高亮', children: <HighlightTab /> },
    {
      key: 'theme',
      label: '主题',
      children: (
        <ThemeSettingsTab
          onEditTheme={(themeId) => setEditorState({ open: true, themeId })}
          onCreateTheme={() => setEditorState({ open: true, themeId: undefined })}
        />
      )
    },
    { key: 'system', label: '系统', children: <SystemSettingsTab /> }
  ]

  const closeEditor = (): void => setEditorState((prev) => (prev.open ? { ...prev, open: false } : prev))

  const handleResetDefaults = (): void => {
    void updateTerminal({ ...DEFAULT_SETTINGS.terminal })
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={760}
      title="设置"
      footer={
        <div className="settings-footer">
          <Button onClick={handleResetDefaults}>恢复默认</Button>
          <Button type="primary" onClick={onClose}>
            关闭
          </Button>
        </div>
      }
    >
      <Tabs defaultActiveKey="font" items={tabItems} />
      <ThemeEditor
        open={editorState.open}
        onClose={closeEditor}
        themeId={editorState.themeId}
      />
    </Modal>
  )
}