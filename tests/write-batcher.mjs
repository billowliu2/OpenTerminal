/**
 * WriteBatcher self-test (write-batcher.mjs).
 *
 * `src/renderer/src/terminal/writeBatcher.ts` sits between the highlight
 * stream and `term.write`: it exists because a busy TUI delivers one IPC
 * message per pty read, and one `term.write` per message re-arms xterm's
 * parser scheduler hundreds of times a second — the parser falls permanently
 * behind and the UI freezes while the backlog drains. The contract the table
 * below pins:
 *
 *   - pushes inside one window land in a SINGLE sink call, concatenated in
 *     arrival order; the first push arms the only timer;
 *   - after a flush the batcher is reusable: the next push arms a new timer;
 *   - `flushNow` emits immediately and cancels the pending timer (the session
 *     -death path relies on this — PTY_EXIT lands before the timer would);
 *   - `dispose` drops buffered text and cancels the timer (teardown/rebind);
 *   - flushing an empty batcher never calls the sink.
 *
 * Direct .ts import (no esbuild bundle needed): the module has no imports and
 * no runtime-only TS syntax, and Node >= 22.18 strips types itself.
 * Run: node tests/write-batcher.mjs   (must exit 0)
 */
import { WriteBatcher } from '../src/renderer/src/terminal/writeBatcher.ts'

const DELAY = 10
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}

const makeSink = () => {
  const calls = []
  return { calls, sink: (text) => calls.push(text) }
}

console.log('pushes inside one window land in a single ordered flush')
{
  const { calls, sink } = makeSink()
  const b = new WriteBatcher(sink, DELAY)
  b.push('a')
  b.push('b')
  b.push('c')
  ok(calls.length === 0, 'nothing is written before the window elapses')
  ok(b.hasPending(), 'hasPending reports buffered text')
  await sleep(DELAY * 4)
  ok(calls.length === 1, `one sink call for three pushes (got ${calls.length})`)
  ok(calls[0] === 'abc', 'order is preserved across pushes')
  ok(!b.hasPending(), 'buffer is empty after the flush')
  b.dispose()
}

console.log('the batcher is reusable after a flush')
{
  const { calls, sink } = makeSink()
  const b = new WriteBatcher(sink, DELAY)
  b.push('first')
  await sleep(DELAY * 4)
  b.push('second')
  await sleep(DELAY * 4)
  ok(calls.length === 2 && calls[0] === 'first' && calls[1] === 'second', 'each window flushes once')
  b.dispose()
}

console.log('flushNow emits immediately and cancels the pending timer')
{
  const { calls, sink } = makeSink()
  const b = new WriteBatcher(sink, DELAY)
  b.push('tail')
  b.flushNow()
  ok(calls.length === 1 && calls[0] === 'tail', 'flushNow writes synchronously')
  await sleep(DELAY * 4)
  ok(calls.length === 1, 'the cancelled timer never fires a second write')
  b.dispose()
}

console.log('dispose drops buffered text and the timer')
{
  const { calls, sink } = makeSink()
  const b = new WriteBatcher(sink, DELAY)
  b.push('dropped')
  b.dispose()
  ok(!b.hasPending(), 'dispose clears the buffer')
  await sleep(DELAY * 4)
  ok(calls.length === 0, 'disposed batcher never writes')
}

console.log('an empty flush never reaches the sink')
{
  const { calls, sink } = makeSink()
  const b = new WriteBatcher(sink, DELAY)
  b.flushNow()
  b.push('')
  await sleep(DELAY * 4)
  ok(calls.length === 0, 'no sink call without content')
  b.dispose()
}

if (failed > 0) {
  console.error(`\n[write-batcher] ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('\n[write-batcher] ALL CHECKS PASSED')
