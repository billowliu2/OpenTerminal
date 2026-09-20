/* Merge RELEASE_NOTES.md into CHANGELOG.md as the section for the current
   package.json version. Idempotent: skips if the version is already present.
   Run BEFORE `npm run dist` — the changelog is bundled into the app.
   Usage: node scripts/sync-changelog.cjs */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
const notesPath = path.join(ROOT, 'RELEASE_NOTES.md')
const changelogPath = path.join(ROOT, 'CHANGELOG.md')
const HEADER = '# OpenTerminal 更新日志'

const notes = fs.readFileSync(notesPath, 'utf8')
  // Drop the notes' own leading title / `## vX` heading — the section heading
  // is constructed here so CHANGELOG stays uniform (`## vX.Y.Z - date`).
  .replace(/^#.*\n/gm, '')
  .replace(new RegExp(`^## v${pkgVersion}.*\\n`), '')
  .replace(/^\s+/, '')
  .trimEnd()

if (!notes) {
  console.error('RELEASE_NOTES.md is empty — write release notes first')
  process.exit(1)
}

const section = `## v${pkgVersion} - ${new Date().toISOString().slice(0, 10)}\n\n${notes}\n`
const existing = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : ''
if (existing.includes(`## v${pkgVersion} `)) {
  console.log(`CHANGELOG.md already has v${pkgVersion} — nothing to do`)
  process.exit(0)
}

const updated = existing
  ? existing.replace(new RegExp(`^(${HEADER}\\n\\n)`), `$1${section}\n`)
  : `${HEADER}\n\n${section}`

fs.writeFileSync(changelogPath, updated, 'utf8')
console.log(`CHANGELOG.md: added v${pkgVersion} (${notes.split('\n').length} lines)`)
