import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ForwardRefExoticComponent, Ref } from 'react'
import { Terminal } from '@xterm/xterm'
import type { ILink, ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { ClearOutlined, CopyOutlined, ExportOutlined, FolderOpenOutlined, PauseOutlined, SearchOutlined, SelectOutlined, SnippetsOutlined, SoundOutlined } from '@ant-design/icons'
import { Checkbox, Modal } from 'antd'
import { t } from '@shared/i18n'
import { getThemeById } from '@shared/theme'
import type { CommandItem } from '@shared/commands'
import type { TerminalSettings } from '@shared/settings'
import { useSettingsStore } from '@renderer/settings/store'
import { writeBroadcast } from '@renderer/workspace/broadcastStore'
import { compileRules, HighlightStream } from './highlightEngine'
import { findUrls } from './urlLinks'
import { subscribePtyData, subscribePtyExit } from './ptyDispatcher'
import { cdArgument, conemuCwd } from './cwdTracker'
import { getSessionCwd, setSessionCwd } from '@renderer/workspace/sessionCwdStore'
import './terminal.css'

/** Platform-modifier-based chord (Cmd on macOS, Ctrl elsewhere), plus Shift. */
function isModShiftChord(e: KeyboardEvent, key: string): boolean {
  const mod = navigator.platform.toLowerCase().includes('mac') ? e.metaKey : e.ctrlKey
  return Boolean(mod) && e.shiftKey && e.key.toLowerCase() === key
}

/** Keep xterm cursor/font weights in its accepted FontWeight format. */
function toFontWeight(n: number): 'normal' | 'bold' | number {
  if (n === 400) return 'normal'
  if (n === 700) return 'bold'
  return n
}

/**
 * Paste-risk heuristic, split by shape rather than by raw length:
 *   - two or more lines always confirm — a stray newline executes a command
 *     the user never reviewed;
 *   - a single line pastes straight through, unless it is unusually long
 *     (those are pasted scripts rather than something typed by hand).
 */
const SINGLE_LINE_CONFIRM_LENGTH = 1000
function needsPasteConfirm(text: string): boolean {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\n$/, '')
  if (normalized.includes('\n')) return true
  return normalized.length > SINGLE_LINE_CONFIRM_LENGTH
}

/**
 * "本次会话不再提示" from the paste confirmation dialog. Deliberately in memory
 * only: it lasts until the app exits and never becomes a stored preference
 * (that is what 关闭后续粘贴检测 in the dialog is for).
 */
let pasteConfirmedForSession = false

const SEARCH_DECORATIONS: NonNullable<NonNullable<Parameters<SearchAddon['findNext']>[1]>['decorations']> = {
  matchBackground: '#3b8eea',
  matchBorder: '#2d2d2d',
  matchOverviewRuler: '#3b8eea',
  activeMatchBackground: '#c77800',
  activeMatchBorder: '#2d2d2d',
  activeMatchColorOverviewRuler: '#c77800'
}

// xterm's default overviewRulerBorder (#7f7f7f) renders as a light vertical line
// on the dark surface once scrollback exists. Force it transparent; search-match
// marks in the ruler keep their own colors.
function withChromeColors(colors: ITheme): ITheme {
  return { ...colors, overviewRulerBorder: '#00000000' }
}

export interface TerminalHandle {
  focus(): void
  clear(): void
  /** currently attached pty session id */
  sessionId(): string
}

export interface TerminalViewProps {
  /** pty session created via window.api.createPty() */
  sessionId: string
  /** called once after the pty process exits and the user closes the dead pane */
  onClose: () => void
  className?: string
  /** ssh sessions have a remote cwd — the open-directory button is hidden */
  isSsh?: boolean
}

interface SearchBarProps {
  value: string
  onChange: (v: string) => void
  onPrev: () => void
  onNext: () => void
  onClose: () => void
  enabled: boolean
  result: string
}

/** M5: cap for the floating completion popup height in px. */
const SUGGEST_POPUP_H = 200

/** M5: estimated popup height for a given number of suggestion rows. */
function estimatePopupHeight(itemCount: number): number {
  // item ≈ 21px, hint row ≈ 18px, popup v-padding + gaps ≈ 10px.
  return Math.min(SUGGEST_POPUP_H, Math.max(70, itemCount * 22 + 28))
}

function SearchBar({ value, onChange, onPrev, onNext, onClose, enabled, result }: SearchBarProps): React.JSX.Element {
  return (
    <div className="term-searchbar">
      <input
        className="term-searchbar-input"
        type="text"
        value={value}
        placeholder={t('terminal.search.placeholder')}
        spellCheck={false}
        autoFocus
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') onNext()
          else if (e.key === 'Escape') onClose()
        }}
      />
      <button type="button" className="term-searchbar-btn" disabled={!enabled} onClick={onPrev}>{t('terminal.search.prev')}</button>
      <button type="button" className="term-searchbar-btn" disabled={!enabled} onClick={onNext}>{t('terminal.search.next')}</button>
      <span className="term-searchbar-count">{result}</span>
      <button type="button" className="term-searchbar-btn" onClick={onClose}>{t('common.close')}</button>
    </div>
  )
}

/**
 * [M5] Feed one data chunk into the per-session line buffer. Returns the
 * accumulated (non-empty) line for the completion overlay, or '' when the
 * buffer is empty (some control data only). Enter/backspace/espace/ctrl-c are
 * handled here; escape sequences (\x1b) and the leading non-printable control
 * bytes on a chunk — like \x1b[K clear-line — never enter the buffer.
 *
 * readline's line-editing keys (Ctrl+U/W/K, Ctrl+A/E/L/Y, …) are handled too:
 * the shell applies them to its own line and never echoes the resulting edit
 * back to us, so appending the raw control byte would silently desync this
 * buffer from the shell's line and make the history record the pre-edit text.
 */
function stepLineBuffer(
  outBuf: React.MutableRefObject<string>,
  data: string
): { line: string; submit?: string } {
  const b = outBuf.current
  if (!data) return { line: b }
  // xterm-native paste (plain Ctrl+V): with the shell's bracketed-paste mode
  // on, the pasted block arrives wrapped in \x1b[200~ / \x1b[201~ and the chunk
  // starts with ESC, which the guards below would drop wholesale. Strip the
  // markers and keep the pasted text as ordinary input.
  if (data.includes('\x1b[200~') || data.includes('\x1b[201~')) {
    const text = data.replace(/\x1b\[20[01]~/g, '')
    if (text) outBuf.current = b + text
    return { line: outBuf.current }
  }
  // A chunk that begins with escape/control sequences (e.g. the terminal's
  // clear-line) only removes buffer content; never appends.
  const first = data[0]
  if (b === '' && first === '\x1b') return { line: '' }
  if (first === '\r') return submitOr(outBuf, b)
  if (first === '\x7f') {
    outBuf.current = b.slice(0, -1)
    return { line: outBuf.current }
  }
  if (first === '\x03') {
    outBuf.current = ''
    return { line: '' }
  }
  if (first === '\x1b') return { line: b }
  // Ctrl+U / Ctrl+K kill the shell's line (before / after the cursor); with no
  // cursor tracking the safe mirror of that is an empty buffer.
  if (first === '\x15' || first === '\x0b') {
    outBuf.current = ''
    return { line: '' }
  }
  // Ctrl+W: readline skips trailing whitespace and kills the word before it.
  if (first === '\x17') {
    outBuf.current = b.replace(/\S+\s*$/, '')
    return { line: outBuf.current }
  }
  // Any other C0 byte is a key the shell interprets itself (Ctrl+A/E/L/Y,
  // Ctrl+R, Ctrl+D, Tab, …) and adds no text to the line — the buffer must not
  // grow either.
  if (data.charCodeAt(0) < 0x20) return { line: b }
  outBuf.current = b + data
  return { line: outBuf.current }
}

function submitOr(outBuf: React.MutableRefObject<string>, b: string): { line: string; submit?: string } {
  const t = b.trim()
  // Commit the line out of the buffer: the shell has it now, and anything typed
  // next belongs to a fresh line. Leaving it in made every following command
  // accumulate onto the previous one (`ls` + `pwd` → `lspwd` in the history).
  outBuf.current = ''
  return t ? { line: '', submit: t } : { line: '', submit: '' }
}

/** M5: build the inline suggestion list (history + library, prefix, capped 5). */
function buildSuggestions(cache: CommandItem[], buffer: string): CommandItem[] {
  const q = buffer.trim()
  if (!q) return []
  const out: CommandItem[] = []
  for (const item of cache) {
    if (item.command.startsWith(q)) out.push(item)
    if (out.length >= 5) break
  }
  return out
}

/**
 * [M5] Accept a completion by forcing the pty to rewrite the whole line rather
 * than appending only the missing tail.
 *
 * The previous implementation wrote just `full.slice(buf.length)` when the
 * shell line buffer (`buf`) was a prefix of the target (`full`). That delta
 * approach is what lost characters: `lineBufRef` is accumulated locally from
 * user keystrokes and races the shell's real line buffer. Whenever the shell
 * redraws the line (e.g. it emits a clear-line/control sequence, or the pty
 * echoes control output back to us) the local buffer drifts out of sync with
 * the shell, and the next keystroke overwrites the completion we just wrote.
 *
 * Rewriting the whole line removes that shared-mutable-buffer dependence:
 *   1. `\x15` (Ctrl+U) kills the current line. bash, zsh, fish, and Windows
 *      PowerShell's PSReadLine all honor it, and — unlike `\x03` (Ctrl+C) —
 *      it leaves no caret and does not start a fresh prompt, so the shell stays
 *      on the same line ready for the replacement text. (A control-sequence
 *      fallback of `\x1b[D` repeated N times + `\x1b[K` would also work but is
 *      noisier and shell-specific; Ctrl+U is simpler and reliably supported.)
 *   2. We then write `full`; the pty echoes it into the session buffer.
 *
 * `buf` is retained purely for call-site symmetry with the old signature; the
 * rewrite always sends the Ctrl+U + full command. Whatever the local buffer
 * previously held is irrelevant to the pty after the kill.
 */
function differenceWrite(sessionId: string, full: string, buf: string): void {
  writeBroadcast(sessionId, '\x15')
  writeBroadcast(sessionId, full)
}

export const TerminalView: ForwardRefExoticComponent<TerminalViewProps & { ref?: Ref<TerminalHandle> }> =
  forwardRef<TerminalHandle, TerminalViewProps>(function TerminalViewInner({ sessionId, onClose, className, isSsh = false }, ref) {
  const settings = useSettingsStore((s) => s.settings)

  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const webglRef = useRef<WebglAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const timerRef = useRef<number>(0)
  // PTY resize bookkeeping: `ptyTimerRef` debounces the resize while a window
  // drag/maximize settles, `ptySizeRef` drops the no-op resizes in between.
  // Poking the pty on every intermediate layout tick makes full-screen TUIs
  // (Claude Code et al.) redraw repeatedly at half-settled sizes, which is what
  // leaves duplicated frames behind in the scrollback.
  const ptyTimerRef = useRef<number>(0)
  const ptySizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const deadRef = useRef(false)
  const searchOpenRef = useRef(false)
  const searchTermRef = useRef('')
  const nativePasteRef = useRef<string | null>(null)
  const onCloseRef = useRef(onClose)
  const streamRef = useRef<HighlightStream | null>(null)
  // Renderer mode currently installed on the terminal, so the mode effect can
  // tell a real switch from its own mount-time run.
  const rendererModeRef = useRef<TerminalSettings['rendererMode'] | null>(null)
  // M5: per-session line-capture buffer + completion candidate cache.
  const lineBufRef = useRef<string>('')
  const completionCacheRef = useRef<CommandItem[]>([])
  const completionKeyRef = useRef('')
  const recordingRef = useRef(false)
  // M5: completion selection tracked in refs so the construction-time key
  // handler always reads the live values without a stale closure.
  const suggestionsRef = useRef<CommandItem[]>([])
  const selIndexRef = useRef(0)
  // Absolute-positioning hook for the completion popup (the box that wraps the
  // xterm surface), so popup coordinates start at the terminal content area.
  const suggestHookRef = useRef<HTMLDivElement | null>(null)
  // M5: absolute position (view-relative) of the floating completion popup.
  const [popupPos, setPopupPos] = useState<{ left: number; top: number; flip: boolean } | null>(null)

  // Compile keyword-highlight rules once per rules change; keep them in a ref so
  // the (stable, single-construction) pty/term subscriptions always read the
  // latest rules without triggering a terminal rebuild. Only new output is
  // highlighted — the existing scrollback buffer is left untouched.
  const compiledRules = useMemo(() => compileRules(settings.highlightRules), [settings.highlightRules])
  streamRef.current?.setRules(compiledRules)

  // M5: load completion candidates once per session (history + library cached).
  const ensureCompletionCache = useCallback((): void => {
    if (completionCacheRef.current.length > 0) return
    const key = `${sessionId}|${window.location.pathname}`
    if (completionKeyRef.current === key) return
    completionKeyRef.current = key
    void Promise.all([window.api.listHistory(), window.api.listLibrary()])
      .then(([h, l]) => {
        // Newest-first history is already ordered; library keeps insertion order.
        completionCacheRef.current = [...h, ...l]
      })
      .catch(() => undefined)
  }, [sessionId])

  const [searchOpen, setSearchOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [resultInfo, setResultInfo] = useState('')
  // Right-click context menu: position + whether a selection existed at open
  // time (decides if 复制 is enabled).
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)
  const [menuHasSel, setMenuHasSel] = useState(false)
  const [paste, setPaste] = useState<{ noPrompt: boolean; disableDetection: boolean } | null>(null)
  const [dead, setDead] = useState(false)
  const [exitCode, setExitCode] = useState(0)
  const [recording, setRecording] = useState(false)
  // Inline command-completion overlays built from history/library (M5).
  const [suggestions, setSuggestions] = useState<CommandItem[]>([])
  const [suggestionIndex, setSuggestionIndex] = useState(0)
  const tSettings = settings.terminal

  // [M5] Mirror completion selection into state's single source of truth. Kept
  // as a pair of effects so the construction-time key handler (below) always
  // reads the live values through refs, never a stale closure.
  useEffect(() => {
    suggestionsRef.current = suggestions
  }, [suggestions])
  useEffect(() => {
    selIndexRef.current = suggestionIndex
  }, [suggestionIndex])

  const applyRenderers = useCallback((mode: TerminalSettings['rendererMode']) => {
    const term = termRef.current
    if (!term) return
    if (webglRef.current) {
      webglRef.current.dispose()
      webglRef.current = null
    }
    if (mode === 'dom') {
      rendererModeRef.current = mode
      return
    }
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        // WebGL context lost -> fall back to the DOM renderer, keep the buffer.
        if (!webglRef.current) return
        webglRef.current.dispose()
        webglRef.current = null
      })
      term.loadAddon(webgl)
      webglRef.current = webgl
    } catch {
      webglRef.current = null
    }
    rendererModeRef.current = mode
  }, [])

  const scheduleFit = useCallback(() => {
    window.cancelAnimationFrame(timerRef.current)
    timerRef.current = window.requestAnimationFrame(() => {
      const fit = fitAddonRef.current
      if (!fit) return
      try {
        fit.fit()
      } catch {
        return
      }
      const term = termRef.current
      if (!term || deadRef.current) return
      // The xterm grid is already correct; only tell the pty once it settles.
      const last = ptySizeRef.current
      if (last && last.cols === term.cols && last.rows === term.rows) return
      const send = (): void => {
        const live = termRef.current
        if (!live || deadRef.current) return
        // A pane without a layout box (hidden or not-yet-laid-out dock tab)
        // reports a degenerate grid; that — and any other sub-minimum size —
        // must never reach the pty, which would reflow the shell into a
        // one-column line. Skipping leaves ptySizeRef untouched, so the next
        // fit retries instead of remembering the bad size.
        if (hostRef.current?.offsetParent === null) return
        if (live.cols < 20 || live.rows < 4) return
        if (live.cols === ptySizeRef.current?.cols && live.rows === ptySizeRef.current?.rows) return
        ptySizeRef.current = { cols: live.cols, rows: live.rows }
        window.api.resizePty(sessionId, live.cols, live.rows)
      }
      window.clearTimeout(ptyTimerRef.current)
      // First size for a session goes out immediately (the pty spawns at a
      // placeholder 80x24 and a shell may already be drawing); later changes —
      // window drags, maximize/restore — wait for the layout to settle.
      if (!last) {
        send()
        return
      }
      // 100ms mirrors what other Electron terminals use: long enough to swallow
      // a maximize/restore animation tick storm, short enough that a plain
      // window drag does not visibly wrap against a stale width.
      ptyTimerRef.current = window.setTimeout(send, 100)
    })
  }, [sessionId])

  const openSearch = useCallback(() => {
    searchOpenRef.current = true
    setSearchOpen(true)
  }, [])

  const openContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setMenuHasSel(Boolean(termRef.current?.getSelection()))
    // Clamp so the menu never overflows the window edge.
    const x = Math.min(e.clientX, window.innerWidth - 216)
    const y = Math.min(e.clientY, window.innerHeight - 200)
    setMenuPos({ x: Math.max(x, 4), y: Math.max(y, 4) })
  }, [])

  // Global dismiss: Escape / scroll / window blur close the context menu.
  useEffect(() => {
    if (!menuPos) return
    const close = (): void => setMenuPos(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('wheel', close, true)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('wheel', close, true)
      window.removeEventListener('blur', close)
    }
  }, [menuPos])

  const closeSearch = useCallback(() => {
    searchOpenRef.current = false
    searchRef.current?.clearDecorations()
    setSearchOpen(false)
    setResultInfo('')
    termRef.current?.focus()
  }, [])

  const search = useCallback((dir: 1 | -1) => {
    const addon = searchRef.current
    const q = searchTermRef.current.trim()
    if (!addon || !q) return
    const found =
      dir === 1
        ? addon.findNext(q, { decorations: SEARCH_DECORATIONS })
        : addon.findPrevious(q, { decorations: SEARCH_DECORATIONS })
    setResultInfo(found ? t('terminal.search.found') : t('terminal.search.notFound'))
  }, [])

  /** Record a submitted command line; cd-style lines also update cwd memory. */
  const trackSubmittedLine = useCallback(
    (submit: string): void => {
      void window.api.recordCommand(submit).catch(() => undefined)
      // Remember the directory for the next launch: a cd-style line is
      // resolved in the main process (the only side with node's `path`).
      const cdArg = cdArgument(submit)
      if (cdArg !== null) {
        void window.api
          .resolveCwd(getSessionCwd(sessionId), cdArg)
          .then((next: string | null) => {
            if (next) setSessionCwd(sessionId, next)
          })
          .catch(() => undefined)
      }
    },
    [sessionId]
  )

  const confirmPaste = useCallback(
    (text: string) => {
      const data = nativePasteRef.current ?? text
      nativePasteRef.current = null
      setPaste(null)
      // Route through xterm's own paste: when the shell asked for bracketed
      // paste (PSReadLine does), the text is wrapped in \x1b[200~ / \x1b[201~
      // and inserted as ONE edit instead of executing line by line — which is
      // what a large multi-line paste needs. It also feeds onData, so the line
      // buffer, command history and cwd memory see the pasted text.
      if (!deadRef.current) termRef.current?.paste(data)
      termRef.current?.focus()
    },
    []
  )

  const cancelPaste = useCallback(() => {
    nativePasteRef.current = null
    setPaste(null)
    termRef.current?.focus()
  }, [])

  /** [M5] Start recording this session's output to a log file. */
  const handleLogStart = useCallback(async (): Promise<void> => {
    try {
      await window.api.logStart(sessionId)
      recordingRef.current = true
      setRecording(true)
    } catch {
      /* log start denied — stay idle */
    }
  }, [sessionId])

  /** [M5] Stop recording; finalize the session's log file. */
  const handleLogStop = useCallback(async (): Promise<void> => {
    try {
      await window.api.logStop(sessionId)
      recordingRef.current = false
      setRecording(false)
    } catch {
      /* log stop denied — keep the current visual state */
    }
  }, [sessionId])

  const beginPaste = useCallback(
    (text: string) => {
      // Read the setting at call time: this runs from a long-lived keydown
      // listener, so a captured value would go stale after a settings change.
      const confirmOn = useSettingsStore.getState().settings.terminal.pasteRiskConfirm
      if (!deadRef.current && confirmOn && !pasteConfirmedForSession && needsPasteConfirm(text)) {
        nativePasteRef.current = text
        setPaste({ noPrompt: false, disableDetection: false })
        return
      }
      confirmPaste(text)
    },
    [confirmPaste]
  )

  /** Confirm the risky-paste dialog: apply its choices, then paste. */
  const acceptPaste = useCallback((): void => {
    if (paste?.noPrompt) pasteConfirmedForSession = true
    if (paste?.disableDetection) {
      void useSettingsStore.getState().updateTerminal({ pasteRiskConfirm: false })
    }
    confirmPaste(nativePasteRef.current ?? '')
  }, [paste, confirmPaste])

  const copySelection = useCallback(async () => {
    const term = termRef.current
    if (!term) return
    const sel = term.getSelection()
    if (!sel) return
    try {
      await navigator.clipboard.writeText(sel)
    } catch {
      /* clipboard write denied */
    }
    // Read the setting at call time: this runs from the terminal's custom key
    // handler, which is attached once per session and would otherwise keep the
    // copyOnSelect value captured at mount.
    if (!useSettingsStore.getState().settings.terminal.copyOnSelect) term.clearSelection()
  }, [])

  const pasteFromClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) beginPaste(text)
    } catch {
      /* clipboard read denied */
    }
    termRef.current?.focus()
  }, [beginPaste])

  /** [M5] Accept the selected suggestion: substitute the buffer via a pty write. */
  const handleTab = useCallback(
    (selected: CommandItem): void => {
      const cmd = selected.command
      // Rewrite the whole shell line (Ctrl+U then `cmd`) instead of appending a
      // delta, so the pty never has to reconcile our local buffer with its own
      // (see differenceWrite). The local buffer mirrors the rewrite — the shell
      // does not echo it back through onData, so nothing else would update it,
      // and the next Enter would otherwise record the pre-accept text.
      differenceWrite(sessionId, cmd, lineBufRef.current)
      lineBufRef.current = cmd
      suggestionsRef.current = []
      selIndexRef.current = 0
      setSuggestions([])
      setSuggestionIndex(0)
      termRef.current?.focus()
    },
    [sessionId]
  )

  /** [M5] Nudge the completion selection up (↑) or down (↓). */
  const moveSelection = useCallback((dir: 1 | -1): void => {
    const n = suggestionsRef.current.length
    if (n === 0) return
    const next = (selIndexRef.current + dir + n) % n
    selIndexRef.current = next
    setSuggestionIndex(next)
  }, [])

  const onTerminalKey = useCallback(
    (e: KeyboardEvent): boolean => {
      if (e.type !== 'keydown') return true
      if (searchOpenRef.current && e.key === 'Escape') {
        closeSearch()
        return false
      }
      const mod = navigator.platform.toLowerCase().includes('mac') ? e.metaKey : e.ctrlKey
      if ((e.key === 'f' || e.key === 'F') && mod && !e.altKey) {
        openSearch()
        return false
      }
      if (isModShiftChord(e, 'c')) {
        void copySelection()
        return false
      }
      if (isModShiftChord(e, 'v')) {
        void pasteFromClipboard()
        return false
      }
      // M5: inline completion keyboard handling (pure overlay; never blocks the
      // underlying pty write when suggestions are absent).
      const list = suggestionsRef.current
      if (list.length > 0) {
        if (e.key === 'Escape') {
          suggestionsRef.current = []
          selIndexRef.current = 0
          setSuggestions([])
          setSuggestionIndex(0)
          return false
        }
        if (e.key === 'ArrowDown') {
          moveSelection(1)
          return false
        }
        if (e.key === 'ArrowUp') {
          moveSelection(-1)
          return false
        }
        if (e.key === 'Tab') {
          // Tab accepts the highlighted suggestion: rewrite the whole line.
          // Enter deliberately falls through — it must always execute the
          // typed line (the old enter-accepts path resubmitted with the
          // suggestion appended, e.g. `kimi` → `kimikimi`).
          const selected = list[selIndexRef.current] ?? list[0]
          if (selected) handleTab(selected)
          return false
        }
        if (e.key === 'Enter') {
          // Never let the popup swallow Enter: dismiss it and submit as typed.
          suggestionsRef.current = []
          selIndexRef.current = 0
          setSuggestions([])
          setSuggestionIndex(0)
          return true
        }
      }
      return true
    },
    [closeSearch, openSearch, copySelection, pasteFromClipboard, moveSelection, handleTab]
  )

  // ---- terminal instance: built once per session ----
  useLayoutEffect(() => {
    const term = new Terminal({
      fontSize: tSettings.fontSize,
      fontFamily: tSettings.fontFamily,
      fontWeight: toFontWeight(tSettings.fontWeight),
      fontWeightBold: toFontWeight(tSettings.boldFontWeight),
      letterSpacing: tSettings.letterSpacing,
      lineHeight: tSettings.lineHeight,
      scrollback: tSettings.scrollback,
      cursorBlink: tSettings.cursorBlink,
      cursorStyle: tSettings.cursorStyle,
      cursorInactiveStyle: tSettings.cursorInactiveStyle,
      theme: withChromeColors(getThemeById(tSettings.themeId, settings.customThemes).colors as ITheme),
      allowProposedApi: true,
      overviewRuler: { width: 9, showTopBorder: false, showBottomBorder: false },
      drawBoldTextInBrightColors: true,
      minContrastRatio: 1,
      automaticFontFallback: true,
      convertEol: false,
      windowsPty: { backend: 'conpty', buildNumber: 0 }
    } as Terminal['options'] & object)

    term.attachCustomKeyEventHandler(onTerminalKey)

    if (!hostRef.current) return
    term.open(hostRef.current)

    const fit = new FitAddon()
    term.loadAddon(fit)
    fitAddonRef.current = fit
    // Place any popup that was already showing (e.g. the pty started with a
    // visible completion) once the terminal surface has real dimensions.
    requestAnimationFrame(() => {
      if (termRef.current === term && suggestionsRef.current.length > 0) placeSuggestPopup()
    })

    const searchAddon = new SearchAddon()
    searchAddon.onDidChangeResults((ev) => {
      if (searchOpenRef.current && searchTermRef.current.trim()) {
        setResultInfo(`${Math.max(ev.resultIndex + 1, 0)}/${ev.resultCount}`)
      }
    })
    term.loadAddon(searchAddon)
    searchRef.current = searchAddon

    // cwd reports straight from the shell: OSC 7 is the portable form (bash,
    // zsh, fish, iTerm2, WezTerm, kitty all speak it), OSC 9;9 is ConEmu's,
    // used by the Windows shells. Normalization happens in the main process.
    const reportCwd = (payload: string): void => {
      void window.api
        .reportCwd(payload)
        .then((cwd: string | null) => {
          if (cwd) setSessionCwd(sessionId, cwd)
        })
        .catch(() => undefined)
    }
    const oscDisposables = [
      term.parser.registerOscHandler(7, (payload) => {
        reportCwd(payload)
        return true
      }),
      term.parser.registerOscHandler(9, (payload) => {
        const value = conemuCwd(payload)
        if (value) reportCwd(value)
        return true
      })
    ]

    termRef.current = term
    // Rebind (e.g. template apply) must clear a death marker left by the
    // previous session's exit — otherwise the pane stays under the dead mask.
    deadRef.current = false
    setDead(false)
    setExitCode(0)
    // M5: reset per-session state on (re)bind — fresh line buffer, no leftovers
    // from a template apply or panel reuse; recording resumes idle.
    lineBufRef.current = ''
    ptySizeRef.current = null
    setSuggestions([])
    setSuggestionIndex(0)
    if (recordingRef.current) {
      recordingRef.current = false
      setRecording(false)
    }
    applyRenderers(tSettings.rendererMode)
    scheduleFit()

    // xterm event hooks return IDisposable objects, api subscriptions return
    // unsubscribe functions — keep the two shapes apart or cleanup throws.
    // A fresh HighlightStream is created per session so carry data never leaks
    // across a sessionId rebind (e.g. template apply).
    const stream = new HighlightStream(compiledRules)
    streamRef.current = stream
    // The stream holds a trailing text run for cross-chunk anchor consistency.
    // A shell prompt is exactly such a run with no follow-up data, so flush the
    // carry on a short timer — prompts render within a frame, anchors survive.
    let carryTimer: number | undefined
    const scheduleCarryFlush = (): void => {
      if (carryTimer !== undefined || !stream.hasPending()) return
      carryTimer = window.setTimeout(() => {
        carryTimer = undefined
        if (deadRef.current) return
        const rest = stream.flush()
        if (rest) term.write(rest)
      }, 16)
    }
    const writeHighlighted = (data: string) => {
      const out = stream.push(data)
      if (out) term.write(out)
      scheduleCarryFlush()
    }
    // Clickable URLs. Ctrl/Cmd+Click opens the target in the system browser;
    // the pointer cursor + underline advertise it on hover. A plain click stays
    // with the terminal (cursor placement / selection), so a link can never
    // open by accident while selecting text.
    const linkProvider = term.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const buffer = term.buffer.active
        // provideLinks speaks 1-based line numbers, IBuffer.getLine 0-based.
        let first = bufferLineNumber - 1
        if (first < 0) {
          callback(undefined)
          return
        }
        while (first > 0 && buffer.getLine(first)?.isWrapped) first--
        const rows: { index: number; text: string }[] = []
        for (let row = first; row < buffer.length; row++) {
          const line = buffer.getLine(row)
          if (!line || (row > first && !line.isWrapped)) break
          rows.push({ index: row, text: line.translateToString(false) })
        }
        const text = rows.map((r) => r.text).join('')
        // translateToString emits one char per cell run — a double-width char
        // is ONE char spanning TWO columns — so a char offset cannot be mapped
        // to a column with `% cols` (every CJK char on the line shifts the
        // link range). Walk the cells once and record the 1-based x / buffer
        // row of each char position in `text`.
        const cols = term.cols > 0 ? term.cols : 1
        const colAt: number[] = []
        const rowAt: number[] = []
        for (const { index: row } of rows) {
          const line = buffer.getLine(row)
          for (let col = 0; col < cols; col++) {
            if ((line?.getCell(col)?.getWidth() ?? 1) === 0) continue // wide-char tail
            colAt.push(col + 1)
            rowAt.push(row)
          }
        }
        const links: ILink[] = findUrls(text).map((found) => {
          return {
            range: {
              start: { x: colAt[found.start] ?? 1, y: (rowAt[found.start] ?? first) + 1 },
              end: { x: colAt[found.end - 1] ?? 1, y: (rowAt[found.end - 1] ?? first) + 1 }
            },
            text: found.url,
            decorations: { pointerCursor: true, underline: true },
            activate: (event: MouseEvent): void => {
              const mod = navigator.platform.toLowerCase().includes('mac')
                ? event.metaKey
                : event.ctrlKey
              if (!mod) return
              // The main process routes window.open through shell.openExternal.
              window.open(found.url, '_blank', 'noopener')
            }
          }
        })
        callback(links.length > 0 ? links : undefined)
      }
    })
    const disposables: { dispose(): void }[] = [
      ...oscDisposables,
      linkProvider,
      term.onData((data) => {
        if (!deadRef.current) writeBroadcast(sessionId, data)
        // Full-screen TUIs (vim, Claude Code, …) own the alternate buffer, their
        // own key handling and their own cursor: the line buffer, the command
        // history and the completion popup have no business there. Interfering
        // swallowed ↑/↓/Tab/Esc (Esc could not even leave vim's insert mode) and
        // wrote TUI keystrokes into the command history.
        if (term.buffer.active.type === 'alternate') {
          lineBufRef.current = ''
          if (suggestionsRef.current.length > 0) {
            suggestionsRef.current = []
            selIndexRef.current = 0
            setSuggestions([])
            setSuggestionIndex(0)
          }
          return
        }
        // M5: line capture → recordCommand + inline completion overlay. Only user
        // input reaches onData; the shell's own redraws arrive on the pty path,
        // which never touches the buffer.
        const step = stepLineBuffer(lineBufRef, data)
        if (typeof step.submit === 'string' && step.submit) {
          trackSubmittedLine(step.submit)
        }
        if (deadRef.current) {
          suggestionsRef.current = []
          selIndexRef.current = 0
          setSuggestions([])
          setSuggestionIndex(0)
        } else if (step.line) {
          ensureCompletionCache()
          // Suggest only when enabled, and drop entries identical to the line
          // already typed — a popup repeating the full input is pure noise.
          const suggestOn = useSettingsStore.getState().settings.terminal.suggestEnabled
          const list = suggestOn
            ? buildSuggestions(completionCacheRef.current, step.line).filter(
                (s) => s.command !== step.line
              )
            : []
          suggestionsRef.current = list
          selIndexRef.current = Math.min(selIndexRef.current, Math.max(list.length - 1, 0))
          if (list.length === 0) selIndexRef.current = 0
          setSuggestions(list)
          setSuggestionIndex(selIndexRef.current)
        } else {
          suggestionsRef.current = []
          selIndexRef.current = 0
          setSuggestions([])
          setSuggestionIndex(0)
        }
      }),
      term.onSelectionChange(() => {
        if (!useSettingsStore.getState().settings.terminal.copyOnSelect) return
        const sel = term.getSelection()
        if (!sel) return
        void navigator.clipboard.writeText(sel).catch(() => undefined)
      }),
      // Keep the floating completion popup pinned to wherever the text cursor
      // currently is (repositioned only while suggestions are visible; opening
      // the popup also places it once in the effect further below).
      term.onCursorMove(() => {
        if (suggestionsRef.current.length > 0) placeSuggestPopup()
      })
    ]
    // [M5] Placement for a visible popup — one measurement per popup opening,
    // so the overlay appears before a subsequent cursor-move event fires.
    if (suggestionsRef.current.length > 0) placeSuggestPopup()
    // Live data is queued until the replay lands so output keeps its order.
    let replayDone = false
    const pending: string[] = []
    const unsubscribes: (() => void)[] = [
      // Routed via the shared dispatcher (one IPC listener for all panes)
      // instead of a per-pane global listener.
      subscribePtyData(sessionId, (data: string) => {
        if (deadRef.current) return
        if (!replayDone) {
          pending.push(data)
          return
        }
        writeHighlighted(data)
      }),
      subscribePtyExit(sessionId, (code: number) => {
        deadRef.current = true
        setExitCode(code)
        setDead(true)
      })
    ]
    // Late-subscriber catch-up: output emitted before this subscription
    // (shell banner, template-apply rebind) replays from the main buffer.
    void window.api
      .getSessionReplay(sessionId)
      .then((replay: string) => {
        if (!deadRef.current && replay) writeHighlighted(replay)
      })
      .catch(() => undefined)
      .finally(() => {
        replayDone = true
        if (!deadRef.current) for (const chunk of pending) writeHighlighted(chunk)
        pending.length = 0
      })

    let observer: ResizeObserver | undefined
    if (hostRef.current) {
      observer = new ResizeObserver(() => scheduleFit())
      observer.observe(hostRef.current)
      observerRef.current = observer
    }

    // Plain Ctrl/Cmd+V: not a chord xterm handles, so it used to reach the pty
    // as a literal ^V (0x16) — nothing pasted. Handled here, on the terminal
    // host in the capture phase, with preventDefault so the pty never sees it
    // and Chromium's own paste cannot double up. Text follows the same
    // single-line / multi-line rule as the Ctrl+Shift+V path.
    const host = hostRef.current
    const onPasteKey = (e: KeyboardEvent): void => {
      if (e.type !== 'keydown' || e.altKey) return
      const mod = navigator.platform.toLowerCase().includes('mac') ? e.metaKey : e.ctrlKey
      if (!mod || e.shiftKey || e.key.toLowerCase() !== 'v') return
      const target = e.target as HTMLElement | null
      const isXtermHelper =
        target instanceof HTMLTextAreaElement && target.classList.contains('xterm-helper-textarea')
      if (
        target &&
        !isXtermHelper &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return // ordinary inputs keep the browser's native paste
      }
      e.preventDefault()
      e.stopPropagation()
      void pasteFromClipboard()
    }
    host?.addEventListener('keydown', onPasteKey, true)

    return () => {
      if (carryTimer !== undefined) window.clearTimeout(carryTimer)
      if (ptyTimerRef.current) window.clearTimeout(ptyTimerRef.current)
      host?.removeEventListener('keydown', onPasteKey, true)
      for (const unsubscribe of unsubscribes) unsubscribe()
      for (const disposable of disposables) disposable.dispose()
      observer?.disconnect()
      observerRef.current = null
      deadRef.current = true
      webglRef.current?.dispose()
      webglRef.current = null
      // Drop the stream with the session; a fresh one is created next bind so no
      // carry survives across sessions. A mid-session carry is flushed below
      // (harmless: it is treated as raw text by the resync-aware xterm).
      streamRef.current?.flush()
      streamRef.current = null
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
      searchRef.current = null
      if (timerRef.current) window.cancelAnimationFrame(timerRef.current)
      timerRef.current = 0
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- terminal constructed exactly once
  }, [sessionId])

  // ---- options reactivity (no instance rebuild) ----
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontSize = tSettings.fontSize
    term.options.fontFamily = tSettings.fontFamily
    term.options.fontWeight = toFontWeight(tSettings.fontWeight)
    term.options.fontWeightBold = toFontWeight(tSettings.boldFontWeight)
    term.options.letterSpacing = tSettings.letterSpacing
    term.options.lineHeight = tSettings.lineHeight
    term.options.cursorBlink = tSettings.cursorBlink
    term.options.cursorStyle = tSettings.cursorStyle
    term.options.cursorInactiveStyle = tSettings.cursorInactiveStyle
    // Live-appliable in xterm 6: without this the setting only took effect for
    // terminals opened after the change, which reads as "the setting is broken".
    term.options.scrollback = tSettings.scrollback
    term.options.theme = withChromeColors(getThemeById(tSettings.themeId, settings.customThemes).colors as ITheme)
    scheduleFit()
  }, [tSettings, settings.customThemes, scheduleFit])

  // ---- renderer mode changes: keep the instance, swap renderer, refit ----
  useEffect(() => {
    const next = tSettings.rendererMode
    // The construction effect above already applied the mode on mount (this
    // effect runs on mount too); only an actual switch should re-run it.
    if (next === rendererModeRef.current) return
    if (next === 'dom') {
      applyRenderers('dom')
    } else if (!webglRef.current) {
      applyRenderers(next)
    }
    scheduleFit()
  }, [tSettings.rendererMode, applyRenderers, scheduleFit])

  // keep onClose fresh for the dead mask
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useImperativeHandle(
    ref,
    () => ({
      focus() {
        termRef.current?.focus()
      },
      clear() {
        termRef.current?.clear()
      },
      sessionId() {
        return sessionId
      }
    }),
    [sessionId]
  )

  const terminalClassName = useMemo(() => ['terminal-view', className].filter(Boolean).join(' '), [className])

  /**
   * [M5] Compute and store the floating popup position so it hugs the text
   * cursor. Called whenever the suggestions become visible (the cursor does not
   * move while a completion is open, so one placement per popup is enough) and
   * on every cursor move while the popup is open. Coordinates are relative to
   * `suggestHookRef` (the container that wraps the xterm surface), so `top`
   * starts from the terminal content row area.
   */
  /**
   * [M5] Compute and store the floating popup position so it hugs the text
   * cursor. Called whenever the suggestions become visible (the cursor does not
   * move while a completion is open, so one placement per popup is enough) and
   * on every cursor move while the popup is open. Coordinates are relative to
   * `suggestHookRef` (the container that wraps the xterm surface), so `top`
   * starts from the terminal content row area.
   */
  const placeSuggestPopup = useCallback((): void => {
    const term = termRef.current
    if (!term) return
    // xterm 6 internal API (`term._core._renderService.dimensions.css.cell`)
    // may change across versions — keep the guarded fallback to a
    // font-size-based cell estimate.
    const ctx = term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } } }
    const dim = ctx._core?._renderService?.dimensions?.css?.cell
    const fontSize = term.options.fontSize ?? 14
    const lineHeight = term.options.lineHeight ?? 1
    const cellWidth = dim && dim.width > 0 ? dim.width : fontSize * 0.6
    const cellHeight = dim && dim.height > 0 ? dim.height : fontSize * lineHeight
    const padLeft = 4
    const cursorX = term.buffer.active.cursorX
    const cursorY = term.buffer.active.cursorY
    const left = Math.round(cursorX * cellWidth + padLeft)
    const hook = suggestHookRef.current
    const roof = hook ? hook.getBoundingClientRect().height : 0
    const hookWidth = hook ? hook.getBoundingClientRect().width : 0
    // Keep a right-side margin so a wide popup (min 240px) never overflows the
    // terminal container — e.g. a narrow split pane with the cursor mid-text.
    const leftClamped = Math.min(Math.max(left, 0), Math.max(0, hookWidth - 240))
    // Below the cursor row by default; only flip above when there is not enough
    // room under the cursor (uses a height estimate keyed off live count).
    const popH = estimatePopupHeight(suggestionsRef.current.length)
    const belowTop = (cursorY + 1) * cellHeight
    const flip = belowTop > Math.max(roof - popH, 100)
    const top = Math.round(flip ? Math.max(0, cursorY * cellHeight - popH) : belowTop)
    setPopupPos({ left: leftClamped, top, flip })
  }, [])

  const onSearchChange = useCallback((value: string) => {
    setSearchTerm(value)
    searchTermRef.current = value
  }, [])

  const runMenuAction = useCallback(
    (action: () => void) => {
      setMenuPos(null)
      action()
      termRef.current?.focus()
    },
    []
  )

  return (
    <div className={terminalClassName} onMouseDown={() => termRef.current?.focus()} onContextMenu={openContextMenu}>
      {menuPos && (
        <>
          <div
            className="term-menu-overlay"
            onMouseDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setMenuPos(null)
              termRef.current?.focus()
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setMenuPos(null)
            }}
          />
          <div className="term-menu" style={{ left: menuPos.x, top: menuPos.y }}>
            <button
              type="button"
              className="term-menu-item"
              disabled={!menuHasSel}
              onClick={() => runMenuAction(() => void copySelection())}
            >
              <CopyOutlined />
              <span className="term-menu-label">{t('common.copy')}</span>
              <kbd>Ctrl+Shift+C</kbd>
            </button>
            <button
              type="button"
              className="term-menu-item"
              disabled={dead}
              onClick={() => runMenuAction(() => void pasteFromClipboard())}
            >
              <SnippetsOutlined />
              <span className="term-menu-label">{t('common.paste')}</span>
              <kbd>Ctrl+Shift+V</kbd>
            </button>
            <div className="term-menu-sep" />
            <button type="button" className="term-menu-item" onClick={() => runMenuAction(openSearch)}>
              <SearchOutlined />
              <span className="term-menu-label">{t('terminal.menu.find')}</span>
              <kbd>Ctrl+F</kbd>
            </button>
            <button type="button" className="term-menu-item" onClick={() => runMenuAction(() => termRef.current?.selectAll())}>
              <SelectOutlined />
              <span className="term-menu-label">{t('terminal.menu.selectAll')}</span>
              <kbd />
            </button>
            <button type="button" className="term-menu-item" onClick={() => runMenuAction(() => termRef.current?.clear())}>
              <ClearOutlined />
              <span className="term-menu-label">{t('terminal.menu.clear')}</span>
              <kbd />
            </button>
          </div>
        </>
      )}
      {searchOpen && (
        <SearchBar
          value={searchTerm}
          onChange={onSearchChange}
          onPrev={() => search(-1)}
          onNext={() => search(1)}
          onClose={closeSearch}
          enabled={searchTerm.trim().length > 0}
          result={resultInfo}
        />
      )}
      <div className="term-recbar">
        {settings.terminal.showRecButton && (
          <button
            type="button"
            className={`term-rec-btn${recording ? ' is-recording' : ''}`}
            title={recording ? t('terminal.rec.stopLog') : t('terminal.rec.startLog')}
            aria-label={recording ? t('terminal.rec.stop') : t('terminal.rec.start')}
            onClick={() => {
              if (recording) void handleLogStop()
              else void handleLogStart()
            }}
          >
            {recording ? <PauseOutlined /> : <SoundOutlined />}
          </button>
        )}
        {settings.terminal.showOpenLogsButton && (
          <button
            type="button"
            className="term-rec-btn"
            title={t('terminal.rec.openLogs')}
            aria-label={t('terminal.rec.openLogs')}
            onClick={() => window.api.openLogsDir()}
          >
            <FolderOpenOutlined />
          </button>
        )}
        {settings.terminal.showOpenCwdButton && !isSsh && (
          <button
            type="button"
            className="term-rec-btn"
            title={t('terminal.rec.openCwd')}
            aria-label={t('terminal.rec.openCwd')}
            onClick={() => {
              const dir = getSessionCwd(sessionId)
              if (dir) void window.api.openDirectory(dir)
            }}
          >
            <ExportOutlined />
          </button>
        )}
      </div>
      <Modal
        open={paste !== null}
        title={t('terminal.paste.title')}
        okText={t('common.paste')}
        cancelText={t('common.cancel')}
        width={420}
        maskClosable={false}
        onOk={acceptPaste}
        onCancel={cancelPaste}
      >
        <div className="term-paste-confirm">
          <p>{t('terminal.paste.message')}</p>
          <Checkbox
            checked={paste?.noPrompt ?? false}
            onChange={(e) => setPaste((prev) => (prev ? { ...prev, noPrompt: e.target.checked } : prev))}
          >
            {t('terminal.paste.noPrompt')}
          </Checkbox>
          <Checkbox
            checked={paste?.disableDetection ?? false}
            onChange={(e) => setPaste((prev) => (prev ? { ...prev, disableDetection: e.target.checked } : prev))}
          >
            {t('terminal.paste.disableDetection')}
          </Checkbox>
          <p className="term-paste-confirm-hint">{t('terminal.paste.hint')}</p>
        </div>
      </Modal>
      {/* Relative-positioned wrapper around the xterm surface: the suggestion
          popup anchors to this box, so its coordinates start at the terminal
          content rows (the search bar above never offsets the top). */}
      <div className="term-suggest-hook" ref={suggestHookRef}>
        {popupPos !== null && suggestions.length > 0 && (
          <div
            className={'term-suggestbar' + (popupPos.flip ? ' is-flipped' : '')}
            style={{ left: popupPos.left, top: popupPos.top }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="term-suggest-list">
              {suggestions.map((s, i) => (
                <button
                  key={s.id}
                  type="button"
                  className={`term-suggest-item${i === suggestionIndex ? ' is-active' : ''}`}
                  onClick={() => handleTab(s)}
                  title={s.command}
                >
                  <span className="term-suggest-cmd">{s.command}</span>
                  {s.name && <span className="term-suggest-tag">{s.name}</span>}
                </button>
              ))}
            </div>
            <div className="term-suggest-hint">{t('terminal.suggest.hint')}</div>
          </div>
        )}
        <div className="terminal-view-dock" ref={hostRef}>
          {dead && (
            <div className="term-dead-mask">
              <div>{t('terminal.dead.message', { code: exitCode })}</div>
              <button type="button" className="term-dead-btn" onClick={() => onCloseRef.current()}>{t('common.close')}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
})