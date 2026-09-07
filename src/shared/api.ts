import type {
  AppInfo,
  LayoutMeta,
  PtyCreateOptions,
  PtyCreateResult,
  PtyDataEvent,
  PtyExitEvent,
  SessionOpenResult
} from './ipc'
import type { AppSettings } from './settings'
import type { ReleaseNote, UpdateState } from './ipc'
import type {
  HostKeyAction,
  HostKeyPromptEvent,
  SessionOpenOptions,
  SshConnection,
  SshConnectionInput
} from './connections'
import type { SysinfoMeta, SysinfoSample } from './sysinfo'
import type { SftpEntry, TransferProgressEvent } from './sftp'
import type { CommandItem, SessionLogMeta } from './commands'
import type { ZmodemDoneEvent, ZmodemOfferEvent, ZmodemResponse } from './ipc'

/**
 * The single API surface exposed on `window.api` by the preload script.
 * Main process implements the handlers; renderer consumes this contract.
 */
export interface AppApi {
  appInfo(): Promise<AppInfo>

  // ---- sessions (pty data plane is shared by local and ssh sessions) ----
  createPty(opts?: PtyCreateOptions): Promise<PtyCreateResult>
  /** open a local or ssh session; resolves once the session is ready to stream */
  openSession(opts: SessionOpenOptions): Promise<SessionOpenResult>
  /** output a session produced before this renderer subscribed (capped ring buffer) */
  getSessionReplay(id: string): Promise<string>
  writePty(id: string, data: string): void
  resizePty(id: string, cols: number, rows: number): void
  killPty(id: string): void
  /** subscribe to all session output; returns unsubscribe */
  onPtyData(cb: (e: PtyDataEvent) => void): () => void
  onPtyExit(cb: (e: PtyExitEvent) => void): () => void

  // ---- sysinfo (M3: ssh sessions only; main polls the remote and broadcasts) ----
  /** start polling for an ssh session; stop happens automatically on session close */
  sysinfoStart(id: string): void
  sysinfoStop(id: string): void
  onSysinfoMeta(cb: (e: { id: string; meta: SysinfoMeta }) => void): () => void
  onSysinfoSample(cb: (e: { id: string; sample: SysinfoSample }) => void): () => void

  // ---- sftp (M4: bound to an established ssh session) ----
  listRemote(sessionId: string, dir: string): Promise<SftpEntry[]>
  mkdirRemote(sessionId: string, dir: string, name: string): Promise<void>
  renameRemote(sessionId: string, from: string, to: string): Promise<void>
  deleteRemote(sessionId: string, paths: string[]): Promise<void>
  /** mode = octal string, e.g. "755" or "0644" */
  chmodRemote(sessionId: string, path: string, mode: string): Promise<void>
  chownRemote(sessionId: string, path: string, uid: number, gid: number): Promise<void>
  /** upload local files into remote dir; returns transferId */
  uploadRemote(sessionId: string, localPaths: string[], remoteDir: string): Promise<string>
  /** download remote paths into local dir; returns transferId */
  downloadRemote(sessionId: string, remotePaths: string[], localDir: string): Promise<string>
  cancelTransfer(transferId: string): void
  onTransferProgress(cb: (e: TransferProgressEvent) => void): () => void
  /** native open dialog; returns picked file paths (empty when cancelled) */
  pickFiles(): Promise<string[]>
  pickDirectory(): Promise<string>

  // ---- command history / library + session logs (M5) ----
  /** record one executed command (deduped, newest first, capped) */
  recordCommand(cmd: string): Promise<void>
  listHistory(): Promise<CommandItem[]>
  clearHistory(): Promise<void>
  listLibrary(): Promise<CommandItem[]>
  saveLibraryItem(item: CommandItem): Promise<CommandItem>
  deleteLibraryItem(id: string): Promise<void>
  /** session output logging */
  logStart(sessionId: string): Promise<SessionLogMeta>
  logStop(sessionId: string): Promise<void>
  listSessionLogs(): Promise<SessionLogMeta[]>
  openLogsDir(): void

  // ---- ssh connections ----
  listConnections(): Promise<SshConnection[]>
  saveConnection(input: SshConnectionInput): Promise<SshConnection>
  deleteConnection(id: string): Promise<void>
  onHostKeyPrompt(cb: (e: HostKeyPromptEvent) => void): () => void
  respondHostKey(promptId: string, action: HostKeyAction): void

  // ---- zmodem (M6: main-process engine over ssh sessions; progress reuses transfer events) ----
  onZmodemOffer(cb: (e: ZmodemOfferEvent) => void): () => void
  zmodemRespond(resp: ZmodemResponse): void
  onZmodemDone(cb: (e: ZmodemDoneEvent) => void): () => void

  // ---- settings ----
  getSettings(): Promise<AppSettings>
  saveSettings(next: AppSettings): Promise<AppSettings>
  onSettingsChanged(cb: (s: AppSettings) => void): () => void

  // ---- fonts ----
  listFonts(): Promise<string[]>

  // ---- layout templates ----
  listLayouts(): Promise<LayoutMeta[]>
  getLayout(id: string): Promise<string | null>
  /** json = serialized dockview layout (DockviewApi.toJSON()) */
  saveLayout(meta: LayoutMeta, json: string): Promise<void>
  deleteLayout(id: string): Promise<void>

  // ---- updater (domestic feed first, GitHub fallback) ----
  updateCheck(): Promise<UpdateState>
  updateDownload(): Promise<void>
  updateInstall(): void
  updateChangelog(): Promise<ReleaseNote[]>
  onUpdateState(cb: (s: UpdateState) => void): () => void
}
