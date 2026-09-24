/**
 * IPC channel names + payload contracts shared between main / preload / renderer.
 * DO NOT rename channels or change payload shapes without updating all consumers.
 */

export const Ipc = {
  // ---- PTY session lifecycle ----
  // NOTE: since M2 these channels are session-generic: `id` addresses both
  // local pty sessions and ssh sessions; data plane is identical.
  PTY_CREATE: 'pty:create',
  PTY_WRITE: 'pty:write',
  PTY_RESIZE: 'pty:resize',
  PTY_KILL: 'pty:kill',
  /** main -> renderer broadcast: { id, data } */
  PTY_DATA: 'pty:data',
  /** main -> renderer broadcast: { id, exitCode } */
  PTY_EXIT: 'pty:exit',

  // ---- settings ----
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  /** main -> renderer broadcast after any save */
  SETTINGS_CHANGED: 'settings:changed',

  // ---- fonts ----
  FONTS_LIST: 'fonts:list',

  // ---- layouts ----
  LAYOUTS_LIST: 'layouts:list',
  LAYOUTS_GET: 'layouts:get',
  LAYOUTS_SAVE: 'layouts:save',
  LAYOUTS_DELETE: 'layouts:delete',

  // ---- sessions (openSession unifies local pty and ssh) ----
  SESSION_OPEN: 'session:open',
  /** main keeps a short replay buffer per session so late subscribers catch up */
  SESSION_REPLAY: 'session:replay',

  // ---- ssh connections (bookmarks) ----
  CONNECTIONS_LIST: 'connections:list',
  CONNECTIONS_SAVE: 'connections:save',
  CONNECTIONS_DELETE: 'connections:delete',

  // ---- host key verification ----
  /** main -> renderer: needs user decision before connect proceeds */
  HOSTKEY_PROMPT: 'hostkey:prompt',
  HOSTKEY_RESPOND: 'hostkey:respond',

  // ---- sysinfo (M3) ----
  SYSINFO_START: 'sysinfo:start',
  SYSINFO_STOP: 'sysinfo:stop',
  /** main -> renderer broadcast: { id, meta } (once per session) */
  SYSINFO_META: 'sysinfo:meta',
  /** main -> renderer broadcast: { id, sample } (poll interval) */
  SYSINFO_SAMPLE: 'sysinfo:sample',

  // ---- sftp (M4) ----
  SFTP_LIST: 'sftp:list',
  SFTP_MKDIR: 'sftp:mkdir',
  SFTP_RENAME: 'sftp:rename',
  SFTP_DELETE: 'sftp:delete',
  SFTP_CHMOD: 'sftp:chmod',
  SFTP_CHOWN: 'sftp:chown',
  SFTP_UPLOAD: 'sftp:upload',
  SFTP_DOWNLOAD: 'sftp:download',
  TRANSFER_CANCEL: 'transfer:cancel',
  /** main -> renderer broadcast: TransferProgressEvent */
  TRANSFER_PROGRESS: 'transfer:progress',
  DIALOG_PICK_FILES: 'dialog:pickFiles',
  DIALOG_PICK_DIR: 'dialog:pickDirectory',

  // ---- commands + logs (M5) ----
  COMMANDS_RECORD: 'commands:record',
  COMMANDS_HISTORY_LIST: 'commands:historyList',
  COMMANDS_HISTORY_CLEAR: 'commands:historyClear',
  COMMANDS_LIBRARY_LIST: 'commands:libraryList',
  COMMANDS_LIBRARY_SAVE: 'commands:librarySave',
  COMMANDS_LIBRARY_DELETE: 'commands:libraryDelete',
  LOG_START: 'log:start',
  LOG_STOP: 'log:stop',
  LOG_LIST: 'log:list',
  LOG_OPEN_DIR: 'log:openDir',

  // ---- zmodem (M6: main-process engine, ssh sessions only) ----
  /** main -> renderer: remote ran rz (mode=send) or sz (mode=receive); renderer must ask the user */
  ZMODEM_OFFER: 'zmodem:offer',
  /** renderer -> main: user answered the zmodem offer */
  ZMODEM_RESPOND: 'zmodem:respond',
  /** main -> renderer: zmodem session finished (ok, cancelled or failed) */
  ZMODEM_DONE: 'zmodem:done',

  // ---- misc ----
  APP_INFO: 'app:info',

  // ---- updater (check/download/install + state broadcast) ----
  UPDATE_CHECK: 'update:check',
  UPDATE_DOWNLOAD: 'update:download',
  UPDATE_INSTALL: 'update:install',
  UPDATE_CHANGELOG: 'update:changelog',
  /** renderer pulls the current updater state without triggering a check */
  UPDATE_STATE_GET: 'update:stateGet',
  /** main -> renderer broadcast: UpdateState */
  UPDATE_STATE: 'update:state',

  // ---- session snapshot (last layout + per-pane cwd) ----
  SESSION_STATE_GET: 'session:stateGet',
  SESSION_STATE_SET: 'session:stateSet',
  /** resolve a cd-style argument against the current cwd, platform-aware */
  CWD_RESOLVE: 'session:cwdResolve',
  /** normalize a cwd reported by the shell (OSC 7 / OSC 9;9) */
  CWD_REPORT: 'session:cwdReport',
  /** open a local directory in the OS file manager (terminal toolbar) */
  CWD_OPEN: 'session:cwdOpen',

  // ---- lock screen (main-window overlay; the main process owns the state) ----
  /** renderer pulls the current lock state without changing it */
  LOCK_STATE_GET: 'lock:stateGet',
  /** set or replace the password; an existing one must be verified first */
  LOCK_SET_PASSWORD: 'lock:setPassword',
  /** remove the password; the existing one must be verified first */
  LOCK_CLEAR_PASSWORD: 'lock:clearPassword',
  LOCK_UNLOCK: 'lock:unlock',
  LOCK_NOW: 'lock:now',
  /** main -> renderer broadcast: LockSettingsState */
  LOCK_STATE_CHANGED: 'lock:state'
} as const

/**
 * The lock state the renderer sees. Deliberately free of salt, hash and
 * password: the stored verifier never leaves the main process.
 */
export interface LockSettingsState {
  /** a password is set, so the lock can engage at all */
  configured: boolean
  enabled: boolean
  autoLockMinutes: number
  lockAtStartup: boolean
  locked: boolean
  /** remaining lockout in ms; absent while no cooldown is running */
  cooldownMs?: number
}

/** Passwords travel one way only: in. Neither field is ever echoed back. */
export interface LockPasswordInput {
  /** required when a password is already set (replace / clear) */
  currentPassword?: string
  /** required when setting or replacing */
  newPassword?: string
}

export type LockOperationError =
  /** the offered new password is unusable (empty, too short, too long) */
  | 'invalid-password'
  /** the offered current password does not match */
  | 'wrong-password'
  /** too many failed attempts: retry after state.cooldownMs */
  | 'cooldown'
  /** the verifier could not be written to disk */
  | 'save-failed'

export interface LockOperationResult {
  ok: boolean
  state: LockSettingsState
  error?: LockOperationError
}

export interface PtyCreateOptions {
  cwd?: string
  /** executable; omit for platform default shell */
  shell?: string
  /** extra argv for the shell (shell-integration adapters use this) */
  shellArgs?: string[]
  env?: Record<string, string>
}

export interface PtyCreateResult {
  id: string
  shell: string
  cwd: string
}

/** One dockview panel as remembered between runs. */
export interface SessionPanelState {
  panelId: string
  title: string
  kind: 'local' | 'ssh'
  /** last known working directory (local panels; also recorded for ssh panes
   *  so a reconnected pane starts somewhere sensible) */
  cwd?: string
  /** ssh only: bookmark to offer a reconnect for */
  connectionId?: string
  hostLabel?: string
}

/**
 * The automatic "pick up where you left off" snapshot: the dockview layouts
 * plus a per-panel record. Distinct from the user-managed layout templates.
 */
export interface SessionSnapshot {
  version: 1
  savedAt: number
  mode: 'terminal' | 'ssh'
  layouts: { terminal?: unknown; ssh?: unknown }
  panels: SessionPanelState[]
  /** newest cwd among local panes — seeds brand-new terminals */
  lastLocalCwd?: string
}

export interface PtyDataEvent {
  id: string
  data: string
}

export interface PtyExitEvent {
  id: string
  exitCode: number
}

export interface AppInfo {
  platform: NodeJS.Platform | string
  appVersion: string
  homeDir: string
}

// ---- updater ----
export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'latest'
  | 'downloading'
  | 'downloaded'
  | 'error'
  /** dev builds have no update channel */
  | 'dev'

export interface UpdateState {
  status: UpdateStatus
  /** running app version */
  currentVersion: string
  /** newer version when available/downloading/downloaded */
  version?: string
  /** 0-100 while downloading */
  percent?: number
  error?: string
  /** which feed served the last check: domestic Gitea first, GitHub fallback */
  feed?: 'gitea' | 'github'
}

export interface ReleaseNote {
  version: string
  date: string
  body: string
}

export interface LayoutMeta {
  id: string
  name: string
  createdAt: number
}

export interface SessionOpenResult {
  id: string
}

export interface HostKeyResponse {
  promptId: string
  action: 'accept' | 'reject'
}

// ---- zmodem (M6) ----
/** 'send' = remote ran `rz`, we upload files; 'receive' = remote ran `sz`, we download */
export interface ZmodemOfferEvent {
  id: string
  mode: 'send' | 'receive'
}

export interface ZmodemResponse {
  id: string
  cancelled: boolean
  /** local files to upload (mode=send) */
  paths?: string[]
  /** local directory to save into (mode=receive) */
  dir?: string
}

export interface ZmodemDoneEvent {
  id: string
  ok: boolean
  /** human-readable failure reason when ok=false */
  message?: string
}
