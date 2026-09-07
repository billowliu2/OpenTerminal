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
  APP_INFO: 'app:info'
} as const

export interface PtyCreateOptions {
  cwd?: string
  /** executable; omit for platform default shell */
  shell?: string
  env?: Record<string, string>
}

export interface PtyCreateResult {
  id: string
  shell: string
  cwd: string
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
