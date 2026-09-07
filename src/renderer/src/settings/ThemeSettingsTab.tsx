import { useMemo } from 'react'
import { Button, Popconfirm } from 'antd'
import type { TerminalSettings } from '@shared/settings'
import { DEFAULT_SETTINGS } from '@shared/settings'
import type { TerminalTheme, ThemeColors } from '@shared/theme'
import { BUILTIN_THEMES } from '@shared/theme'
import { useSettingsStore, useResolvedTheme } from './store'

export interface ThemeSettingsTabProps {
  onCreateTheme: () => void
  onEditTheme: (themeId: string) => void
}

const ANSI_KEYS: ReadonlyArray<keyof ThemeColors> = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white'
]

export function ThemeSettingsTab({
  onCreateTheme,
  onEditTheme
}: ThemeSettingsTabProps): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const updateTerminal = useSettingsStore((s) => s.updateTerminal)
  const setCustomThemes = useSettingsStore((s) => s.setCustomThemes)
  const activeTheme = useResolvedTheme()

  const themeCards = useMemo(
    () => [...BUILTIN_THEMES, ...settings.customThemes],
    [settings.customThemes]
  )

  const handleDelete = async (themeId: string): Promise<void> => {
    const next = settings.customThemes.filter((t) => t.id !== themeId)
    if (settings.terminal.themeId === themeId) {
      // currently-active custom theme removed — fall back to the default dark theme
      await updateTerminal({ themeId: DEFAULT_SETTINGS.terminal.themeId })
    }
    await setCustomThemes(next)
  }

  return (
    <div className="theme-gallery">
      {themeCards.map((t) => {
        const selected = t.id === activeTheme.id
        const isCustom = t.builtin === false
        return (
          <div
            key={t.id}
            className={selected ? 'theme-card theme-card-selected' : 'theme-card'}
            onClick={() => void updateTerminal({ themeId: t.id })}
            title={t.name}
          >
            <div className="theme-card-bg" style={{ background: t.colors.background }} />
            <div className="theme-card-body">
              <div className="theme-card-name-row">
                <span className="theme-card-name">{t.name}</span>
                {isCustom && <span className="theme-card-badge">自定义</span>}
              </div>
              <div className="theme-card-dots">
{ANSI_KEYS.map((k) => (
                  <span
                    key={k}
                    className="theme-card-dot"
                    style={{ background: t.colors[k] }}
                  />
                ))}
              </div>
              <div className="theme-card-actions">
                {isCustom ? (
                  <>
                    <Button
                      size="small"
                      onClick={(e) => {
                        e.stopPropagation()
                        onEditTheme(t.id)
                      }}
                    >
                      编辑
                    </Button>
                    <Popconfirm
                      title="删除自定义主题"
                      description="删除后无法恢复，确定继续？"
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={(e) => {
                        e?.stopPropagation()
                        void handleDelete(t.id)
                      }}
                    >
                      <Button
                        size="small"
                        danger
                        onClick={(e) => e.stopPropagation()}
                        title="删除"
                      >
                        删除
                      </Button>
                    </Popconfirm>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        )
      })}

      <div className="theme-card theme-card-new" onClick={onCreateTheme}>
        <div className="theme-card-new-icon">+</div>
        <div className="theme-card-new-text">新建主题</div>
      </div>
    </div>
  )
}