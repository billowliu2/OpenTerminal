import { app, ipcMain } from 'electron'
import fontList from 'font-list'
import { homedir } from 'os'
import { Ipc, type AppInfo, type LayoutMeta, type PtyCreateOptions } from '../shared/ipc'
import type { HostKeyAction, SessionOpenOptions, SshConnection, SshConnectionInput } from '../shared/connections'
import { getLayout, listLayouts, saveLayout, deleteLayout } from './layouts'
import { startPolling, stopPolling } from './sysinfo'
import { registerSettingsIpc } from './settingsStore'
import { ConnectionsStore, defaultConnectionsPath } from './connectionsStore'
import { KnownHostsStore, defaultKnownHostsPath } from './knownHosts'
import { resolveHostKey } from './ssh'
import {
  listRemote,
  mkdirRemote,
  renameRemote,
  deleteRemote,
  chmodRemote,
  chownRemote,
  uploadRemote,
  downloadRemote,
  cancelTransfer,
  pickFiles,
  pickDirectory
} from './sftp'
import { broadcast } from './broadcast'
import { CommandsStore, defaultCommandsPath } from './commands'
import type { CommandItem } from '../shared/commands'
import { createPty, killPty, resizePty, writePty, openSession, configureSessionRuntime, getSessionReplay, registerLogHooks } from './pty'
import { respondZmodem } from './zmodem'
import type { ZmodemResponse } from '../shared/ipc'

let commandsStore: CommandsStore | undefined

/** M5: inject a custom command store (tests) or default to userData-backed. */
export function setCommandsStore(store: CommandsStore): void {
  commandsStore = store
}

export function getCommandsStore(): CommandsStore {
  if (!commandsStore) {
    commandsStore = new CommandsStore(defaultCommandsPath(app.getPath('userData')))
  }
  return commandsStore
}

export function registerIpc(): void {
  const connectionsStore = new ConnectionsStore(defaultConnectionsPath(app.getPath('userData')))
  const knownHostsStore = new KnownHostsStore(defaultKnownHostsPath(app.getPath('userData')))
  const cmds = getCommandsStore()

  // Route PTY output into the session log (M5). logWrite decides whether a
  // session is actively logging; logStop finalizes on session close / kill.
  registerLogHooks(
    (id, data) => cmds.logWrite(id, data),
    (id) => cmds.logStop(id)
  )

  // Runtime deps for the session layer (pty.ts routes into ssh.ts, which stays
  // Electron-free).
  configureSessionRuntime({
    broadcast: (channel, ...args) => broadcast(channel, ...args),
    getConnection: (connectionId) => {
      const found = connectionsStore.listConnections().find((c) => c.id === connectionId)
      if (!found) throw new Error(`连接书签不存在 (${connectionId})`)
      return found
    },
    getSecret: (conn, field) => connectionsStore.getSecret(conn, field),
    touch: (id) => connectionsStore.touch(id),
    knownHosts: {
      check: (host, port, key) => knownHostsStore.check(host, port, key),
      accept: (host, port, key, fingerprint) => knownHostsStore.accept(host, port, key, fingerprint)
    },
    promptHostKey: (prompt) => broadcast(Ipc.HOSTKEY_PROMPT, prompt)
  })

  ipcMain.handle(
    Ipc.APP_INFO,
    (): AppInfo => ({ platform: process.platform, appVersion: app.getVersion(), homeDir: homedir() })
  )

  ipcMain.handle(Ipc.PTY_CREATE, (_event, opts?: PtyCreateOptions) => createPty(opts))
  ipcMain.handle(Ipc.SESSION_OPEN, (_event, opts: SessionOpenOptions) => openSession(opts))
  ipcMain.handle(Ipc.SESSION_REPLAY, (_event, id: string) => getSessionReplay(id))
  ipcMain.on(Ipc.PTY_WRITE, (_event, id: string, data: string) => writePty(id, data))
  ipcMain.on(Ipc.PTY_RESIZE, (_event, id: string, cols: number, rows: number) =>
    resizePty(id, cols, rows)
  )
  ipcMain.on(Ipc.PTY_KILL, (_event, id: string) => killPty(id))

  // ---- zmodem (M6: main-process engine over ssh sessions) ----
  // ZMODEM_OFFER / ZMODEM_DONE are broadcasts (main -> renderer); this is the
  // renderer's answer, forwarded to the engine (which routes on resp.id).
  ipcMain.on(Ipc.ZMODEM_RESPOND, (_event, resp: ZmodemResponse) => respondZmodem(resp))

  // ---- sysinfo (M3: remote hardware monitoring, ssh sessions only) ----
  ipcMain.on(Ipc.SYSINFO_START, (_event, id: string) => startPolling(id))
  ipcMain.on(Ipc.SYSINFO_STOP, (_event, id: string) => stopPolling(id))

  // ---- ssh connections (bookmarks) ----
  ipcMain.handle(Ipc.CONNECTIONS_LIST, (): SshConnection[] => connectionsStore.listConnections())
  ipcMain.handle(Ipc.CONNECTIONS_SAVE, (_event, input: SshConnectionInput): SshConnection =>
    connectionsStore.saveConnection(input)
  )
  ipcMain.handle(Ipc.CONNECTIONS_DELETE, (_event, id: string) => {
    connectionsStore.deleteConnection(id)
  })

  // HOSTKEY_PROMPT is broadcast; the renderer answers here (send, not handle).
  ipcMain.on(Ipc.HOSTKEY_RESPOND, (_event, promptId: string, action: HostKeyAction) => {
    resolveHostKey(promptId, action)
  })

  // ---- sftp (M4) ----
  ipcMain.handle(Ipc.SFTP_LIST, (_e, sessionId: string, dir: string) => listRemote(sessionId, dir))
  ipcMain.handle(Ipc.SFTP_MKDIR, (_e, sessionId: string, dir: string, name: string) =>
    mkdirRemote(sessionId, dir, name)
  )
  ipcMain.handle(Ipc.SFTP_RENAME, (_e, sessionId: string, from: string, to: string) =>
    renameRemote(sessionId, from, to)
  )
  ipcMain.handle(Ipc.SFTP_DELETE, (_e, sessionId: string, paths: string[]) =>
    deleteRemote(sessionId, paths)
  )
  ipcMain.handle(Ipc.SFTP_CHMOD, (_e, sessionId: string, path: string, mode: string) =>
    chmodRemote(sessionId, path, mode)
  )
  ipcMain.handle(Ipc.SFTP_CHOWN, (_e, sessionId: string, path: string, uid: number, gid: number) =>
    chownRemote(sessionId, path, uid, gid)
  )
  ipcMain.handle(Ipc.SFTP_UPLOAD, (_e, sessionId: string, localPaths: string[], remoteDir: string) =>
    uploadRemote(sessionId, localPaths, remoteDir, broadcast)
  )
  ipcMain.handle(
    Ipc.SFTP_DOWNLOAD,
    (_e, sessionId: string, remotePaths: string[], localDir: string) =>
      downloadRemote(sessionId, remotePaths, localDir, broadcast)
  )
  ipcMain.on(Ipc.TRANSFER_CANCEL, (_e, transferId: string) => cancelTransfer(transferId))
  ipcMain.handle(Ipc.DIALOG_PICK_FILES, () => pickFiles())
  ipcMain.handle(Ipc.DIALOG_PICK_DIR, () => pickDirectory())

  ipcMain.handle(Ipc.FONTS_LIST, async () => {
    try {
      return await fontList.getFonts({ disableQuoting: true })
    } catch {
      return []
    }
  })

  ipcMain.handle(Ipc.LAYOUTS_LIST, (): LayoutMeta[] => listLayouts())
  ipcMain.handle(Ipc.LAYOUTS_GET, (_event, id: string) => getLayout(id))
  ipcMain.handle(Ipc.LAYOUTS_SAVE, (_event, meta: LayoutMeta, json: string) =>
    saveLayout(meta, json)
  )
  ipcMain.handle(Ipc.LAYOUTS_DELETE, (_event, id: string) => deleteLayout(id))

  // ---- command history / library + session logs (M5) ----
  ipcMain.handle(Ipc.COMMANDS_RECORD, (_event, cmd: string) => cmds.recordCommand(cmd))
  ipcMain.handle(Ipc.COMMANDS_HISTORY_LIST, () => cmds.listHistory())
  ipcMain.handle(Ipc.COMMANDS_HISTORY_CLEAR, () => cmds.clearHistory())
  ipcMain.handle(Ipc.COMMANDS_LIBRARY_LIST, () => cmds.listLibrary())
  ipcMain.handle(Ipc.COMMANDS_LIBRARY_SAVE, (_event, item: CommandItem) =>
    cmds.saveLibraryItem(item)
  )
  ipcMain.handle(Ipc.COMMANDS_LIBRARY_DELETE, (_event, id: string) =>
    cmds.deleteLibraryItem(id)
  )
  ipcMain.handle(Ipc.LOG_START, (_event, sessionId: string) => cmds.logStart(sessionId))
  ipcMain.handle(Ipc.LOG_STOP, (_event, sessionId: string) => cmds.logStop(sessionId))
  ipcMain.handle(Ipc.LOG_LIST, () => cmds.listSessionLogs())
  ipcMain.on(Ipc.LOG_OPEN_DIR, () => cmds.openLogsDir())

  registerSettingsIpc()
}