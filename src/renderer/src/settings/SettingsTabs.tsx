import type { ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { Input, InputNumber, Radio, Select, Switch } from 'antd'
import type { ThemeColors } from '@shared/theme'
import { DEFAULT_LANGUAGE, LANGUAGES, t, type Language } from '@shared/i18n'
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
        label={t('settings.font.label')}
        desc={t('settings.font.desc')}
        control={
          <Select
            className="settings-select"
            showSearch
            placeholder={t('settings.font.placeholder')}
            value={selectedFont()}
            onChange={handleFontChange}
            options={[
              {
                value: 'default',
                label: <span style={{ fontFamily: DEFAULT_FONT_STACK }}>{t('settings.font.default')}</span>
              },
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
        label={t('settings.font.size')}
        desc={t('settings.font.sizeDesc')}
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
        label={t('settings.font.weight')}
        desc={t('settings.font.weightDesc')}
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
        label={t('settings.font.boldWeight')}
        desc={t('settings.font.boldWeightDesc')}
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
        label={t('settings.font.letterSpacing')}
        desc={t('settings.font.letterSpacingDesc')}
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
        label={t('settings.font.lineHeight')}
        desc={t('settings.font.lineHeightDesc')}
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
        label={t('settings.cursor.blink')}
        desc={t('settings.cursor.blinkDesc')}
        control={
          <Switch
            checked={settings.terminal.cursorBlink}
            onChange={(checked) => void updateTerminal({ cursorBlink: checked })}
          />
        }
      />
      <SettingRow
        label={t('settings.cursor.style')}
        desc={t('settings.cursor.styleDesc')}
        control={
          <Select
            className="settings-select"
            value={settings.terminal.cursorStyle}
            onChange={(v) => {
              if (v !== null) void updateTerminal({ cursorStyle: v })
            }}
            options={cursorStyleOptions()}
          />
        }
      />
      <SettingRow
        label={t('settings.cursor.inactiveStyle')}
        desc={t('settings.cursor.inactiveStyleDesc')}
        control={
          <Select
            className="settings-select"
            value={settings.terminal.cursorInactiveStyle}
            onChange={(v) => {
              if (v !== null) void updateTerminal({ cursorInactiveStyle: v })
            }}
            options={inactiveCursorStyleOptions()}
          />
        }
      />
      <SettingRow
        label={t('settings.cursor.scrollback')}
        desc={t('settings.cursor.scrollbackDesc')}
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
  const rendererModes = rendererModeOptions()
  return (
    <div className="settings-pane">
      <div className="settings-block-label">
        {t('settings.render.modeLabel')}
        <span className="settings-block-hint">{t('settings.render.modeHint')}</span>
      </div>
      <Radio.Group
        className="settings-radio-group"
        value={settings.terminal.rendererMode}
        onChange={(e) => void updateTerminal({ rendererMode: e.target.value })}
        options={rendererModes}
        optionType="button"
        buttonStyle="solid"
      />
      <div className="settings-block-hint settings-render-hint">
        {rendererModes.find((o) => o.value === settings.terminal.rendererMode)?.hint}
      </div>
      <SettingRow
        label={t('settings.render.autoWrap')}
        desc={t('settings.render.autoWrapDesc')}
        control={
          <Switch
            checked={settings.terminal.autoWrap}
            onChange={(checked) => void updateTerminal({ autoWrap: checked })}
          />
        }
      />
      <SettingRow
        label={t('settings.render.copyOnSelect')}
        desc={t('settings.render.copyOnSelectDesc')}
        control={
          <Switch
            checked={settings.terminal.copyOnSelect}
            onChange={(checked) => void updateTerminal({ copyOnSelect: checked })}
          />
        }
      />
      <SettingRow
        label={t('settings.render.pasteRiskConfirm')}
        desc={t('settings.render.pasteRiskConfirmDesc')}
        control={
          <Switch
            checked={settings.terminal.pasteRiskConfirm}
            onChange={(checked) => void updateTerminal({ pasteRiskConfirm: checked })}
          />
        }
      />
      <SettingRow
        label={t('settings.render.suggest')}
        desc={t('settings.render.suggestDesc')}
        control={
          <Switch
            checked={settings.terminal.suggestEnabled}
            onChange={(checked) => void updateTerminal({ suggestEnabled: checked })}
          />
        }
      />
      <SettingRow
        label={t('settings.render.history')}
        desc={t('settings.render.historyDesc')}
        control={
          <Switch
            checked={settings.terminal.historyEnabled}
            onChange={(checked) => void updateTerminal({ historyEnabled: checked })}
          />
        }
      />
      <SettingRow
        label={t('settings.render.historyLimit')}
        desc={t('settings.render.historyLimitDesc')}
        control={
          <InputNumber
            min={1}
            max={500}
            step={10}
            value={settings.terminal.historyLimit}
            disabled={settings.terminal.historyEnabled === false}
            onChange={(value) => {
              if (typeof value === 'number') void updateTerminal({ historyLimit: value })
            }}
            style={{ width: 110 }}
          />
        }
      />
      <SettingRow
        label={t('settings.render.recButton')}
        desc={t('settings.render.recButtonDesc')}
        control={
          <Switch
            checked={settings.terminal.showRecButton}
            onChange={(checked) => void updateTerminal({ showRecButton: checked })}
          />
        }
      />
      <SettingRow
        label={t('settings.render.openLogsButton')}
        desc={t('settings.render.openLogsButtonDesc')}
        control={
          <Switch
            checked={settings.terminal.showOpenLogsButton}
            onChange={(checked) => void updateTerminal({ showOpenLogsButton: checked })}
          />
        }
      />
      <SettingRow
        label={t('settings.render.openCwdButton')}
        desc={t('settings.render.openCwdButtonDesc')}
        control={
          <Switch
            checked={settings.terminal.showOpenCwdButton}
            onChange={(checked) => void updateTerminal({ showOpenCwdButton: checked })}
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
      {/* Interface language — first row: the whole dialog re-renders on change. */}
      <div className="settings-block-label">{t('common.language')}</div>
      <Radio.Group
        className="settings-language-group"
        value={settings.system.language ?? DEFAULT_LANGUAGE}
        onChange={(e) => void updateSystem({ language: e.target.value as Language })}
        options={LANGUAGES.map((l) => ({ value: l.value, label: l.label }))}
        optionType="button"
        buttonStyle="solid"
      />
      <div className="settings-block-hint settings-language-hint">{t('common.languageDesc')}</div>
      <SettingRow
        label={t('settings.system.launchAtLogin')}
        desc={t('settings.system.launchAtLoginDesc')}
        control={
          <Switch
            checked={settings.system.launchAtLogin}
            onChange={(checked) => void updateSystem({ launchAtLogin: checked })}
          />
        }
      />
      <SettingRow
        label={t('settings.system.preventSleep')}
        desc={t('settings.system.preventSleepDesc')}
        control={
          <Switch
            checked={settings.system.preventSleep}
            onChange={(checked) => void updateSystem({ preventSleep: checked })}
          />
        }
      />
      <SettingRow
        label={t('settings.system.restoreSession')}
        desc={t('settings.system.restoreSessionDesc')}
        control={
          <Switch
            checked={settings.system.restoreSession !== false}
            onChange={(checked) => void updateSystem({ restoreSession: checked })}
          />
        }
      />
      <SettingRow
        label={t('settings.system.shellIntegration')}
        desc={t('settings.system.shellIntegrationDesc')}
        control={
          <Switch
            checked={settings.system.shellIntegration === true}
            onChange={(checked) => void updateSystem({ shellIntegration: checked })}
          />
        }
      />
      <SettingRow
        label={t('settings.system.closeAction')}
        desc={t('settings.system.closeActionDesc')}
        control={
          <Select
            className="settings-select"
            value={settings.system.closeAction ?? 'tray'}
            onChange={(value) => void updateSystem({ closeAction: value })}
            options={[
              { value: 'tray', label: t('settings.system.closeActionTray') },
              { value: 'exit', label: t('settings.system.closeActionExit') },
              { value: 'ask', label: t('settings.system.closeActionAsk') }
            ]}
          />
        }
      />
      <SettingRow
        label={t('settings.system.globalShortcut')}
        desc={t('settings.system.globalShortcutDesc')}
        control={
          <ShortcutInput
            value={settings.system.globalShowHide ?? ''}
            onChange={(v) => void updateSystem({ globalShowHide: v })}
          />
        }
      />
      <div className="settings-block-hint settings-shortcut-hint">
        {t('settings.system.globalShortcutHint')}
      </div>
    </div>
  )
}

/**
 * Convert a keydown into an Electron globalShortcut accelerator (e.g.
 * "Control+Shift+Alt+T"). Returns null while only modifiers are held or for
 * keys we don't want to bind. The Win key maps to Super.
 */
function acceleratorFromEvent(e: React.KeyboardEvent<HTMLInputElement>): string | null {
  const modifierCodes = new Set([
    'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
    'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight'
  ])
  if (modifierCodes.has(e.code)) return null
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Control')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Super')
  let key: string | null = null
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3)
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5)
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code
  else if (/^Numpad[0-9]$/.test(e.code)) key = `num${e.code.slice(6)}`
  else {
    const named: Record<string, string> = {
      Space: 'Space', Tab: 'Tab', Enter: 'Return', NumpadEnter: 'Return',
      ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
      Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
      Insert: 'Insert', Delete: 'Delete', Backspace: 'Backspace',
      Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
      Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
      NumpadAdd: 'numadd', NumpadSubtract: 'numsub',
      NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec'
    }
    key = named[e.code] ?? null
  }
  if (!key) return null
  // Guard against hijacking plain typing: a global shortcut must involve a
  // modifier, unless it is a function key (F1-F12 are safe standalone).
  const isFunctionKey = /^F\d{1,2}$/.test(key)
  if (parts.length === 0 && !isFunctionKey) return null
  parts.push(key)
  return parts.join('+')
}

/**
 * Press-to-record input for the global shortcut: focus it, hit the combo, the
 * accelerator is captured and saved. Esc cancels recording, Backspace/Delete
 * clears (disables) the shortcut. Read-only so no stray text can be typed.
 */
function ShortcutInput({ value, onChange }: { value: string; onChange: (v: string) => void }): React.JSX.Element {
  const [recording, setRecording] = useState(false)
  return (
    <Input
      className={`settings-select shortcut-input${recording ? ' is-recording' : ''}`}
      readOnly
      value={recording ? t('settings.system.shortcutRecording') : value}
      placeholder={t('settings.system.shortcutPlaceholder')}
      onFocus={() => setRecording(true)}
      onBlur={() => setRecording(false)}
      onKeyDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
        if (e.key === 'Escape') {
          e.currentTarget.blur()
          return
        }
        if (e.key === 'Backspace' || e.key === 'Delete') {
          onChange('')
          e.currentTarget.blur()
          return
        }
        const accel = acceleratorFromEvent(e)
        if (accel) {
          onChange(accel)
          e.currentTarget.blur()
        }
      }}
    />
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
      <span className="settings-preview-title">{t('settings.preview')}</span>
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