import { useEffect, useState } from 'react'
import { Button, Progress, Select, Switch, Tag } from 'antd'
import type { AppInfo, ReleaseNote, UpdateState, UpdateStatus } from '@shared/ipc'
import { useSettingsStore } from './store'

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

/** 关于页：版本信息 + 更新检查/下载/安装 + 更新日志（国内源优先，GitHub 兜底）。 */
export function AboutTab(): React.JSX.Element {
  const [version, setVersion] = useState('')
  const [state, setState] = useState<UpdateState | null>(null)
  const [notes, setNotes] = useState<ReleaseNote[]>([])
  const updateSystem = useSettingsStore((s) => s.updateSystem)
  const autoCheck = useSettingsStore((s) => s.settings.system.autoCheckUpdate !== false)

  useEffect(() => {
    void window.api.appInfo().then((i: AppInfo) => setVersion(i.appVersion))
    void window.api.updateChangelog().then(setNotes).catch(() => undefined)
    return window.api.onUpdateState(setState)
  }, [])

  const status = state?.status ?? 'idle'
  const statusText = STATUS_TEXT[status] + (state?.version ? ` v${state.version}` : '')

  return (
    <div className="about-tab">
      <div className="about-header">
        <div className="about-logo">OT</div>
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
          <Button type="primary" onClick={() => window.api.updateInstall()}>
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
