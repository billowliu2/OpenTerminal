import { useEffect, useState } from 'react'
import { Button, Progress, Select, Switch, Tag } from 'antd'
import type { AppInfo, ReleaseNote, UpdateState, UpdateStatus } from '@shared/ipc'
import { useSettingsStore } from './store'
import appIconUrl from '../../../../build/icon.png'
import changelogMd from '../../../../CHANGELOG.md?raw'

const STATUS_TEXT: Record<UpdateStatus, string> = {
  idle: '点击检查更新',
  checking: '正在检查更新…',
  available: '发现新版本',
  latest: '已经是最新版本',
  downloading: '正在下载…',
  downloaded: '下载完成，可重启安装',
  error: '检查失败',
  dev: '开发模式不支持更新检查'
}

/** Parse the bundled CHANGELOG.md into release notes. Sections look like
 *  `## v1.0.12 - 2026-09-20`; the body below the heading is kept verbatim. */
function parseChangelog(md: string): ReleaseNote[] {
  const notes: ReleaseNote[] = []
  for (const section of md.split(/^## /m).slice(1)) {
    const lineEnd = section.indexOf('\n')
    if (lineEnd < 0) continue
    const head = section.slice(0, lineEnd).trim()
    const m = /^(v[\d.]+)\s*-\s*(\d{4}-\d{2}-\d{2})/.exec(head)
    const body = section.slice(lineEnd + 1).trim()
    if (m && body) notes.push({ version: m[1], date: m[2], body })
  }
  return notes
}

/** 关于页：版本信息 + 更新检查/下载/安装 + 更新日志（内置 CHANGELOG 优先，网络兜底）。 */
export function AboutTab(): React.JSX.Element {
  const [version, setVersion] = useState('')
  const [state, setState] = useState<UpdateState | null>(null)
  const [notes, setNotes] = useState<ReleaseNote[]>([])
  const updateSystem = useSettingsStore((s) => s.updateSystem)
  const autoCheck = useSettingsStore((s) => s.settings.system.autoCheckUpdate !== false)

  useEffect(() => {
    void window.api.appInfo().then((i: AppInfo) => setVersion(i.appVersion))
    // Embedded changelog first (works offline); network sources as fallback.
    const local = parseChangelog(changelogMd)
    if (local.length > 0) setNotes(local)
    else void window.api.updateChangelog().then(setNotes).catch(() => undefined)
    return window.api.onUpdateState(setState)
  }, [])

  const status = state?.status ?? 'idle'
  const statusText = STATUS_TEXT[status] + (state?.version ? ` v${state.version}` : '')

  return (
    <div className="about-tab">
      <div className="about-header">
        <img className="about-logo" src={appIconUrl} alt="OpenTerminal" draggable={false} />
        <div>
          <div className="about-name">OpenTerminal</div>
          <div className="about-version">
            当前版本: {version || '…'}{' '}
            <span className={'about-status' + (status === 'available' ? ' is-new' : '')}>
              {statusText}
            </span>
            {state?.error && <div className="about-error">{state.error}</div>}
          </div>
        </div>
      </div>

      <div className="about-controls">
        <Select
          value="stable"
          options={[{ value: 'stable', label: '稳定更新通道' }]}
          style={{ width: 150 }}
        />
        <label className="about-autocheck">
          <Switch
            size="small"
            checked={autoCheck}
            onChange={(checked) => void updateSystem({ autoCheckUpdate: checked })}
          />
          启动时自动检查
        </label>
        {status === 'available' && (
          <Button type="primary" onClick={() => void window.api.updateDownload()}>
            下载更新{state?.feed === 'github' ? '（GitHub 源）' : ''}
          </Button>
        )}
        {status === 'downloaded' && (
          <Button type="primary" onClick={() => void window.api.updateInstall()}>
            重启安装
          </Button>
        )}
        {(status === 'idle' || status === 'latest' || status === 'error') && (
          <Button type="primary" onClick={() => void window.api.updateCheck()}>
            检查更新
          </Button>
        )}
        {status === 'checking' && (
          <Button type="primary" loading disabled>
            检查中
          </Button>
        )}
      </div>

      {status === 'downloading' && (
        <Progress percent={state?.percent ?? 0} size="small" status="active" />
      )}

      <div className="about-changelog">
        <div className="about-changelog-title">更新日志</div>
        {notes.length === 0 && <div className="about-changelog-empty">暂无更新日志</div>}
        {notes.map((n) => (
          <div key={n.version} className="about-release">
            <div className="about-release-head">
              <Tag color="green">{n.version}</Tag>
              <span className="about-release-date">{n.date}</span>
            </div>
            <div className="about-release-body">{n.body}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
