import type { ReactNode } from 'react'
import type { TerminalSettings } from '@shared/settings'

/** font stack shown as the persistent "默认" option */
export const DEFAULT_FONT_STACK = "'Cascadia Mono', Consolas, 'JetBrains Mono', 'Courier New', monospace"

export const WEIGHT_OPTIONS = [100, 200, 300, 400, 500, 600, 700, 800, 900]

export const weightOptions = WEIGHT_OPTIONS.map((w) => ({ value: w, label: String(w) }))

export const cursorStyleOptions: Array<{ value: TerminalSettings['cursorStyle']; label: string }> = [
  { value: 'bar', label: '竖线 (bar)' },
  { value: 'block', label: '方块 (block)' },
  { value: 'underline', label: '下划线 (underline)' }
]

export const inactiveCursorStyleOptions: Array<{
  value: TerminalSettings['cursorInactiveStyle']
  label: string
}> = [
  { value: 'outline', label: '轮廓 (outline)' },
  { value: 'block', label: '方块 (block)' },
  { value: 'bar', label: '竖线 (bar)' },
  { value: 'underline', label: '下划线 (underline)' },
  { value: 'none', label: '无 (none)' }
]

export const rendererModeOptions: Array<{
  value: TerminalSettings['rendererMode']
  label: string
  hint: string
}> = [
  { value: 'auto', label: '自动', hint: '优先使用 WebGL 加速，失败时自动回退到 DOM 渲染' },
  { value: 'webgl', label: '高性能 WebGL', hint: '强制使用 GPU 加速渲染，适合高刷新率与大行数滚动' },
  { value: 'dom', label: '兼容 DOM', hint: '纯 CPU 渲染，兼容性最好，适合无 GPU 或远程桌面环境' }
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