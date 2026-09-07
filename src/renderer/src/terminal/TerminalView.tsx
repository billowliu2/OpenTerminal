import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ForwardRefExoticComponent, Ref } from 'react'
import { Terminal } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { FolderOpenOutlined, PauseOutlined, SoundOutlined } from '@ant-design/icons'
import { getThemeById } from '@shared/theme'
import type { CommandItem } from '@shared/commands'
import type { PtyDataEvent, PtyExitEvent } from '@shared/ipc'
import type { TerminalSettings } from '@shared/settings'
import { useSettingsStore } from '@renderer/settings/store'
import { writeBroadcast } from '@renderer/workspace/broadcastStore'
import { compileRules, HighlightStream, type CompiledRule } from './highlightEngine'
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

/** Paste-risk heuristic: multi-line or unreasonably long text. */
function isRiskyPaste(text: string): boolean {
  if (text.includes('\n') || text.includes('\r')) return true
  return text.length > 100
}

const SEARCH_DECORATIONS: NonNullable<NonNullable<Parameters<SearchAddon['findNext']>[1]>['decorations']> = {
  matchBackground: '#3b8eea',
  matchBorder: '#2d2d2d',
  matchOverviewRuler: '#3b8eea',
  activeMatchBackground: '#c77800',
  activeMatchBorder: '#2d2d2d',
  activeMatchColorOverviewRuler: '#c77800'
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
        placeholder="搜索"
        spellCheck={false}
        autoFocus
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') onNext()
          else if (e.key === 'Escape') onClose()
        }}
      />
      <button type="button" className="term-searchbar-btn" disabled={!enabled} onClick={onPrev}>上一个</button>
      <button type="button" className="term-searchbar-btn" disabled={!enabled} onClick={onNext}>下一个</button>
      <span className="term-searchbar-count">{result}</span>
      <button type="button" className="term-searchbar-btn" onClick={onClose}>关闭</button>
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
 * `rewrite` flags a completion acceptance that just rewrote the shell line (a
 * Ctrl+U kill + full-command write). The very next onData chunk is the shell's
 * redraw echoing the accepted line, so instead of appending onto the stale
 * pre-accept buffer we *replace* it with what the pty actually echoed. This is
 * the echo-suppression that keeps the local buffer in sync with the shell and
 * prevents the accepted text from being duplicated.
 */
function stepLineBuffer(
  outBuf: React.MutableRefObject<string>,
  data: string,
  rewrite: boolean
): { line: string; submit?: string } {
  const b = outBuf.current
  if (!data) return { line: b }
  // Completion-rewrite redraw: reset to this chunk's visible text verbatim. For
  // a shell like PowerShell the redraw is a leading escape/control sequence
  // + the line text; strip leading control bytes so only the echoed command
  // enters the buffer (matching how a normal chunk is captured). Any trailing
  // text on the chunk is appended as usual.
  if (rewrite) {
    let i = 0
    while ((data[i] === '\x1b' && (data[i + 1] === '[' || data[i + 1] === '(')) || data[i] === '\r' || data[i] === '\n') {
      i += data[i] === '\x1b' ? 2 : 1
    }
    const visible = data.slice(i)
    if (visible) {
      outBuf.current = visible
      return { line: visible }
    }
    // Only control output (e.g. the kill sequence handling) — treat as a reset.
    outBuf.current = ''
    return { line: '' }
  }
  // A chunk that begins with escape/control sequences (e.g. the terminal's
  // clear-line) only removes buffer content; never appends.
  const first = data[0]
  if (b === '' && first === '\x1b') return { line: '' }
  if (first === '\r') return submitOr(b)
  if (first === '\x7f') {
    outBuf.current = b.slice(0, -1)
    return { line: outBuf.current }
  }
  if (first === '\x03') {
    outBuf.current = ''
    return { line: '' }
  }
  if (first === '\x1b') return { line: b }
  outBuf.current = b + data
  return { line: outBuf.current }
}

function submitOr(b: string): { line: string; submit?: string } {
  const t = b.trim()
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
  forwardRef<TerminalHandle, TerminalViewProps>(function TerminalViewInner({ sessionId, onClose, className }, ref) {
  const settings = useSettingsStore((s) => s.settings)

  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const webglRef = useRef<WebglAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const timerRef = useRef<number>(0)
  const deadRef = useRef(false)
  const searchOpenRef = useRef(false)
  const searchTermRef = useRef('')
  const nativePasteRef = useRef<string | null>(null)
  const onCloseRef = useRef(onClose)
  const compiledRef = useRef<CompiledRule[]>([])
  const streamRef = useRef<HighlightStream | null>(null)
  // M5: per-session line-capture buffer + completion candidate cache.
  const lineBufRef = useRef<string>('')
  // M5: when a completion acceptance rewrites the shell line (Ctrl+U + full
  // command via writeBroadcast in `differenceWrite`), the shell answers with a
  // redraw that echoes `full`. If that echo were folded into the local buffer
  // on top of the pre-accept text it would double the line. `diffRewriteRef`
  // flags that the *next* onData chunk is that redraw output, so stepLineBuffer
  // replaces the buffer with the freshly-echoed line instead of appending.
  const diffRewriteRef = useRef(false)
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
  compiledRef.current = compiledRules
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
  const [paste, setPaste] = useState<string | null>(null)
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
    if (mode === 'dom') return
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
      if (term && !deadRef.current) {
        window.api.resizePty(sessionId, term.cols, term.rows)
      }
    })
  }, [sessionId])

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
    setResultInfo(found ? '已找到' : '未找到')
  }, [])

  const confirmPaste = useCallback(
    (text: string) => {
      const data = nativePasteRef.current ?? text
      nativePasteRef.current = null
      setPaste(null)
      if (!deadRef.current) writeBroadcast(sessionId, data)
      termRef.current?.focus()
    },
    [sessionId]
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
      if (!deadRef.current && settings.terminal.pasteRiskConfirm && isRiskyPaste(text)) {
        nativePasteRef.current = text
        setPaste(text)
        return
      }
      confirmPaste(text)
    },
    [settings.terminal.pasteRiskConfirm, confirmPaste]
  )

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
    if (!settings.terminal.copyOnSelect) term.clearSelection()
  }, [settings.terminal.copyOnSelect])

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
      // delta — the pty redraw, not our local buffer, becomes the source of
      // truth for the line (see differenceWrite). The redraw trigger sets the
      // rewrite flag so onData resets the line buffer to the echoed line.
      differenceWrite(sessionId, cmd, lineBufRef.current)
      diffRewriteRef.current = true
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
        searchOpenRef.current = true
        setSearchOpen(true)
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
    [closeSearch, copySelection, pasteFromClipboard, moveSelection, handleTab]
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
      theme: getThemeById(tSettings.themeId, settings.customThemes).colors as ITheme,
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

    termRef.current = term
    // Rebind (e.g. template apply) must clear a death marker left by the
    // previous session's exit — otherwise the pane stays under the dead mask.
    deadRef.current = false
    setDead(false)
    setExitCode(0)
    // M5: reset per-session state on (re)bind — fresh line buffer, no leftovers
    // from a template apply or panel reuse; recording resumes idle.
    lineBufRef.current = ''
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
    const disposables: { dispose(): void }[] = [
      term.onData((data) => {
        if (!deadRef.current) writeBroadcast(sessionId, data)
        // M5: a completion acceptance rewrite armed `diffRewriteRef`; consume it
        // now so this redraw chunk replaces (not appends to) the line buffer.
        const consumeRewrite = diffRewriteRef.current
        diffRewriteRef.current = false
        // M5: line capture → recordCommand + inline completion overlay.
        const step = stepLineBuffer(lineBufRef, data, consumeRewrite)
        if (typeof step.submit === 'string' && step.submit) {
          void window.api.recordCommand(step.submit).catch(() => undefined)
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
      window.api.onPtyData((e: PtyDataEvent) => {
        if (e.id !== sessionId || deadRef.current) return
        if (!replayDone) {
          pending.push(e.data)
          return
        }
        writeHighlighted(e.data)
      }),
      window.api.onPtyExit((e: PtyExitEvent) => {
        if (e.id !== sessionId) return
        deadRef.current = true
        setExitCode(e.exitCode)
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

    return () => {
      if (carryTimer !== undefined) window.clearTimeout(carryTimer)
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
    term.options.theme = { ...(getThemeById(tSettings.themeId, settings.customThemes).colors as ITheme) }
    scheduleFit()
  }, [tSettings, settings.customThemes, scheduleFit])

  // ---- renderer mode changes: keep the instance, swap renderer, refit ----
  useEffect(() => {
    const next = tSettings.rendererMode
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

  return (
    <div className={terminalClassName} onMouseDown={() => termRef.current?.focus()}>
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
        <button
          type="button"
          className={`term-rec-btn${recording ? ' is-recording' : ''}`}
          title={recording ? '停止记录会话日志' : '开始记录会话日志'}
          aria-label={recording ? '停止记录' : '开始记录'}
          onClick={() => {
            if (recording) void handleLogStop()
            else void handleLogStart()
          }}
        >
          {recording ? <PauseOutlined /> : <SoundOutlined />}
        </button>
        <button
          type="button"
          className="term-rec-btn"
          title="打开日志目录"
          aria-label="打开日志目录"
          onClick={() => window.api.openLogsDir()}
        >
          <FolderOpenOutlined />
        </button>
      </div>
      {paste !== null && !dead && (
        <div className="term-pastebar">
          <span className="term-pastebar-text">检测到多行/长文本粘贴</span>
          <button type="button" className="term-pastebar-btn term-pastebar-btn-ok" onClick={() => confirmPaste(paste)}>
            粘贴
          </button>
          <button type="button" className="term-pastebar-btn term-pastebar-btn-cancel" onClick={cancelPaste}>
            取消
          </button>
        </div>
      )}
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
            <div className="term-suggest-hint">↑/↓ 选择 · Tab 接受 · Esc 关闭</div>
          </div>
        )}
        <div className="terminal-view-dock" ref={hostRef}>
          {dead && (
            <div className="term-dead-mask">
              <div>进程已退出 (代码 {exitCode})</div>
              <button type="button" className="term-dead-btn" onClick={() => onCloseRef.current()}>关闭</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
})