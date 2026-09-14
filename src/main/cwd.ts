import { statSync } from 'fs'
import { homedir, hostname } from 'os'
import { isAbsolute, resolve as resolvePath, normalize } from 'path'

/**
 * Resolve a cd-style argument against a known working directory.
 *
 * Lives in the main process because this is the only side with node's `path`,
 * and it must stay platform-aware for the cross-platform roadmap: `path.resolve`
 * already does the right thing for `C:\a`, `/home/a`, `..`, `.` and mixed
 * separators on the host platform, so the core carries no drive-letter or
 * backslash assumptions of its own.
 *
 * Returns the resolved, existing directory, or null when the argument does not
 * denote one (in which case callers keep the previous cwd).
 */

/** Flags that a shell may put in front of the path (`cd /d X`, `sl -Path X`). */
const LEADING_FLAGS = /^(?:\/d|-d|-p|-path|-literalpath)\s+/i

/** Everything from a command separator on is a different command. */
const SEPARATOR = /\s*(?:&&|\|\||[;|])\s*/

export function resolveCwd(current: string | undefined, rawArg: string): string | null {
  let arg = rawArg.trim()
  // `cd X && something` — only the cd part is ours.
  arg = arg.split(SEPARATOR)[0]?.trim() ?? ''
  // Repeatedly strip shell flags (`cd /d "D:\x"`, `sl -Path .`).
  while (LEADING_FLAGS.test(arg)) arg = arg.replace(LEADING_FLAGS, '').trim()
  // Strip one layer of matching quotes ("D:\Program Files" / '~/src').
  const quoted = arg.match(/^(["'])(.*)\1$/)
  if (quoted) arg = quoted[2]

  // Bare `cd`, `cd ~`, `cd $HOME` → home directory.
  if (arg === '' || arg === '~' || arg === '$HOME' || arg === '%USERPROFILE%') {
    return existingDir(homedir())
  }
  // `cd -` means the shell's previous directory, which we cannot know here.
  if (arg === '-') return null

  const base = current && current.trim() ? current : homedir()
  // An absolute argument wins; otherwise resolve against the base. Both forms
  // are handled by path.resolve on every platform.
  const target = isAbsolute(arg) ? normalize(arg) : resolvePath(base, arg)
  return existingDir(target)
}

function existingDir(candidate: string): string | null {
  try {
    return statSync(candidate).isDirectory() ? candidate : null
  } catch {
    return null
  }
}

/**
 * Normalize a cwd reported by the shell itself.
 *
 * Both portable forms land here:
 *   - OSC 7:  `file://<host>/<path>` (bash/zsh/fish, iTerm2, WezTerm, kitty…)
 *   - OSC 9;9: a bare path (ConEmu convention, Windows shells)
 *
 * A report from a remote host is ignored (an ssh/container shell is not our
 * filesystem). On Windows the POSIX-ish `/C:/dir` form is folded back to
 * `C:\dir`; path.resolve does the rest per platform.
 */
export function normalizeReportedCwd(raw: string): string | null {
  let value = raw.trim()
  if (!value) return null

  const fileUrl = value.match(/^file:\/\/([^/]*)(\/.*)$/i)
  if (fileUrl) {
    const host = fileUrl[1]
    if (host && !isLocalHost(host)) return null
    value = safeDecode(fileUrl[2])
    // `/C:/Users/x` → `C:/Users/x` (Windows shells report the URL this way).
    const drive = value.match(/^\/([A-Za-z]:)(\/.*)?$/)
    if (drive && process.platform === 'win32') value = `${drive[1]}${drive[2] ?? '\\'}`
  }

  // A Windows drive path reported with forward slashes still resolves fine.
  return existingDir(resolvePath(value)) ?? existingDir(value)
}

function isLocalHost(host: string): boolean {
  const lower = host.toLowerCase()
  return lower === 'localhost' || lower === '127.0.0.1' || lower === '::1' || lower === osHostname()
}

function osHostname(): string {
  try {
    return hostname().toLowerCase()
  } catch {
    return ''
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
