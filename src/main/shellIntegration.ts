import { basename } from 'path'
import { homedir } from 'os'

/**
 * Shell integration: make the shell announce its working directory so the app
 * can remember it exactly, instead of guessing from typed `cd` commands.
 *
 * The channel is the industry standard **OSC 7** (`ESC ] 7 ; file://<host><path>
 * BEL`): bash, zsh, fish, iTerm2, WezTerm, kitty and Windows Terminal all speak
 * it, so the app's parser is written once and works on every platform. Windows
 * shells that historically emit ConEmu's **OSC 9;9** (`ESC ] 9 ; 9 ; <path> BEL`)
 * are handled by the same parser as a second form.
 *
 * Everything platform-specific is confined to an adapter below: adding a shell
 * or a platform means adding one entry here, never touching the renderer, the
 * snapshot format or the restore path.
 *
 * Trade-off: an adapter wraps the user's prompt (that is the only reliable hook
 * a foreign process has), so this whole feature is opt-in via
 * 设置 → 系统 → Shell 集成. With it off the app falls back to parsing typed
 * `cd` commands, which covers the common case with zero interference.
 */

export interface ShellAdapter {
  /** Stable id used by the setting and by logs. */
  id: string
  /** Human label shown in settings. */
  label: string
  /** True when this adapter can drive the given shell executable. */
  matches(shellPath: string, platform: NodeJS.Platform): boolean
  /** Extra argv appended when spawning the shell. */
  args(shellPath: string): string[]
  /** Extra environment variables for the child. */
  env?(): Record<string, string>
}

/** `ESC ] 7 ; file://<host>/<path> BEL` — the portable form. */
function posixPromptCommand(): string {
  return `printf '\\033]7;file://%s%s\\033\\\\' "$HOSTNAME" "$PWD"`
}

/**
 * PowerShell: keep the user's prompt function and re-emit it after our own
 * write, so oh-my-posh / starship / a hand-written prompt all keep working.
 */
const POWERSHELL_ADAPTER: ShellAdapter = {
  id: 'powershell',
  label: 'PowerShell',
  matches: (shellPath) => /(?:^|[\\/])(pwsh|powershell)(\.exe)?$/i.test(shellPath),
  args: () => [
    '-NoLogo',
    '-NoExit',
    '-Command',
    [
      // Save whatever prompt is in effect, then wrap it.
      '$global:__otPrompt = $function:prompt',
      'function global:prompt {',
      '  $p = $PWD.ProviderPath; if (-not $p) { $p = $PWD.Path }',
      '  $esc = [char]27; $bel = [char]7',
      '  Write-Host -NoNewline "$esc]7;file://$env:COMPUTERNAME/$($p -replace \'\\\\\',\'/\')$bel"',
      '  if ($global:__otPrompt) { & $global:__otPrompt } else { "PS $p> " }',
      '}'
    ].join(' ')
  ]
}

/** cmd.exe: `$E` is ESC inside the prompt string, `$P` the current directory. */
const CMD_ADAPTER: ShellAdapter = {
  id: 'cmd',
  label: '命令提示符 (cmd)',
  matches: (shellPath, platform) => platform === 'win32' && /(?:^|[\\/])cmd(\.exe)?$/i.test(shellPath),
  args: () => [
    '/K',
    // Emit OSC 7 (path with backslashes swapped for slashes) then the normal
    // `C:\dir>` prompt.
    'prompt $E]7;file://%COMPUTERNAME%/$P$E\\$P$G'
  ]
}

/**
 * POSIX shells: a one-line prompt hook. bash honours PROMPT_COMMAND directly;
 * zsh/fish hook through the same env var where their startup files cooperate —
 * see `env()` notes. Implementation is kept deliberately small because these
 * need verifying on their own platforms before being enabled by default.
 */
const POSIX_ADAPTER: ShellAdapter = {
  id: 'posix',
  label: 'bash / zsh / fish',
  matches: (shellPath, platform) =>
    platform !== 'win32' && /(?:^|[\\/])(bash|zsh|dash|fish|sh)$/i.test(shellPath),
  args: () => [],
  env: () => ({
    // bash reads this before every prompt. zsh ignores it (no harm); fish uses
    // its own hook, so fish users on this path simply keep the cd-parsing
    // fallback until a dedicated adapter is verified.
    PROMPT_COMMAND: posixPromptCommand()
  })
}

/** Every adapter the app knows about. Order matters: first match wins. */
export const SHELL_ADAPTERS: ShellAdapter[] = [POWERSHELL_ADAPTER, CMD_ADAPTER, POSIX_ADAPTER]

export function pickAdapter(shellPath: string, platform: NodeJS.Platform = process.platform): ShellAdapter | null {
  const name = basename(shellPath)
  return SHELL_ADAPTERS.find((a) => a.matches(name, platform) || a.matches(shellPath, platform)) ?? null
}

/** The default POSIX shell, used when the setting is on and no shell is given. */
export function posixFallbackShell(): string {
  return process.env.SHELL || '/bin/sh'
}

/** Kept for symmetry with the adapters that need a home directory. */
export const integrationHome = (): string => homedir()
