/**
 * Wheel fallback for full-screen TUIs whose mouse reporting never arrives.
 *
 * Why this exists: on Windows the ConPTY layer drops the DEC private modes a
 * child writes before its console input mode is switched to VT (`\x1b[?1000h`
 * … `\x1b[?1003h` … `\x1b[?1006h`). The child believes it enabled mouse
 * reporting and paints an in-app scrollbar, but xterm never learns about it, so
 * it degrades every wheel notch to a bare `ESC[A` / `ESC[B`. A TUI that only
 * scrolls on PageUp/PageDown (or PageUp-half-page) then looks frozen, and the
 * in-app scrollbar can never light up because scrolling never happens.
 *
 * Re-writing the enable sequence from here cannot help — ConPTY already
 * discarded it on the way in. What does work is speaking the vocabulary the TUI
 * does understand: while the alternate screen has NO mouse tracking, translate
 * a wheel notch into a page key. The moment the child really does own mouse
 * reporting (`mouseTrackingMode !== 'none'`) this must stay out of the way, so
 * vim/tmux/less keep their own wheel handling untouched.
 *
 * Pure decision function; the listener wiring lives in TerminalView.
 * Table-tested by tests/wheel-fallback.mjs.
 */

export interface WheelFallbackState {
  /** xterm's `buffer.active.type === 'alternate'` */
  alternate: boolean
  /** xterm's `modes.mouseTrackingMode` — anything but 'none' means the app owns the wheel */
  mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any'
}

/** PageUp / PageDown, the sequences pi-tui and readline-based pagers accept. */
export const WHEEL_FALLBACK_PAGE_UP = '\x1b[5~'
export const WHEEL_FALLBACK_PAGE_DOWN = '\x1b[6~'

/**
 * The sequence to write in place of a wheel notch, or `undefined` to let xterm
 * handle the event normally.
 *
 * Both `preventDefault` and the write are the caller's job: returning a sequence
 * *is* the decision to consume the event. `deltaY` is a direction only — the
 * magnitude is deliberately ignored, because xterm has already folded it into
 * its own scrollback and the TUI pages by viewport, not by pixels.
 */
export function wheelFallbackSequence(state: WheelFallbackState, deltaY: number): string | undefined {
  if (!state.alternate) return undefined
  if (state.mouseTrackingMode !== 'none') return undefined
  if (deltaY === 0) return undefined
  return deltaY < 0 ? WHEEL_FALLBACK_PAGE_UP : WHEEL_FALLBACK_PAGE_DOWN
}
