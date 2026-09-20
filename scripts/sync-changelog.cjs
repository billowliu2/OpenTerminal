/* Merge per-language release notes into the matching CHANGELOG file as the
   section for the current package.json version. Idempotent: a version already
   present is skipped. Run BEFORE `npm run dist` — the changelogs are bundled
   into the app and shown per interface language.
   Usage: node scripts/sync-changelog.cjs

   RELEASE_NOTES.md (Simplified Chinese) is required; the other three are
   optional — a version without a translation falls back to zh-CN in the UI. */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version

const TARGETS = [
  { notes: 'RELEASE_NOTES.md', changelog: 'CHANGELOG.md', header: '# OpenTerminal 更新日志', required: true },
  { notes: 'RELEASE_NOTES.zh-TW.md', changelog: 'CHANGELOG.zh-TW.md', header: '# OpenTerminal 更新日誌' },
  { notes: 'RELEASE_NOTES.en.md', changelog: 'CHANGELOG.en.md', header: '# OpenTerminal Changelog' },
  { notes: 'RELEASE_NOTES.ja.md', changelog: 'CHANGELOG.ja.md', header: '# OpenTerminal 更新履歴' }
]

const sync = ({ notes, changelog, header, required }) => {
  const notesPath = path.join(ROOT, notes)
  const changelogPath = path.join(ROOT, changelog)
  if (!fs.existsSync(notesPath)) {
    if (required) {
      console.error(`${notes} is missing — write the release notes first`)
      process.exit(1)
    }
    console.log(`${changelog}: no ${notes} — left unchanged`)
    return
  }

  const body = fs
    .readFileSync(notesPath, 'utf8')
    // Drop the notes' own title / `## vX` heading: the section heading is built
    // here so every changelog stays uniform (`## vX.Y.Z - date`).
    .replace(/^#.*\n/gm, '')
    .replace(new RegExp(`^## v${pkgVersion}.*\\n`), '')
    .replace(/^\s+/, '')
    .trimEnd()

  if (!body) {
    console.error(`${notes} is empty — write the release notes first`)
    process.exit(1)
  }

  const existing = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : ''
  if (existing.includes(`## v${pkgVersion} `)) {
    console.log(`${changelog}: already has v${pkgVersion} — nothing to do`)
    return
  }

  const section = `## v${pkgVersion} - ${new Date().toISOString().slice(0, 10)}\n\n${body}\n`
  const updated = existing
    ? existing.replace(new RegExp(`^(${header}\\n\\n)`), `$1${section}\n`)
    : `${header}\n\n${section}`
  fs.writeFileSync(changelogPath, updated, 'utf8')
  console.log(`${changelog}: added v${pkgVersion} (${body.split('\n').length} lines)`)
}

for (const target of TARGETS) sync(target)
