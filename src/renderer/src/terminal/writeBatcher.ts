/**
 * Output write batching (writeBatcher.ts).
 *
 * A busy TUI delivers one IPC message per pty read, and every `term.write`
 * re-arms xterm's parser scheduler — hundreds of tiny writes a second keep
 * the parser permanently behind the producer, which is what freezes the UI
 * for seconds after an output burst while the backlog drains. This batcher
 * accumulates flushed output and hands it to xterm in ONE write per ~16ms
 * window, so a flood costs one parser run per frame instead of one per IPC
 * message. Ordering is preserved: pushes concatenate and flush in arrival
 * order.
 *
 * Pure + timer-only (no electron/xterm surface), so the self-test drives it
 * with real timers at a small delay: tests/write-batcher.mjs.
 */
export class WriteBatcher {
  private buf = ''
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly sink: (text: string) => void
  private readonly delayMs: number

  constructor(sink: (text: string) => void, delayMs = 16) {
    this.sink = sink
    this.delayMs = delayMs
  }

  /** True while buffered text is waiting for the flush timer. */
  hasPending(): boolean {
    return this.buf.length > 0
  }

  /** Append `text`; the first push in a window arms the single flush timer. */
  push(text: string): void {
    if (!text) return
    this.buf += text
    if (this.timer === undefined) {
      this.timer = setTimeout(() => this.flushNow(), this.delayMs)
    }
  }

  /**
   * Emit everything buffered right now (no-op when empty). Used by the timer,
   * and by the session-death path: PTY_EXIT lands after the final data but
   * before the flush timer, and a dead session drops writes — so the exit
   * handler flushes first.
   */
  flushNow(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (!this.buf) return
    const out = this.buf
    this.buf = ''
    this.sink(out)
  }

  /**
   * Drop buffered text and cancel the timer (session teardown / rebind). A
   * rebound pane re-fetches the session replay, so nothing visible is lost.
   */
  dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.buf = ''
  }
}
