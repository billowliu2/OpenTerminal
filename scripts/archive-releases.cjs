/* Archive old Gitea releases: backup assets locally, then delete remote
   releases, keeping only the one you name. Tags are untouched.

   WARNING: `delete` removes every release except <keep-tag> from the Gitea
   repository. The kept tag is a REQUIRED argument precisely because a
   hardcoded default is how the wrong version gets wiped — the script refuses
   to run without it. `delete` is safe by construction: it aborts unless every
   asset of every old release already has a size-matching local backup.

   Usage:
     node scripts/archive-releases.cjs <keep-tag> backup   # download assets only
     node scripts/archive-releases.cjs <keep-tag> delete   # delete releases whose
                                                           # assets are all backed
                                                           # up (size match)

   Reads GIT_TOKEN from .env (same format as scripts/release.cjs). */
const fs = require('node:fs')
const path = require('node:path')
const ROOT = path.join(__dirname, '..')
const KEEP_TAG = process.argv[2]
if (!KEEP_TAG) {
  console.error('usage: node scripts/archive-releases.cjs <keep-tag> backup|delete')
  process.exit(1)
}
const ARCHIVE = path.join(ROOT, 'release', 'archive')
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)
const API = 'https://git.codingplan.site/api/v1/repos/admin/OpenTerminal'
const H = { Authorization: `token ${env.GIT_TOKEN}` }

const listReleases = async () => {
  const out = []
  let page = 1
  for (;;) {
    const res = await fetch(`${API}/releases?limit=50&page=${page}`, { headers: H })
    if (!res.ok) throw new Error(`list HTTP ${res.status}`)
    const batch = await res.json()
    if (!batch.length) break
    out.push(...batch)
    page++
  }
  return out
}

const backup = async () => {
  const releases = await listReleases()
  const old = releases.filter((r) => r.tag_name !== KEEP_TAG)
  let ok = true
  for (const r of old) {
    for (const a of r.assets ?? []) {
      const dir = path.join(ARCHIVE, r.tag_name)
      fs.mkdirSync(dir, { recursive: true })
      const dest = path.join(dir, a.name)
      if (fs.existsSync(dest) && fs.statSync(dest).size === a.size) {
        console.log(`skip (have) ${r.tag_name}/${a.name}`)
        continue
      }
      process.stdout.write(`get ${r.tag_name}/${a.name} (${(a.size / 1e6).toFixed(1)} MB) ... `)
      const res = await fetch(a.browser_download_url, { headers: H })
      if (!res.ok) { console.log(`HTTP ${res.status}`); ok = false; continue }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length !== a.size) { console.log(`size mismatch ${buf.length} != ${a.size}`); ok = false; continue }
      fs.writeFileSync(dest, buf)
      console.log('ok')
    }
  }
  console.log(ok ? 'BACKUP DONE' : 'BACKUP INCOMPLETE — do not delete')
}

const del = async () => {
  const releases = await listReleases()
  const old = releases.filter((r) => r.tag_name !== KEEP_TAG)
  let ok = true
  for (const r of old) {
    for (const a of r.assets ?? []) {
      const dest = path.join(ARCHIVE, r.tag_name, a.name)
      const have = fs.existsSync(dest) && fs.statSync(dest).size === a.size
      if (!have) { console.log(`MISSING backup ${r.tag_name}/${a.name} — abort this release`); ok = false }
    }
  }
  if (!ok) { console.log('DELETE ABORTED'); return }
  for (const r of old) {
    const res = await fetch(`${API}/releases/${r.id}`, { method: 'DELETE', headers: H })
    console.log(`delete ${r.tag_name}: HTTP ${res.status}`)
  }
  const left = await listReleases()
  console.log(`remaining: ${left.map((r) => r.tag_name).join(', ')}`)
}

;(async () => {
  const mode = process.argv[3]
  if (mode === 'backup') await backup()
  else if (mode === 'delete') await del()
  else console.log('usage: node scripts/archive-releases.cjs <keep-tag> backup|delete')
})().catch((e) => { console.error('failed:', e.message); process.exit(1) })
