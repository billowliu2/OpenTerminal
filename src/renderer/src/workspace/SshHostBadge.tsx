import { tFor, type Language } from '@shared/i18n'

/**
 * Small capsule badge showing the SSH host label (e.g. `root@36.151.147.123`)
 * on an SSH terminal tab. Host labels are often long, so the display string is
 * truncated with an ellipsis rather than wrapped; the full label is always
 * available via the native `title` tooltip and the tab-level tooltip.
 *
 * `language` comes from the tab component instead of a subscription of its own:
 * the badge lives in dockview's tab render slot, so it follows TerminalTab's
 * re-renders — but `t()` would then read the module-level language, which is
 * only as fresh as the last App render.
 */
export function SshHostBadge({ label, language }: { label: string; language: Language }): React.JSX.Element {
  return (
    <span
      className="ssh-host-badge"
      title={label}
      aria-label={tFor(language, 'ssh.hostBadge.aria', { label })}
    >
      {label}
    </span>
  )
}