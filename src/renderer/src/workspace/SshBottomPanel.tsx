import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

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
  /** Container height captured while a drag is in flight. */
  const dragInfoRef = useRef<{ startY: number; startHeight: number; containerH: number } | null>(null)

  const onDividerMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    const container = (e.currentTarget.parentElement as HTMLElement | null) ?? null
    if (!container) return
    dragInfoRef.current = {
      startY: e.clientY,
      startHeight: filesHeight,
      containerH: container.clientHeight
    }
    e.preventDefault()
  }, [filesHeight])

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      const info = dragInfoRef.current
      if (!info) return
      const delta = e.clientY - info.startY
      const max = Math.round(info.containerH * 0.6)
      setFilesHeight(Math.min(max, Math.max(MIN_HEIGHT, info.startHeight - delta)))
    }
    const onUp = (): void => {
      dragInfoRef.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  return (
    <div className="ssh-bottom-panel">
      <div className="ssh-bottom-top">{terminal}</div>
      <div
        className="ssh-bottom-divider"
        role="separator"
        aria-orientation="horizontal"
        aria-label="调整文件面板高度"
        onMouseDown={onDividerMouseDown}
      />
      <div className="ssh-bottom-files" style={{ height: filesHeight }}>
        <FilePanel sessionId={sessionId} />
      </div>
    </div>
  )
}