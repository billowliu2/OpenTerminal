/** Command history / command library + session output logs (M5). */

export interface CommandItem {
  id: string
  /** library items have a name; history items don't */
  name?: string
  command: string
  note?: string
  group?: string
  /** library items support {{var}} placeholders; recorded purely as metadata */
  params?: string[]
  createdAt: number
  /** epoch ms of last execution (history ordering) */
  lastUsedAt?: number
}

export interface SessionLogMeta {
  sessionId: string
  /** absolute file path of the plain-text log */
  file: string
  fileName: string
  /** epoch ms when logging started */
  startedAt: number
  /** undefined while still logging */
  endedAt?: number
}
