# OpenTerminal Changelog

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
