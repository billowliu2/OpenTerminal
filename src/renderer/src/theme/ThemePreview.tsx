import type { ThemeColors } from '@shared/theme'

export interface ThemePreviewProps {
  colors: ThemeColors
  compact?: boolean
}

const LINES: ReadonlyArray<readonly [string, keyof ThemeColors]> = [
  ['drwxr-xr-x  12 bill  users   4096 Sep  5 10:02 node_modules', 'brightBlue'],
  ['-rw-r--r--   1 bill  users    890 Sep  5 09:41 package.json', 'brightBlack'],
  ['-rw-r--r--   1 bill  users     42 Sep  5 09:41 index.ts', 'brightBlack'],
  ['OpenTerminal v0.1.0', 'brightCyan']
]

export function ThemePreview({ colors, compact = false }: ThemePreviewProps): React.JSX.Element {
  return (
    <div
      className={compact ? 'theme-preview theme-preview-compact' : 'theme-preview theme-editor-preview-box'}
      style={{ background: colors.background }}
    >
      {(compact ? LINES.slice(0, 3) : LINES).map(([text, colorKey], index) => (
        <div key={index} className="theme-preview-line" style={{ color: colors[colorKey] }}>
          {text}
        </div>
      ))}
    </div>
  )
}
