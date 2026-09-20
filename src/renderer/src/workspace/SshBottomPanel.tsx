import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { t } from '@shared/i18n'
import { FilePanel } from '../sftp/FilePanel'

export interface SshBottomPanelProps {
  sessionId: string
  /** The terminal surface rendered in the flexible top region. */
  terminal: ReactNode
}

/** File browser height in px — clamped to [120, 60% of container height]. */
const MIN_HEIGHT = 120

export function SshBottomPanel({ sessionId, terminal }: SshBottomPanelProps): React.JSX.Element {
  /** Current file-browser height in px. */
  const [filesHeight, setFilesHeight] = useState<number>(220)
  /** Divider drag in flight — drives the accent highlight. */
  const [resizing, setResizing] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  /** Drag origin; non-null only while a divider drag is in flight. */
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null)
  /** Live container height, refreshed by the observer below: clamping against a
   *  height captured at mousedown keeps a stale maximum after a window resize. */
  const containerHRef = useRef(0)

  const clampHeight = useCallback((height: number): number => {
    return Math.max(MIN_HEIGHT, Math.min(Math.round(containerHRef.current * 0.6), height))
  }, [])

  // Re-clamp on container resize: a shrunk window would otherwise leave the file
  // browser taller than 60% of the panel, collapsing the terminal.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const observer = new ResizeObserver(() => {
      containerHRef.current = root.clientHeight
      setFilesHeight((prev) => clampHeight(prev))
    })
    observer.observe(root)
    return () => observer.disconnect()
  }, [clampHeight])

  const onDividerPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (e.button !== 0) return
      const root = rootRef.current
      if (!root) return
      containerHRef.current = root.clientHeight
      dragRef.current = { startY: e.clientY, startHeight: filesHeight }
      // Pointer capture keeps move/up events coming even when the pointer leaves
      // the window, so a release outside it cannot strand the drag.
      e.currentTarget.setPointerCapture(e.pointerId)
      setResizing(true)
      e.preventDefault()
    },
    [filesHeight]
  )

  const onDividerPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      const info = dragRef.current
      if (!info) return
      setFilesHeight(clampHeight(info.startHeight - (e.clientY - info.startY)))
    },
    [clampHeight]
  )

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragRef.current) return
    dragRef.current = null
    setResizing(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }, [])

  return (
    <div className="ssh-bottom-panel" ref={rootRef}>
      <div className="ssh-bottom-top">{terminal}</div>
      <div
        className={'ssh-bottom-divider' + (resizing ? ' is-resizing' : '')}
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('ssh.bottomPanel.resize')}
        onPointerDown={onDividerPointerDown}
        onPointerMove={onDividerPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      />
      <div className="ssh-bottom-files" style={{ height: filesHeight }}>
        <FilePanel sessionId={sessionId} />
      </div>
    </div>
  )
}