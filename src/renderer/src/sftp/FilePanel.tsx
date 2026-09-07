import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowUpOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  FileAddOutlined,
  FileOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  FormOutlined,
  ReloadOutlined,
  SafetyOutlined,
  UploadOutlined
} from '@ant-design/icons'
import { App, Button, Checkbox, Dropdown, Input, Modal, Popconfirm, Tooltip } from 'antd'
import type { MenuProps } from 'antd'
import type { SftpEntry, TransferProgressEvent } from '@shared/sftp'
import './sftp.css'

/** Remote file browser for one SSH session (M4). */
export interface FilePanelProps {
  sessionId: string
}

/** 9 permission bits: [owner r,w,x, group r,w,x, other r,w,x]. */
type PermBits = boolean[]

function parseModeBits(mode: string | undefined): PermBits {
  const chars = mode ? Array.from(mode.slice(1)) : []
  return Array.from({ length: 9 }, (_, i) => chars[i] != null && chars[i] !== '-')
}

function formatModeType(mode: string | undefined): string {
  if (!mode || mode.length === 0) return '-'
  return mode[0]
}

function bitsToModeStr(type: string, bits: PermBits): string {
  const letters = bits.map((on, i) => {
    if (!on) return '-'
    return ['r', 'w', 'x', 'r', 'w', 'x', 'r', 'w', 'x'][i]
  })
  return type + letters.join('')
}

/** e.g. r+w+x = 7 → returns the 3-bit octal digit (0..7). */
function octalDigit(start: number, bits: PermBits): number {
  return (bits[start] ? 4 : 0) + (bits[start + 1] ? 2 : 0) + (bits[start + 2] ? 1 : 0)
}

function bitsToOctal(bits: PermBits): string {
  // Concatenate octal digits as a string — 5,1,1 → "511". (The previous
  // arithmetic version computed 5*64+1*8+1 = 329 decimal, which is NOT the
  // octal "511" and made chmod a silent no-op when both sides agreed on the
  // same wrong value.)
  return `${octalDigit(0, bits)}${octalDigit(3, bits)}${octalDigit(6, bits)}`
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}G`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}K`
  return String(bytes)
}

function fmtTime(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const PERM_ROW_LABELS = ['所有者', '组', '其他'] as const
const PERM_COL_LABELS = ['读', '写', '执行'] as const

interface PermissionModalProps {
  open: boolean
  sessionId: string
  entry: SftpEntry | null
  onClose: () => void
  onSaved: () => void
}

function PermissionModal({ open, sessionId, entry, onClose, onSaved }: PermissionModalProps): React.JSX.Element {
  const { message } = App.useApp()
  const [bits, setBits] = useState<PermBits>(Array.from({ length: 9 }, () => false))
  const [octal, setOctal] = useState('')
  const [uid, setUid] = useState('')
  const [gid, setGid] = useState('')
  const [saving, setSaving] = useState(false)
  const hasUidGid = entry != null && (entry.uid != null || entry.gid != null)

  const modeStr = useMemo(() => {
    if (!entry) return { type: '-', str: '---------' }
    return { type: formatModeType(entry.mode), str: (entry.mode ?? '').slice(1) || '---------' }
  }, [entry])

  // seed state when opening
  useEffect(() => {
    if (!open) return
    if (entry) {
      const b = parseModeBits(entry.mode)
      setBits(b)
      setOctal(bitsToOctal(b))
      setUid(entry.uid != null ? String(entry.uid) : '')
      setGid(entry.gid != null ? String(entry.gid) : '')
    } else {
      setBits(Array.from({ length: 9 }, () => false))
      setOctal('')
      setUid('')
      setGid('')
    }
  }, [open, entry])

  const applyOctal = (v: string | null): void => {
    const s = (v ?? '').trim()
    if (/^[0-7]{1,4}$/.test(s)) {
      const num = parseInt(s, 8) || 0
      setBits([
        (num >> 6) & 4 ? true : false,
        (num >> 6) & 2 ? true : false,
        (num >> 6) & 1 ? true : false,
        (num >> 3) & 4 ? true : false,
        (num >> 3) & 2 ? true : false,
        (num >> 3) & 1 ? true : false,
        num & 4 ? true : false,
        num & 2 ? true : false,
        num & 1 ? true : false
      ])
    }
    setOctal(s)
  }

  const toggleBit = (idx: number): void => {
    setBits((prev) => {
      const next = prev.slice()
      next[idx] = !next[idx]
      setOctal(bitsToOctal(next))
      return next
    })
  }

  const onSave = (): void => {
    void (async () => {
      if (!entry) return
      setSaving(true)
      try {
        const octalStr = bitsToOctal(bits)
        const curOctal = entry.mode ? bitsToOctal(parseModeBits(entry.mode)) : null
        // Only chown when the uid/gid actually differ from the entry's current
        // owner — the inputs are seeded with the current values, so "untouched"
        // would otherwise chown on every save.
        const newUid = uid.trim() !== '' && !Number.isNaN(Number(uid)) ? Number(uid) : null
        const newGid = gid.trim() !== '' && !Number.isNaN(Number(gid)) ? Number(gid) : null
        const ownerChanged =
          (newUid !== null && newUid !== entry.uid) || (newGid !== null && newGid !== entry.gid)

        if (octalStr !== curOctal) {
          await window.api.chmodRemote(sessionId, entry.path, octalStr)
        }
        if (ownerChanged) {
          const u = newUid ?? entry.uid ?? 0
          const g = newGid ?? newUid ?? entry.gid ?? 0
          await window.api.chownRemote(sessionId, entry.path, u, g)
        }
        if (octalStr !== curOctal || ownerChanged) {
          message.success('已应用权限')
        }
        onClose()
        onSaved()
      } catch (err) {
        message.error((err as Error).message)
      } finally {
        setSaving(false)
      }
    })()
  }

  return (
    <Modal
      title={`权限 · ${entry?.name ?? ''}`}
      open={open}
      onOk={onSave}
      onCancel={onClose}
      confirmLoading={saving}
      okText="保存"
      cancelText="取消"
      width={380}
    >
      <div className="sftp-perm">
        {entry && (
          <div className="sftp-perm-mode">
            <span className="sftp-perm-sym">{modeStr.str}</span>
            <span className="sftp-perm-octal">{bitsToOctal(bits)}</span>
          </div>
        )}

        <div className="sftp-perm-grid">
          <div className="sftp-perm-grid-head">
            <span />
            {PERM_COL_LABELS.map((l) => (
              <span key={l}>{l}</span>
            ))}
          </div>
          {PERM_ROW_LABELS.map((row, r) => (
            <div className="sftp-perm-grid-row" key={row}>
              <span className="sftp-perm-grid-label">{row}</span>
              {PERM_COL_LABELS.map((_, c) => {
                const idx = r * 3 + c
                return (
                  <Checkbox key={idx} checked={bits[idx]} onChange={() => toggleBit(idx)} />
                )
              })}
            </div>
          ))}
        </div>

        <div className="sftp-perm-octal-input">
          <span className="sftp-perm-label">八进制</span>
          <Input
            value={octal}
            onChange={(e) => applyOctal(e.target.value)}
            placeholder="如 755"
            addonAfter={bitsToModeStr(modeStr.type, bits)}
          />
        </div>

        <div className="sftp-perm-own">
          <div className="sftp-perm-own-field">
            <span className="sftp-perm-label">UID</span>
            <Input value={uid} onChange={(e) => setUid(e.target.value)} placeholder={hasUidGid ? '不改则留空' : '0'} />
          </div>
          <div className="sftp-perm-own-field">
            <span className="sftp-perm-label">GID</span>
            <Input value={gid} onChange={(e) => setGid(e.target.value)} placeholder={hasUidGid ? '不改则留空' : '0'} />
          </div>
        </div>
        <div className="sftp-perm-hint">UID/GID 留空表示不修改属主</div>
      </div>
    </Modal>
  )
}

export function FilePanel({ sessionId }: FilePanelProps): React.JSX.Element {
  const { message, modal } = App.useApp()
  const [dir, setDir] = useState('/')
  const [entries, setEntries] = useState<SftpEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<SftpEntry | null>(null)
  const [menuEntry, setMenuEntry] = useState<SftpEntry | null>(null)
  const [mkdirOpen, setMkdirOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [permOpen, setPermOpen] = useState(false)
  const [inputValue, setInputValue] = useState('')

  /** the entry the context menu is operating on (selected when right-clicked) */
  const menuTarget = menuEntry ?? selected

  const refresh = useCallback(
    async (target: string): Promise<void> => {
      setLoading(true)
      setError('')
      try {
        const list = await window.api.listRemote(sessionId, target)
        setEntries(list)
        setDir(target)
        setSelected(null)
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setLoading(false)
      }
    },
    [sessionId]
  )

  useEffect(() => {
    void refresh('/')
  }, [refresh])

  const segments = dir.split('/').filter(Boolean)
  const jumpTo = (index: number): string => '/' + segments.slice(0, index + 1).join('/')
  const parent = '/' + segments.slice(0, -1).join('/')

  const selectedPath = selected?.path ?? ''

  const doUpload = (): void => {
    void (async () => {
      try {
        const files = await window.api.pickFiles()
        if (files.length === 0) return
        await window.api.uploadRemote(sessionId, files, dir)
        // refresh when the transfer completes
        const off = window.api.onTransferProgress((e: TransferProgressEvent) => {
          if (e.state === 'done' || e.state === 'error' || e.state === 'cancelled') {
            off()
            void refresh(dir)
          }
        })
      } catch (err) {
        message.error((err as Error).message)
      }
    })()
  }

  const doDownload = (entry: SftpEntry): void => {
    void (async () => {
      try {
        const dirTo = await window.api.pickDirectory()
        if (!dirTo) return
        await window.api.downloadRemote(sessionId, [entry.path], dirTo)
      } catch (err) {
        message.error((err as Error).message)
      }
    })()
  }

  const doDelete = (): void => {
    void (async () => {
      if (!selected) return
      try {
        await window.api.deleteRemote(sessionId, [selected.path])
        void refresh(dir)
      } catch (err) {
        message.error((err as Error).message)
      }
    })()
  }

  const doMkdir = (): void => {
    void (async () => {
      const name = inputValue.trim()
      if (!name) return
      try {
        await window.api.mkdirRemote(sessionId, dir, name)
        setMkdirOpen(false)
        setInputValue('')
        void refresh(dir)
      } catch (err) {
        message.error((err as Error).message)
      }
    })()
  }

  const doRename = (): void => {
    void (async () => {
      const name = inputValue.trim()
      if (!name || !selected) return
      try {
        const to = `${dir.replace(/\/$/, '')}/${name}`
        await window.api.renameRemote(sessionId, selected.path, to)
        setRenameOpen(false)
        setInputValue('')
        void refresh(dir)
      } catch (err) {
        message.error((err as Error).message)
      }
    })()
  }

  const doCopyPath = (entry: SftpEntry): void => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(entry.path)
        message.success('已复制路径')
      } catch {
        message.error('复制路径失败')
      }
    })()
  }

  /** opens the mkdir modal in create-a-file mode (no-op: new files unsupported) */
  const menu: MenuProps = useMemo(() => {
    const target = menuTarget
    const isDir = target?.isDir
    const canAction = target != null
    return {
      items: [
        { key: 'refresh', label: '刷新', icon: <ReloadOutlined /> },
        { type: 'divider' },
        {
          key: 'open',
          label: isDir ? '打开' : '下载',
          icon: isDir ? <FolderOpenOutlined /> : <DownloadOutlined />,
          disabled: !canAction
        },
        {
          key: 'download',
          label: '下载',
          icon: <DownloadOutlined />,
          disabled: !canAction || Boolean(isDir)
        },
        { key: 'upload', label: '上传…', icon: <UploadOutlined /> },
        {
          key: 'rename',
          label: '重命名',
          icon: <FormOutlined />,
          disabled: !canAction
        },
        {
          type: 'submenu',
          key: 'new',
          label: '新建',
          icon: <FileAddOutlined />,
          children: [
            { key: 'mkdir', label: '新建文件夹', icon: <FolderAddOutlined /> }
            // 新建文件：无现成 SFTP 创建文件 API（main 仅 mkdir/rename/chmod/chown），不做
          ]
        },
        { type: 'divider' },
        {
          key: 'copyPath',
          label: '复制路径',
          icon: <CopyOutlined />,
          disabled: !canAction
        },
        {
          key: 'permission',
          label: '文件权限…',
          icon: <SafetyOutlined />,
          disabled: !canAction
        },
        { key: 'delete', label: '删除', icon: <DeleteOutlined />, danger: true, disabled: !canAction }
      ],
      onClick: ({ key }) => {
        const entry = menuTarget
        if (key === 'refresh') {
          void refresh(dir)
        } else if (key === 'open') {
          if (!entry) return
          if (entry.isDir) void refresh(entry.path)
          else doDownload(entry)
        } else if (key === 'download') {
          if (entry && !entry.isDir) doDownload(entry)
        } else if (key === 'upload') {
          doUpload()
        } else if (key === 'rename') {
          setInputValue(entry?.name ?? '')
          setRenameOpen(true)
        } else if (key === 'mkdir') {
          setInputValue('')
          setMkdirOpen(true)
        } else if (key === 'copyPath') {
          if (entry) doCopyPath(entry)
        } else if (key === 'permission') {
          setPermOpen(true)
        } else if (key === 'delete') {
          modal.confirm({
            title: '确认删除？',
            content: entry ? `${entry.name}（${entry.path}）` : undefined,
            okText: '删除',
            okButtonProps: { danger: true },
            cancelText: '取消',
            onOk: () =>
              new Promise<void>((resolve, reject) => {
                if (!entry) {
                  resolve()
                  return
                }
                window.api.deleteRemote(sessionId, [entry.path]).then(
                  () => {
                    void refresh(dir)
                    resolve()
                  },
                  (err: unknown) => reject(err)
                )
              })
          })
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuTarget, dir, refresh])

  return (
    <div className="sftp-panel">
      <div className="sftp-toolbar">
        <Tooltip title="上一级">
          <Button
            type="text"
            size="small"
            icon={<ArrowUpOutlined />}
            disabled={dir === '/'}
            onClick={() => void refresh(parent)}
          />
        </Tooltip>
        <Tooltip title="刷新">
          <Button type="text" size="small" icon={<ReloadOutlined />} onClick={() => void refresh(dir)} />
        </Tooltip>
        <Tooltip title="新建文件夹">
          <Button
            type="text"
            size="small"
            icon={<FolderAddOutlined />}
            onClick={() => {
              setInputValue('')
              setMkdirOpen(true)
            }}
          />
        </Tooltip>
        <Tooltip title="上传文件">
          <Button type="text" size="small" icon={<UploadOutlined />} onClick={doUpload} />
        </Tooltip>
        <Tooltip title="下载选中项">
          <Button
            type="text"
            size="small"
            icon={<DownloadOutlined />}
            disabled={!selected}
            onClick={() => selected && doDownload(selected)}
          />
        </Tooltip>
        <Tooltip title="重命名">
          <Button
            type="text"
            size="small"
            icon={<FormOutlined />}
            disabled={!selected}
            onClick={() => {
              setInputValue(selected?.name ?? '')
              setRenameOpen(true)
            }}
          />
        </Tooltip>
        <Tooltip title="权限 / 属主">
          <Button
            type="text"
            size="small"
            icon={<SafetyOutlined />}
            disabled={!selected}
            onClick={() => setPermOpen(true)}
          />
        </Tooltip>
        <Popconfirm title="确认删除？" okText="删除" cancelText="取消" onConfirm={doDelete}>
          <Button type="text" size="small" icon={<DeleteOutlined />} disabled={!selected} danger />
        </Popconfirm>
      </div>

      <div className="sftp-breadcrumb">
        <span className="sftp-crumb" onClick={() => void refresh('/')}>
          /
        </span>
        {segments.map((seg, i) => (
          <span key={i} className="sftp-crumb" onClick={() => void refresh(jumpTo(i))}>
            {seg}/
          </span>
        ))}
      </div>

      {error ? (
        <div className="sftp-error">{error}</div>
      ) : (
        <div className="sftp-list">
          {loading && entries.length === 0 && <div className="sftp-empty">加载中…</div>}
          {!loading && entries.length === 0 && <div className="sftp-empty">空目录</div>}
          {entries.map((e) => (
            <Dropdown
              key={e.path}
              menu={menu}
              trigger={['contextMenu']}
              getPopupContainer={() => document.body}
              onOpenChange={(open) => {
                if (!open) setMenuEntry(null)
              }}
            >
              <div
                className={`sftp-row${selected?.path === e.path ? ' sftp-row-selected' : ''}`}
                onClick={() => setSelected(e)}
                onContextMenu={() => {
                  setSelected(e)
                  setMenuEntry(e)
                }}
                onDoubleClick={() => (e.isDir ? void refresh(e.path) : doDownload(e))}
              >
                <span className="sftp-icon">{e.isDir ? <FolderOutlined className="sftp-icon-dir" /> : <FileOutlined />}</span>
                <span className="sftp-name" title={e.name}>
                  {e.name}
                </span>
                <span className="sftp-mode" title={e.mode ?? '权限不可用'}>
                  {e.mode ?? '----------'}
                </span>
                <span className="sftp-owner" title={`UID ${e.uid ?? '—'} / GID ${e.gid ?? '—'}`}>
                  {e.uid != null && e.gid != null ? `${e.uid}/${e.gid}` : '—'}
                </span>
                <span className="sftp-size" title={e.isDir ? '' : `${e.size} bytes`}>
                  {e.isDir ? '' : fmtSize(e.size)}
                </span>
                <span className="sftp-time">{fmtTime(e.mtime)}</span>
              </div>
            </Dropdown>
          ))}
        </div>
      )}

      <PermissionModal
        open={permOpen}
        sessionId={sessionId}
        entry={selected}
        onClose={() => setPermOpen(false)}
        onSaved={() => void refresh(dir)}
      />
      <Modal
        title="新建文件夹"
        open={mkdirOpen}
        onOk={doMkdir}
        onCancel={() => setMkdirOpen(false)}
        okText="创建"
        cancelText="取消"
        width={360}
      >
        <Input
          autoFocus
          placeholder="文件夹名称"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onPressEnter={doMkdir}
        />
      </Modal>
      <Modal
        title={`重命名 ${selected?.name ?? ''}`}
        open={renameOpen}
        onOk={doRename}
        onCancel={() => setRenameOpen(false)}
        okText="确定"
        cancelText="取消"
        width={360}
      >
        <Input
          autoFocus
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onPressEnter={doRename}
        />
      </Modal>
    </div>
  )
}
