import type { TerminalTheme } from './theme'

/** One terminal keyword-highlight rule (regex → ANSI color injection). */
export interface HighlightRule {
  id: string
  /** regex source; compiled with 'g' flag at use site */
  pattern: string
  enabled: boolean
  /** 1..100, lower runs first and claims its spans first */
  priority: number
  /** truecolor hex (#rrggbb); fg required, bg optional */
  color: { fg: string; bg?: string }
  note?: string
  /** part of the factory preset set (restored by 恢复默认) */
  builtin?: boolean
}

export interface TerminalSettings {
  fontFamily: string
  fontSize: number
  /** 100..900 */
  fontWeight: number
  /** 100..900 */
  boldFontWeight: number
  letterSpacing: number
  lineHeight: number
  scrollback: number
  cursorBlink: boolean
  cursorStyle: 'bar' | 'block' | 'underline'
  cursorInactiveStyle: 'outline' | 'block' | 'bar' | 'underline' | 'none'
  themeId: string
  rendererMode: 'auto' | 'webgl' | 'dom'
  autoWrap: boolean
  copyOnSelect: boolean
  /** confirm before pasting multi-line / suspicious text */
  pasteRiskConfirm: boolean
  /** inline command suggestion popup while typing (history + library) */
  suggestEnabled: boolean
  /** accent color for the active tab outline, rail indicator and SSH badges */
  tabAccentColor: string
}

export interface SystemSettings {
  /** register the app to launch at OS login */
  launchAtLogin: boolean
  /** hold a powerSaveBlocker so the OS never auto-suspends while running */
  preventSleep: boolean
  /** Electron accelerator that toggles window visibility; '' = disabled (M6) */
  globalShowHide?: string
  /** close-button behavior: prompt every time / hide to tray / quit directly */
  closeAction?: 'ask' | 'tray' | 'exit'
  /** check for updates shortly after startup (manual check always available) */
  autoCheckUpdate?: boolean
}

export interface AppSettings {
  terminal: TerminalSettings
  /** user-created themes; builtin themes are immutable and live in shared/theme.ts */
  customThemes: TerminalTheme[]
  /** terminal keyword highlight rules, applied at write time in priority order */
  highlightRules: HighlightRule[]
  system: SystemSettings
}

const RULE = (
  id: string,
  pattern: string,
  priority: number,
  fg: string,
  note: string,
  bg?: string
): HighlightRule => ({ id, pattern, enabled: true, priority, color: { fg, bg }, note, builtin: true })

export const DEFAULT_HIGHLIGHT_RULES: HighlightRule[] = [
  RULE('perm', '^[-dlbcps][rwxstST-]{9}', 1, '#3fb950', 'Linux 权限与用户'),
  RULE('path', '(?:^|[\\s:=])(?:/[A-Za-z0-9_.\\-/@+]+|~[A-Za-z0-9_.\\-/]*)', 2, '#58a6ff', 'Linux 文件路径'),
  RULE('shellkw', '\\b(if|then|else|elif|fi|for|while|do|done|case|esac|function|return|break|continue|export|source)\\b', 3, '#d2a8ff', 'Shell 关键字与流程'),
  RULE('okstate', '\\b(SUCCESS|PASS|OK|DONE|PASSED)\\b', 5, '#3fb950', '成功状态'),
  RULE('badstate', '\\b(FAILED|ERROR|FAIL|FATAL|WARN|WARNING|DENIED)\\b', 6, '#f85149', '错误/警告状态'),
  RULE('quoted', '"[^"\\n]*"|\'[^\'\\n]*\'', 8, '#e3b341', '字符串与引号'),
  RULE('envvar', '\\$\\{?[A-Za-z_][A-Za-z0-9_]*\\}?', 10, '#79c0ff', '环境变量与参数'),
  RULE('ipv4', '\\b(?:\\d{1,3}\\.){3}\\d{1,3}(?::\\d{1,5})?\\b', 15, '#58a6ff', '网络与 IP 地址'),
  RULE('datetime', '\\b\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}(?:[ T]\\d{1,2}:\\d{2}(?::\\d{2})?)?\\b|\\b\\d{1,2}:\\d{2}(?::\\d{2})?\\b', 20, '#bc8cff', '时间与日期'),
  RULE('numbers', '\\b\\d+(?:\\.\\d+)?(?:%)?\\b', 25, '#f2cc60', '数字与计数'),
  RULE('url', 'https?://[^\\s]+', 30, '#58a6ff', '网址链接')
]

export const DEFAULT_SETTINGS: AppSettings = {
  terminal: {
    fontFamily: "'Cascadia Mono', Consolas, 'JetBrains Mono', 'Courier New', monospace",
    fontSize: 14,
    fontWeight: 400,
    boldFontWeight: 700,
    letterSpacing: 0,
    lineHeight: 1,
    scrollback: 5000,
    cursorBlink: true,
    cursorStyle: 'block',
    cursorInactiveStyle: 'outline',
    themeId: 'material-dark',
    rendererMode: 'auto',
    autoWrap: true,
    copyOnSelect: false,
    pasteRiskConfirm: true,
    suggestEnabled: true,
    tabAccentColor: '#3fb950'
  },
  customThemes: [],
  highlightRules: DEFAULT_HIGHLIGHT_RULES,
  system: { launchAtLogin: false, preventSleep: false, globalShowHide: '', closeAction: 'tray', autoCheckUpdate: true }
}
