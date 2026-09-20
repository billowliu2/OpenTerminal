import type { ReactNode } from 'react'
import { t } from '@shared/i18n'
import type { TerminalSettings } from '@shared/settings'

/** font stack shown as the persistent "默认" option */
export const DEFAULT_FONT_STACK = "'Cascadia Mono', Consolas, 'JetBrains Mono', 'Courier New', monospace"

export const WEIGHT_OPTIONS = [100, 200, 300, 400, 500, 600, 700, 800, 900]

export const weightOptions = WEIGHT_OPTIONS.map((w) => ({ value: w, label: String(w) }))

export const cursorStyleOptions = (): Array<{ value: TerminalSettings['cursorStyle']; label: string }> => [
  { value: 'bar', label: t('settings.cursorStyle.bar') },
  { value: 'block', label: t('settings.cursorStyle.block') },
  { value: 'underline', label: t('settings.cursorStyle.underline') }
]

export const inactiveCursorStyleOptions = (): Array<{
  value: TerminalSettings['cursorInactiveStyle']
  label: string
}> => [
  { value: 'outline', label: t('settings.cursorStyle.outline') },
  { value: 'block', label: t('settings.cursorStyle.block') },
  { value: 'bar', label: t('settings.cursorStyle.bar') },
  { value: 'underline', label: t('settings.cursorStyle.underline') },
  { value: 'none', label: t('settings.cursorStyle.none') }
]

export const rendererModeOptions = (): Array<{
  value: TerminalSettings['rendererMode']
  label: string
  hint: string
}> => [
  { value: 'auto', label: t('settings.rendererMode.auto'), hint: t('settings.rendererMode.autoHint') },
  {
    value: 'webgl',
    label: t('settings.rendererMode.webgl'),
    hint: t('settings.rendererMode.webglHint')
  },
  { value: 'dom', label: t('settings.rendererMode.dom'), hint: t('settings.rendererMode.domHint') }
]

/** one label + control row inside a settings pane */
export function SettingRow({
  label,
  desc,
  control
}: {
  label: ReactNode
  desc?: ReactNode
  control: ReactNode
}): React.JSX.Element {
  return (
    <div className="settings-row">
      <span className="settings-row-label">
        {label}
        {desc != null && <span className="settings-row-desc">{desc}</span>}
      </span>
      <div className="settings-row-control">{control}</div>
    </div>
  )
}