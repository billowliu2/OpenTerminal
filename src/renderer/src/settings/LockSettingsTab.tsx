import { useEffect, useState } from 'react'
import { Button, Input, Popconfirm, Select, Switch, Tag } from 'antd'
import { t } from '@shared/i18n'
import type { LockOperationResult, LockSettingsState } from '@shared/ipc'
import { LOCK_AUTO_DELAYS, type LockAutoDelay } from '@shared/settings'
import { lockErrorText } from '@renderer/lock/LockScreen'
import { SettingRow } from './fields'
import { useSettingsStore } from './store'

type Feedback = { kind: 'ok' | 'error'; text: string } | null

/**
 * 锁屏设置页。
 *
 * Two sources, on purpose: the switches live in `settings.lock` (persisted
 * through the settings store, so they follow the normal save/rollback path),
 * while "is a password configured / is the screen locked right now" comes from
 * main (`lock.json` holds the verifier, never settings). The password fields
 * are write-only: they are sent once and cleared, main never echoes them back.
 */
export function LockSettingsTab(): React.JSX.Element {
  const lock = useSettingsStore((s) => s.settings.lock)
  const updateLock = useSettingsStore((s) => s.updateLock)
  const [lockState, setLockState] = useState<LockSettingsState | null>(null)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>(null)

  useEffect(() => {
    let alive = true
    void window.api.getLockState().then(
      (state: LockSettingsState) => {
        if (alive) setLockState(state)
      },
      (err: unknown) => console.error('[lock] getLockState failed', err)
    )
    // Keeps `configured` honest when the lock engages or main clears the
    // verifier (e.g. an unlock attempt failed and a cooldown started).
    const off = window.api.onLockStateChanged((state: LockSettingsState) => setLockState(state))
    return () => {
      alive = false
      off()
    }
  }, [])

  const configured = lockState?.configured === true
  const usable = configured && lock.enabled

  const clearFields = (): void => {
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
  }

  /** Run a lock operation and fold its result into the local state + feedback. */
  const run = async (op: () => Promise<LockOperationResult>, okText: string): Promise<void> => {
    setBusy(true)
    setFeedback(null)
    try {
      const result = await op()
      setLockState(result.state)
      if (result.ok) {
        clearFields()
        setFeedback({ kind: 'ok', text: okText })
      } else {
        setFeedback({
          kind: 'error',
          text: lockErrorText(result.error ?? 'save-failed', result.state.cooldownMs)
        })
      }
    } catch (err) {
      console.error('[lock] operation failed', err)
      setFeedback({ kind: 'error', text: lockErrorText('save-failed') })
    } finally {
      setBusy(false)
    }
  }

  const savePassword = (): void => {
    if (newPassword.length === 0) {
      setFeedback({ kind: 'error', text: t('settings.lock.password.empty') })
      return
    }
    if (newPassword !== confirmPassword) {
      setFeedback({ kind: 'error', text: t('settings.lock.password.mismatch') })
      return
    }
    void run(
      () =>
        window.api.setLockPassword(configured ? { currentPassword, newPassword } : { newPassword }),
      t('settings.lock.password.saved')
    )
  }

  const clearPassword = (): void => {
    if (currentPassword.length === 0) {
      setFeedback({ kind: 'error', text: t('settings.lock.password.empty') })
      return
    }
    void run(
      () => window.api.clearLockPassword({ currentPassword }),
      t('settings.lock.password.cleared')
    )
  }

  /** lockNow answers with the state directly, not with an operation result. */
  const lockNow = async (): Promise<void> => {
    setBusy(true)
    setFeedback(null)
    try {
      setLockState(await window.api.lockNow())
    } catch (err) {
      console.error('[lock] lockNow failed', err)
      setFeedback({ kind: 'error', text: lockErrorText('save-failed') })
    } finally {
      setBusy(false)
    }
  }

  const autoLockOptions = LOCK_AUTO_DELAYS.map((minutes: LockAutoDelay) => ({
    value: minutes,
    label:
      minutes === 0
        ? t('settings.lock.autoLockOff')
        : t('settings.lock.autoLockMinutes', { n: minutes })
  }))

  return (
    <div className="settings-pane">
      <div className="settings-block-label">
        {t('settings.lock.password.title')}
        <span className="settings-block-hint">{t('settings.lock.password.desc')}</span>
        <Tag color={configured ? 'green' : 'default'}>
          {configured
            ? t('settings.lock.password.configured')
            : t('settings.lock.password.notConfigured')}
        </Tag>
      </div>

      {configured && (
        <SettingRow
          label={t('settings.lock.password.current')}
          control={
            <Input.Password
              className="settings-lock-input"
              value={currentPassword}
              autoComplete="off"
              spellCheck={false}
              placeholder={t('settings.lock.password.currentPlaceholder')}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          }
        />
      )}
      <SettingRow
        label={t('settings.lock.password.new')}
        control={
          <Input.Password
            className="settings-lock-input"
            value={newPassword}
            autoComplete="off"
            spellCheck={false}
            placeholder={t('settings.lock.password.newPlaceholder')}
            onChange={(e) => setNewPassword(e.target.value)}
          />
        }
      />
      <SettingRow
        label={t('settings.lock.password.confirm')}
        control={
          <Input.Password
            className="settings-lock-input"
            value={confirmPassword}
            autoComplete="off"
            spellCheck={false}
            placeholder={t('settings.lock.password.confirmPlaceholder')}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
        }
      />
      <div className="settings-lock-actions">
        <Button
          type="primary"
          loading={busy}
          disabled={newPassword.length === 0 || confirmPassword.length === 0}
          onClick={savePassword}
        >
          {configured ? t('settings.lock.password.change') : t('settings.lock.password.set')}
        </Button>
        {configured && (
          <Popconfirm
            title={t('settings.lock.password.clearTitle')}
            description={t('settings.lock.password.clearDesc')}
            okText={t('settings.lock.password.clear')}
            cancelText={t('common.cancel')}
            okButtonProps={{ danger: true }}
            onConfirm={clearPassword}
          >
            <Button danger disabled={busy}>
              {t('settings.lock.password.clear')}
            </Button>
          </Popconfirm>
        )}
      </div>
      <div
        className={'settings-lock-feedback' + (feedback?.kind === 'error' ? ' is-error' : ' is-ok')}
        role="status"
      >
        {feedback?.text ?? ''}
      </div>
      <div className="settings-lock-note">{t('settings.lock.password.forgot')}</div>

      <SettingRow
        label={t('settings.lock.enabled')}
        desc={configured ? t('settings.lock.enabledDesc') : t('settings.lock.needPassword')}
        control={
          <Switch
            checked={lock.enabled}
            disabled={!configured}
            onChange={(checked) => void updateLock({ enabled: checked })}
          />
        }
      />
      <SettingRow
        label={t('settings.lock.autoLock')}
        desc={t('settings.lock.autoLockDesc')}
        control={
          <Select
            className="settings-select"
            value={lock.autoLockMinutes}
            disabled={!usable}
            onChange={(value) => void updateLock({ autoLockMinutes: value })}
            options={autoLockOptions}
          />
        }
      />
      <SettingRow
        label={t('settings.lock.lockAtStartup')}
        desc={t('settings.lock.lockAtStartupDesc')}
        control={
          <Switch
            checked={lock.lockAtStartup}
            disabled={!usable}
            onChange={(checked) => void updateLock({ lockAtStartup: checked })}
          />
        }
      />
      <SettingRow
        label={t('settings.lock.lockNow')}
        desc={t('settings.lock.lockNowDesc')}
        control={
          <Button disabled={!configured || busy} onClick={() => void lockNow()}>
            {t('settings.lock.lockNow')}
          </Button>
        }
      />
    </div>
  )
}
