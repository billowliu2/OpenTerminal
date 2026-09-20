import { useEffect, useState } from 'react'
import { Button, Progress, Select, Switch, Tag } from 'antd'
import { DEFAULT_LANGUAGE, t, type Language } from '@shared/i18n'
import type { AppInfo, ReleaseNote, UpdateState, UpdateStatus } from '@shared/ipc'
import { useSettingsStore } from './store'
import appIconUrl from '../../../../build/icon.png'
import changelogZhCN from '../../../../CHANGELOG.md?raw'
import changelogZhTW from '../../../../CHANGELOG.zh-TW.md?raw'
import changelogEn from '../../../../CHANGELOG.en.md?raw'
import changelogJa from '../../../../CHANGELOG.ja.md?raw'

/** Bundled changelog per language; zh-CN is the canonical source. */
const CHANGELOGS: Record<Language, string> = {
  'zh-CN': changelogZhCN,
  'zh-TW': changelogZhTW,
  en: changelogEn,
  ja: changelogJa
}

const STATUS_TEXT: Record<UpdateStatus, string> = {
  idle: 'settings.about.statusIdle',
  checking: 'settings.about.statusChecking',
  available: 'settings.about.statusAvailable',
  latest: 'settings.about.statusLatest',
  downloading: 'settings.about.statusDownloading',
  downloaded: 'settings.about.statusDownloaded',
  error: 'settings.about.statusError',
  dev: 'settings.about.statusDev'
}

/** Parse a bundled changelog into release notes, keyed by version. Sections
 *  look like `## v1.0.12 - 2026-09-20`; the body below is kept verbatim. */
function parseChangelog(md: string): Map<string, ReleaseNote> {
  const notes = new Map<string, ReleaseNote>()
  for (const section of md.split(/^## /m).slice(1)) {
    const lineEnd = section.indexOf('\n')
    if (lineEnd < 0) continue
    const head = section.slice(0, lineEnd).trim()
    const m = /^(v[\d.]+)\s*-\s*(\d{4}-\d{2}-\d{2})/.exec(head)
    const body = section.slice(lineEnd + 1).trim()
    if (m && body) notes.set(m[1], { version: m[1], date: m[2], body })
  }
  return notes
}

/** Notes for `language`, newest first, falling back to zh-CN per version so a
 *  missing translation shows the canonical text instead of a gap. */
function notesFor(language: Language): ReleaseNote[] {
  const primary = parseChangelog(CHANGELOGS[language])
  const fallback = language === DEFAULT_LANGUAGE ? primary : parseChangelog(CHANGELOGS[DEFAULT_LANGUAGE])
  const versions = new Set([...primary.keys(), ...fallback.keys()])
  return [...versions]
    .map((v) => primary.get(v) ?? fallback.get(v))
    .filter((n): n is ReleaseNote => n !== undefined)
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
}

/** 关于页：版本信息 + 更新检查/下载/安装 + 更新日志（内置多语言 CHANGELOG 优先，网络兜底）。 */
export function AboutTab(): React.JSX.Element {
  const [version, setVersion] = useState('')
  const [state, setState] = useState<UpdateState | null>(null)
  const [notes, setNotes] = useState<ReleaseNote[]>([])
  const updateSystem = useSettingsStore((s) => s.updateSystem)
  const autoCheck = useSettingsStore((s) => s.settings.system.autoCheckUpdate !== false)
  const language = useSettingsStore((s) => s.settings.system.language ?? DEFAULT_LANGUAGE)

  useEffect(() => {
    // Embedded changelog first (works offline, follows the UI language);
    // network sources as fallback.
    const local = notesFor(language)
    if (local.length > 0) setNotes(local)
    else void window.api.updateChangelog().then(setNotes).catch(() => undefined)
  }, [language])

  useEffect(() => {
    void window.api.appInfo().then((i: AppInfo) => setVersion(i.appVersion))
    // Pull the updater's current state (no network check); the check itself
    // stays behind the manual button and the auto-check-on-launch setting.
    void window.api
      .getUpdateState()
      .then(setState)
      .catch(() => undefined)
    return window.api.onUpdateState(setState)
  }, [])

  const status = state?.status ?? 'idle'
  const statusText = t(STATUS_TEXT[status]) + (state?.version ? ` v${state.version}` : '')

  return (
    <div className="about-tab">
      <div className="about-header">
        <img className="about-logo" src={appIconUrl} alt="OpenTerminal" draggable={false} />
        <div>
          <div className="about-name">OpenTerminal</div>
          <div className="about-version">
            {t('settings.about.currentVersion')}: {version || '…'}{' '}
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
          options={[{ value: 'stable', label: t('settings.about.channelStable') }]}
          style={{ width: 150 }}
        />
        <label className="about-autocheck">
          <Switch
            size="small"
            checked={autoCheck}
            onChange={(checked) => void updateSystem({ autoCheckUpdate: checked })}
          />
          {t('settings.about.autoCheck')}
        </label>
        {status === 'available' && (
          <Button type="primary" onClick={() => void window.api.updateDownload()}>
            {t('settings.about.download')}
            {state?.feed === 'github' ? t('settings.about.downloadGithub') : ''}
          </Button>
        )}
        {status === 'downloaded' && (
          <Button type="primary" onClick={() => void window.api.updateInstall()}>
            {t('settings.about.install')}
          </Button>
        )}
        {(status === 'idle' || status === 'latest' || status === 'error') && (
          <Button type="primary" onClick={() => void window.api.updateCheck()}>
            {t('settings.about.check')}
          </Button>
        )}
        {status === 'checking' && (
          <Button type="primary" loading disabled>
            {t('settings.about.checkingButton')}
          </Button>
        )}
      </div>

      {status === 'downloading' && (
        <Progress percent={state?.percent ?? 0} size="small" status="active" />
      )}

      <div className="about-changelog">
        <div className="about-changelog-title">{t('settings.about.changelog')}</div>
        {notes.length === 0 && (
          <div className="about-changelog-empty">{t('settings.about.changelogEmpty')}</div>
        )}
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
