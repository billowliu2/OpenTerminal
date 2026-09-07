/**
 * Small capsule badge showing the SSH host label (e.g. `root@36.151.147.123`)
 * on an SSH terminal tab. Host labels are often long, so the display string is
 * truncated with an ellipsis rather than wrapped; the full label is always
 * available via the native `title` tooltip and the tab-level tooltip.
 */
export function SshHostBadge({ label }: { label: string }): React.JSX.Element {
  return (
    <span
      className="ssh-host-badge"
      title={label}
      aria-label={`SSH 主机 ${label}`}
    >
      {label}
    </span>
  )
}