/**
 * Release everything the output path is still holding, in the order the
 * terminal must see it.
 *
 * Two buffers sit between the PTY and xterm:
 *   - the highlight stream holds the trailing TEXT RUN of every escape-free
 *     chunk (it has to hold it, or a rule anchored with `^` would match
 *     mid-line), and
 *   - the write batcher holds a ~16ms window of what the stream already
 *     released.
 *
 * The session-death path must release BOTH, and it must do it BEFORE the pane
 * starts dropping writes: PTY_EXIT lands right after the last PTY_DATA, so
 * whatever is still held IS the session's final output. Releasing only the
 * batcher dropped the last line of every session that ended within 16ms of
 * its last output — and a dead session has no replay left to re-fetch it.
 *
 * Zero imports on purpose: the test reaches this module through Node's
 * native type stripping (Node >= 22.18).
 */

/** The part of HighlightStream this module needs. */
export interface FlushableStream {
  /** Release the held bytes as a final text run. */
  flush(): string
}

/** The part of WriteBatcher this module needs. */
export interface FlushableBatcher {
  /** Queue text for the next window. */
  push(text: string): void
  /** Emit the queued text now and cancel the pending window. */
  flushNow(): void
}

/**
 * Push the stream's held bytes into the batcher, then close the batcher's
 * window. The order matters: a flushNow() before the push would close an
 * empty batcher and leave the held text sitting in the next window.
 */
export function flushPendingOutput(stream: FlushableStream, batcher: FlushableBatcher): void {
  const held = stream.flush()
  if (held) batcher.push(held)
  batcher.flushNow()
}