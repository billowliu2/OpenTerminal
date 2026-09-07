import { useEffect, useMemo, useState } from 'react'
import { Input, Modal } from 'antd'
import type { ThemeColors, TerminalTheme } from '@shared/theme'
import { DEFAULT_DARK, getThemeById } from '@shared/theme'
import { useSettingsStore } from '../../settings/store'

export interface ThemeEditorProps {
  open: boolean
  onClose: () => void
  /**
   * Editing mode: theme id to edit (must exist in settings.customThemes).
   * Create mode: undefined — initial values are the currently active theme's colors.
   */
  themeId?: string
}

/** editable palette keys; cursorAccent is derived and intentionally not exposed */
type ColorKey = Exclude<keyof ThemeColors, 'cursorAccent'>

interface FieldSpec {
  key: ColorKey
  label: string
}

const HEADER_KEYS: FieldSpec[] = [
  { key: 'foreground', label: '前景' },
  { key: 'background', label: '背景' },
  { key: 'cursor', label: '光标' },
  { key: 'selectionBackground', label: '选区' }
]

const ANSI_KEYS: FieldSpec[] = [
  { key: 'black', label: 'Black' },
  { key: 'red', label: 'Red' },
  { key: 'green', label: 'Green' },
  { key: 'yellow', label: 'Yellow' },
  { key: 'blue', label: 'Blue' },
  { key: 'magenta', label: 'Magenta' },
  { key: 'cyan', label: 'Cyan' },
  { key: 'white', label: 'White' },
  { key: 'brightBlack', label: 'Bright Black' },
  { key: 'brightRed', label: 'Bright Red' },
  { key: 'brightGreen', label: 'Bright Green' },
  { key: 'brightYellow', label: 'Bright Yellow' },
  { key: 'brightBlue', label: 'Bright Blue' },
  { key: 'brightMagenta', label: 'Bright Magenta' },
  { key: 'brightCyan', label: 'Bright Cyan' },
  { key: 'brightWhite', label: 'Bright White' }
]

export function ThemeEditor({ open, onClose, themeId }: ThemeEditorProps): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const updateTerminal = useSettingsStore((s) => s.updateTerminal)
  const setCustomThemes = useSettingsStore((s) => s.setCustomThemes)

  /** create mode = themeId undefined; edit mode must point at a custom theme */
  const isCreate = themeId === undefined
  const editingTheme = useMemo(() => {
    if (themeId === undefined) return undefined
    return settings.customThemes.find((t) => t.id === themeId)
  }, [settings.customThemes, themeId])

  const [name, setName] = useState('')
  const [colors, setColors] = useState<ThemeColors>(DEFAULT_DARK.colors)
  const [saving, setSaving] = useState(false)

  // (re)initialize the form each time the modal opens
  useEffect(() => {
    if (!open) return
    if (!isCreate) {
      if (editingTheme === undefined) {
        // the target theme disappeared (e.g. deleted in another window) — close the editor
        onClose()
        return
      }
      setName(editingTheme.name)
      setColors({ ...editingTheme.colors })
    } else {
      /** create mode: seed a fresh copy based on the currently active theme */
      const active = getThemeById(settings.terminal.themeId, settings.customThemes)
      setName(active.name + '（副本）')
      setColors({ ...active.colors })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const handleSave = async (): Promise<void> => {
    const trimmed = name.trim()
    if (trimmed === '') return
    setSaving(true)
    try {
      if (isCreate) {
        const theme: TerminalTheme = {
          id: crypto.randomUUID(),
          name: trimmed,
          builtin: false,
          colors: { ...colors }
        }
        // persist the new theme and activate it immediately
        await setCustomThemes([...settings.customThemes, theme])
        await updateTerminal({ themeId: theme.id })
        onClose()
      } else if (editingTheme !== undefined) {
        await setCustomThemes(
          settings.customThemes.map((t) =>
            t.id === editingTheme.id ? { ...t, name: trimmed, colors: { ...colors } } : t
          )
        )
        onClose()
      }
    } finally {
      setSaving(false)
    }
  }

  const setColor = (key: ColorKey, value: string): void => {
    setColors((prev) => ({ ...prev, [key]: value }))
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={handleSave}
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      destroyOnHidden
      width={560}
      title={isCreate ? '新建主题' : '编辑主题'}
      okButtonProps={{ disabled: name.trim() === '' }}
    >
      <div className="theme-editor">
        <div className="theme-editor-row">
          <span className="theme-editor-label">名称</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="主题名称"
            maxLength={60}
          />
        </div>

        <div className="theme-editor-colors">
          {HEADER_KEYS.map((spec) => (
            <ColorField key={spec.key} spec={spec} value={colors[spec.key]} onChange={setColor} />
          ))}
          <div className="theme-editor-divider" />
          {ANSI_KEYS.map((spec) => (
            <ColorField key={spec.key} spec={spec} value={colors[spec.key]} onChange={setColor} />
          ))}
        </div>

        <div className="theme-editor-preview">
          <span className="theme-editor-preview-label">预览</span>
          <ThemePreviewSnippet colors={colors} />
        </div>
      </div>
    </Modal>
  )
}

function ColorField({
  spec,
  value,
  onChange
}: {
  spec: FieldSpec
  value: string
  onChange: (key: ColorKey, value: string) => void
}): React.JSX.Element {
  return (
    <div className="theme-editor-color-field">
      <span className="theme-editor-color-label">{spec.label}</span>
      <input
        type="color"
        className="theme-editor-color-input"
        value={value}
        onChange={(e) => onChange(spec.key, e.target.value)}
      />
    </div>
  )
}

function ThemePreviewSnippet({ colors }: { colors: ThemeColors }): React.JSX.Element {
  const lines: ReadonlyArray<readonly [string, string]> = [
    ['drwxr-xr-x  12 bill  users   4096 Sep  5 10:02 node_modules', colors.brightBlue],
    ['-rw-r--r--   1 bill  users    890 Sep  5 09:41 package.json', colors.brightBlack],
    ['-rw-r--r--   1 bill  users     42 Sep  5 09:41 index.ts', colors.brightBlack],
    ['OpenTerminal v0.1.0', colors.brightCyan]
  ]
  return (
    <div className="theme-editor-preview-box" style={{ background: colors.background }}>
      {lines.map(([text, color], i) => (
        <div key={i} className="theme-editor-preview-line" style={{ color }}>
          {text}
        </div>
      ))}
    </div>
  )
}