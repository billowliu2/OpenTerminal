import { contextBridge, ipcRenderer } from 'electron'
import { Ipc } from '../shared/ipc'
import type { AppSettings } from '../shared/settings'
import type { AppApi } from '../shared/api'
import type { LayoutMeta, PtyCreateOptions, PtyDataEvent, PtyExitEvent, ReleaseNote, UpdateState, ZmodemOfferEvent, ZmodemResponse, ZmodemDoneEvent } from '../shared/ipc'
import type {
  HostKeyAction,
  HostKeyPromptEvent,
  SessionOpenOptions,
  SshConnectionInput
} from '../shared/connections'
import type { SysinfoMeta, SysinfoSample } from '../shared/sysinfo'
import type { TransferProgressEvent } from '../shared/sftp'

const api: AppApi = {
  appInfo: () => ipcRenderer.invoke(Ipc.APP_INFO),

  createPty: (opts?: PtyCreateOptions) => ipcRenderer.invoke(Ipc.PTY_CREATE, opts),
  openSession: (opts: SessionOpenOptions) => ipcRenderer.invoke(Ipc.SESSION_OPEN, opts),
  getSessionReplay: (id: string) => ipcRenderer.invoke(Ipc.SESSION_REPLAY, id),
  writePty: (id: string, data: string) => ipcRenderer.send(Ipc.PTY_WRITE, id, data),
  resizePty: (id: string, cols: number, rows: number) =>
    ipcRenderer.send(Ipc.PTY_RESIZE, id, cols, rows),
  killPty: (id: string) => ipcRenderer.send(Ipc.PTY_KILL, id),
  onPtyData: (cb: (e: PtyDataEvent) => void) => {
    const listener = (_: unknown, e: PtyDataEvent): void => cb(e)
    ipcRenderer.on(Ipc.PTY_DATA, listener)
    return () => ipcRenderer.removeListener(Ipc.PTY_DATA, listener)
  },
  onPtyExit: (cb: (e: PtyExitEvent) => void) => {
    const listener = (_: unknown, e: PtyExitEvent): void => cb(e)
    ipcRenderer.on(Ipc.PTY_EXIT, listener)
    return () => ipcRenderer.removeListener(Ipc.PTY_EXIT, listener)
  },

  sysinfoStart: (id: string) => ipcRenderer.send(Ipc.SYSINFO_START, id),
  sysinfoStop: (id: string) => ipcRenderer.send(Ipc.SYSINFO_STOP, id),
  onSysinfoMeta: (cb: (e: { id: string; meta: SysinfoMeta }) => void) => {
    const listener = (_: unknown, e: { id: string; meta: SysinfoMeta }): void => cb(e)
    ipcRenderer.on(Ipc.SYSINFO_META, listener)
    return () => ipcRenderer.removeListener(Ipc.SYSINFO_META, listener)
  },
  onSysinfoSample: (cb: (e: { id: string; sample: SysinfoSample }) => void) => {
    const listener = (_: unknown, e: { id: string; sample: SysinfoSample }): void => cb(e)
    ipcRenderer.on(Ipc.SYSINFO_SAMPLE, listener)
    return () => ipcRenderer.removeListener(Ipc.SYSINFO_SAMPLE, listener)
  },

  listRemote: (sessionId: string, dir: string) => ipcRenderer.invoke(Ipc.SFTP_LIST, sessionId, dir),
  mkdirRemote: (sessionId: string, dir: string, name: string) =>
    ipcRenderer.invoke(Ipc.SFTP_MKDIR, sessionId, dir, name),
  renameRemote: (sessionId: string, from: string, to: string) =>
    ipcRenderer.invoke(Ipc.SFTP_RENAME, sessionId, from, to),
  deleteRemote: (sessionId: string, paths: string[]) =>
    ipcRenderer.invoke(Ipc.SFTP_DELETE, sessionId, paths),
  chmodRemote: (sessionId: string, path: string, mode: string) =>
    ipcRenderer.invoke(Ipc.SFTP_CHMOD, sessionId, path, mode),
  chownRemote: (sessionId: string, path: string, uid: number, gid: number) =>
    ipcRenderer.invoke(Ipc.SFTP_CHOWN, sessionId, path, uid, gid),
  uploadRemote: (sessionId: string, localPaths: string[], remoteDir: string) =>
    ipcRenderer.invoke(Ipc.SFTP_UPLOAD, sessionId, localPaths, remoteDir),
  downloadRemote: (sessionId: string, remotePaths: string[], localDir: string) =>
    ipcRenderer.invoke(Ipc.SFTP_DOWNLOAD, sessionId, remotePaths, localDir),
  cancelTransfer: (transferId: string) => ipcRenderer.send(Ipc.TRANSFER_CANCEL, transferId),
  onTransferProgress: (cb: (e: TransferProgressEvent) => void) => {
    const listener = (_: unknown, e: TransferProgressEvent): void => cb(e)
    ipcRenderer.on(Ipc.TRANSFER_PROGRESS, listener)
    return () => ipcRenderer.removeListener(Ipc.TRANSFER_PROGRESS, listener)
  },
  pickFiles: () => ipcRenderer.invoke(Ipc.DIALOG_PICK_FILES),
  pickDirectory: () => ipcRenderer.invoke(Ipc.DIALOG_PICK_DIR),

  recordCommand: (cmd: string) => ipcRenderer.invoke(Ipc.COMMANDS_RECORD, cmd),
  listHistory: () => ipcRenderer.invoke(Ipc.COMMANDS_HISTORY_LIST),
  clearHistory: () => ipcRenderer.invoke(Ipc.COMMANDS_HISTORY_CLEAR),
  listLibrary: () => ipcRenderer.invoke(Ipc.COMMANDS_LIBRARY_LIST),
  saveLibraryItem: (item) => ipcRenderer.invoke(Ipc.COMMANDS_LIBRARY_SAVE, item),
  deleteLibraryItem: (id: string) => ipcRenderer.invoke(Ipc.COMMANDS_LIBRARY_DELETE, id),
  logStart: (sessionId: string) => ipcRenderer.invoke(Ipc.LOG_START, sessionId),
  logStop: (sessionId: string) => ipcRenderer.invoke(Ipc.LOG_STOP, sessionId),
  listSessionLogs: () => ipcRenderer.invoke(Ipc.LOG_LIST),
  openLogsDir: () => ipcRenderer.send(Ipc.LOG_OPEN_DIR),

  listConnections: () => ipcRenderer.invoke(Ipc.CONNECTIONS_LIST),
  saveConnection: (input: SshConnectionInput) => ipcRenderer.invoke(Ipc.CONNECTIONS_SAVE, input),
  deleteConnection: (id: string) => ipcRenderer.invoke(Ipc.CONNECTIONS_DELETE, id),

  onZmodemOffer: (cb: (e: ZmodemOfferEvent) => void) => {
    const listener = (_: unknown, e: ZmodemOfferEvent): void => cb(e)
    ipcRenderer.on(Ipc.ZMODEM_OFFER, listener)
    return () => ipcRenderer.removeListener(Ipc.ZMODEM_OFFER, listener)
  },
  zmodemRespond: (resp: ZmodemResponse) => ipcRenderer.send(Ipc.ZMODEM_RESPOND, resp),
  onZmodemDone: (cb: (e: ZmodemDoneEvent) => void) => {
    const listener = (_: unknown, e: ZmodemDoneEvent): void => cb(e)
    ipcRenderer.on(Ipc.ZMODEM_DONE, listener)
    return () => ipcRenderer.removeListener(Ipc.ZMODEM_DONE, listener)
  },
  onHostKeyPrompt: (cb: (e: HostKeyPromptEvent) => void) => {
    const listener = (_: unknown, e: HostKeyPromptEvent): void => cb(e)
    ipcRenderer.on(Ipc.HOSTKEY_PROMPT, listener)
    return () => ipcRenderer.removeListener(Ipc.HOSTKEY_PROMPT, listener)
  },
  respondHostKey: (promptId: string, action: HostKeyAction) =>
    ipcRenderer.send(Ipc.HOSTKEY_RESPOND, promptId, action),

  getSettings: () => ipcRenderer.invoke(Ipc.SETTINGS_GET),
  saveSettings: (next: AppSettings) => ipcRenderer.invoke(Ipc.SETTINGS_SET, next),
  onSettingsChanged: (cb: (s: AppSettings) => void) => {
    const listener = (_: unknown, s: AppSettings): void => cb(s)
    ipcRenderer.on(Ipc.SETTINGS_CHANGED, listener)
    return () => ipcRenderer.removeListener(Ipc.SETTINGS_CHANGED, listener)
  },

  listFonts: () => ipcRenderer.invoke(Ipc.FONTS_LIST),

  listLayouts: () => ipcRenderer.invoke(Ipc.LAYOUTS_LIST),
  getLayout: (id: string) => ipcRenderer.invoke(Ipc.LAYOUTS_GET, id),
  saveLayout: (meta: LayoutMeta, json: string) => ipcRenderer.invoke(Ipc.LAYOUTS_SAVE, meta, json),
  deleteLayout: (id: string) => ipcRenderer.invoke(Ipc.LAYOUTS_DELETE, id),

  updateCheck: () => ipcRenderer.invoke(Ipc.UPDATE_CHECK),
  updateDownload: () => ipcRenderer.invoke(Ipc.UPDATE_DOWNLOAD),
  updateInstall: () => ipcRenderer.send(Ipc.UPDATE_INSTALL),
  updateChangelog: () => ipcRenderer.invoke(Ipc.UPDATE_CHANGELOG),
  onUpdateState: (cb: (s: UpdateState) => void) => {
    const listener = (_: unknown, s: UpdateState): void => cb(s)
    ipcRenderer.on(Ipc.UPDATE_STATE, listener)
    return () => ipcRenderer.removeListener(Ipc.UPDATE_STATE, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
