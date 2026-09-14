/**
 * Working-directory tracking helpers.
 *
 * Two signals feed the same store:
 *   1. the shell itself, over OSC 7 (`file://host/path`) or ConEmu's OSC 9;9 —
 *      exact, but only present when shell integration is on;
 *   2. the command the user typed, matched against the `cd` family plus the
 *      bare drive switch (`d:`) of cmd.exe / PowerShell — the fallback that
 *      works with no shell cooperation at all.
 *
 * Both are platform-neutral: path resolution and existence checks happen in the
 * main process (`src/main/cwd.ts`) where node's `path` lives, so nothing here
 * assumes backslashes or drive letters.
 */

/**
 * The `cd` family, per shell:
 *   bash/zsh/dash/fish  cd
 *   cmd.exe             cd, chdir
 *   PowerShell          cd (alias), sl (alias), Set-Location, pushd/Push-Location
 * The `$` anchor is what keeps lookalikes out: `cdrom`, `cdemo` never match.
 */
const CD_COMMAND = /^\s*(?:cd|chdir|sl|set-location|pushd|push-location)(?:\s+([\s\S]*))?$/i

/**
 * Bare drive switch (`d:`, `D:`) — cmd.exe and PowerShell change the current
 * drive with no `cd` keyword at all, and it is the common way to land on
 * another drive on Windows. Treated as a cd to the drive root; the main
 * process's existence check quietly drops it on platforms where drive
 * letters mean nothing (POSIX resolves it to a nonexistent relative path).
 */
const DRIVE_SWITCH = /^\s*([a-zA-Z]):\s*$/

/**
 * Return the argument of a cd-style command line, or null when the line is not
 * one. An empty string means "bare cd" (the shell's home directory). A bare
 * drive switch yields the drive root (`D:\`).
 */
export function cdArgument(line: string): string | null {
  const match = line.match(CD_COMMAND)
  if (match) return (match[1] ?? '').trim()
  const drive = line.match(DRIVE_SWITCH)
  if (drive) return `${drive[1].toUpperCase()}:\\`
  return null
}

/** Payload of an OSC 9 sequence that follows the ConEmu `9;<path>` convention. */
export function conemuCwd(payload: string): string | null {
  if (!payload.startsWith('9;')) return null
  const value = payload.slice(2).trim()
  return value || null
}
