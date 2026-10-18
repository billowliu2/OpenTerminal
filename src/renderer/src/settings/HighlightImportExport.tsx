import { useEffect, useMemo, useState } from 'react'
import { Alert, App, Button, Input, Modal, Popconfirm, Radio, Space } from 'antd'
import { t } from '@shared/i18n'
import { exportHighlightRules, mergeRules, parseHighlightRules } from '@shared/highlightIO'
import type { ImportError } from '@shared/highlightIO'
import type { HighlightRule } from '@shared/settings'
import { useSettingsStore } from './store'

interface ImportResult {
  error?: ImportError
  warnings: string[]
  /** rules that made it in; 0 means nothing was imported */
  count: number
  /** probe verdicts for the imported rules, once the batch came back */
  probe?: ProbeTally
}

interface ProbeTally {
  passed: number
  pending: number
  quarantined: number
  /** at least one batch never came back — its rules are counted as pending */
  failed: boolean
}

/** Rules per validation batch. The IPC handler caps batches at the same
 *  order of magnitude; a bigger import is probed in several rounds so no single
 *  request holds a worker slot for an unbounded list. */
const IMPORT_VALIDATE_CHUNK = 50

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
  const { message } = App.useApp()
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
    setMode('append')
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
    // Chromium reads the blob asynchronously after the click, so revoking the
    // URL synchronously aborts the download before it can start.
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  const handleFile = (file: File): void => {
    const reader = new FileReader()
    reader.onload = () => setDraft(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => message.error(t('settings.highlight.importReadFailed'))
    reader.readAsText(file)
  }

  const errorText = (error: ImportError): string => {
    if (error === 'not-json') return t('settings.highlight.importBadJson')
    if (error === 'wrong-kind') return t('settings.highlight.importWrongKind')
    if (error === 'wrong-version') return t('settings.highlight.importWrongVersion')
    return t('settings.highlight.importEmpty')
  }

  /**
   * Probe the rules that just came in, in chunks, and report the tally.
   *
   * An imported file is not evidence: whatever it carried under `validation` is
   * ignored on parse, and every rule is measured here against this build's
   * corpus. The saved rules also go through the background pass, so this call
   * mostly reports what that pass is doing — the validator dedupes by pattern,
   * so the two never double the work.
   */
  const probeImported = async (rules: HighlightRule[]): Promise<ProbeTally> => {
    const tally: ProbeTally = { passed: 0, pending: 0, quarantined: 0, failed: false }
    const api = window.api
    if (api?.validateRules === undefined) {
      tally.pending = rules.length
      return tally
    }
    for (let start = 0; start < rules.length; start += IMPORT_VALIDATE_CHUNK) {
      const chunk = rules.slice(start, start + IMPORT_VALIDATE_CHUNK)
      try {
        const report = await api.validateRules({
          kind: 'highlight',
          items: chunk.map((rule, index) => ({
            id: `${start + index}`,
            pattern: rule.pattern,
            caseInsensitive: rule.caseInsensitive,
            lineAnchor: rule.lineAnchor
          }))
        })
        for (const outcome of report.results) {
          // A preset needs no proof, so it counts as usable straight away.
          if (outcome.state === 'passed' || outcome.state === 'builtin') tally.passed += 1
          else if (outcome.state === 'quarantined') tally.quarantined += 1
          else tally.pending += 1
        }
      } catch {
        // The rules are already saved; the background pass keeps trying, so a
        // failed batch is reported as "pending" rather than as an import error —
        // but the failure is flagged, because a silent "pending" count looks
        // exactly like a probe that simply has not answered yet.
        tally.pending += chunk.length
        tally.failed = true
      }
    }
    return tally
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
    // read at call time: the render-scoped array goes stale inside a React batch
    const current = useSettingsStore.getState().settings.highlightRules
    await setHighlightRules(mergeRules(current, parsed.rules, mode))
    setResult({ warnings: parsed.warnings, count: parsed.rules.length })
    const probe = await probeImported(parsed.rules)
    setResult((prev) => (prev === null ? prev : { ...prev, probe }))
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
            {mode === 'replace' ? (
              // replace wipes the whole set, so it gets the same guard as deletes
              <Popconfirm
                title={t('settings.highlight.importReplaceTitle')}
                description={t('settings.highlight.importReplaceDesc')}
                okText={t('settings.highlight.importOk')}
                cancelText={t('common.cancel')}
                okButtonProps={{ danger: true }}
                onConfirm={() => void handleImport()}
              >
                <Button size="small" type="primary" disabled={draft.trim() === ''}>
                  {t('settings.highlight.importOk')}
                </Button>
              </Popconfirm>
            ) : (
              <Button
                size="small"
                type="primary"
                disabled={draft.trim() === ''}
                onClick={() => void handleImport()}
              >
                {t('settings.highlight.importOk')}
              </Button>
            )}
          </Space>
          {result && (
            <Alert
              type={
                result.error !== undefined || result.count === 0
                  ? 'error'
                  : result.probe !== undefined && (result.probe.failed || result.probe.quarantined > 0)
                    ? 'warning'
                    : 'success'
              }
              showIcon
              message={
                result.error !== undefined
                  ? errorText(result.error)
                  : result.count === 0
                    ? t('settings.highlight.importEmpty')
                    : t('settings.highlight.imported', { n: result.count })
              }
              description={
                result.probe === undefined && result.warnings.length === 0 ? undefined : (
                  <div>
                    {result.probe !== undefined && (
                      <div>
                        {t('settings.highlight.importValidated', {
                          passed: result.probe.passed,
                          pending: result.probe.pending,
                          quarantined: result.probe.quarantined
                        })}
                      </div>
                    )}
                    {result.probe?.failed === true && (
                      <div>{t('settings.highlight.probeFailed')}</div>
                    )}
                    {result.warnings.length > 0 &&
                      t('settings.highlight.importSkipped', {
                        n: result.warnings.length,
                        list: result.warnings.join('; ')
                      })}
                  </div>
                )
              }
            />
          )}
        </div>
      </div>
    </Modal>
  )
}
