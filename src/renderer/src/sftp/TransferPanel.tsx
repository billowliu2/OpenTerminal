import { useCallback, useEffect, useRef, useState } from 'react'
import { CloseOutlined } from '@ant-design/icons'
import type { TransferKind, TransferProgressEvent, TransferState } from '@shared/sftp'
import { t } from '@shared/i18n'

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

/**
 * Global transfer overlay (bottom-right). Aggregates progress events by
 * transferId; done transfers fade out, errors stay until dismissed.
 */
export function TransferPanel(): React.JSX.Element | null {
  const [transfers, setTransfers] = useState<Map<string, TransferEntry>>(new Map())
  /** auto-dismiss timers, keyed by transfer id (never more than one per run) */
  const timersRef = useRef<Map<string, number>>(new Map())

  const dismiss = useCallback((id: string): void => {
    const timer = timersRef.current.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timersRef.current.delete(id)
    }
    setTransfers((prev) => {
      if (!prev.has(id)) return prev
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }, [])

  useEffect(() => {
    const off = window.api.onTransferProgress((e: TransferProgressEvent) => {
      setTransfers((prev) => {
        const next = new Map(prev)
        const existing = next.get(e.transferId)
        if (e.file) {
          next.set(e.transferId, {
            kind: e.kind,
            file: e.file,
            bytes: e.bytes,
            totalBytes: e.totalBytes,
            state: e.state,
            error: e.error
          })
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
            next.set(e.transferId, { ...base, state: 'error', error: e.error })
          } else if (e.state === 'cancelled') {
            next.set(e.transferId, { ...base, state: 'cancelled' })
          } else {
            next.set(e.transferId, { ...base, state: 'done' })
          }
        }
        return next
      })
    })
    return off
  }, [])

  // auto-dismiss finished entries after 3s
  useEffect(() => {
    for (const [id, tr] of transfers) {
      if ((tr.state === 'done' || tr.state === 'cancelled') && !tr.error && !timersRef.current.has(id)) {
        const timer = window.setTimeout(() => {
          timersRef.current.delete(id)
          dismiss(id)
        }, 3000)
        timersRef.current.set(id, timer)
      }
    }
  }, [transfers, dismiss])

  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer)
      timers.clear()
    }
  }, [])

  const list = [...transfers.entries()]
  if (list.length === 0) return null

  return (
    <div className="sftp-transfer-panel">
      {list.map(([id, tr]) => {
        const pct = tr.totalBytes > 0 ? Math.min(100, Math.round((tr.bytes / tr.totalBytes) * 100)) : tr.state === 'done' ? 100 : 0
        return (
          <div key={id} className={`sftp-transfer sftp-transfer-${tr.state}`}>
            <div className="sftp-transfer-head">
              <span className="sftp-transfer-title">
                {tr.state === 'error'
                  ? t('panels.transfer.failed')
                  : tr.state === 'cancelled'
                    ? t('panels.transfer.cancelled')
                    : tr.state === 'done'
                      ? t('panels.transfer.done')
                      : tr.kind === 'upload'
                        ? t('panels.transfer.uploading')
                        : tr.kind === 'download'
                          ? t('panels.transfer.downloading')
                          : tr.kind === 'zmodem-upload'
                            ? t('panels.transfer.zmodemUploading')
                            : t('panels.transfer.zmodemDownloading')}
              </span>
              {(tr.state === 'error' || tr.state === 'done') && (
                <button
                  type="button"
                  className="sftp-transfer-close"
                  onClick={() => dismiss(id)}
                >
                  <CloseOutlined />
                </button>
              )}
            </div>
            <div className="sftp-transfer-file">{tr.file || tr.error || ''}</div>
            {tr.state === 'running' && tr.totalBytes > 0 && (
              <div className="sftp-transfer-bar">
                <div className="sftp-transfer-fill" style={{ width: `${pct}%` }} />
              </div>
            )}
            {tr.error && <div className="sftp-transfer-err">{tr.error}</div>}
          </div>
        )
      })}
    </div>
  )
}
