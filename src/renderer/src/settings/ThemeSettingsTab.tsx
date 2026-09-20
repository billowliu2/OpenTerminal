import { useMemo } from 'react'
import { Button, ColorPicker, Popconfirm, Slider } from 'antd'
import { t } from '@shared/i18n'
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

  const pickImage = async (): Promise<void> => {
    const files = await window.api.pickFiles()
    const image = files.find((f) => /\.(png|jpe?g|bmp|gif|webp|avif)$/i.test(f))
    if (image) await updateTerminal({ backgroundImage: image })
  }

  return (
    <div className="theme-pane">
      <div className="theme-accent-row">
        <div>
          <div className="settings-block-label">{t('settings.theme.backgroundImage')}</div>
          <div className="settings-block-hint">{t('settings.theme.backgroundImageDesc')}</div>
        </div>
        <div className="theme-accent-controls">
          <Button size="small" onClick={() => void pickImage()}>
            {t('settings.theme.chooseImage')}
          </Button>
          {settings.terminal.backgroundImage !== '' && (
            <Button size="small" onClick={() => void updateTerminal({ backgroundImage: '' })}>
              {t('settings.theme.clearImage')}
            </Button>
          )}
        </div>
      </div>
      {settings.terminal.backgroundImage !== '' && (
        <div className="theme-accent-row">
          <div>
            <div className="settings-block-label">{t('settings.theme.imageOpacity')}</div>
          </div>
          <Slider
            style={{ width: 200 }}
            min={10}
            max={100}
            step={5}
            value={settings.terminal.backgroundImageOpacity}
            onChange={(v) => void updateTerminal({ backgroundImageOpacity: v })}
          />
        </div>
      )}
      <div className="theme-accent-row">
        <div>
          <div className="settings-block-label">{t('settings.theme.accent')}</div>
          <div className="settings-block-hint">{t('settings.theme.accentDesc')}</div>
        </div>
        <div className="theme-accent-controls">
          <ColorPicker
            value={settings.terminal.tabAccentColor}
            onChange={(color) => void updateTerminal({ tabAccentColor: color.toHexString() })}
          />
          <Button
            size="small"
            onClick={() => void updateTerminal({ tabAccentColor: DEFAULT_SETTINGS.terminal.tabAccentColor })}
          >
            {t('common.reset')}
          </Button>
        </div>
      </div>
      <div className="theme-gallery">
      {themeCards.map((theme) => {
        const selected = theme.id === activeTheme.id
        const isCustom = theme.builtin === false
        return (
          <div
            key={theme.id}
            className={selected ? 'theme-card theme-card-selected' : 'theme-card'}
            onClick={() => void updateTerminal({ themeId: theme.id })}
            title={theme.name}
          >
            <div className="theme-card-bg" style={{ background: theme.colors.background }} />
            <div className="theme-card-body">
              <div className="theme-card-name-row">
                <span className="theme-card-name">{theme.name}</span>
                {isCustom && <span className="theme-card-badge">{t('settings.theme.customBadge')}</span>}
              </div>
              <div className="theme-card-dots">
{ANSI_KEYS.map((k) => (
                  <span
                    key={k}
                    className="theme-card-dot"
                    style={{ background: theme.colors[k] }}
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
                        onEditTheme(theme.id)
                      }}
                    >
                      {t('common.edit')}
                    </Button>
                    <Popconfirm
                      title={t('settings.theme.deleteTitle')}
                      description={t('settings.deleteConfirmDesc')}
                      okText={t('common.delete')}
                      cancelText={t('common.cancel')}
                      okButtonProps={{ danger: true }}
                      onConfirm={(e) => {
                        e?.stopPropagation()
                        void handleDelete(theme.id)
                      }}
                    >
                      <Button
                        size="small"
                        danger
                        onClick={(e) => e.stopPropagation()}
                        title={t('common.delete')}
                      >
                        {t('common.delete')}
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
        <div className="theme-card-new-text">{t('settings.theme.create')}</div>
      </div>
      </div>
    </div>
  )
}