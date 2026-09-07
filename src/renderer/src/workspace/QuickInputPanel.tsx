import { useCallback, useEffect, useRef, useState } from 'react'
import { App, Input } from 'antd'
import { create } from 'zustand'
import type { CommandItem } from '@shared/commands'
import { writeBroadcast } from './broadcastStore'

/** Open state shared between the tab-bar toggle button and the floating panel. */
export const useQuickInputStore = create<{
  open: boolean
  toggle: () => void
  setOpen: (open: boolean) => void
}>((set) => ({
  open: window.localStorage.getItem('ot.quickInputOpen') === '1',
  toggle: () =>
    set((state) => {
      const next = !state.open
      window.localStorage.setItem('ot.quickInputOpen', next ? '1' : '0')
      return { open: next }
    }),
  setOpen: (open) => {
    window.localStorage.setItem('ot.quickInputOpen', open ? '1' : '0')
    set({ open })
  }
}))

/**
 * M6 quick-input panel (bottom-right floating). Three sections:
 *   1. free-text command line (with auto-execute(\r) toggle)
 *   2. library commands (api.listLibrary())
 *   3. recent history (api.listHistory(), top 10)
 *
 * Sends target = the active session via `onResolveActiveSession`; when broadcast
 * is enabled and the active session is a target, the send routes through the
 * broadcast fan-out so it reaches every target. Lists refresh on open.
 */
export interface QuickInputPanelProps {
  /** resolve the currently active terminal session id ('' when none) */
  onResolveActiveSession: () => string
}

export function QuickInputPanel({ onResolveActiveSession }: QuickInputPanelProps): React.JSX.Element | null {
  const { message } = App.useApp()
  const open = useQuickInputStore((s) => s.open)
  const close = useQuickInputStore((s) => s.setOpen)
  // auto-execute(\r); persisted across sessions.
  const [autoEnter, setAutoEnter] = useState<boolean>(() => window.localStorage.getItem('ot.quickInputEnter') !== '0')
  const [value, setValue] = useState('')
  const [history, setHistory] = useState<CommandItem[]>([])
  const [library, setLibrary] = useState<CommandItem[]>([])
  /** tracks the previous `open` so lists refresh on the false→true transition */
  const prevOpenRef = useRef(open)

  // Refresh lists every time the panel opens (and stay fresh if it was open).
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [h, l] = await Promise.all([window.api.listHistory(), window.api.listLibrary()])
      setHistory(h.slice(0, 10))
      setLibrary(l)
    } catch {
      setHistory([])
      setLibrary([])
    }
  }, [])

  useEffect(() => {
    if (open && !prevOpenRef.current) void refresh()
    prevOpenRef.current = open
  }, [open, refresh])

  const send = useCallback(
    (text: string) => {
      const target = onResolveActiveSession()
      if (!target) {
        void message.info('没有激活的终端会话')
        return
      }
      const data = autoEnter ? `${text}\r` : text
      writeBroadcast(target, data)
      // keep "最近命令" fresh immediately after a send
      void window.api
        .listHistory()
        .then((h: CommandItem[]) => setHistory(h.slice(0, 10)))
        .catch(() => undefined)
      setValue('')
    },
    [autoEnter, onResolveActiveSession]
  )

  const onEnter = useCallback((): void => {
    const t = value.trim()
    if (t) send(t)
  }, [value, send])

  const onToggleAutoEnter = useCallback((checked: boolean): void => {
    setAutoEnter(checked)
    window.localStorage.setItem('ot.quickInputEnter', checked ? '1' : '0')
  }, [])

  if (!open) return null

  return (
    <div className="quick-input-panel">
      <div className="quick-input-headbar">
        <span className="quick-input-headbar-title">快捷输入</span>
        <button type="button" className="quick-input-close" title="收起" aria-label="收起" onClick={() => close(false)}>
          ×
        </button>
      </div>
      <div className="quick-input-row">
        <Input
          className="quick-input-field"
          placeholder="输入命令…"
          value={value}
          spellCheck={false}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onPressEnter={onEnter}
        />
        <label className="quick-input-autoenter" title="关闭后只键入不回车">
          <input
            type="checkbox"
            checked={autoEnter}
            onChange={(e) => onToggleAutoEnter(e.target.checked)}
          />
          <span>自动执行(\r)</span>
        </label>
      </div>

      <div className="quick-input-section">
        <div className="quick-input-head">快捷命令</div>
        {library.length === 0 ? (
          <div className="quick-input-empty">暂无快捷命令</div>
        ) : (
          <div className="quick-input-list">
            {library.map((item) => (
              <button
                key={item.id}
                type="button"
                className="quick-input-item"
                title={item.command}
                onClick={() => send(item.command)}
              >
                <span className="quick-input-item-cmd">{item.command}</span>
                {item.name && <span className="quick-input-item-tag">{item.name}</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="quick-input-section">
        <div className="quick-input-head">最近命令</div>
        {history.length === 0 ? (
          <div className="quick-input-empty">暂无历史记录</div>
        ) : (
          <div className="quick-input-list">
            {history.map((item) => (
              <button
                key={item.id}
                type="button"
                className="quick-input-item"
                title={item.command}
                onClick={() => send(item.command)}
              >
                <span className="quick-input-item-cmd">{item.command}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}