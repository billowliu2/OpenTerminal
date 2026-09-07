/** SFTP file model + transfer progress (M4). */

export interface SftpEntry {
  name: string
  /** absolute remote path */
  path: string
  isDir: boolean
  /** bytes (0 for dirs) */
  size: number
  /** epoch ms */
  mtime: number
  /** e.g. "drwxr-xr-x" (best effort) */
  mode?: string
  /** numeric uid/gid (best effort) */
  uid?: number
  gid?: number
}

export type TransferKind = 'upload' | 'download' | 'zmodem-upload' | 'zmodem-download'
export type TransferState = 'running' | 'done' | 'error' | 'cancelled'

export interface TransferProgressEvent {
  transferId: string
  kind: TransferKind
  state: TransferState
  /** file currently being transferred */
  file: string
  bytes: number
  totalBytes: number
  error?: string
}
