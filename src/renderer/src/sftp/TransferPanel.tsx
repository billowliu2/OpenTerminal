import { useEffect, useRef, useState } from 'react'
import { CloseOutlined } from '@ant-design/icons'
import type { TransferKind, TransferProgressEvent } from '@shared/sftp'

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
      {list.map(([id, t]) => {
        const pct = t.totalBytes > 0 ? Math.min(100, Math.round((t.bytes / t.totalBytes) * 100)) : t.state === 'done' ? 100 : 0
        return (
          <div key={id} className={`sftp-transfer sftp-transfer-${t.state}`}>
            <div className="sftp-transfer-head">
              <span className="sftp-transfer-title">
                {t.state === 'error'
                  ? '传输失败'
                  : t.state === 'cancelled'
                    ? '已取消'
                    : t.state === 'done'
                      ? '传输完成'
                      : t.kind === 'upload'
                        ? '上传中'
                        : t.kind === 'download'
                          ? '下载中'
                          : t.kind === 'zmodem-upload'
                            ? 'ZMODEM 上传中'
                            : 'ZMODEM 下载中'}
              </span>
              {(t.state === 'error' || t.state === 'done') && (
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
            <div className="sftp-transfer-file">{t.file || t.error || ''}</div>
            {t.state === 'running' && t.totalBytes > 0 && (
              <div className="sftp-transfer-bar">
                <div className="sftp-transfer-fill" style={{ width: `${pct}%` }} />
              </div>
            )}
            {t.error && <div className="sftp-transfer-err">{t.error}</div>}
          </div>
        )
      })}
    </div>
  )
}
