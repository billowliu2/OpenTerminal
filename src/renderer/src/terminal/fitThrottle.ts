/**
 * Refit throttle (fitThrottle.ts).
 *
 * `FitAddon.fit()` triggers an xterm resize, which reflows the WHOLE
 * scrollback — tens of milliseconds at the default 5000 lines, more with
 * CJK-dense buffers. A window drag fires the pane's ResizeObserver every
 * animation frame, so an unthrottled fit-per-frame saturates the main
 * thread and starves xterm's write queue; the UI then stays frozen for
 * seconds after the drag while the backlog drains. The throttle caps
 * reflows during a drag; a trailing timer in TerminalView lands the final
 * fit at the settled size.
 *
 * Pure decision function (the rAF/trailing-timer wiring stays in
 * TerminalView), table-tested by tests/refit-throttle.mjs.
 */
export const FIT_REFLOW_THROTTLE_MS = 150

/**
 * Milliseconds to wait before the next fit may reflow; 0 = fit now.
 * `lastFitAt <= 0` marks "no fit recorded yet" — a session's first fit must
 * never wait, because the pty spawns at a placeholder size and the shell may
 * already be drawing. `now` comes from a monotonic clock (performance.now).
 */
export function refitDelay(lastFitAt: number, now: number, throttleMs: number = FIT_REFLOW_THROTTLE_MS): number {
  if (lastFitAt <= 0) return 0
  const wait = throttleMs - (now - lastFitAt)
  return wait > 0 ? wait : 0
}
