/**
 * Template-apply cleared-vs-touched self-test (template-apply.mjs).
 *
 * dockview's real `_doFromJSON` splits on the root check: it throws
 * `grid.root.type !== 'branch'` BEFORE `this.clear()`, leaving the dockview
 * untouched — but once the root check passes it runs `this.clear()` and only
 * then deserializes, so a deserialization failure (clear-then-throw, or worse a
 * payload that silently fails to materialize every panel it declares) wipes the
 * old layout with no exception escaping.
 *
 * The old verdict — "touched only if fromJSON RETURNED, throwing means
 * untouched" — misread a clear-then-throw as "untouched", so the recovery path
 * skipped restoring the SSH dockview and its panes were lost for good. The new
 * verdict is evidential: compare the panel-id set before and after each call,
 * and treat "result missing declared panels" as a failure too. `cleared` is
 * meaningful on the failure path only.
 *
 * Direct .ts import (no esbuild bundle needed): the module has no imports and
 * Node >= 22.18 strips types itself.
 * Run: node tests/template-apply.mjs   (must exit 0)
 */
import { applyTemplatePayload } from '../src/renderer/src/workspace/templateApply.ts'

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}

/**
 * A dockview double. `mode` selects the three dockview behaviors:
 *  - 'throw-untouched': `fromJSON` validates at root and throws WITHOUT
 *    touching panels (the root-check stage).
 *  - 'clear-then-throw': `fromJSON` clears the panels, then throws (the
 *    deserialization stage).
 *  - 'silent-clear': `fromJSON` clears the panels and rebuilds something,
 *    but the rebuild materializes only the ids in `actual` (default: a subset
 *    missing at least one declared id); it does NOT throw.
 *  - (default) 'legal': replace panels wholesale, materialize exactly what the
 *    payload declares, no throw.
 *
 * `panels` is the dockview's live, settable panel-id source — the module reads
 * `api.panels`, so clearing means replacing that list.
 */
const makeApi = (mode = 'legal', overrides = {}) => {
  const state = { panelIds: [...(overrides.panels ?? ['a', 'b'])] }
  const declared = (data) => {
    if (!data || typeof data !== 'object') return []
    const panels = data.panels
    if (!panels || typeof panels !== 'object') return []
    return Object.keys(panels)
  }
  const api = {
    loaded: [],
    mode,
    state,
    get panels() {
      return state.panelIds.map((id) => ({ id }))
    },
    fromJSON(data) {
      if (mode === 'throw-untouched') throw new Error('dockview: root must be of type branch')
      if (mode === 'clear-then-throw') {
        state.panelIds = []
        throw new Error('dockview: failed to deserialize layout. Reverting changes')
      }
      if (mode === 'silent-clear') {
        state.panelIds = [...(overrides.actual ?? declared(data).slice(0, -1))]
        api.loaded.push(data)
        return
      }
      // legal: assume every group/panel the payload declares materializes
      state.panelIds = [...declared(data)]
      api.loaded.push(data)
    },
    toJSON() {
      return { grid: { root: { type: 'branch', data: [] } }, panels: {} }
    }
  }
  return api
}

const payload = (terminalData, sshData) => ({ terminal: terminalData, ssh: sshData })

console.log('[acceptance 1] root validation failure clears nothing')
{
  const terminal = makeApi('throw-untouched', { panels: ['t1', 't2'] })
  const ssh = makeApi('throw-untouched', { panels: ['s1'] })
  const res = applyTemplatePayload(terminal, ssh, payload({ grid: null }, { grid: { root: {} } }), true)
  ok(res.terminal.error !== undefined, 'terminal failure is reported')
  ok(res.terminal.cleared === false, 'terminal side is NOT cleared (its throw preceded clear())')
  ok(res.ssh.error !== undefined, 'ssh failure is reported')
  ok(res.ssh.cleared === false, 'ssh side is NOT cleared')
  ok(terminal.state.panelIds.join(',') === 't1,t2', 'terminal panels untouched')
  ok(ssh.state.panelIds.join(',') === 's1', 'ssh panels untouched')
}

console.log('[acceptance 2] deserialization failure clears the live side')
{
  const terminal = makeApi('clear-then-throw', { panels: ['t1', 't2'] })
  const ssh = makeApi('legal', { panels: ['s1'] })
  const res = applyTemplatePayload(terminal, ssh, payload({ panels: { x: {} } }, { panels: { y: {} } }), true)
  ok(res.terminal.error !== undefined, 'terminal failure is reported')
  ok(res.terminal.cleared === true, 'terminal side IS cleared (clear() ran before the throw)')
  ok(res.ssh.error === undefined, 'a legal ssh side reports no error')
  ok(res.ssh.cleared === false, 'a legal ssh side (replaced panels) is NOT cleared')
  ok(terminal.state.panelIds.length === 0, 'terminal panels were wiped')
  ok(ssh.state.panelIds.join(',') === 'y', 'ssh panels were replaced by the payload')
}

console.log('[acceptance 2b] only the failing side restores — the other stays')
{
  const terminal = makeApi('legal', { panels: ['t1'] })
  const ssh = makeApi('clear-then-throw', { panels: ['s1'] })
  const res = applyTemplatePayload(terminal, ssh, payload({ panels: { tNew: {} } }, { panels: { sNew: {} } }), true)
  ok(res.terminal.error === undefined && res.terminal.cleared === false, 'terminal side not cleared')
  ok(res.ssh.error !== undefined && res.ssh.cleared === true, 'only ssh side cleared')
}

console.log('[acceptance 3] silent clear (no throw but result missing declared panels)')
{
  const terminal = makeApi('silent-clear', { panels: ['t1', 't2'], actual: ['t1'] })
  const ssh = makeApi('legal', { panels: ['s1'] })
  const res = applyTemplatePayload(terminal, ssh, payload({ panels: { t1: {}, t2: {} } }, { panels: { s1: {} } }), true)
  ok(res.terminal.error !== undefined, 'a silent-clear is reported as a failure')
  ok(res.terminal.cleared === true, 'the cleared side must be restored')
  ok(res.ssh.error === undefined && res.ssh.cleared === false, 'legal ssh side unaffected')
}

console.log('[acceptance 6] a legal payload that REPLACES the panels is NOT a failure')
{
  const terminal = makeApi('legal', { panels: ['old1', 'old2'] })
  const ssh = makeApi('legal', { panels: ['oldS'] })
  const res = applyTemplatePayload(
    terminal,
    ssh,
    payload({ panels: { n1: {}, n2: {} } }, { panels: { nS: {} } }),
    true
  )
  ok(res.terminal.error === undefined, 'terminal no error')
  ok(res.terminal.cleared === false, 'terminal NOT cleared even though ids changed (n1,n2 != old1,old2)')
  ok(res.ssh.error === undefined && res.ssh.cleared === false, 'ssh no error, not cleared')
  ok(terminal.state.panelIds.join(',') === 'n1,n2', 'terminal replaced the payload’s way')
}

console.log('[acceptance 6b] payload that declares no panels on an existing dockview still clears detection')
{
  // A payload with no `panels` key: `declaredPanelIds` is empty, so a successful
  // empty rebuild is not a "missing panels" error.
  const terminal = makeApi('legal', { panels: ['old1', 'old2'] })
  const res = applyTemplatePayload(terminal, undefined, payload({ grid: { root: { type: 'branch', data: [] } } }, {}), true)
  ok(res.terminal.error === undefined, 'a payload that rebuilds empty successfully is not an error')
  ok(res.terminal.cleared === false, 'nothing was lost by a thowing/cleared load, so no restore')
}

console.log('[acceptance 7/legacy] legacy single-dockview payload only reaches terminal')
{
  const terminal = makeApi('clear-then-throw', { panels: ['t1'] })
  const ssh = makeApi('legal', { panels: ['s1'] })
  // Legacy: terminal throws after clearing (should be cleared), ssh is never
  // called so it must report cleared:false with no error.
  const res = applyTemplatePayload(terminal, ssh, { panels: { a: {} } }, false)
  ok(res.terminal.error !== undefined && res.terminal.cleared === true, 'terminal cleared by a legacy failure')
  ok(res.ssh.error === undefined, 'ssh never reached by a legacy payload: no error')
  ok(res.ssh.cleared === false, 'ssh never reached by a legacy payload: not cleared')
  ok(ssh.loaded.length === 0, 'ssh fromJSON never called')
}

console.log('[acceptance 7/edge] a missing dockview api is not a crash')
{
  const res = applyTemplatePayload(undefined, undefined, { terminal: { a: 1 } }, true)
  ok(res.terminal.error === undefined && res.terminal.cleared === false, 'missing terminal api skipped')
  ok(res.ssh.error === undefined && res.ssh.cleared === false, 'missing ssh api skipped')
}

console.log('[acceptance 7/edge] ssh api missing but terminal cleared')
{
  const terminal = makeApi('clear-then-throw', { panels: ['t1'] })
  const res = applyTemplatePayload(terminal, undefined, payload({ panels: { x: {} } }, { panels: { y: {} } }), true)
  ok(res.terminal.cleared === true, 'terminal cleared even with ssh api absent')
  ok(res.ssh.error === undefined && res.ssh.cleared === false, 'absent ssh api reported untouched')
}

if (failed > 0) {
  console.error(`\n[template-apply] ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('\n[template-apply] ALL CHECKS PASSED')