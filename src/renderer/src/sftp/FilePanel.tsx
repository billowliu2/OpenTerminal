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
import { getLanguage, t } from '@shared/i18n'
import './sftp.css'

/** Remote file browser for one SSH session (M4). */
export interface FilePanelProps {
  sessionId: string
}

/**
 * Permission bits: [owner r,w,x, group r,w,x, other r,w,x, setuid, setgid, sticky].
 * The last three (indices 9..11) only exist as the 4th octal digit — the grid
 * does not toggle them, the octal input does.
 */
type PermBits = boolean[]

const MODE_LETTERS = ['r', 'w', 'x', 'r', 'w', 'x', 'r', 'w', 'x']
/** x-column index → index of the special bit that changes its letter. */
const SPECIAL_BIT_AT: Record<number, number> = { 2: 9, 5: 10, 8: 11 }

const emptyBits = (): PermBits => Array.from({ length: 12 }, () => false)

function parseModeBits(mode: string | undefined): PermBits {
  const chars = mode ? Array.from(mode.slice(1)) : []
  const bits = emptyBits()
  for (let i = 0; i < 9; i++) {
    const c = chars[i]
    if (c == null || c === '-') continue
    // uppercase S/T means "special bit set, execute bit clear"
    bits[i] = c !== 'S' && c !== 'T'
  }
  if (chars[2] === 's' || chars[2] === 'S') bits[9] = true
  if (chars[5] === 's' || chars[5] === 'S') bits[10] = true
  if (chars[8] === 't' || chars[8] === 'T') bits[11] = true
  return bits
}

function formatModeType(mode: string | undefined): string {
  if (!mode || mode.length === 0) return '-'
  return mode[0]
}

function bitsToModeStr(type: string, bits: PermBits): string {
  const letters = MODE_LETTERS.map((on, i) => {
    const special = SPECIAL_BIT_AT[i]
    if (special !== undefined && bits[special]) {
      // setuid/setgid → s/S, sticky → t/T
      return bits[i] ? (i === 8 ? 't' : 's') : i === 8 ? 'T' : 'S'
    }
    return bits[i] ? on : '-'
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
  const special = (bits[9] ? 4 : 0) + (bits[10] ? 2 : 0) + (bits[11] ? 1 : 0)
  const perms = `${octalDigit(0, bits)}${octalDigit(3, bits)}${octalDigit(6, bits)}`
  // Keep the 3-digit form when no special bit is set so it round-trips with
  // what main sends (its mode string is 9 bits wide).
  return special > 0 ? `${special}${perms}` : perms
}

/** t() falls back to the key itself when a translation is missing. */
function tOr(key: string, fallback: string): string {
  const value = t(key)
  return value === key ? fallback : value
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

/** Permission-grid labels are resolved per render so they follow the language. */
function permRowLabels(): string[] {
  return [t('ssh.file.permRowOwner'), t('ssh.file.permRowGroup'), t('ssh.file.permRowOther')]
}

function permColLabels(): string[] {
  return [t('ssh.file.permColRead'), t('ssh.file.permColWrite'), t('ssh.file.permColExec')]
}

interface PermissionModalProps {
  open: boolean
  sessionId: string
  entry: SftpEntry | null
  onClose: () => void
  onSaved: () => void
}

function PermissionModal({ open, sessionId, entry, onClose, onSaved }: PermissionModalProps): React.JSX.Element {
  const { message } = App.useApp()
  const [bits, setBits] = useState<PermBits>(emptyBits)
  const [octal, setOctal] = useState('')
  const [uid, setUid] = useState('')
  const [gid, setGid] = useState('')
  const [saving, setSaving] = useState(false)
  const hasUidGid = entry != null && (entry.uid != null || entry.gid != null)
  /** lstat failed while listing → no mode to compare against or preserve. */
  const modeKnown = Boolean(entry?.mode)
  const rowLabels = permRowLabels()
  const colLabels = permColLabels()

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
      setOctal(entry.mode ? bitsToOctal(b) : '')
      setUid(entry.uid != null ? String(entry.uid) : '')
      setGid(entry.gid != null ? String(entry.gid) : '')
    } else {
      setBits(emptyBits())
      setOctal('')
      setUid('')
      setGid('')
    }
  }, [open, entry])

  const applyOctal = (v: string | null): void => {
    const s = (v ?? '').trim()
    if (/^[0-7]{1,4}$/.test(s)) {
      const num = parseInt(s, 8) || 0
      const special = s.length === 4 ? parseInt(s[0], 8) : 0
      setBits([
        (num >> 6) & 4 ? true : false,
        (num >> 6) & 2 ? true : false,
        (num >> 6) & 1 ? true : false,
        (num >> 3) & 4 ? true : false,
        (num >> 3) & 2 ? true : false,
        (num >> 3) & 1 ? true : false,
        num & 4 ? true : false,
        num & 2 ? true : false,
        num & 1 ? true : false,
        (special & 4) !== 0,
        (special & 2) !== 0,
        (special & 1) !== 0
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

  /** Non-negative integer input, '' meaning "keep current". */
  const parseId = (v: string): number | null => {
    const s = v.trim()
    if (s === '') return null
    const n = Number(s)
    return Number.isInteger(n) && n >= 0 ? n : null
  }
  const idInvalid = (v: string): boolean => v.trim() !== '' && parseId(v) === null

  const onSave = (): void => {
    void (async () => {
      if (!entry) return
      setSaving(true)
      try {
        const octalStr = bitsToOctal(bits)
        const curOctal = entry.mode ? bitsToOctal(parseModeBits(entry.mode)) : null
        // Unknown mode (lstat failed): bits start all-false, so only chmod when
        // the user actually touched something — otherwise an untouched dialog
        // would send "chmod 000".
        const modeChanged = curOctal === null ? bits.some(Boolean) : octalStr !== curOctal
        // Only chown when the uid/gid actually differ from the entry's current
        // owner — the inputs are seeded with the current values, so "untouched"
        // would otherwise chown on every save.
        const newUid = parseId(uid)
        const newGid = parseId(gid)
        const ownerChanged =
          (newUid !== null && newUid !== entry.uid) || (newGid !== null && newGid !== entry.gid)

        if (modeChanged) {
          await window.api.chmodRemote(sessionId, entry.path, octalStr)
        }
        if (ownerChanged) {
          const u = newUid ?? entry.uid ?? 0
          const g = newGid ?? entry.gid ?? 0
          await window.api.chownRemote(sessionId, entry.path, u, g)
        }
        if (modeChanged || ownerChanged) {
          message.success(t('ssh.file.permApplied'))
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
      title={t('ssh.file.permTitle', { name: entry?.name ?? '' })}
      open={open}
      onOk={onSave}
      onCancel={onClose}
      confirmLoading={saving}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      okButtonProps={{ disabled: idInvalid(uid) || idInvalid(gid) }}
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
            {colLabels.map((l) => (
              <span key={l}>{l}</span>
            ))}
          </div>
          {rowLabels.map((row, r) => (
            <div className="sftp-perm-grid-row" key={row}>
              <span className="sftp-perm-grid-label">{row}</span>
              {colLabels.map((_, c) => {
                const idx = r * 3 + c
                return (
                  <Checkbox key={idx} checked={bits[idx]} onChange={() => toggleBit(idx)} />
                )
              })}
            </div>
          ))}
        </div>

        <div className="sftp-perm-octal-input">
          <span className="sftp-perm-label">{t('ssh.file.octal')}</span>
          <Input
            value={octal}
            onChange={(e) => applyOctal(e.target.value)}
            placeholder={t('ssh.file.octalPlaceholder')}
            addonAfter={bitsToModeStr(modeStr.type, bits)}
          />
        </div>

        <div className="sftp-perm-own">
          <div className="sftp-perm-own-field">
            <span className="sftp-perm-label">UID</span>
            <Input
              value={uid}
              onChange={(e) => setUid(e.target.value)}
              placeholder={hasUidGid ? t('ssh.file.keepEmpty') : '0'}
            />
          </div>
          <div className="sftp-perm-own-field">
            <span className="sftp-perm-label">GID</span>
            <Input
              value={gid}
              onChange={(e) => setGid(e.target.value)}
              placeholder={hasUidGid ? t('ssh.file.keepEmpty') : '0'}
            />
          </div>
        </div>
        <div className="sftp-perm-hint">{t('ssh.file.ownerHint')}</div>
        {entry && !modeKnown && <div className="sftp-perm-hint">{t('ssh.file.modeUnavailable')}</div>}
        {(idInvalid(uid) || idInvalid(gid)) && (
          <div className="sftp-perm-hint">{t('main.sftp.invalidUidGid')}</div>
        )}
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

  /** local file name as main computes it for the remote path (basename). */
  const remoteNameOf = (local: string): string => local.split(/[\\/]/).pop() ?? local

  /**
   * Start the upload. The listener is registered BEFORE the transfer id is
   * known: uploadRemote resolves with the id right away while the transfer
   * itself runs detached, so a small file can finish before the id arrives —
   * registering afterwards would miss the terminal event and never refresh.
   */
  const startUpload = (files: string[]): void => {
    let targetId: string | null = null
    let settled = false
    const earlyTerminalIds: string[] = []
    const finish = (): void => {
      if (settled) return
      settled = true
      off()
      void refresh(dir)
    }
    const off = window.api.onTransferProgress((e: TransferProgressEvent) => {
      if (e.state !== 'done' && e.state !== 'error' && e.state !== 'cancelled') return
      if (targetId === null) {
        earlyTerminalIds.push(e.transferId)
        return
      }
      if (e.transferId === targetId) finish()
    })
    window.api.uploadRemote(sessionId, files, dir).then(
      (id: string) => {
        targetId = id
        if (earlyTerminalIds.includes(id)) finish()
      },
      (err: unknown) => {
        off()
        message.error((err as Error).message)
      }
    )
  }

  const doUpload = (): void => {
    void (async () => {
      try {
        // Explicit type: env.d.ts resolves `AppApi` through a wrong path, so
        // `window.api` is untyped and the callback params lose their context.
        const files: string[] = await window.api.pickFiles()
        if (files.length === 0) return
        // Main opens the target with 'w' (truncate), so an existing file would
        // be silently overwritten — ask first, like delete and clear-history do.
        const existing = files.map(remoteNameOf).filter((name) => entries.some((e) => e.name === name))
        if (existing.length === 0) {
          startUpload(files)
          return
        }
        const desc = tOr('ssh.file.overwriteDesc', '')
        modal.confirm({
          title: tOr('ssh.file.overwriteTitle', t('ssh.file.uploadFile')),
          content: (
            <div>
              {existing.map((name) => (
                <div key={name}>{name}</div>
              ))}
              {desc && <div>{desc}</div>}
            </div>
          ),
          okText: t('common.ok'),
          okButtonProps: { danger: true },
          cancelText: t('common.cancel'),
          onOk: () => startUpload(files)
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
        message.success(t('ssh.file.pathCopied'))
      } catch {
        message.error(t('ssh.file.copyPathFailed'))
      }
    })()
  }

  /** Active language; a dep of the menu below so translated labels refresh. */
  const language = getLanguage()

  /** opens the mkdir modal in create-a-file mode (no-op: new files unsupported) */
  const menu: MenuProps = useMemo(() => {
    const target = menuTarget
    const isDir = target?.isDir
    const canAction = target != null
    return {
      items: [
        { key: 'refresh', label: t('ssh.file.refresh'), icon: <ReloadOutlined /> },
        { type: 'divider' },
        {
          key: 'open',
          label: isDir ? t('ssh.file.open') : t('ssh.file.download'),
          icon: isDir ? <FolderOpenOutlined /> : <DownloadOutlined />,
          disabled: !canAction
        },
        {
          key: 'download',
          label: t('ssh.file.download'),
          icon: <DownloadOutlined />,
          disabled: !canAction || Boolean(isDir)
        },
        { key: 'upload', label: t('ssh.file.upload'), icon: <UploadOutlined /> },
        {
          key: 'rename',
          label: t('ssh.file.rename'),
          icon: <FormOutlined />,
          disabled: !canAction
        },
        {
          type: 'submenu',
          key: 'new',
          label: t('ssh.file.new'),
          icon: <FileAddOutlined />,
          children: [
            { key: 'mkdir', label: t('ssh.file.newFolder'), icon: <FolderAddOutlined /> }
            // 新建文件：无现成 SFTP 创建文件 API（main 仅 mkdir/rename/chmod/chown），不做
          ]
        },
        { type: 'divider' },
        {
          key: 'copyPath',
          label: t('ssh.file.copyPath'),
          icon: <CopyOutlined />,
          disabled: !canAction
        },
        {
          key: 'permission',
          label: t('ssh.file.permission'),
          icon: <SafetyOutlined />,
          disabled: !canAction
        },
        { key: 'delete', label: t('common.delete'), icon: <DeleteOutlined />, danger: true, disabled: !canAction }
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
            title: t('ssh.file.deleteTitle'),
            content: entry ? `${entry.name}（${entry.path}）` : undefined,
            okText: t('common.delete'),
            okButtonProps: { danger: true },
            cancelText: t('common.cancel'),
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
  }, [menuTarget, dir, refresh, language])

  return (
    <div className="sftp-panel">
      <div className="sftp-toolbar">
        <Tooltip title={t('ssh.file.up')}>
          <Button
            type="text"
            size="small"
            icon={<ArrowUpOutlined />}
            disabled={dir === '/'}
            onClick={() => void refresh(parent)}
          />
        </Tooltip>
        <Tooltip title={t('ssh.file.refresh')}>
          <Button type="text" size="small" icon={<ReloadOutlined />} onClick={() => void refresh(dir)} />
        </Tooltip>
        <Tooltip title={t('ssh.file.newFolder')}>
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
        <Tooltip title={t('ssh.file.uploadFile')}>
          <Button type="text" size="small" icon={<UploadOutlined />} onClick={doUpload} />
        </Tooltip>
        <Tooltip title={t('ssh.file.downloadSelected')}>
          <Button
            type="text"
            size="small"
            icon={<DownloadOutlined />}
            disabled={!selected}
            onClick={() => selected && doDownload(selected)}
          />
        </Tooltip>
        <Tooltip title={t('ssh.file.rename')}>
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
        <Tooltip title={t('ssh.file.permOwner')}>
          <Button
            type="text"
            size="small"
            icon={<SafetyOutlined />}
            disabled={!selected}
            onClick={() => setPermOpen(true)}
          />
        </Tooltip>
        <Popconfirm
          title={t('ssh.file.deleteTitle')}
          okText={t('common.delete')}
          cancelText={t('common.cancel')}
          onConfirm={doDelete}
        >
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
          {loading && entries.length === 0 && <div className="sftp-empty">{t('ssh.file.loading')}</div>}
          {!loading && entries.length === 0 && <div className="sftp-empty">{t('ssh.file.empty')}</div>}
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
                <span className="sftp-mode" title={e.mode ?? t('ssh.file.modeUnavailable')}>
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
        title={t('ssh.file.newFolder')}
        open={mkdirOpen}
        onOk={doMkdir}
        onCancel={() => setMkdirOpen(false)}
        okText={t('ssh.file.create')}
        cancelText={t('common.cancel')}
        width={360}
      >
        <Input
          autoFocus
          placeholder={t('ssh.file.folderName')}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onPressEnter={doMkdir}
        />
      </Modal>
      <Modal
        title={t('ssh.file.renameTitle', { name: selected?.name ?? '' })}
        open={renameOpen}
        onOk={doRename}
        onCancel={() => setRenameOpen(false)}
        okText={t('common.ok')}
        cancelText={t('common.cancel')}
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
