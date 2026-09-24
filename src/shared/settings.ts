import type { TerminalTheme } from './theme'
import type { Language } from './i18n'

/** Coarse grouping for the settings table's grouped view. */
export type HighlightCategory = 'safety' | 'status' | 'file' | 'net' | 'text' | 'metric'

/** Stable order for the category column, the filter list and the editor select. */
export const HIGHLIGHT_CATEGORIES: HighlightCategory[] = [
  'safety',
  'status',
  'file',
  'net',
  'text',
  'metric'
]

export function isHighlightCategory(value: unknown): value is HighlightCategory {
  return typeof value === 'string' && (HIGHLIGHT_CATEGORIES as string[]).includes(value)
}

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
  /**
   * Value bands: the first number found in the match picks the colour, lowest
   * `min` first. `fg` above stays the fallback for matches without a number or
   * below the smallest `min`.
   */
  bands?: { min: number; fg: string }[]
  /** match without regard to letter case (compiled with the 'i' flag) */
  caseInsensitive?: boolean
  /**
   * Part of the "basic" set: still applied when the highlight mode is
   * `basic` (the cheap, low-noise subset — status, danger, secrets).
   */
  basic?: boolean
  /** Grouping shown by the settings table's category column / grouped view. */
  category?: HighlightCategory
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
  /** record executed commands into the history panel */
  historyEnabled: boolean
  /** max entries kept in command history */
  historyLimit: number
  /** terminal toolbar: session-log record button */
  showRecButton: boolean
  /** terminal toolbar: open logs folder button */
  showOpenLogsButton: boolean
  /** terminal toolbar: open working-directory button (local sessions only) */
  showOpenCwdButton: boolean
  /** accent color for the active tab outline, rail indicator and SSH badges */
  tabAccentColor: string
  /**
   * How much keyword highlighting runs: `all` uses every enabled rule, `basic`
   * only the rules flagged `basic` (status, danger, secrets), `off` injects no
   * colour at all. The rule set itself is never touched by this.
   */
  highlightMode: HighlightMode
  /**
   * Settings-table view: cluster rules by category (adds a category column and
   * sorts by it) instead of listing them in plain priority order.
   */
  highlightGroupByCategory: boolean
  /**
   * Collect per-rule hit counts and timings for the settings page. Off by
   * default: the engine skips all counting unless a sink is attached.
   */
  highlightStats: boolean
  /**
   * Draw highlight colours from the active terminal palette (by hue) instead of
   * the rule's own hex. Off by default: the shipped colours already read on
   * every theme, this is for users who want palette-consistent highlighting.
   */
  highlightThemeColors: boolean
  /**
   * Consult per-host highlight profiles: an SSH connection bound to a profile
   * runs only that profile's rules. Off by default — with it off every session
   * runs the full rule set, exactly as before.
   */
  highlightPerHost: boolean
  /** absolute path to an image rendered behind the terminal; '' = none */
  backgroundImage: string
  /** background image layer opacity, 10..100 (%) */
  backgroundImageOpacity: number
}

export type HighlightMode = 'all' | 'basic' | 'off'

/**
 * Read a stored mode, tolerating anything a hand-edited settings.json holds: an
 * unknown value behaves like `all`, the default before modes existed.
 */
export function highlightModeOf(value: unknown): HighlightMode {
  return value === 'basic' || value === 'off' ? value : 'all'
}

/**
 * The delays offered for the idle auto-lock, in minutes. A closed set rather
 * than a free number: `0` means "never", and the settings UI, the sanitizer and
 * the idle watcher all read this one list so they cannot disagree.
 */
export type LockAutoDelay = 0 | 1 | 5 | 15 | 30 | 60

export const LOCK_AUTO_DELAYS: LockAutoDelay[] = [0, 1, 5, 15, 30, 60]

/**
 * Read a stored auto-lock delay, tolerating a hand-edited settings.json: only a
 * whitelisted value survives, anything else falls back to 0 (never).
 */
export function lockAutoDelayOf(value: unknown): LockAutoDelay {
  return LOCK_AUTO_DELAYS.includes(value as LockAutoDelay) ? (value as LockAutoDelay) : 0
}

export function isLockAutoDelay(value: unknown): value is LockAutoDelay {
  return LOCK_AUTO_DELAYS.includes(value as LockAutoDelay)
}

/**
 * Screen-lock preferences. The password itself is never stored here — the
 * verifier lives in `<userData>/lock.json` (src/main/lockStore.ts), so settings
 * can be copied around, synced or logged without leaking it.
 */
export interface LockSettings {
  /** master switch: without it nothing ever locks, idle watcher included */
  enabled: boolean
  /** minutes of system idle before the screen locks; 0 = never */
  autoLockMinutes: LockAutoDelay
  /** start each run locked (asks for the password before the app is usable) */
  lockAtStartup: boolean
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
  /**
   * Restore the previous layout and each pane's working directory on launch
   * (see the session snapshot). On by default — that is the point of it.
   */
  restoreSession?: boolean
  /**
   * Let the shell announce its cwd over OSC 7 (shell integration). Exact, but
   * it wraps the user's prompt, so it is opt-in; without it the app falls back
   * to parsing typed `cd` commands.
   */
  shellIntegration?: boolean
  /** interface language (see @shared/i18n); missing = 简体中文 */
  language?: Language
}

/**
 * A named subset of the highlight rules, bound to an SSH connection so a
 * production host can run a quieter set than a local shell. An empty `ruleIds`
 * means "everything", the same as not binding a profile at all.
 */
export interface HighlightProfile {
  id: string
  name: string
  ruleIds: string[]
}

export interface AppSettings {
  terminal: TerminalSettings
  /** user-created themes; builtin themes are immutable and live in shared/theme.ts */
  customThemes: TerminalTheme[]
  /** terminal keyword highlight rules, applied at write time in priority order */
  highlightRules: HighlightRule[]
  /** named rule subsets for per-host highlighting (see terminal.highlightPerHost) */
  highlightProfiles: HighlightProfile[]
  system: SystemSettings
  /** screen lock; the password verifier lives outside settings (lock.json) */
  lock: LockSettings
}

const RULE = (
  id: string,
  pattern: string,
  priority: number,
  fg: string,
  note: string,
  opts?: {
    bg?: string
    caseInsensitive?: boolean
    bands?: HighlightRule['bands']
    basic?: boolean
  }
): HighlightRule => ({
  id,
  pattern,
  enabled: true,
  priority,
  color: { fg, bg: opts?.bg },
  note,
  // omitted (not `false`) unless set, so a preset round trip stays compact
  ...(opts?.caseInsensitive ? { caseInsensitive: true } : {}),
  ...(opts?.bands ? { bands: opts.bands } : {}),
  ...(opts?.basic ? { basic: true } : {}),
  builtin: true
})

/**
 * Factory preset rules.
 *
 * Status words are matched case-insensitively (`\bOK\b` should fire on `ok` as
 * well as `OK`), but always behind word boundaries: `invalid` must not light up
 * `valid`, `disabled` must not light up `enabled`. The `okstate` pattern carries
 * a `not ` lookbehind so the `ok` in `not ok` (TAP, mocha, pytest summaries) is
 * left for `badstate` to claim instead of turning it green.
 *
 * Priorities put the destructive-command and file-operation rules above the
 * status words, and the status words above `shellkw`: `done` is a shell keyword
 * and a success word, `if` sits inside `dd if=`, and `drop table` belongs to
 * `danger` rather than the plain `drop` of `delop`. Whichever rule runs first
 * paints the span and the other one is skipped, so that order is the whole
 * contract between them.
 *
 * Keyword stems carry their own endings rather than a generic suffix group:
 * `DELET(?:E|ED|ES|ING|ION)` instead of `DELETE(?:D|S|ING)?`, which silently
 * misses `deleting`. Stems that are not words on their own (MOV, SAV, CLON,
 * PURG, ERAS, WIP, REVOK) always demand an ending, so a bare `MOV` in an
 * assembly listing is left alone.
 *
 * `percent` carries value bands instead of one colour: the number in the match
 * picks the band (below 20% red, 20–50% yellow, 50–80% light green, 80%+ green),
 * which is what makes a progress bar readable at a glance.
 */
export const DEFAULT_HIGHLIGHT_RULES: HighlightRule[] = [
  RULE('perm', '^[-dlbcps][rwxstST-]{9}', 1, '#3fb950', 'Linux 权限与用户'),
  RULE('path', '(?:^|[\\s:=])(?:/[A-Za-z0-9_.\\-/@+]+|~[A-Za-z0-9_.\\-/]*)', 2, '#58a6ff', 'Linux 文件路径'),
  RULE(
    'danger',
    '\\brm\\s+-(?:[a-z]*[rf][a-z]*)\\b|\\bmkfs(?:\\.[a-z0-9]+)?\\b|\\bdd\\s+if(?==)|\\bchmod\\s+(?:-R\\s+)?0?777\\b|\\b(?:shutdown|reboot|poweroff|halt)\\b|\\bgit\\s+(?:push\\s+(?:-f|--force)|reset\\s+--hard)\\b|\\bdrop\\s+(?:database|table)\\b|\\|\\s*(?:sudo\\s+)?(?:sh|bash|zsh|dash|ksh|python[0-9.]*|perl|ruby|node)\\b|\\beval\\b|\\bbase64\\s+(?:-d|--decode)\\b|\\bchmod\\s+\\+x\\b',
    3,
    '#ff7b72',
    '危险/破坏性命令',
    { caseInsensitive: true }
  ),
  RULE(
    'delop',
    '\\b(?:DELET(?:E|ED|ES|ING|ION)|REMOV(?:E|ED|ES|ING|AL)|RM|RMDIR|UNLINK(?:ED|S|ING)?|ERAS(?:E|ED|ES|ING)|PURG(?:E|ED|ES|ING)|DESTROY(?:ED|S|ING)?|TRUNCAT(?:E|ED|ES|ING|ION)|WIP(?:E|ED|ES|ING)|DISCARD(?:ED|S|ING)?|REVOK(?:E|ED|ES|ING)|UNMOUNT(?:ED|S|ING)?|KILL(?:ED|S|ING)?|TERMINAT(?:E|ED|ES|ING|ION)|DROP(?:PED|S|PING)?|CLEANUP|SHRED(?:DED|DING)?|MOV(?:E|ED|ES|ING)|RENAM(?:E|ED|ES|ING)|OVERWRIT(?:E|TEN|ING|ES)?)\\b',
    4,
    '#ffa657',
    '删除/移动/覆盖操作',
    { caseInsensitive: true }
  ),
  RULE(
    'createop',
    '\\b(?:CREAT(?:E|ED|ES|ING|ION)|MKDIR|TOUCH(?:ED|ES|ING)?|ADD(?:ED|S|ING)?|INSTALL(?:ED|S|ING)?|CLON(?:E|ED|ES|ING)|GENERAT(?:E|ED|ES|ING|ION)|INIT(?:IALIZ(?:E|ED|ES|ING))?|IMPORT(?:ED|S|ING)?|UPLOAD(?:ED|S|ING)?|DOWNLOAD(?:ED|S|ING)?|SAV(?:E|ED|ES|ING)|WROTE|WRITTEN|MOUNT(?:ED|S|ING)?)\\b',
    5,
    '#56d364',
    '新建/创建操作',
    { caseInsensitive: true }
  ),
  RULE(
    'okstate',
    '(?<!not\\s)\\b(?:SUCCESS(?:FUL(?:LY)?)?|SUCCEED(?:S|ED|ING)?|PASS(?:ED|ES|ING)?|OK(?:AY)?|DONE|FINISH(?:ED|ES|ING)?|COMPLET(?:E|ED|ES|ING|ION)|GOOD|FINE|TRUE|ENABL(?:E|ED|ES|ING)|ACTIVE|ONLINE|READY|HEALTHY|MATCH(?:ED|ES|ING)?|FOUND|ACCEPT(?:ED|S|ING)?|APPROV(?:E|ED|ES|ING|AL)|VALID|ALLOW(?:ED|S|ING)?)\\b|[\\u2713\\u2714\\u2705]\\uFE0F?',
    6,
    '#3fb950',
    '成功状态',
    { caseInsensitive: true }
  ),
  RULE(
    'warnstate',
    '\\b(?:WARN(?:S|ED|ING|INGS)?|CAUTION|ATTENTION|NOTICE|DEPRECAT(?:E|ED|ES|ING|ION)|OBSOLETE|UNSTABLE|TODO|FIXME|XXX|HACK|TBD)\\b|\\u26A0\\uFE0F?',
    7,
    '#e3b341',
    '警告与待办标记',
    { caseInsensitive: true }
  ),
  RULE(
    'badstate',
    '\\b(?:ERROR|ERR|ERRNO|EXCEPTION|TRACEBACK|FAIL(?:ED|S|URE|URES|ING)?|FATAL|CRITICAL|PANIC|ABORT(?:ED|S|ING)?|CRASH(?:ED|ES|ING)?|BUG(?:S|GY)?|SEGFAULT|SEGV|OOM|DENIED|REFUS(?:E|ED|ES|ING|AL)|REJECT(?:ED|S|ING)?|INVALID|ILLEGAL|MISMATCH(?:ED|ES)?|TIMEOUT|TIMED\\s+OUT|UNREACHABLE|UNHEALTHY|CONFLICT(?:ED|S|ING)?|VIOLAT(?:ED|ES|ING|ION)|CORRUPT(?:ED|S|ING|ION)?|MISSING|NOT\\s+(?:OK|DONE|PASSED|FOUND|READY|ACTIVE|RUNNING)|NG|BAD|WRONG|OFFLINE)\\b|[\\u2717\\u2718\\u2716\\u274C]\\uFE0F?',
    8,
    '#f85149',
    '错误/失败状态',
    { caseInsensitive: true }
  ),
  RULE('shellkw', '\\b(if|then|else|elif|fi|for|while|do|done|case|esac|function|return|break|continue|export|source)\\b', 9, '#d2a8ff', 'Shell 关键字与流程'),
  RULE('quoted', '"[^"\\n]*"|\'[^\'\\n]*\'', 10, '#e3b341', '字符串与引号'),
  RULE('loglevel', '\\b(?:INFO|DEBUG|TRACE|VERBOSE)\\b', 11, '#79c0ff', '日志级别'),
  RULE('envvar', '\\$\\{?[A-Za-z_][A-Za-z0-9_]*\\}?', 12, '#79c0ff', '环境变量与参数'),
  RULE('rootat', '\\broot@[A-Za-z0-9_.-]+', 13, '#ffa657', '管理员提示符 root@'),
  RULE('ipv4', '\\b(?:\\d{1,3}\\.){3}\\d{1,3}(?::\\d{1,5})?\\b', 15, '#58a6ff', '网络与 IP 地址'),
  RULE('datetime', '\\b\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}(?:[ T]\\d{1,2}:\\d{2}(?::\\d{2})?)?\\b|\\b\\d{1,2}:\\d{2}(?::\\d{2})?\\b', 20, '#bc8cff', '时间与日期'),
  RULE(
    'exitcode',
    '\\bexit(?:ed)?\\s+(?:with\\s+)?(?:code|status)\\s*[:=]?\\s*\\d+|\\bexit\\s+\\d{1,3}\\b',
    21,
    '#3fb950',
    '退出码',
    {
      bands: [
        { min: 0, fg: '#3fb950' },
        { min: 1, fg: '#f85149' }
      ]
    }
  ),
  RULE(
    'percent',
    '\\b\\d{1,3}(?:\\.\\d+)?\\s?%',
    22,
    '#3fb950',
    '百分比与进度',
    {
      bands: [
        { min: 0, fg: '#f85149' },
        { min: 20, fg: '#e3b341' },
        { min: 50, fg: '#7ee787' },
        { min: 80, fg: '#3fb950' }
      ]
    }
  ),
  RULE(
    'http',
    '(?<=\\bHTTP/\\d(?:\\.\\d)?\\s)[1-5]\\d\\d\\b|(?<=\\b(?:status|code|http_code|status_code)\\s*[:=]?\\s)[1-5]\\d\\d\\b|\\b[1-5]\\d\\d(?=\\s+(?:OK|Created|Accepted|No Content|Moved Permanently|Found|Not Modified|Bad Request|Unauthorized|Forbidden|Not Found|Method Not Allowed|Conflict|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\\b)',
    23,
    '#58a6ff',
    'HTTP 状态码',
    {
      bands: [
        { min: 100, fg: '#8b949e' },
        { min: 200, fg: '#3fb950' },
        { min: 300, fg: '#58a6ff' },
        { min: 400, fg: '#e3b341' },
        { min: 500, fg: '#f85149' }
      ]
    }
  ),
  RULE(
    'latency',
    '\\b\\d+(?:\\.\\d+)?\\s?(?:ms|msec|µs|us|ns)\\b',
    24,
    '#3fb950',
    '耗时（毫秒）',
    {
      bands: [
        { min: 0, fg: '#3fb950' },
        { min: 100, fg: '#e3b341' },
        { min: 500, fg: '#f85149' }
      ]
    }
  ),
  RULE('numbers', '\\b\\d+(?:\\.\\d+)?(?:%)?\\b', 25, '#f2cc60', '数字与计数'),
  RULE('url', 'https?://[^\\s]+|ftp://[^\\s]+|www\\.[A-Za-z0-9-]+\\.[A-Za-z]{2,}(?::\\d+)?(?:/[^\\s]*)?', 30, '#58a6ff', '网址链接'),
  RULE(
    'secret',
    '\\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,})\\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\\bBearer\\s+[A-Za-z0-9._-]{16,}',
    31,
    '#ff7b72',
    '疑似密钥/令牌'
  )
]

/**
 * Rules that keep working in the `basic` highlight mode: the cheap, high-signal
 * ones — failures, successes, warnings, destructive commands, leaked secrets.
 * Everything else (paths, numbers, URLs, network, timings) is dropped there,
 * which is what makes that mode both quieter and roughly 3x cheaper.
 */
const BASIC_RULE_IDS = new Set(['danger', 'secret', 'okstate', 'warnstate', 'badstate'])
/**
 * Category per preset id, for the settings table's grouped view. One table
 * rather than a field on each rule, so the whole taxonomy reads at a glance —
 * and so `basic` stays a strict subset of the safety + status groups.
 */
const PRESET_CATEGORIES: Record<string, HighlightCategory> = {
  danger: 'safety',
  secret: 'safety',
  okstate: 'status',
  warnstate: 'status',
  badstate: 'status',
  loglevel: 'status',
  exitcode: 'status',
  rootat: 'status',
  percent: 'metric',
  latency: 'metric',
  numbers: 'metric',
  ipv4: 'net',
  url: 'net',
  http: 'net',
  perm: 'file',
  path: 'file',
  delop: 'file',
  createop: 'file',
  shellkw: 'text',
  quoted: 'text',
  envvar: 'text',
  datetime: 'text'
}
for (const rule of DEFAULT_HIGHLIGHT_RULES) {
  if (BASIC_RULE_IDS.has(rule.id)) rule.basic = true
  const category = PRESET_CATEGORIES[rule.id]
  if (category !== undefined) rule.category = category
}

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
    suggestEnabled: false,
    historyEnabled: false,
    historyLimit: 100,
    showRecButton: false,
    showOpenLogsButton: false,
    showOpenCwdButton: true,
    tabAccentColor: '#3fb950',
    highlightMode: 'all',
    highlightGroupByCategory: false,
    highlightStats: false,
    highlightThemeColors: false,
    highlightPerHost: false,
    backgroundImage: '',
    backgroundImageOpacity: 60
  },
  customThemes: [],
  highlightRules: DEFAULT_HIGHLIGHT_RULES,
  highlightProfiles: [],
  system: { launchAtLogin: false, preventSleep: false, globalShowHide: '', closeAction: 'tray', autoCheckUpdate: true, restoreSession: true, shellIntegration: false, language: 'zh-CN' },
  // Off until the user sets a password and turns it on: an app that locks
  // itself out of the box would be a support ticket, not a feature.
  lock: { enabled: false, autoLockMinutes: 0, lockAtStartup: false }
}
