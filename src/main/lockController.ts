/**
 * Screen-lock controller.
 *
 * The main process owns the lock: it holds the verifier (lockStore) and the one
 * piece of live state that matters — whether the screen is currently locked.
 * Nothing here creates a window; the renderer draws the overlay for whatever
 * window it is and asks these channels for the truth, so a renderer reload (or a
 * second window, later) can never disagree about being locked.
 *
 * Every state change is published on LOCK_STATE_CHANGED, so the overlay appears
 * the moment the idle watcher fires rather than when something happens to ask.
 */

import { app, ipcMain, powerMonitor } from 'electron'
import {
  Ipc,
  type LockOperationError,
  type LockOperationResult,
  type LockPasswordInput,
  type LockSettingsState
} from '../shared/ipc'
import type { LockSettings } from '../shared/settings'
import { broadcast } from './broadcast'
import {
  LockStateStore,
  LockStore,
  defaultLockPath,
  defaultLockStatePath,
  isValidPassword
} from './lockStore'
import { loadSettings, mutateSettings } from './settingsStore'

/**
 * Backoff after each failed verification: the nth failure refuses further
 * attempts for COOLDOWN_STEPS_MS[n-1], with the last step repeating. A wrong
 * password therefore costs 1s, 2s, 5s, 10s and then 30s every time.
 */
const COOLDOWN_STEPS_MS = [1000, 2000, 5000, 10000, 30000]

/** How often the idle watcher asks the OS how long the user has been away. */
const IDLE_POLL_MS = 15_000

/**
 * Upper bound applied to a cooldown restored from disk. The longest backoff step
 * is 30s, so a legitimately stored deadline can never sit further out than that;
 * anything beyond it means the clock moved backwards, and trusting the file
 * verbatim would lock the user out until the old deadline came around again.
 */
const MAX_RESTORED_COOLDOWN_MS = 30_000

export interface LockControllerOptions {
  /** injected by tests; defaults to <userData>/lock.json */
  store?: LockStore
  /** injected by tests; defaults to <userData>/lock-state.json */
  stateStore?: LockStateStore
  /** where the preferences are read from — read per call, so a settings change
   *  takes effect without restarting anything */
  getLockSettings?: () => LockSettings
  publish?: (state: LockSettingsState) => void
  now?: () => number
  /** system idle time in seconds; injected so tests need no powerMonitor */
  idleSeconds?: () => number
  /** turns the lock preferences off once the password is gone; the default
   *  writes them through settingsStore, which broadcasts the change itself */
  clearLockPreferences?: () => void | Promise<void>
}

export class LockController {
  private readonly store: LockStore
  private readonly stateStore: LockStateStore
  private readonly getLockSettings: () => LockSettings
  private readonly publish: (state: LockSettingsState) => void
  private readonly now: () => number
  private readonly idleSeconds: () => number
  private readonly clearLockPreferences: () => void | Promise<void>

  /** true only while a verifier exists and a lock was requested */
  private locked = false
  /** consecutive failed verifications; any success clears them */
  private failures = 0
  /** epoch ms until which attempts are refused; 0 = no cooldown */
  private cooldownUntil = 0
  private idleTimer?: ReturnType<typeof setInterval>
  /** tail of the operation queue; see serialize() */
  private queue: Promise<void> = Promise.resolve()

  constructor(options: LockControllerOptions = {}) {
    this.store = options.store ?? new LockStore(defaultLockPath(app.getPath('userData')))
    this.stateStore =
      options.stateStore ?? new LockStateStore(defaultLockStatePath(app.getPath('userData')))
    this.getLockSettings = options.getLockSettings ?? ((): LockSettings => loadSettings().lock)
    this.publish =
      options.publish ?? ((state): void => broadcast(Ipc.LOCK_STATE_CHANGED, state))
    this.now = options.now ?? ((): number => Date.now())
    this.idleSeconds = options.idleSeconds ?? ((): number => powerMonitor.getSystemIdleTime())
    this.clearLockPreferences =
      options.clearLockPreferences ??
      ((): Promise<void> =>
        mutateSettings((s) => ({
          ...s,
          lock: { ...s.lock, enabled: false, lockAtStartup: false }
        })).then(() => undefined))
  }

  // ---- state -----------------------------------------------------------------

  /**
   * Write the live flags through to disk. Called after every change rather than
   * once at quit, because the exits that matter here are the abrupt ones: a
   * tray exit, a task-manager kill or a crash must not hand back an unlocked
   * app, and the failure count has to survive with it. The state is three
   * fields, so a synchronous write per change is not worth debouncing.
   *
   * A failed write is a warning and nothing more: losing the flags costs the
   * user one restart's worth of protection, while failing the operation they
   * just asked for would be a visible bug.
   */
  private persist(): void {
    try {
      this.stateStore.save({
        locked: this.locked,
        failures: this.failures,
        cooldownUntil: this.cooldownUntil
      })
    } catch {
      console.warn('[lock] could not persist the lock state')
    }
  }

  /**
   * Run the operations one at a time. The gate reads the backoff, then awaits a
   * ~100ms scrypt verification; two calls arriving together would both clear the
   * gate and only raise the cooldown once they had both failed, so firing
   * attempts in parallel would step around the backoff entirely. Serializing
   * also means only one scrypt runs at a time in the main process.
   */
  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op)
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private remainingCooldown(): number {
    return Math.max(0, this.cooldownUntil - this.now())
  }

  /**
   * What the renderer sees: the stored preferences plus the live lock flags.
   * Never the verifier — no salt, no hash, no password.
   */
  getState(): LockSettingsState {
    const settings = this.getLockSettings()
    const cooldownMs = this.remainingCooldown()
    return {
      configured: this.store.isConfigured(),
      enabled: settings.enabled,
      autoLockMinutes: settings.autoLockMinutes,
      lockAtStartup: settings.lockAtStartup,
      locked: this.locked,
      ...(cooldownMs > 0 ? { cooldownMs } : {})
    }
  }

  private result(error?: LockOperationError): LockOperationResult {
    const state = this.getState()
    return error === undefined ? { ok: true, state } : { ok: false, state, error }
  }

  /** Change the lock flag and publish, so every renderer follows immediately. */
  private applyLocked(locked: boolean): void {
    if (this.locked === locked) return
    this.locked = locked
    this.persist()
    this.publish(this.getState())
  }

  /** Record a failed verification and (re)start the backoff. */
  private noteFailure(): void {
    const step = COOLDOWN_STEPS_MS[Math.min(this.failures, COOLDOWN_STEPS_MS.length - 1)]
    this.failures += 1
    this.cooldownUntil = this.now() + step
    this.persist()
  }

  private resetFailures(): void {
    this.failures = 0
    this.cooldownUntil = 0
    this.persist()
  }

  /** Refuse an attempt while the backoff is running. */
  private gate(): LockOperationResult | null {
    return this.remainingCooldown() > 0 ? this.result('cooldown') : null
  }

  /** Passwords only ever travel in; a missing one is simply a mismatch. */
  private static passwordOf(value: unknown): string {
    return typeof value === 'string' ? value : ''
  }

  // ---- operations ------------------------------------------------------------

  /**
   * Set or replace the password. Replacing requires the current one: without
   * that check, anyone who walked up to an unlocked machine could install their
   * own password and keep the real user out afterwards.
   */
  async setPassword(input: LockPasswordInput): Promise<LockOperationResult> {
    return this.serialize(async (): Promise<LockOperationResult> => {
      const next = input?.newPassword
      if (!isValidPassword(next)) return this.result('invalid-password')
      if (this.store.isConfigured()) {
        const blocked = this.gate()
        if (blocked) return blocked
        if (!(await this.store.verify(LockController.passwordOf(input?.currentPassword)))) {
          this.noteFailure()
          return this.result('wrong-password')
        }
      }
      try {
        await this.store.setPassword(next)
      } catch {
        // Deliberately not logging the error: it can quote the input, and the
        // password must not reach a log file.
        console.error('[lock] could not write the lock verifier')
        return this.result('save-failed')
      }
      this.resetFailures()
      // Whoever set the password knows it, so a freshly configured lock does not
      // slam shut on them; `locked` is left exactly as it was.
      this.publish(this.getState())
      return this.result()
    })
  }

  /**
   * Drop the password. Verifying first is the whole point: otherwise the lock
   * could be removed by anyone at the keyboard. Clearing also unlocks, because
   * an unconfigured lock has no way to ask for anything.
   */
  async clearPassword(input: { currentPassword?: string }): Promise<LockOperationResult> {
    return this.serialize(async (): Promise<LockOperationResult> => {
      if (!this.store.isConfigured()) {
        this.applyLocked(false)
        return this.result()
      }
      const blocked = this.gate()
      if (blocked) return blocked
      if (!(await this.store.verify(LockController.passwordOf(input?.currentPassword)))) {
        this.noteFailure()
        return this.result('wrong-password')
      }
      try {
        this.store.clear()
      } catch {
        console.error('[lock] could not remove the lock verifier')
        return this.result('save-failed')
      }
      this.locked = false
      this.resetFailures()
      // The preferences go with the password: the settings UI promises that
      // clearing turns the lock off, and leaving `enabled`/`lockAtStartup` set
      // would silently re-arm the screen the moment a new password was typed.
      try {
        await this.clearLockPreferences()
      } catch {
        console.warn('[lock] could not turn the lock preferences off')
      }
      this.publish(this.getState())
      return this.result()
    })
  }

  /** Answer the lock screen. */
  async unlock(input: { password?: string }): Promise<LockOperationResult> {
    return this.serialize(async (): Promise<LockOperationResult> => {
      if (!this.store.isConfigured()) {
        // The verifier is gone (deleted while running): nothing could ever open
        // the screen again, so it must not stay shut.
        this.applyLocked(false)
        return this.result()
      }
      if (!this.locked) return this.result()
      const blocked = this.gate()
      if (blocked) return blocked
      if (!(await this.store.verify(LockController.passwordOf(input?.password)))) {
        this.noteFailure()
        return this.result('wrong-password')
      }
      this.locked = false
      this.resetFailures()
      this.publish(this.getState())
      return this.result()
    })
  }

  /** Whether the screen is currently shut. Read by the main-process guards that
   *  have to stop input reaching a locked window (see before-input-event). */
  isLocked(): boolean {
    return this.locked
  }

  /** Lock the screen now. Only a configured password can lock — with no
   *  verifier there would be no way back in. */
  lockNow(): LockSettingsState {
    if (this.store.isConfigured()) this.applyLocked(true)
    return this.getState()
  }

  // ---- lifecycle -------------------------------------------------------------

  /**
   * Apply the startup lock and start watching for idleness. Call once the app is
   * ready: powerMonitor cannot be touched before that.
   *
   * The lock flags come back from disk, so a relaunch is not a way out of a lock
   * that was already up — an idle auto-lock or an explicit lock survives the
   * quit, exactly like `lockAtStartup` does. `locked` is assigned directly here
   * (no publish): nothing is listening yet, and the renderer asks for the state
   * as soon as it loads.
   */
  start(): void {
    const restored = this.stateStore.load()
    this.failures = restored.failures
    // Clamped: see MAX_RESTORED_COOLDOWN_MS.
    this.cooldownUntil = Math.min(restored.cooldownUntil, this.now() + MAX_RESTORED_COOLDOWN_MS)
    if (this.store.isConfigured()) {
      if (this.getLockSettings().lockAtStartup || restored.locked) this.locked = true
    } else {
      // No verifier means nothing could ever open the screen again, so the
      // stored flags must not outlive it (a later password would re-arm a lock
      // nobody asked for).
      try {
        this.stateStore.clear()
      } catch {
        console.warn('[lock] could not clear the persisted lock state')
      }
    }
    if (this.idleTimer === undefined) {
      this.idleTimer = setInterval(() => this.checkIdle(), IDLE_POLL_MS)
      // Polling for idleness must never hold the process open.
      this.idleTimer.unref?.()
    }
  }

  /**
   * Idle auto-lock. Only a configured, enabled lock with a real delay may fire,
   * and never while the screen is already locked — otherwise every poll would
   * republish the same state.
   */
  private checkIdle(): void {
    const settings = this.getLockSettings()
    if (!settings.enabled || settings.autoLockMinutes <= 0) return
    if (this.locked || !this.store.isConfigured()) return
    let idleSeconds: number
    try {
      idleSeconds = this.idleSeconds()
    } catch {
      // powerMonitor refuses without a session (or on a locked workstation);
      // "unknown" must read as "not idle" rather than locking the app.
      return
    }
    if (idleSeconds >= settings.autoLockMinutes * 60) this.applyLocked(true)
  }
}

let controller: LockController | undefined

export function getLockController(): LockController {
  if (!controller) controller = new LockController()
  return controller
}

/** Start the idle watcher and apply the startup lock (call after app ready). */
export function initLockController(): LockController {
  const instance = getLockController()
  instance.start()
  return instance
}

/**
 * Register the lock channels. Goes through `ipcMain.handle` like every other
 * channel, so the sender guard installed by registerIpc covers these too.
 */
export function registerLockIpc(): void {
  const lock = getLockController()
  ipcMain.handle(Ipc.LOCK_STATE_GET, () => lock.getState())
  ipcMain.handle(Ipc.LOCK_SET_PASSWORD, (_event, input: LockPasswordInput) =>
    lock.setPassword(input ?? {})
  )
  ipcMain.handle(Ipc.LOCK_CLEAR_PASSWORD, (_event, input: { currentPassword?: string }) =>
    lock.clearPassword(input ?? {})
  )
  ipcMain.handle(Ipc.LOCK_UNLOCK, (_event, input: { password?: string }) =>
    lock.unlock(input ?? {})
  )
  ipcMain.handle(Ipc.LOCK_NOW, () => lock.lockNow())
}
