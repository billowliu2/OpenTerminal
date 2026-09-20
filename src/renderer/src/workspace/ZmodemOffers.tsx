import { useCallback, useEffect, useRef, useState } from 'react'
import { App as AntdApp, Button, Modal, Space, Typography } from 'antd'
import type { ZmodemOfferEvent, ZmodemResponse } from '@shared/ipc'
import { t } from '@shared/i18n'

/**
 * M6 ZMODEM offer/done UX: renders one dialog per active zmodem offer.
 *
 *  - mode='send'  : remote ran `rz` -> user picks local files to upload.
 *  - mode='receive': remote ran `sz` -> user picks a local save directory.
 *
 * Binary details never touch the renderer; it only answers offers (paths/dir)
 * and shows completion via App.useApp().message. Progress reuses the shared
 * transfer panel (kind 'zmodem-upload' / 'zmodem-download').
 */
export default function ZmodemOffers(): null | React.JSX.Element {
  const { message } = AntdApp.useApp()
  const [offers, setOffers] = useState<Map<string, ZmodemOfferEvent>>(new Map())
  const busyRef = useRef<Set<string>>(new Set())

  const respond = useCallback((resp: ZmodemResponse) => {
    window.api.zmodemRespond(resp)
    busyRef.current.delete(resp.id)
    setOffers((prev) => {
      const next = new Map(prev)
      next.delete(resp.id)
      return next
    })
  }, [])

  const handleCancel = useCallback(
    (id: string) => respond({ id, cancelled: true }),
    [respond]
  )

  const handlePickFiles = useCallback(
    async (id: string) => {
      if (busyRef.current.has(id)) return
      busyRef.current.add(id)
      try {
        const paths = await window.api.pickFiles()
        if (paths.length > 0) {
          respond({ id, cancelled: false, paths })
        } else {
          busyRef.current.delete(id)
        }
      } catch {
        busyRef.current.delete(id)
      }
    },
    [respond]
  )

  const handlePickDir = useCallback(
    async (id: string) => {
      if (busyRef.current.has(id)) return
      busyRef.current.add(id)
      try {
        const dir = await window.api.pickDirectory()
        if (dir) {
          respond({ id, cancelled: false, dir })
        } else {
          busyRef.current.delete(id)
        }
      } catch {
        busyRef.current.delete(id)
      }
    },
    [respond]
  )

  // queue: more than one offer may arrive before the user answers the first
  useEffect(() => {
    const off = window.api.onZmodemOffer((evt: ZmodemOfferEvent) => {
      setOffers((prev) => {
        const next = new Map(prev)
        next.set(evt.id, evt)
        return next
      })
    })
    return off
  }, [])

  const offDone = useCallback(
    (evt: { id: string; ok: boolean; message?: string }) => {
      if (evt.ok) message.success(t('ssh.zmodem.done'))
      else
        message.error(
          t('ssh.zmodem.failed', { message: evt.message ?? t('ssh.zmodem.unknownError') })
        )
    },
    [message]
  )
  useEffect(() => {
    const off = window.api.onZmodemDone(offDone)
    return off
  }, [offDone])

  const pending = [...offers.values()]
  const first = pending[0]
  if (!first) return null

  const isReceive = first.mode === 'receive'
  return (
    <Modal
      open
      closable={false}
      maskClosable={false}
      keyboard={false}
      title={isReceive ? t('ssh.zmodem.titleReceive') : t('ssh.zmodem.titleSend')}
      footer={
        <Space>
          <Button
            type="primary"
            onClick={() => (isReceive ? void handlePickDir(first.id) : void handlePickFiles(first.id))}
          >
            {isReceive ? t('ssh.zmodem.pickDir') : t('ssh.zmodem.pickFiles')}
          </Button>
          <Button onClick={() => handleCancel(first.id)}>{t('common.cancel')}</Button>
        </Space>
      }
    >
      <Typography.Text>
        {isReceive ? t('ssh.zmodem.receiveDesc') : t('ssh.zmodem.sendDesc')}
      </Typography.Text>
    </Modal>
  )
}