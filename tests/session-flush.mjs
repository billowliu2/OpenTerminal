/**
 * Session-death flush self-test (session-flush.mjs).
 *
 * The output path has TWO buffers between the PTY and xterm:
 *   - HighlightStream holds the trailing TEXT RUN of every escape-free chunk
 *     (it must hold it, or a rule anchored with `^` would match mid-line);
 *   - WriteBatcher holds a ~16ms window of what the stream already released.
 *
 * The session-death path must release BOTH, in that order, before the pane
 * starts dropping writes: PTY_EXIT arrives right after the last PTY_DATA, so
 * whatever is still held is exactly the session's final output. Releasing only
 * the batcher (the old behaviour) dropped the last line of every session that
 * ended within 16ms of its last output — and a dead session has no replay to
 * re-fetch it from.
 *
 * Direct .ts import (no esbuild bundle needed): the module has no imports and
 * no runtime-only TS syntax, and Node >= 22.18 strips types itself.
 * Run: node tests/session-flush.mjs   (must exit 0)
 */
import { flushPendingOutput } from '../src/renderer/src/terminal/sessionFlush.ts'
import { WriteBatcher } from '../src/renderer/src/terminal/writeBatcher.ts'
import { readFileSync } from 'node:fs'

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}

console.log('the final output survives the session-death path')
{
  const calls = []
  // A 10s window: without the flush the batcher would still be holding when
  // the test ends, which is exactly the bug (the text never reaches xterm).
  const batcher = new WriteBatcher((text) => calls.push(text), 10_000)
  const stream = { flush: () => 'final line\r\n' }
  flushPendingOutput(stream, batcher)
  ok(calls.length === 1, `the held text is written exactly once (got ${calls.length})`)
  ok(calls[0] === 'final line\r\n', 'the held text reaches the sink verbatim')
  batcher.dispose()
}

console.log('the held text is queued BEFORE the window is closed')
{
  const order = []
  const batcher = {
    push: () => order.push('push'),
    flushNow: () => order.push('flushNow')
  }
  flushPendingOutput({ flush: () => 'x' }, batcher)
  ok(order.join(',') === 'push,flushNow', `push must precede flushNow (got ${order.join(',')})`)
}

console.log('an empty stream does not queue an empty string')
{
  const pushed = []
  const batcher = { push: (t) => pushed.push(t), flushNow: () => undefined }
  flushPendingOutput({ flush: () => '' }, batcher)
  ok(pushed.length === 0, 'nothing is queued when the stream holds nothing')
}

console.log('the batcher window is always closed')
{
  let flushed = 0
  const batcher = { push: () => undefined, flushNow: () => { flushed += 1 } }
  flushPendingOutput({ flush: () => '' }, batcher)
  ok(flushed === 1, 'flushNow runs even when the stream was empty')
}

// Structural gate on the production wiring. The two functional checks above
// only prove `flushPendingOutput` itself works; they stay green even if someone
// reverts markDead to a bare `batcher.flushNow()` or moves the call to AFTER
// `deadRef.current = true` (which starts dropping writes). That regression
// would silently drop every dead session's last line — a dead session has no
// replay to re-fetch it from. So require the call to appear BEFORE the dead
// flag is set.
console.log('[markDead production wiring]')
{
  let body = readFileSync('src/renderer/src/terminal/TerminalView.tsx', 'utf8')
  const markStart = body.indexOf('const markDead = (code: number): void => {')
  ok(markStart !== -1, 'markDead exists')
  if (markStart !== -1) {
    // The function body is delimited by balanced braces from the first one after
    // the arrow (the terminator itself appears only inside nested braces/templates).
    let i = body.indexOf('{', markStart)
    let depth = 0
    let end = body.length
    for (; i < body.length; i++) {
      if (body[i] === '{') depth++
      else if (body[i] === '}') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    body = body.slice(markStart, end + 1)
    const flushAt = body.indexOf('flushPendingOutput(')
    const deadAt = body.indexOf('deadRef.current = true')
    ok(flushAt !== -1, 'markDead calls flushPendingOutput')
    if (flushAt === -1 || deadAt === -1) failed += 1
    else {
      ok(
        flushAt < deadAt,
        `flushPendingOutput is called BEFORE deadRef.current = true (flush at ${flushAt}, dead at ${deadAt})`
      )
    }
  } else {
    failed += 1
  }
}

if (failed > 0) {
  console.error(`\n[session-flush] ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('\n[session-flush] ALL CHECKS PASSED')