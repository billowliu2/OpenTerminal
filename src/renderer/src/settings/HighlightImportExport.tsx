import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Input, Modal, Radio, Space } from 'antd'
import { t } from '@shared/i18n'
import { exportHighlightRules, mergeRules, parseHighlightRules } from '@shared/highlightIO'
import type { ImportError } from '@shared/highlightIO'
import { useSettingsStore } from './store'

interface ImportResult {
  error?: ImportError
  warnings: string[]
  /** rules that made it in; 0 means nothing was imported */
  count: number
}

/**
 * Import / export of the rule set as JSON. The renderer can do all of this on
 * its own (clipboard, FileReader, a download link), so no main-process dialog or
 * IPC is involved — which also keeps the feature testable outside Electron.
 */
export function HighlightImportExport({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const highlightRules = useSettingsStore((s) => s.settings.highlightRules)
  const setHighlightRules = useSettingsStore((s) => s.setHighlightRules)

  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<'replace' | 'append'>('append')
  const [copied, setCopied] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)

  const exported = useMemo(() => exportHighlightRules(highlightRules), [highlightRules])

  // start clean each time the dialog opens
  useEffect(() => {
    if (!open) return
    setDraft('')
    setResult(null)
    setCopied(false)
  }, [open])

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(exported)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard can be blocked; the textarea stays selectable by hand
    }
  }

  const handleDownload = (): void => {
    const url = URL.createObjectURL(new Blob([exported], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'openterminal-highlight-rules.json'
    link.click()
    URL.revokeObjectURL(url)
  }

  const handleFile = (file: File): void => {
    const reader = new FileReader()
    reader.onload = () => setDraft(typeof reader.result === 'string' ? reader.result : '')
    reader.readAsText(file)
  }

  const errorText = (error: ImportError): string => {
    if (error === 'not-json') return t('settings.highlight.importBadJson')
    if (error === 'wrong-kind') return t('settings.highlight.importWrongKind')
    return t('settings.highlight.importEmpty')
  }

  const handleImport = async (): Promise<void> => {
    const parsed = parseHighlightRules(draft)
    if (parsed.error !== undefined) {
      setResult({ error: parsed.error, warnings: [], count: 0 })
      return
    }
    if (parsed.rules.length === 0) {
      setResult({ warnings: parsed.warnings, count: 0 })
      return
    }
    await setHighlightRules(mergeRules(highlightRules, parsed.rules, mode))
    setResult({ warnings: parsed.warnings, count: parsed.rules.length })
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={640}
      destroyOnHidden
      title={t('settings.highlight.importExportTitle')}
    >
      <div className="hl-io">
        <div className="hl-io-section">
          <div className="hl-io-label">{t('settings.highlight.exportSection')}</div>
          <Input.TextArea
            value={exported}
            readOnly
            autoSize={{ minRows: 3, maxRows: 6 }}
            className="hl-io-json"
          />
          <Space>
            <Button size="small" onClick={() => void handleCopy()}>
              {copied ? t('settings.highlight.copied') : t('settings.highlight.copy')}
            </Button>
            <Button size="small" onClick={handleDownload}>
              {t('settings.highlight.download')}
            </Button>
          </Space>
        </div>

        <div className="hl-io-section">
          <div className="hl-io-label">{t('settings.highlight.importSection')}</div>
          <Input.TextArea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoSize={{ minRows: 3, maxRows: 6 }}
            className="hl-io-json"
          />
          <Space wrap>
            <label className="hl-io-file">
              <input
                type="file"
                accept=".json,application/json"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) handleFile(file)
                  e.target.value = ''
                }}
              />
              <Button size="small">{t('settings.highlight.chooseFile')}</Button>
            </label>
            <span className="hl-editor-sub-label">{t('settings.highlight.importMode')}</span>
            <Radio.Group
              size="small"
              value={mode}
              onChange={(e) => setMode(e.target.value as 'replace' | 'append')}
            >
              <Radio.Button value="append">{t('settings.highlight.importAppend')}</Radio.Button>
              <Radio.Button value="replace">{t('settings.highlight.importReplace')}</Radio.Button>
            </Radio.Group>
            <Button
              size="small"
              type="primary"
              disabled={draft.trim() === ''}
              onClick={() => void handleImport()}
            >
              {t('settings.highlight.importOk')}
            </Button>
          </Space>
          {result && (
            <Alert
              type={result.error !== undefined || result.count === 0 ? 'error' : 'success'}
              showIcon
              message={
                result.error !== undefined
                  ? errorText(result.error)
                  : result.count === 0
                    ? t('settings.highlight.importEmpty')
                    : t('settings.highlight.imported', { n: result.count })
              }
              description={
                result.warnings.length > 0
                  ? t('settings.highlight.importSkipped', {
                      n: result.warnings.length,
                      list: result.warnings.join('; ')
                    })
                  : undefined
              }
            />
          )}
        </div>
      </div>
    </Modal>
  )
}
