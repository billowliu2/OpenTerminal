import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { t } from '@shared/i18n'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * Last-resort boundary: a render/effect crash must never take the whole app
 * down to a black window. Shows the error and a reload escape instead.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          style={{
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            color: '#cccccc'
          }}
        >
          <div>{t('workspace.error.title')}</div>
          <pre
            style={{
              maxWidth: 720,
              maxHeight: 240,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              color: '#ff6b6b',
              fontSize: 12
            }}
          >
            {this.state.error.message}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{ padding: '6px 18px', cursor: 'pointer' }}
          >
            {t('workspace.error.reload')}
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
