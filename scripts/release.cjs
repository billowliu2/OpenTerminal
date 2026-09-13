// OpenTerminal release publisher
// Usage: node scripts/release.cjs <version> [--skip-github] [--skip-gitea]
//   node scripts/release.cjs 1.0.2
// Reads release notes from RELEASE_NOTES.md (repo root, gitignored).
// Credentials from .env (repo root, gitignored): GIT_TOKEN, GH_TOKEN.
// If HTTPS_PROXY / HTTP_PROXY (env or .env) is set, traffic goes through it
// (needed for api.github.com / uploads.github.com in some networks).
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const V = process.argv[2]
if (!V || !/^\d+\.\d+\.\d+$/.test(V)) {
  console.error('usage: node scripts/release.cjs <x.y.z> [--skip-github] [--skip-gitea]')
  process.exit(1)
}
const SKIP_GH = process.argv.includes('--skip-github')
const SKIP_GITEA = process.argv.includes('--skip-gitea')

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)
const notes = fs.readFileSync(path.join(ROOT, 'RELEASE_NOTES.md'), 'utf8')
const R = path.join(ROOT, 'release')
const files = [
  path.join(R, `OpenTerminal-${V}-setup.msi`),
  path.join(R, `OpenTerminal-${V}-setup.exe`)
]
for (const f of files) {
  if (!fs.existsSync(f)) { console.error('missing build artifact:', f); process.exit(1) }
}
// Guard rails: the artifacts must belong to the version being published, and
// the tag must not exist yet — otherwise a re-run silently republishes a
// *different* binary under an already-released version number, and installed
// clients never see it (their version check compares numbers, not hashes).
const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
if (pkgVersion !== V) {
  console.error(`package.json is ${pkgVersion} but you asked to publish ${V}`)
  process.exit(1)
}
const ymlPath = path.join(R, 'latest.yml')
if (!fs.existsSync(ymlPath)) { console.error('missing release/latest.yml — run npm run dist first'); process.exit(1) }
const ymlVersion = fs.readFileSync(ymlPath, 'utf8').match(/^version:\s*(\S+)/m)?.[1]
if (ymlVersion !== V) {
  console.error(`release/latest.yml says ${ymlVersion} but you asked to publish ${V} — rebuild first`)
  process.exit(1)
}

const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || env.HTTPS_PROXY || env.PROXY
if (proxy) {
  const { ProxyAgent, setGlobalDispatcher } = require('undici')
  setGlobalDispatcher(new ProxyAgent(proxy))
  console.log('using proxy:', proxy)
}

async function upload(url, file, token, authScheme) {
  const name = path.basename(file)
  const stat = fs.statSync(file)
  const resp = await fetch(`${url}${url.includes('?') ? '&' : '?'}name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {
      Authorization: `${authScheme} ${token}`,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(stat.size)
    },
    body: fs.createReadStream(file),
    duplex: 'half'
  })
  console.log(`  upload ${name}: HTTP ${resp.status}`)
  if (!resp.ok) {
    const body = (await resp.text()).slice(0, 300)
    throw new Error(`upload failed (${resp.status}) for ${name}: ${body}`)
  }
}

async function gitea() {
  console.log('=== Gitea release ===')
  const base = 'https://git.codingplan.site/api/v1/repos/admin/OpenTerminal'
  const resp = await fetch(`${base}/releases`, {
    method: 'POST',
    headers: { Authorization: `token ${env.GIT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: `v${V}`, name: `OpenTerminal v${V}`, body: notes, draft: false, prerelease: false })
  })
  if (!resp.ok) { throw new Error(`Gitea release create failed: ${resp.status} ${(await resp.text()).slice(0, 300)}`) }
  const rel = await resp.json()
  console.log('release created, id =', rel.id)
  for (const f of files) await upload(`${base}/releases/${rel.id}/assets`, f, env.GIT_TOKEN, 'token')
}

async function giteaChannel() {
  console.log('=== Gitea update channel ===')
  const base = 'https://git.codingplan.site/api/packages/admin/generic/openterminal-update/stable'
  const channelFiles = [
    [path.join(R, 'latest.yml'), 'latest.yml'],
    [path.join(R, `OpenTerminal-${V}-setup.exe.blockmap`), `OpenTerminal-${V}-setup.exe.blockmap`],
    [path.join(R, `OpenTerminal-${V}-setup.exe`), `OpenTerminal-${V}-setup.exe`],
    // Changelog served from the channel: the Gitea repo is private (anonymous
    // releases API 404s), but the generic package is publicly readable.
    [path.join(ROOT, 'RELEASE_NOTES.md'), 'release-notes.md']
  ]
  // Validate before touching the channel: a missing file after the DELETE would
  // leave the update channel empty (clients then fall back to GitHub, which is
  // unreachable in China for most users).
  for (const [f] of channelFiles) {
    if (!fs.existsSync(f)) throw new Error(`missing channel file: ${f}`)
  }
  // latest.yml goes last: it is what makes clients start downloading, so the
  // payload must already be in place.
  const isLatest = ([f]) => path.basename(f) === 'latest.yml'
  const ordered = [...channelFiles.filter((e) => !isLatest(e)), ...channelFiles.filter(isLatest)]
  // Replace the version only once every file is known to be present on disk.
  const del = await fetch(base, { method: 'DELETE', headers: { Authorization: `token ${env.GIT_TOKEN}` } })
  console.log('  delete old stable:', del.status)
  for (const [f, name] of ordered) {
    const stat = fs.statSync(f)
    const resp = await fetch(`${base}/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { Authorization: `token ${env.GIT_TOKEN}`, 'Content-Type': 'application/octet-stream', 'Content-Length': String(stat.size) },
      body: fs.createReadStream(f),
      duplex: 'half'
    })
    console.log(`  put ${name}: HTTP ${resp.status}`)
    if (!resp.ok) throw new Error(`channel put failed (${resp.status}) for ${name}: ${(await resp.text()).slice(0, 200)}`)
  }
}

async function github() {
  console.log('=== GitHub release ===')
  const resp = await fetch('https://api.github.com/repos/billowliu2/OpenTerminal/releases', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'OpenTerminal',
      Accept: 'application/vnd.github+json'
    },
    body: JSON.stringify({ tag_name: `v${V}`, name: `OpenTerminal v${V}`, body: notes, draft: false, prerelease: false })
  })
  if (!resp.ok) { throw new Error(`GitHub release create failed: ${resp.status} ${(await resp.text()).slice(0, 300)}`) }
  const rel = await resp.json()
  console.log('release created, id =', rel.id)
  const up = `https://uploads.github.com/repos/billowliu2/OpenTerminal/releases/${rel.id}/assets`
  for (const f of [...files, path.join(R, `OpenTerminal-${V}-setup.exe.blockmap`), path.join(R, 'latest.yml')]) {
    await upload(up, f, env.GH_TOKEN, 'Bearer')
  }
}

async function main() {
  if (!SKIP_GITEA) { await gitea(); await giteaChannel() }
  if (!SKIP_GH) await github()
  console.log('done')
}
main().catch((e) => { console.error(e); process.exit(1) })
