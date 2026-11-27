/**
 * Apply a workspace template payload to the two dockviews.
 *
 * The point of this module is ONE question: did the template actually clear a
 * dockview, and is that dockview therefore due for a snapshot rollback?
 *
 * dockview's real `_doFromJSON` splits on the root check: it validates the
 * serialized layout BEFORE it clears anything (`grid.root.type !== 'branch'`
 * throws ahead of `this.clear()`), so a payload rejected at that stage leaves
 * the dockview — and every live session in it — completely untouched. Once the
 * root check passes, though, dockview runs `this.clear()` and only then
 * deserializes; if the deserialization throws (or silently fails to materialize
 * every panel the payload declares) the old layout is already gone.
 *
 * The workspace used to answer "which dockview did this touch" by how far the
 * fromJSON call got — a dockview was "touched" the moment its call returned, a
 * throwing one was declared untouched. That misread a deserialization failure
 * (clear-then-throw) as "untouched", so the recovery path skipped restoring it:
 * SSH panes were cleared and never came back. The verdict here is evidential —
 * compare the panel-id set before and after each call — and it drives the
 * restore decision on the failure path only: a legal apply replaces the panels
 * (their ids change) but must NOT be rolled back.
 *
 * Zero imports on purpose: the test reaches this module through Node's native
 * type stripping (Node >= 22.18).
 */

/** The part of a DockviewReact api this module needs. The api is passed in as
 *  `unknown` by the caller, so all shape comes from this interface. */
export interface DockviewLike {
  fromJSON(data: unknown): void
  toJSON(): unknown
  /** DockviewApi.panels — IDockviewPanel[], each carrying an `id`. */
  readonly panels: ReadonlyArray<{ id: string }>
}

/** Per-dockview outcome of an apply. */
export interface SideApplyResult {
  /**
   * Whether this dockview's panels were cleared by a FAILED load and therefore
   * need to be restored from a snapshot. Meaningful on the failure path only —
   * a legal apply replaces the panels (their ids change) and cleared stays false.
   */
  cleared: boolean
  /** The error that stopped the load, if any. */
  error?: unknown
}

export interface TemplateApplyResult {
  terminal: SideApplyResult
  ssh: SideApplyResult
}

/**
 * The panel ids a dockview serialized layout declares. dockview's serialized
 * shape is `{ grid, panels }` where `panels` is a map keyed by panel id
 * (`dockview-core` `_doAddPanel` writes each panel under its own id).
 */
function declaredPanelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return []
  const panels = (payload as { panels?: unknown }).panels
  if (!panels || typeof panels !== 'object') return []
  return Object.keys(panels as Record<string, unknown>)
}

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const ids = new Set(b)
  return a.every((id) => ids.has(id))
}

/** Apply one side's payload and judge whether that side must be restored. */
function applySide(api: DockviewLike | undefined, payload: unknown): SideApplyResult {
  if (!api) return { cleared: false }

  const declared = declaredPanelIds(payload)
  const idsBefore = api.panels.map((p) => p.id)

  let error: unknown
  try {
    api.fromJSON(payload)
  } catch (caught) {
    error = caught
  }

  const idsAfter = api.panels.map((p) => p.id)

  // The load failed AND the panel-id set changed (e.g. `clear()` ran before the
  // deserialization threw, or the layout rebuilt itself into empty). The old
  // panels are gone, so the side must be restored. A load rejected at root
  // validation throws before `clear()`, leaving the ids unchanged — no rollback.
  const cleared = !sameIds(idsBefore, idsAfter)
  if (error !== undefined) return { cleared, error }

  // The load "succeeded" structurally but left out a panel the payload declared
  // — a silent failure (e.g. a payload whose `views` names a panel that `panels`
  // does not define): the previous layout was cleared and the rebuild could not
  // materialize every panel. Treat it as a failure so the side gets restored and
  // the user is told.
  const missing = declared.filter((id) => !idsAfter.includes(id))
  if (missing.length > 0) {
    return {
      cleared: true,
      error: new Error(`the loaded layout is missing panels the payload declared: ${missing.join(', ')}`)
    }
  }

  // Legal load: the layout may have been replaced wholesale (new ids), but
  // nothing was cleared-and-lost, so no restore is needed.
  return { cleared: false }
}

/**
 * Load the payload into the dockviews it belongs to and judge each side.
 *
 * `hasDualLayout` is false for the legacy (pre-M6.1) single-dockview format,
 * whose payload goes wholly into the terminal dockview.
 */
export function applyTemplatePayload(
  terminalApi: DockviewLike | undefined,
  sshApi: DockviewLike | undefined,
  payload: { terminal?: unknown; ssh?: unknown },
  hasDualLayout: boolean
): TemplateApplyResult {
  if (hasDualLayout) {
    return {
      terminal: applySide(terminalApi, payload.terminal),
      ssh: applySide(sshApi, payload.ssh)
    }
  }
  // Legacy single-dockview: the whole payload is the terminal layout; the ssh
  // dockview is never reached and is never cleared.
  return {
    terminal: applySide(terminalApi, payload as unknown),
    ssh: { cleared: false }
  }
}