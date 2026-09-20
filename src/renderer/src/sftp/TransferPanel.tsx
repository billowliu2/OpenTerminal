import { useEffect, useRef, useState } from 'react'
import { CloseOutlined } from '@ant-design/icons'
import type { TransferKind, TransferProgressEvent } from '@shared/sftp'
import { t } from '@shared/i18n'

interface TransferState {
  kind: TransferKind
  file: string
  bytes: number
  totalBytes: number
  state: 'running' | 'done' | 'error' | 'cancelled'
  error?: string
}

/**
 * Global transfer overlay (bottom-right). Aggregates progress events by
 * transferId; done transfers fade out, errors stay until dismissed.
 */
export function TransferPanel(): React.JSX.Element | null {
  const [transfers, setTransfers] = useState<Map<string, TransferState>>(new Map())
  const timersRef = useRef<number[]>([])

  useEffect(() => {
    const off = window.api.onTransferProgress((e: TransferProgressEvent) => {
      setTransfers((prev) => {
        const next = new Map(prev)
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
          // terminal event for the whole transfer
          const existing = next.get(e.transferId)
          if (existing) {
            if (e.state === 'error') {
              next.set(e.transferId, { ...existing, state: 'error', error: e.error })
            } else if (e.state === 'cancelled') {
              next.set(e.transferId, { ...existing, state: 'cancelled' })
            } else {
              next.set(e.transferId, { ...existing, state: 'done' })
            }
          }
        }
        return next
      })
    })
    return () => {
      off()
      for (const t of timersRef.current) window.clearTimeout(t)
    }
  }, [])

  // auto-dismiss finished entries after 3s
  useEffect(() => {
    for (const [id, t] of transfers) {
      if ((t.state === 'done' || t.state === 'cancelled') && !t.error) {
        const timer = window.setTimeout(() => {
          setTransfers((prev) => {
            const next = new Map(prev)
            next.delete(id)
            return next
          })
        }, 3000)
        timersRef.current.push(timer)
      }
    }
  }, [transfers])

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
                  onClick={() =>
                    setTransfers((prev) => {
                      const next = new Map(prev)
                      next.delete(id)
                      return next
                    })
                  }
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
