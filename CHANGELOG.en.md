# OpenTerminal Changelog

## v1.0.24 - 2026-10-09

## v1.0.23

### SFTP file management
- **The list is now a real table**: Name / Size / Modified / Permissions / Owner / Group are aligned in six columns, with a sticky header that stays visible while scrolling long listings.
- **Click-to-sort headers**: all six columns sort, with arrow indicators for ascending/descending; directories always come before files.
- **Adjustable font size**: use the A- / A+ toolbar buttons or Ctrl+mouse wheel to scale between 0.8x and 1.8x. Row height follows the font size, and the setting is remembered locally, so it survives reopening the panel.
- **Real owner / group names**: previously only numeric UID / GID were shown; the client now parses the real names (`eveuser`, `root`, ...) out of the data returned by the SSH server.
- **Context menu on empty space**: right-click anywhere in the blank area of the list to get New Folder, Upload, Refresh and friends without having to select a row first.
- The modified column now reads `2026/10/08 15:23`, and sizes read `30.7 KB`.

### Fixes
- Fixed the file panel's six columns not actually aligning to the grid (the sort icon's style class was being cloned onto the row element, overriding the row's grid layout).

## v1.0.23 - 2026-10-09

### SFTP file management
- **The list is now a real table**: Name / Size / Modified / Permissions / Owner / Group are aligned in six columns, with a sticky header that stays visible while scrolling long listings.
- **Click-to-sort headers**: all six columns sort, with arrow indicators for ascending/descending; directories always come before files.
- **Adjustable font size**: use the A- / A+ toolbar buttons or Ctrl+mouse wheel to scale between 0.8x and 1.8x. Row height follows the font size, and the setting is remembered locally, so it survives reopening the panel.
- **Real owner / group names**: previously only numeric UID / GID were shown; the client now parses the real names (`eveuser`, `root`, ...) out of the data returned by the SSH server.
- **Context menu on empty space**: right-click anywhere in the blank area of the list to get New Folder, Upload, Refresh and friends without having to select a row first.
- The modified column now reads `2026/10/08 15:23`, and sizes read `30.7 KB`.

### Fixes
- Fixed the file panel's six columns not actually aligning to the grid (the sort icon's style class was being cloned onto the row element, overriding the row's grid layout).

## v1.0.22 - 2026-10-08

### IME
- **Fixed: Chinese IME candidate window not following the caret** (regression in v1.0.21): the v1.0.21 build environment had a terminal component dependency that did not match the locked version, so the installer shipped an older build without the upstream IME fix; this release restores the terminal component version used by v1.0.20, and the candidate window follows the caret again.

### Installer
- The MSI installer is discontinued (electron-updater never supported MSI auto-updates); the NSIS exe is now the only installer format.

### Internal
- The packaging pipeline now verifies dependency consistency before building: installed dependencies are compared against the lockfile and the build aborts on any mismatch, preventing this class of issue from recurring.

## v1.0.21 - 2026-10-07

### Background image experience
- **No more wash-out on light themes**: with a background image set, lowering the opacity now dims the image on every theme (on light themes it used to fade the image to white, making text unreadable).
- **Automatic text brightening**: in image mode the terminal enforces WCAG AA-level contrast, so dark foreground text from light themes stays readable over wallpapers.
- **New "Background dim" slider** (Settings → Theme): overlays an independent dim layer on the image, darkening it while preserving saturation. 30–50% works well for bright images.
- Default background image opacity changed from 60% to 30%.

### Performance
- Settings writes no longer make every terminal pane rewrite its options and refit (field-level subscriptions — only affected panes react).
- SFTP file list virtualization: directories with tens of thousands of entries (e.g. node_modules) no longer freeze the window.
- A crashing pane no longer takes down the whole workspace: per-panel error boundary with a retry button.
- Smoother SSH bottom-panel dragging; noticeably cheaper rendering for the transfer panel and monitor charts.

### Installer size
- Installer slimmed by about **90MB** (bundled dependencies 98MB → 8.1MB): UI-only packages are no longer shipped twice.

### Security hardening
- Local paths for SFTP upload/download and ZMODEM transfers are only accepted when picked through a native dialog, blocking crafted read/write paths.
- SSH private key files are validated (must be a regular file ≤ 1MB).
- Window security options pinned explicitly (contextIsolation / nodeIntegration / webSecurity) instead of relying on defaults.

### Stability fixes
- ZMODEM: write errors now terminate the transfer correctly, progress events are throttled, terminal events are emitted on session detach.
- Corrupted connections/commands config files are backed up before rebuilding instead of silently losing settings.
- Failed layout-template applies restore the previous layout; portals mounted while locked are properly inerted.
- The release channel refuses downgrades and verifies assets by sha512.
- SFTP operations have per-op timeouts with one automatic retry on half-dead channels.
- Multiple hardening fixes in the startup chain and host-key verification.

### Misc
- Auto-numbered terminal tab titles ("Terminal 3") now follow the UI language.
- The lock shortcut Ctrl+L uses physical key codes, so Dvorak and other non-QWERTY layouts trigger it correctly.
- Removed the dead "update channel" dropdown from Settings.

## v1.0.20 - 2026-10-01

### Input Method Fixes
- **Fixed the Chinese IME candidate window not following the cursor**: typing Chinese in the terminal (especially in fast-repainting TUI apps such as Kimi Code or Claude Code) previously made the candidate window drift far away from the caret; it now appears right next to it. The bundled terminal component was upgraded to a version containing the upstream IME fixes.

### Lock Screen Hardening
- **The application menu is removed while locked**: the Alt-revealed menu exposes Reload / DevTools / Zoom items that mouse clicks could use to bypass keyboard interception, so the whole menu is detached during lock and rebuilt on unlock.
- The Ctrl+L instant-lock key classification was extracted into a dedicated module with 29 table-driven test cases to prevent regressions.
- The global show/hide shortcut recorder now reserves Ctrl+L, so a global registration can no longer silently disable the panic lock at the OS level.
- Fixed: after system suspend or window focus loss, the lock screen cooldown countdown could outlive its real deadline, keeping the password input disabled for longer than necessary.

## v1.0.19 - 2026-09-28

### Update mechanism change
- **GitHub is now the primary update source**: update checks go to GitHub releases first (following the system proxy), gated by a 20-second connectivity probe — without a proxy, or when GitHub is unreachable, the app does not hang but falls back to the domestic update channel (forced direct connection).
- **GitHub releases carry the installer assets again** (exe + blockmap + latest.yml), in step with the domestic channel.

### Terminal highlighting: performance and compatibility
- **Faster engine**: colour sequences are precomputed at compile time (no per-span hex parsing); span claiming moved from a linear scan to sorted insertion (binary search); escape-free text floods (e.g. cat of a large file) skip redundant rescans. Measured on 200KB payloads: ~19–56% faster on match-dense output, ~54% faster on plain streamed text, with output byte-identical to the previous version.
- **Broader escape-sequence coverage**: DCS/APC/PM/SOS (tmux passthrough, sixel, kitty graphics protocol) and DEC single-character sequences (save/restore cursor, etc.) are now recognised, so normal text on the same line no longer loses its highlighting in those scenarios.

### Highlight settings page fixes
- The "group by category" view now actually clusters by category (it was previously flattened back to priority order).
- New "basic rule" switch in the rule editor: your own rules can join the set that stays active in "basic only" mode.
- The profile editor lists the rules a partial selection leaves out.
- "Replace current rules" imports now ask for confirmation, and the dialog defaults back to "append" each time it opens.
- Assorted small fixes: rapid toggles could lose a change, value-band rows were not kept sorted by threshold, the colour field lingered after clearing a background, and more.

## v1.0.18 - 2026-09-24

- **Fixed a serious v1.0.17 regression: the password could not be typed on the lock screen**. v1.0.17 swallowed all keyboard input at the renderer level while locked (meant to block zoom/reload shortcuts), but the default action of a key press is exactly "insert the character into the focused field" — so the lock screen's password box received nothing and the app could not be unlocked.
- Shortcut blocking now happens entirely in the main process (`before-input-event`) and only for reload / DevTools / zoom chords; normal typing is unaffected.
- **New lock shortcut Ctrl+L**: press it anywhere inside the app — terminals included — to lock immediately. When no lock password is set the chord is left alone (a shell's Ctrl+L clear-screen keeps working).
- **If v1.0.17 locked you out**: quit the app completely → delete `%APPDATA%\OpenTerminal\lock.json` → start it again (with the lock data gone the screen will not lock), then upgrade and set a new lock password.

## v1.0.17 - 2026-09-24

- **New Settings → Lock tab**: set, change or remove a lock password (stored on this machine only, scrypt one-way hash — no plaintext, no account system)
- **Three ways to lock**: lock now, auto-lock after the system is idle for a chosen time (1/5/15/30/60 minutes, off by default), and lock at startup
- The mask is fully opaque; terminal sessions keep running behind it and stay connected — unlocking restores everything
- Wrong attempts enter a growing cooldown (1s→30s) to stop guessing at the keyboard
- **The lock survives quitting and relaunching**: tray exit, task-manager kill or a crash do not get around it
- While locked, reload (Ctrl+R / F5), DevTools and zoom shortcuts are disabled, so the sessions behind the mask cannot be killed by accident
- A forgotten password cannot be recovered; the only way back in is deleting this machine's `%APPDATA%\OpenTerminal\lock.json` and setting a new one

- Packaged builds no longer honour `ELECTRON_RENDERER_URL` / `OT_UPDATE_URL`, closing an injection path that could point the app or its update feed at a hostile address
- The renderer preload runs sandboxed again
- An unreadable or corrupt known-hosts store now refuses connections and asks for the file to be repaired or deleted, instead of silently overwriting every pinned host fingerprint
- Connect-time password/passphrase prompts now match the bookmark's auth method (a key/agent bookmark no longer pops a password dialog or offers a leftover stored password)
- Fixed missing or duplicate session-exit broadcasts when an SSH connection dies — the terminal no longer hangs on "connecting"
- Closing one split-pane monitor no longer stops the sibling pane's polling
- Session-log index entries are path-validated, so a tampered index cannot write outside the log directory
- Settings are saved atomically, with a retry for Windows file-lock errors

- Added CI (GitHub Actions): typecheck + 10 offline tests + build
- The freeze-detection log no longer reports timer throttling as a ~1-minute "stall" while the window is hidden in the tray

## v1.0.16 - 2026-09-23

- **Built-in rules 11 → 22**: new dangerous/destructive commands (`rm -rf`, `mkfs`, `dd if=`, `chmod 777`, `drop database`, piping into `sh`, …), suspected secret/token reminders, delete/move/overwrite operations, create operations, log levels, exit codes, HTTP status codes, durations (ms), percentage progress, network & IP addresses, timestamps, `root@` prompts, shell keywords, quoted strings, environment variables and more
- **Status words in three colours, case-insensitive**: success (`Success` / `Succeeded` / `good` / `done` / `OK` / `✓`), warning (`Warning` / `Caution` / `Deprecated` / `⚠`), error & fatal (`Error` / `NG` / `err` / `bug` / `fail` / `FATAL` / `CRITICAL` / `PANIC` / `✗`)
- `not ok` / `not found` correctly show as errors instead of success green
- **Value-banded colours**: percentages below 20% red, 20–50% yellow, 50–80% light green, 80%+ green; exit codes, HTTP status codes and durations are banded the same way
- **Three highlight modes**: all / basic (only the key error, success, warning, dangerous-command and secret rules — about a quarter of the cost) / off (zero cost)
- Rules support "ignore case" and "value bands" switches, with a live preview against your own test text in the editor
- Import / export rules as JSON to share one palette across a team
- **Per-host rule sets**: save a subset of rules as a named set and bind it to a host in the SSH connection editor (off by default; unbound hosts run every rule)
- **Hit/duration stats**: per-rule hit count and scan time for the session (off by default, zero cost when off)
- **Theme-following colours**: rule colours map onto the active terminal theme's palette (off by default)

- The highlight settings page gained a category column (safety / status / file / network / text / metric) with grouping
- Fixed the highlight settings toolbar squeezing labels into vertical text and mis-aligning buttons in narrow windows

- New regression tests for the highlight presets (word boundaries, case flag, negative words, value bands, import/export, chunked streaming); the full `npm test` suite passes

## v1.0.15 - 2026-09-20

- **Custom terminal background image**: Settings → Theme → Background image lets you use any local image as the terminal background, with 10%–100% image opacity control; removing the image restores the solid background
- **Duplicate-name warning in the theme editor**: creating or renaming a theme that collides with a builtin or another custom theme now shows a hint (saving is still allowed)
- Theme editor seed colors are normalized; invalid color values can no longer enter custom themes
- Corrupted custom theme colors are auto-repaired to defaults with a warning logged

- The selected item in the settings dialog's left navigation is now white, matching the contrast of unselected items (fixes unreadable blue text on dark backgrounds)
- New background-image and opacity controls ship with localized strings in all four languages (zh-CN / zh-TW / en / ja)

- Added freeze-duration probes for the renderer and main process to help diagnose future "not responding" reports

## v1.0.14 - 2026-09-20

- Fixed silent corruption of uploaded files **larger than ~250KB** (size looked correct but the content had scrambled bytes)
- Fixed a remote file-handle leak on every download and a leftover SFTP channel after every transfer; a malformed server response no longer crashes the whole app
- Uploading over an existing file now asks for confirmation; partially failed multi-file deletes are now reported
- Permission editor fixes: files with unknown mode no longer get a stray `chmod 000`; an empty GID is no longer replaced by the new UID; setuid / setgid / sticky bits are shown and preserved
- chmod / chown now time out instead of spinning forever

- Fixed Chinese output over SSH turning into mojibake (multi-byte chars split across network chunks)
- Fixed command history being lost or corrupted after accepting a Tab completion
- Fixed editing keys (Ctrl+U / Ctrl+W, …) being written into command history (the "two commands merged" entries)
- `cd ~/dir` and `cd $HOME/...` are now remembered; new terminals restore them
- URL click ranges inside lines containing CJK characters no longer shift; degenerate sizes are no longer sent when the window is tiny
- SSH sessions report the real exit code; ZMODEM timeouts no longer dump garbage into the terminal or the log

- A failed session restore no longer disables snapshot saving for the whole run
- Monitor CPU / network history charts now redraw live; polling stops while the SSH workspace is hidden
- Broadcast: closing one pane of a split no longer drops the other from broadcast targets; unchecking one target no longer clears the rest
- Connection failures show the real reason; double-clicks no longer open duplicate sessions
- Fixed "Close others / Close right" skipping tabs
- Language switches apply from the first frame; active-tab text adapts after a theme switch (no more unreadable labels on light themes)
- The private-key path field no longer claims to be a server-side path

- File drops can no longer navigate the window; external links are limited to http(s) / ftp; IPC is sender-checked
- Stored passwords are only used for password-auth bookmarks (key-auth bookmarks no longer fall back to sending a password)
- Connections / known hosts are written atomically — a crash can no longer wipe them
- A crashed renderer has all of its sessions and logs reclaimed automatically
- A corrupted custom theme no longer prevents the app from starting
- Update-channel publishing is atomic — a failed publish can no longer break auto-update

## v1.0.13 - 2026-09-20

- Simplified Chinese, Traditional Chinese, English and Japanese, switchable in Settings → System → Language; applies instantly and persists
- The whole app is translated: settings pages, workspace, terminal context menu and search, SSH connections, file panel, system monitor, command panel, tray menu and the close prompt
- antd's built-in component texts (empty states, pagination, …) follow the interface language

- The changelog now ships **inside the app**, so it works offline instead of relying on a network endpoint
- The changelog is multi-language: shown in the active interface language, falling back to Simplified Chinese for versions without a translation

- Fixed "Close button → Ask every time" doing nothing (it was silently rewritten to "Minimize to tray")
- Highlight rules are no longer silently dropped over shape problems: string priorities, 0/1 booleans and a missing foreground colour are repaired, and unknown fields are preserved
- Settings parse warnings are written to `settings-warnings.log` so a broken config is traceable

- The terminal toolbar is configurable (Settings → Rendering & behaviour): open working directory (on by default), session-log recording, open logs folder
- "Open working directory" opens the terminal's current folder in the file manager, tracked live through `cd`
- The global show/hide shortcut is now **press-to-record**: focus the field and hit the combo; Esc cancels, Backspace clears; a modifier or function key is required so plain typing is never hijacked
- "Input suggestions" and "Record command history" now default to off (existing installs are reset once; later manual changes are never overwritten)
- Fixed the settings dialog content column not scrolling (an antd v6 container class rename); the theme page no longer shows a second nested scrollbar
- UI polish: render-mode and language pickers are joined segments, with corrected text contrast on the selected segment

`scripts/sync-changelog.cjs` merges `RELEASE_NOTES.en.md` into this file at
release time. The content ships inside the app; the About tab shows the
changelog for the active interface language and falls back to Simplified
Chinese for versions that have no translation yet.

## v1.0.12 - 2026-09-20

### Light-theme contrast fixes
- Tab bar and sidebar colours now derive from the theme background's luminance: on light themes the tab bar stays in the terminal's own colour family (no more muddy grey strip), while dark themes are unchanged
- Fixed tabs rendering as dark blocks with white text on light themes: tab surfaces and labels now come from theme variables — inactive tabs are light with dark text, and active-tab text is darkened automatically
- The settings dialog now follows light themes throughout: labels, descriptions, tables and palette text on the font, highlight and theme pages track the theme foreground and stay readable

### Stability
- Session-log writes now use a per-file buffer with a single drain loop: burst output is merged and stays ordered, with no unbounded queue growth
- Settings writes are serialized: changing the close action from the tray no longer clobbers a concurrent save from the settings UI
