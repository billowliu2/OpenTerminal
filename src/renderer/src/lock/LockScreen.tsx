import { useEffect, useRef, useState } from 'react'
import { LockOutlined } from '@ant-design/icons'
import { Button, Input } from 'antd'
import type { InputRef } from 'antd'
import { t } from '@shared/i18n'
import type { LockOperationError, LockSettingsState } from '@shared/ipc'
import './lock.css'

/** Message key per failure, so every LockOperationError reads as its own line. */
const ERROR_KEYS: Record<LockOperationError, string> = {
  'invalid-password': 'settings.lock.error.invalidPassword',
  'wrong-password': 'settings.lock.error.wrongPassword',
  cooldown: 'settings.lock.error.cooldown',
  'save-failed': 'settings.lock.error.saveFailed'
}

/**
 * Failure text for a `LockOperationResult.error`. A `cooldown` error is shown
 * with the remaining seconds when main reports them, and with the generic
 * wording otherwise — never as "retry in 0 seconds".
 */
export function lockErrorText(error: LockOperationError, cooldownMs?: number): string {
  if (error === 'cooldown') {
    const seconds = cooldownMs !== undefined && cooldownMs > 0 ? Math.ceil(cooldownMs / 1000) : 0
    return seconds > 0
      ? t('settings.lock.error.cooldown', { n: seconds })
      : t('settings.lock.error.cooldownGeneric')
  }
  return t(ERROR_KEYS[error])
}

export interface LockScreenProps {
  state: LockSettingsState
  /** publish the state main returned, so App drops the overlay once unlocked */
  onStateChange: (state: LockSettingsState) => void
}

/**
 * Lock overlay for the main window.
 *
 * App.tsx renders it as a *sibling* of the app shell rather than inside it: the
 * shell stays mounted (and inert) underneath, so PTY/SSH sessions keep running
 * and the workspace is not torn down by a lock. The layer is opaque, so no
 * terminal output is visible through it.
 *
 * Deliberately minimal — no session content, no bypass button, and the password
 * never leaves this component: it is cleared after every attempt and is not
 * logged anywhere.
 */
export function LockScreen({ state, onStateChange }: LockScreenProps): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<LockOperationError | null>(null)
  /** local deadline, so the countdown keeps ticking between main's broadcasts */
  const [cooldownUntil, setCooldownUntil] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const inputRef = useRef<InputRef>(null)

  const cooldownMs = state.cooldownMs ?? 0
  useEffect(() => {
    setCooldownUntil(cooldownMs > 0 ? Date.now() + cooldownMs : 0)
    setNow(Date.now())
  }, [cooldownMs])

  useEffect(() => {
    if (cooldownUntil <= 0) return
    const id = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [cooldownUntil])

  const remainingMs = Math.max(0, cooldownUntil - now)
  const cooling = remainingMs > 0

  // Focus follows usability: on mount and again when a cooldown runs out, so
  // the lock can be answered by typing without reaching for the mouse.
  useEffect(() => {
    if (!cooling) inputRef.current?.focus()
  }, [cooling])

  const submit = async (): Promise<void> => {
    if (busy || cooling || password.length === 0) return
    const attempt = password
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.unlockLock({ password: attempt })
      setPassword('')
      onStateChange(result.state)
      if (!result.ok) setError(result.error ?? 'wrong-password')
    } catch (err) {
      console.error('[lock] unlock request failed', err)
      setError('save-failed')
    } finally {
      setBusy(false)
    }
  }

  const message = cooling
    ? lockErrorText('cooldown', remainingMs)
    : error
      ? lockErrorText(error, cooldownMs)
      : ''

  return (
    <div
      className="lock-screen"
      role="dialog"
      aria-modal="true"
      aria-label={t('settings.lock.title')}
      // Modal focus trap: antd popovers/modals render outside the inert app
      // root, so Tab must not be allowed to walk into content hidden behind
      // this opaque overlay.
      onKeyDown={(e) => {
        if (e.key === 'Tab') {
          e.preventDefault()
          inputRef.current?.focus()
        }
      }}
    >
      <form
        className="lock-screen-panel"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <LockOutlined className="lock-screen-icon" />
        <div className="lock-screen-title">{t('settings.lock.title')}</div>
        <div className="lock-screen-desc">{t('settings.lock.screenDesc')}</div>
        <Input.Password
          ref={inputRef}
          className="lock-screen-input"
          size="large"
          value={password}
          disabled={cooling}
          visibilityToggle={false}
          autoComplete="off"
          spellCheck={false}
          placeholder={t('settings.lock.passwordPlaceholder')}
          onChange={(e) => {
            setPassword(e.target.value)
            if (error) setError(null)
          }}
        />
        <Button
          className="lock-screen-button"
          type="primary"
          size="large"
          htmlType="submit"
          loading={busy}
          disabled={cooling || password.length === 0}
        >
          {busy ? t('settings.lock.unlocking') : t('settings.lock.unlock')}
        </Button>
        <div className="lock-screen-message" role="status">
          {message}
        </div>
        <div className="lock-screen-hint">{t('settings.lock.screenForgot')}</div>
      </form>
    </div>
  )
}
