/**
 * Broadcast-store self-test (broadcast-store.mjs).
 *
 * `src/renderer/src/workspace/broadcastStore.ts` decides who receives a keypress
 * typed into one pane, and it holds the two rules that are easy to get wrong:
 *
 *   1. fan-out only happens when broadcast is on AND the originating session is
 *      itself a target — otherwise the keypress stays in the pane it came from;
 *   2. losing a target session wipes the whole selection and turns broadcast off
 *      (`pruneOnTargetLoss`), while *unchecking* one by hand deliberately keeps
 *      the remaining targets and only drops `enabled`. The two paths look alike
 *      and are not.
 *
 * `pruneOnTargetLoss` is module-private, so its behaviour is pinned through the
 * only caller that can reach it (`unregisterSession`) instead of by exporting it.
 * The panel registry is module-level and append-only, so each scenario uses its
 * own ids and resets `enabled`/`targets` through the store's public `setState`.
 * The `window.api.writePty` surface is stubbed for the write-path scenarios.
 *
 * The import pulls in zustand (a devDependency); no React renderer is involved —
 * the store's `getState`/`setState` work on their own, which is why this test can
 * import the module directly instead of going through an esbuild bundle.
 * Run: node tests/broadcast-store.mjs   (must exit 0)
 */
import { broadcastFanOut, useBroadcastStore, writeBroadcast } from '../src/renderer/src/workspace/broadcastStore.ts'

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}

const store = useBroadcastStore
const state = () => store.getState()
/** Reset only the fields these scenarios drive; the panel registry is shared. */
const reset = () => store.setState({ enabled: false, targets: new Set() })
const open = (panelId, id) => state().registerSession({ id, panelId, title: id, isSsh: false })
const targets = () => [...state().targets]
const openIds = () => state().sessions.map((s) => s.id)

console.log('broadcastFanOut: who receives the keypress')
const fanOutCases = [
  ['a', [], false, ['a']],
  ['a', ['a'], false, ['a']],
  ['a', ['a', 'b'], false, ['a']],
  ['a', [], true, ['a']],
  ['a', ['a'], true, ['a']],
  ['a', ['b', 'c'], true, ['a']],
  ['a', ['a', 'b'], true, ['a', 'b']],
  ['b', ['b', 'a'], true, ['b', 'a']],
  ['c', ['a', 'b', 'c'], true, ['a', 'b', 'c']]
]
for (const [origin, list, enabled, expected] of fanOutCases) {
  const got = broadcastFanOut(origin, new Set(list), enabled)
  const same = JSON.stringify(got) === JSON.stringify(expected)
  ok(
    same,
    `origin ${origin}, targets [${list}], enabled=${enabled} -> [${got}]${same ? '' : ` (want [${expected}])`}`
  )
}

console.log('broadcastFanOut returns a fresh array')
const live = new Set(['a', 'b'])
const out = broadcastFanOut('a', live, true)
ok(Array.isArray(out) && out !== live, 'the result is not the live Set')
out.push('c')
ok(live.size === 2 && !live.has('c'), 'mutating the result does not touch the live target set')

console.log('losing a target session wipes the selection and turns broadcast off')
reset()
open('a-p1', 'a1')
open('a-p2', 'a2')
state().toggleTarget('a1')
state().toggleTarget('a2')
ok(state().enabled === true && targets().join() === 'a1,a2', 'two targets turn broadcast on')
state().unregisterSession('a-p2')
ok(state().enabled === false, 'closing the pane that showed a target turns broadcast off')
ok(targets().length === 0, 'the whole selection is dropped, not just the lost id')
ok(!openIds().includes('a2'), 'the closed session left the registry')
ok(openIds().includes('a1'), 'the session that is still open stays')

console.log('unchecking by hand keeps the rest of the selection')
reset()
open('b-p1', 'b1')
open('b-p2', 'b2')
open('b-p3', 'b3')
for (const id of ['b1', 'b2', 'b3']) state().toggleTarget(id)
ok(state().enabled === true && targets().length === 3, 'three targets turn broadcast on')
state().toggleTarget('b3')
ok(state().enabled === true && targets().join() === 'b1,b2', 'dropping to two targets keeps it on')
state().toggleTarget('b2')
ok(
  state().enabled === false && targets().join() === 'b1',
  'dropping below the minimum turns it off but keeps the remaining target'
)

console.log('a session mirrored in two panes survives one of them closing')
reset()
open('c-pA', 'c1')
open('c-pB', 'c1')
open('c-pC', 'c2')
ok(openIds().filter((id) => id === 'c1').length === 1, 'two panels showing one session register it once')
state().toggleTarget('c1')
state().toggleTarget('c2')
ok(state().enabled === true && targets().join() === 'c1,c2', 'c1 is mirrored, c2 is not')
state().unregisterSession('c-pA')
ok(openIds().includes('c1'), 'the mirrored session is still open through the other pane')
ok(targets().join() === 'c1,c2' && state().enabled === true, 'and keeps its target slot')
state().unregisterSession('c-pB')
ok(!openIds().includes('c1'), 'the last pane showing it takes the session out of the registry')
ok(state().enabled === false && targets().length === 0, 'losing it prunes the target set')

console.log('broadcast needs two targets to turn on')
reset()
open('d-p1', 'd1')
state().setEnabled(true)
ok(state().enabled === false, 'enabling with no targets is refused')
state().toggleTarget('d1')
ok(state().enabled === false && targets().join() === 'd1', 'a single target stays off')
state().setEnabled(true)
ok(state().enabled === false, 'still refused with one target')
open('d-p2', 'd2')
state().toggleTarget('d2')
ok(state().enabled === true, 'the second target turns it on')
state().setEnabled(false)
ok(state().enabled === false, 'it can always be turned off')
state().setEnabled(true)
ok(state().enabled === true, 'and back on while two targets remain')

console.log('unregistering an unknown or already-dropped panel is a no-op')
reset()
open('e-p1', 'e1')
open('e-p2', 'e2')
state().toggleTarget('e1')
state().toggleTarget('e2')
state().unregisterSession('e-never-registered')
ok(state().enabled === true && targets().join() === 'e1,e2', 'an unknown panel id changes nothing')
ok(openIds().includes('e1') && openIds().includes('e2'), 'and drops no session')
state().unregisterSession('e-p1')
const snapshot = JSON.stringify({ enabled: state().enabled, targets: targets(), sessions: openIds() })
state().unregisterSession('e-p1')
ok(
  JSON.stringify({ enabled: state().enabled, targets: targets(), sessions: openIds() }) === snapshot,
  'a second unregister of the same panel changes nothing'
)

console.log('writeBroadcast fans out through the live registry')
reset()
open('f-p1', 'f1')
open('f-p2', 'f2')
state().toggleTarget('f1')
state().toggleTarget('f2')
const writes = []
globalThis.window = { api: { writePty: (id, data) => writes.push(`${id}:${data}`) } }
try {
  writeBroadcast('f1', 'ls')
  ok(writes.join(' ') === 'f1:ls f2:ls', 'an enabled origin that is a target reaches every target')
  writes.length = 0
  store.setState({ targets: new Set(['f1', 'f2', 'f-ghost']) })
  writeBroadcast('f1', 'x')
  ok(writes.join(' ') === 'f1:x f2:x', 'a target with no open session is skipped')
  writes.length = 0
  store.setState({ enabled: false })
  writeBroadcast('f2', 'y')
  ok(writes.join(' ') === 'f2:y', 'with broadcast off only the origin is written')
  writes.length = 0
  store.setState({ enabled: true, targets: new Set(['f1', 'f2']) })
  open('f-p3', 'f3')
  writeBroadcast('f3', 'q')
  ok(writes.join(' ') === 'f3:q', 'an open origin that is not a target writes only to itself')
  writes.length = 0
  store.setState({ enabled: false })
  writeBroadcast('f-gone', 'w')
  ok(writes.length === 0, 'a closed origin writes nowhere')
} finally {
  delete globalThis.window
}

if (failed > 0) {
  console.error(`\n[broadcast-store] ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('\n[broadcast-store] ALL CHECKS PASSED')
