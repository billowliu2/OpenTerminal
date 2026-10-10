import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { CloseOutlined } from '@ant-design/icons'
import type { TransferKind, TransferProgressEvent, TransferState } from '@shared/sftp'
import { DEFAULT_LANGUAGE, tFor } from '@shared/i18n'
import { useSettingsStore } from '@renderer/settings/store'

/** One aggregated transfer row in the overlay (the per-event state string is
 *  the shared `TransferState`). */
interface TransferEntry {
  kind: TransferKind
  file: string
  bytes: number
  totalBytes: number
  state: TransferState
  error?: string
}

interface TransferRowProps {
  id: string
  entry: TransferEntry
  onDismiss: (id: string) => void
}

/**
 * Memoized on the entry object: the progress channel replaces only the entry a
 * transfer owns, so a busy multi-transfer overlay re-renders the advancing row
 * and leaves the others alone.
 *
 * That memo is also why the row subscribes to the language itself: a language
 * switch changes no prop here, so nothing else would ever re-render it, and
 * `t()` would keep serving whatever the module-level language was. A row count
 * is bounded by the concurrent transfers, so one subscription per row is
 * cheaper than threading the language down as a prop (which would defeat the
 * memo and re-render every row on each progress tick).
 */
const TransferRow = memo(function TransferRow({ id, entry, onDismiss }: TransferRowProps): React.JSX.Element {
  const language = useSettingsStore((s) => s.settings.system.language ?? DEFAULT_LANGUAGE)
  const pct =
    entry.totalBytes > 0
      ? Math.min(100, Math.round((entry.bytes / entry.totalBytes) * 100))
      : entry.state === 'done'
        ? 100
        : 0
  return (
    <div className={`sftp-transfer sftp-transfer-${entry.state}`}>
      <div className="sftp-transfer-head">
        <span className="sftp-transfer-title">
          {entry.state === 'error'
            ? tFor(language, 'panels.transfer.failed')
            : entry.state === 'cancelled'
              ? tFor(language, 'panels.transfer.cancelled')
              : entry.state === 'done'
                ? tFor(language, 'panels.transfer.done')
                : entry.kind === 'upload'
                  ? tFor(language, 'panels.transfer.uploading')
                  : entry.kind === 'download'
                    ? tFor(language, 'panels.transfer.downloading')
                    : entry.kind === 'zmodem-upload'
                      ? tFor(language, 'panels.transfer.zmodemUploading')
                      : tFor(language, 'panels.transfer.zmodemDownloading')}
        </span>
        {/* Only the SFTP engine's own transfers can be cancelled; zmodem
            runs in a separate engine that ignores cancelTransfer. */}
        {entry.state === 'running' && (entry.kind === 'upload' || entry.kind === 'download') && (
          <button
            type="button"
            className="sftp-transfer-cancel"
            onClick={() => window.api.cancelTransfer(id)}
          >
            {tFor(language, 'common.cancel')}
          </button>
        )}
        {/* Cancelled rows dismiss themselves after 3s, but one that also
            carries an error (a cancel racing a failed file) skips that
            path, so every terminal state keeps a manual close. */}
        {(entry.state === 'error' || entry.state === 'done' || entry.state === 'cancelled') && (
          <button
            type="button"
            className="sftp-transfer-close"
            onClick={() => onDismiss(id)}
          >
            <CloseOutlined />
          </button>
        )}
      </div>
      <div className="sftp-transfer-file">{entry.file || entry.error || ''}</div>
      {entry.state === 'running' && entry.totalBytes > 0 && (
        <div className="sftp-transfer-bar">
          <div className="sftp-transfer-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
      {entry.error && <div className="sftp-transfer-err">{entry.error}</div>}
    </div>
  )
})

/**
 * Global transfer overlay (bottom-right). Aggregates progress events by
 * transferId; done transfers fade out, errors stay until dismissed.
 *
 * The entries live in a ref and only a version counter reaches React: a
 * progress event used to rebuild the whole Map per event, which is O(transfers)
 * allocation on the hottest IPC stream in the app. Mutation stays outside
 * render, so React never observes a half-updated map.
 */
export function TransferPanel(): React.JSX.Element | null {
  const entriesRef = useRef<Map<string, TransferEntry>>(new Map())
  const [version, setVersion] = useState(0)
  /** auto-dismiss timers, keyed by transfer id (never more than one per run) */
  const timersRef = useRef<Map<string, number>>(new Map())

  const dismiss = useCallback((id: string): void => {
    const timer = timersRef.current.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timersRef.current.delete(id)
    }
    if (!entriesRef.current.has(id)) return
    entriesRef.current.delete(id)
    setVersion((v) => v + 1)
  }, [])

  useEffect(() => {
    const off = window.api.onTransferProgress((e: TransferProgressEvent) => {
      const entries = entriesRef.current
      const existing = entries.get(e.transferId)
      let next: TransferEntry
      if (e.file) {
        next = {
          kind: e.kind,
          file: e.file,
          bytes: e.bytes,
          totalBytes: e.totalBytes,
          state: e.state,
          error: e.error
        }
      } else {
        // Terminal event for the whole transfer. It can arrive without any
        // per-file progress first (e.g. the remote open was denied), so a
        // missing entry is created rather than dropped — otherwise the
        // failure would be visible nowhere.
        const base: TransferEntry = existing ?? {
          kind: e.kind,
          file: '',
          bytes: e.bytes,
          totalBytes: e.totalBytes,
          state: 'running'
        }
        if (e.state === 'error') {
          next = { ...base, state: 'error', error: e.error }
        } else if (e.state === 'cancelled') {
          next = { ...base, state: 'cancelled' }
        } else {
          next = { ...base, state: 'done' }
        }
      }
      // Skip the render for a progress tick that changed nothing visible
      // (a repeat of the same file at the same byte count is common).
      if (
        existing &&
        existing.file === next.file &&
        existing.bytes === next.bytes &&
        existing.totalBytes === next.totalBytes &&
        existing.state === next.state &&
        existing.error === next.error
      ) {
        return
      }
      entries.set(e.transferId, next)
      setVersion((v) => v + 1)
    })
    return off
  }, [])

  // auto-dismiss finished entries after 3s
  useEffect(() => {
    for (const [id, tr] of entriesRef.current) {
      if ((tr.state === 'done' || tr.state === 'cancelled') && !tr.error && !timersRef.current.has(id)) {
        const timer = window.setTimeout(() => {
          timersRef.current.delete(id)
          dismiss(id)
        }, 3000)
        timersRef.current.set(id, timer)
      }
    }
  }, [version, dismiss])

  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer)
      timers.clear()
    }
  }, [])

  const list = [...entriesRef.current.entries()]
  if (list.length === 0) return null

  return (
    <div className="sftp-transfer-panel">
      {list.map(([id, entry]) => (
        <TransferRow key={id} id={id} entry={entry} onDismiss={dismiss} />
      ))}
    </div>
  )
}
