import type { ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { Input, InputNumber, Radio, Select, Switch } from 'antd'
import type { ThemeColors } from '@shared/theme'
import { useSettingsStore, useResolvedTheme } from './store'
import {
  DEFAULT_FONT_STACK,
  SettingRow,
  cursorStyleOptions,
  inactiveCursorStyleOptions,
  rendererModeOptions,
  weightOptions
} from './fields'

export function FontSettingsTab(): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const updateTerminal = useSettingsStore((s) => s.updateTerminal)
  const theme = useResolvedTheme()

  const [fonts, setFonts] = useState<string[]>([])

  // refresh system font list when the component mounts (dialog open first time);
  // results are cached for this component's lifetime
  useState(() => {
    window.api.listFonts().then(
      (list: string[]) => setFonts(list.filter((f: string) => f !== '')),
      (err: unknown) => console.error('[settings] listFonts failed', err)
    )
    return []
  })

  const fontOptions = useMemo(() => {
    const seen = new Set<string>()
    const items: Array<{ value: string; label: ReactNode }> = []
    for (const f of fonts) {
      if (seen.has(f)) continue
      seen.add(f)
      items.push({ value: f, label: <span style={{ fontFamily: f }}>{f}</span> })
    }
    return items
  }, [fonts])

  /** map the persisted family to a recognized option value (default / system font / verbatim) */
  const selectedFont = (): string => {
    const cur = settings.terminal.fontFamily
    if (cur === DEFAULT_FONT_STACK) return 'default'
    if (fonts.includes(cur)) return cur
    return cur
  }

  const handleFontChange = (value: string): void => {
    void updateTerminal({
      fontFamily: value === 'default' ? DEFAULT_FONT_STACK : value
    })
  }

  return (
    <div className="settings-pane">
      <SettingRow
        label="字体"
        desc="内置默认字体或系统等宽字体"
        control={
          <Select
            className="settings-select"
            showSearch
            placeholder="选择字体"
            value={selectedFont()}
            onChange={handleFontChange}
            options={[
              { value: 'default', label: <span style={{ fontFamily: DEFAULT_FONT_STACK }}>默认</span> },
              ...fontOptions
            ]}
            filterOption={(input, option) =>
              typeof option?.value === 'string' &&
              option.value.toLowerCase().includes(input.toLowerCase())
            }
          />
        }
      />
      <SettingRow
        label="字号"
        desc="终端文字的像素大小"
        control={
          <InputNumber
            className="settings-input-number"
            min={8}
            max={40}
            value={settings.terminal.fontSize}
            onChange={(v) => {
              if (v !== null) void updateTerminal({ fontSize: v })
            }}
          />
        }
      />
      <SettingRow
        label="字重"
        desc="400 为常规，700 为粗体"
        control={
          <Select
            className="settings-select"
            value={settings.terminal.fontWeight}
            onChange={(v) => {
              if (v !== null) void updateTerminal({ fontWeight: v })
            }}
            options={weightOptions}
          />
        }
      />
      <SettingRow
        label="粗体字重"
        desc="粗体文字所用的字重"
        control={
          <Select
            className="settings-select"
            value={settings.terminal.boldFontWeight}
            onChange={(v) => {
              if (v !== null) void updateTerminal({ boldFontWeight: v })
            }}
            options={weightOptions}
          />
        }
      />
      <SettingRow
        label="字间距"
        desc="字符之间的水平间距"
        control={
          <InputNumber
            className="settings-input-number"
            min={0}
            max={10}
            step={0.5}
            value={settings.terminal.letterSpacing}
            onChange={(v) => {
              if (v !== null) void updateTerminal({ letterSpacing: v })
            }}
          />
        }
      />
      <SettingRow
        label="行高"
        desc="相邻两行之间的垂直距离"
        control={
          <InputNumber
            className="settings-input-number"
            min={0.8}
            max={2}
            step={0.05}
            value={settings.terminal.lineHeight}
            onChange={(v) => {
              if (v !== null) void updateTerminal({ lineHeight: v })
            }}
          />
        }
      />

      <TerminalPreview
        fontFamily={settings.terminal.fontFamily}
        fontSize={settings.terminal.fontSize}
        fontWeight={settings.terminal.fontWeight}
        lineHeight={settings.terminal.lineHeight}
        letterSpacing={settings.terminal.letterSpacing}
        colors={theme.colors}
      />
    </div>
  )
}

export function CursorSettingsTab(): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const updateTerminal = useSettingsStore((s) => s.updateTerminal)
  return (
    <div className="settings-pane">
      <SettingRow
        label="光标闪烁"
        desc="光标是否周期性闪烁"
        control={
          <Switch
            checked={settings.terminal.cursorBlink}
            onChange={(checked) => void updateTerminal({ cursorBlink: checked })}
          />
        }
      />
      <SettingRow
        label="光标样式"
        desc="光标的显示形状"
        control={
          <Select
            className="settings-select"
            value={settings.terminal.cursorStyle}
            onChange={(v) => {
              if (v !== null) void updateTerminal({ cursorStyle: v })
            }}
            options={cursorStyleOptions}
          />
        }
      />
      <SettingRow
        label="非活动光标样式"
        desc="窗口失焦时光标样式"
        control={
          <Select
            className="settings-select"
            value={settings.terminal.cursorInactiveStyle}
            onChange={(v) => {
              if (v !== null) void updateTerminal({ cursorInactiveStyle: v })
            }}
            options={inactiveCursorStyleOptions}
          />
        }
      />
      <SettingRow
        label="滚动缓冲区"
        desc="屏幕上可回滚的行数"
        control={
          <InputNumber
            className="settings-input-number"
            min={100}
            max={100000}
            step={500}
            value={settings.terminal.scrollback}
            onChange={(v) => {
              if (v !== null) void updateTerminal({ scrollback: v })
            }}
          />
        }
      />
    </div>
  )
}

export function RenderSettingsTab(): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const updateTerminal = useSettingsStore((s) => s.updateTerminal)
  return (
    <div className="settings-pane">
      <div className="settings-block-label">
        渲染模式
        <span className="settings-block-hint">终端单元渲染加速方式，改动将应用到所有终端</span>
      </div>
      <Radio.Group
        className="settings-radio-group"
        value={settings.terminal.rendererMode}
        onChange={(e) => void updateTerminal({ rendererMode: e.target.value })}
        options={rendererModeOptions}
        optionType="button"
        buttonStyle="solid"
      />
      <div className="settings-block-hint settings-render-hint">
        {rendererModeOptions.find((o) => o.value === settings.terminal.rendererMode)?.hint}
      </div>
      <SettingRow
        label="自动换行"
        desc="超出宽度时自动折行"
        control={
          <Switch
            checked={settings.terminal.autoWrap}
            onChange={(checked) => void updateTerminal({ autoWrap: checked })}
          />
        }
      />
      <SettingRow
        label="选中即复制"
        desc="鼠标选中文字时自动复制"
        control={
          <Switch
            checked={settings.terminal.copyOnSelect}
            onChange={(checked) => void updateTerminal({ copyOnSelect: checked })}
          />
        }
      />
      <SettingRow
        label="粘贴风险确认"
        desc="粘贴前弹出风险确认提示"
        control={
          <Switch
            checked={settings.terminal.pasteRiskConfirm}
            onChange={(checked) => void updateTerminal({ pasteRiskConfirm: checked })}
          />
        }
      />
      <SettingRow
        label="输入建议"
        desc="输入时弹出命令建议；Tab 接受，回车始终直接执行"
        control={
          <Switch
            checked={settings.terminal.suggestEnabled}
            onChange={(checked) => void updateTerminal({ suggestEnabled: checked })}
          />
        }
      />
    </div>
  )
}

export function SystemSettingsTab(): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const updateSystem = useSettingsStore((s) => s.updateSystem)
  return (
    <div className="settings-pane">
      <SettingRow
        label="开机时自启动"
        desc="开机时自动启动软件（开发模式下注册的是开发版程序）"
        control={
          <Switch
            checked={settings.system.launchAtLogin}
            onChange={(checked) => void updateSystem({ launchAtLogin: checked })}
          />
        }
      />
      <SettingRow
        label="阻止系统休眠"
        desc="开启后 OpenTerminal 将阻止系统自动休眠；关闭则允许系统按系统设置休眠"
        control={
          <Switch
            checked={settings.system.preventSleep}
            onChange={(checked) => void updateSystem({ preventSleep: checked })}
          />
        }
      />
      <SettingRow
        label="关闭按钮行为"
        desc="点击窗口关闭按钮时的动作；最小化到托盘后可在托盘图标右键菜单中退出"
        control={
          <Select
            className="settings-select"
            value={settings.system.closeAction ?? 'tray'}
            onChange={(value) => void updateSystem({ closeAction: value })}
            options={[
              { value: 'tray', label: '最小化到托盘' },
              { value: 'exit', label: '直接退出' },
              { value: 'ask', label: '每次询问' }
            ]}
          />
        }
      />
      <SettingRow
        label="全局唤起快捷键"
        desc="Control+Shift+Alt+T 等，留空禁用"
        control={
          <Input
            className="settings-select"
            placeholder="如 Control+Shift+Alt+T，留空禁用"
            value={settings.system.globalShowHide ?? ''}
            onChange={(e) => void updateSystem({ globalShowHide: e.target.value })}
          />
        }
      />
      <div className="settings-block-hint settings-shortcut-hint">
        配合全局键可在任何界面唤起/隐藏窗口；若注册失败（与其他软件冲突）则不生效，应用不会报错。
      </div>
    </div>
  )
}

/**
 * Live preview of the current font settings, rendered as an `ls -la`-style
 * terminal screen with ANSI-colored tokens on the active theme background.
 */
function TerminalPreview({
  fontFamily,
  fontSize,
  fontWeight,
  lineHeight,
  letterSpacing,
  colors
}: {
  fontFamily: string
  fontSize: number
  fontWeight: number
  lineHeight: number
  letterSpacing: number
  colors: ThemeColors
}): React.JSX.Element {
  const lines: Array<ReactNode> = [
    <span>
      <span style={{ color: colors.yellow }}>drwxr-xr-x</span>{' '}
      <span style={{ color: colors.brightBlack }}>12 bill users 4096 Sep 5 10:02</span>{' '}
      <span style={{ color: colors.brightBlue }}>node_modules</span>
    </span>,
    <span>
      <span style={{ color: colors.red }}>-rw-r--r--</span>{' '}
      <span style={{ color: colors.brightBlack }}>1 bill users 890 Sep 5 09:41</span>{' '}
      <span style={{ color: colors.white }}>package.json</span>
    </span>,
    <span>
      <span style={{ color: colors.red }}>-rw-r--r--</span>{' '}
      <span style={{ color: colors.brightBlack }}>1 bill users 42 Sep 5 09:41</span>{' '}
      <span style={{ color: colors.green }}>index.ts</span>
    </span>,
    <span>
      <span style={{ color: colors.brightCyan }}>
        bill@desktop:~$ _
      </span>
    </span>
  ]
  const gridStyle: React.CSSProperties = {
    fontFamily,
    fontSize,
    fontWeight,
    lineHeight,
    letterSpacing
  }
  return (
    <div className="settings-preview" style={{ background: colors.background }}>
      <span className="settings-preview-title">预览</span>
      <div className="settings-preview-grid" style={gridStyle}>
        {lines.map((l, i) => (
          <div key={i} className="settings-preview-line">
            {l}
          </div>
        ))}
      </div>
    </div>
  )
}