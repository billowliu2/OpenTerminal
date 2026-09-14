/**
 * Plain-text sanitizer for session logs.
 *
 * Raw PTY output is unreadable in a text file: SGR colors, cursor moves,
 * synchronized-output markers — and for full-screen TUIs (vim, htop) every
 * redrawn frame. For each logged session this filter:
 *   1. strips ANSI escape sequences (CSI / OSC / single-char), statefully
 *      across chunk boundaries (a sequence may split between two PTY chunks);
 *   2. collapses carriage-return overwrites (progress bars, spinner lines)
 *      keeping only the final text of the line — a `\r` directly followed by
 *      `\n` is a line ending, not an overwrite;
 *   3. drops output produced while the alternate screen is active (TUI
 *      redraw frames), emitting one marker line per suppressed span.
 *
 * Note: inline TUIs that redraw in the *normal* buffer (Ink-based CLIs such
 * as Claude Code / kimi) cannot be frame-collapsed without full screen
 * emulation; their committed lines are preserved as-is.
 */

const MARKER = '\n──── [全屏界面(TUI)输出已省略] ────\n'

type Mode = 'text' | 'esc' | 'esc-skip1' | 'csi' | 'osc' | 'osc-esc'

/** Alt-screen toggles: CSI ? 1049|1047|47 h / l */
const ALT_ON = /^\?(?:1049|1047|47)h$/
const ALT_OFF = /^\?(?:1049|1047|47)l$/

export class LogSanitizer {
  private mode: Mode = 'text'
  /** raw bytes of the escape sequence in flight (bounded: OSC can be long) */
  private seq = ''
  private alt = false
  /** some output was suppressed since the last marker */
  private altDirty = false
  /** current line, not yet newline-terminated */
  private line = ''
  /** previous text char was \r — the next char decides ending vs overwrite */
  private cr = false

  /** Transform one raw chunk; returns the plain text to append ('' for none). */
  push(data: string): string {
    let out = ''
    for (let i = 0; i < data.length; i++) {
      const c = data[i]

      // A pending \r: `\r\n` completes the line; anything else overwrites it.
      if (this.cr) {
        this.cr = false
        if (c === '\n') {
          out += this.emitLine()
          continue
        }
        this.line = ''
        // fall through and process c normally
      }

      switch (this.mode) {
        case 'text':
          if (c === '\x1b') {
            this.mode = 'esc'
            this.seq = ''
          } else if (c === '\r') {
            this.cr = true
          } else if (c === '\n') {
            out += this.emitLine()
          } else if (c === '\t' || c >= ' ' || c === '\x7f') {
            // printable + tab; DEL and C0 controls (bell etc.) are dropped
            if (this.alt) this.altDirty = true
            else this.line += c
          }
          break
        case 'esc':
          if (c === '[') this.mode = 'csi'
          else if (c === ']') this.mode = 'osc'
          else if (c === '(' || c === ')' || c === '#' || c === '%') this.mode = 'esc-skip1'
          else this.mode = 'text' // single-character escape, consumed
          break
        case 'esc-skip1':
          this.mode = 'text'
          break
        case 'csi':
          if (c >= '@' && c <= '~') {
            // the final byte is not part of `seq` — test the full sequence
            const full = this.seq + c
            if (ALT_ON.test(full)) {
              this.alt = true
            } else if (ALT_OFF.test(full)) {
              this.alt = false
              if (this.altDirty) {
                this.altDirty = false
                out += MARKER
              }
            }
            this.seq = ''
            this.mode = 'text'
          } else if (this.seq.length < 1024) {
            this.seq += c
          }
          break
        case 'osc':
          if (c === '\x07') this.mode = 'text'
          else if (c === '\x1b') this.mode = 'osc-esc'
          break
        case 'osc-esc':
          // ST is ESC \; a new ESC [ / ESC ] starts the next sequence
          if (c === '\\') this.mode = 'text'
          else if (c === '[') {
            this.mode = 'csi'
            this.seq = ''
          } else if (c === ']') this.mode = 'osc'
          else this.mode = 'text'
          break
      }
    }
    return out
  }

  /** Flush the pending partial line at log stop. */
  flush(): string {
    let out = ''
    if (this.cr) {
      this.cr = false
      // A trailing \r at stop: treat as line ending rather than overwrite.
      out += this.emitLine()
    } else if (this.line && !this.alt) {
      out += this.line
      this.line = ''
    }
    if (this.altDirty) {
      this.altDirty = false
      out += MARKER
    }
    return out
  }

  /** Complete the current line: hand it out with a newline and reset. */
  private emitLine(): string {
    if (this.alt) {
      if (this.line) this.altDirty = true
      this.line = ''
      return ''
    }
    const out = this.line ? this.line + '\n' : '\n'
    this.line = ''
    return out
  }
}
