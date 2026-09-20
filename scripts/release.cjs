// OpenTerminal release publisher
// Usage: node scripts/release.cjs <version> [--skip-github] [--skip-gitea] [--channel-only]
//   node scripts/release.cjs 1.0.2
//   node scripts/release.cjs 1.0.2 --channel-only   # update channel only (repair)
// Reads release notes from RELEASE_NOTES.md (repo root, gitignored).
// Credentials from .env (repo root, gitignored): GIT_TOKEN, GH_TOKEN.
// If HTTPS_PROXY / HTTP_PROXY (env or .env) is set, traffic goes through it
// (needed for api.github.com / uploads.github.com in some networks).
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const V = process.argv[2]
if (!V || !/^\d+\.\d+\.\d+$/.test(V)) {
  console.error('usage: node scripts/release.cjs <x.y.z> [--skip-github] [--skip-gitea] [--channel-only]')
  process.exit(1)
}
const SKIP_GH = process.argv.includes('--skip-github')
const SKIP_GITEA = process.argv.includes('--skip-gitea')
const CHANNEL_ONLY = process.argv.includes('--channel-only')

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')
    // Trim before the comment check: an indented `# comment = x` is a comment,
    // not an env entry.
    .map((l) => l.trim())
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
// Guard rails: the artifacts must belong to the version being published —
// otherwise a re-run silently republishes a *different* binary under an
// already-released version number, and installed clients never see it (their
// version check compares numbers, not hashes). Re-running the same version is
// supported (gitea() reuses an existing release), so this is a version check,
// not a tag check.
const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
if (pkgVersion !== V) {
  console.error(`package.json is ${pkgVersion} but you asked to publish ${V}`)
  process.exit(1)
}
// The changelog ships inside the app, so it must mention this version — a
// missing entry means `sync-changelog.cjs` was skipped before the build.
const changelog = path.join(ROOT, 'CHANGELOG.md')
if (!fs.existsSync(changelog) || !fs.readFileSync(changelog, 'utf8').includes(`## v${V} `)) {
  console.error(`CHANGELOG.md has no v${V} entry — run: node scripts/sync-changelog.cjs (then rebuild)`)
  process.exit(1)
}
const ymlPath = path.join(R, 'latest.yml')
if (!fs.existsSync(ymlPath)) { console.error('missing release/latest.yml — run npm run dist first'); process.exit(1) }
const ymlVersion = fs.readFileSync(ymlPath, 'utf8').match(/^version:\s*(\S+)/m)?.[1]
if (ymlVersion !== V) {
  console.error(`release/latest.yml says ${ymlVersion} but you asked to publish ${V} — rebuild first`)
  process.exit(1)
}

// Proxy applies to GitHub only. The domestic Gitea host is fastest — and most
// reliable — over a direct connection; routing it through a local proxy is
// what once broke a channel upload (ECONNRESET mid-PUT), and a proxy that is
// down would take the domestic channel with it. So no global dispatcher here:
// the agent is passed explicitly on GitHub requests.
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || env.HTTPS_PROXY || env.PROXY
const proxyAgent = proxy ? new (require('undici').ProxyAgent)(proxy) : undefined
// Never log the proxy URL verbatim: it may embed `user:password@`.
if (proxy) console.log('proxy for GitHub only:', proxy.replace(/\/\/[^/@]*@/, '//'))

async function upload(url, file, token, authScheme, viaProxy = false) {
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
    duplex: 'half',
    ...(viaProxy && proxyAgent ? { dispatcher: proxyAgent } : {})
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
  const auth = { Authorization: `token ${env.GIT_TOKEN}` }
  // Idempotent: a re-run (e.g. `--channel-only` after a half-finished publish)
  // must not die on the release it created last time — reuse it, and skip assets
  // that are already attached.
  const existing = await fetch(`${base}/releases/tags/v${V}`, { headers: auth })
  let rel
  if (existing.ok) {
    rel = await existing.json()
    console.log('release already exists, reusing id =', rel.id)
  } else {
    const resp = await fetch(`${base}/releases`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_name: `v${V}`, name: `OpenTerminal v${V}`, body: notes, draft: false, prerelease: false })
    })
    if (resp.ok) {
      rel = await resp.json()
      console.log('release created, id =', rel.id)
    } else {
      const detail = (await resp.text()).slice(0, 300)
      // 409 = the tag already carries a release, created by an earlier partial run.
      const again = resp.status === 409 ? await fetch(`${base}/releases/tags/v${V}`, { headers: auth }) : undefined
      if (!again || !again.ok) throw new Error(`Gitea release create failed: ${resp.status} ${detail}`)
      rel = await again.json()
      console.log('release already exists, reusing id =', rel.id)
    }
  }
  const listed = await fetch(`${base}/releases/${rel.id}/assets`, { headers: auth })
  const attached = new Set(listed.ok ? (await listed.json()).map((a) => a.name) : [])
  for (const f of files) {
    const name = path.basename(f)
    if (attached.has(name)) { console.log(`  asset ${name}: already attached, skipped`); continue }
    await upload(`${base}/releases/${rel.id}/assets`, f, env.GIT_TOKEN, 'token')
  }
}

/** Version the update channel serves right now (read from its latest.yml), or
    undefined when the channel is empty/unreachable. */
async function channelVersion(base) {
  try {
    const resp = await fetch(`${base}/latest.yml`)
    if (!resp.ok) return undefined
    return (await resp.text()).match(/^version:\s*(\S+)/m)?.[1]
  } catch {
    return undefined
  }
}

/** Size of a channel file, or -1 when it is not there. */
async function channelFileSize(url) {
  try {
    const resp = await fetch(url, { method: 'HEAD' })
    return resp.ok ? Number(resp.headers.get('content-length') ?? -1) : -1
  } catch {
    return -1
  }
}

/** Drop the previous version's binaries, once the new latest.yml is live. The old
    files keep serving until then, so nothing is ever removed up front. Best
    effort: leftovers cost disk, never correctness — latest.yml names the files
    clients fetch. */
async function pruneChannel(base, previous) {
  if (!previous || previous === V) return
  for (const name of [`OpenTerminal-${previous}-setup.exe`, `OpenTerminal-${previous}-setup.exe.blockmap`]) {
    try {
      const resp = await fetch(`${base}/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        headers: { Authorization: `token ${env.GIT_TOKEN}` }
      })
      if (resp.ok) console.log(`  removed previous ${name}`)
    } catch (e) {
      console.log(`  previous ${name} not removed: ${e.message}`)
    }
  }
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
  // Validate before touching the channel: uploading a payload-less latest.yml
  // would leave the update channel broken (clients then fall back to GitHub,
  // which is unreachable in China for most users).
  for (const [f] of channelFiles) {
    if (!fs.existsSync(f)) throw new Error(`missing channel file: ${f}`)
  }
  // latest.yml goes last: it is what makes clients start downloading, so the
  // payload must already be in place. Nothing is deleted first — the previous
  // version keeps serving until every new file has landed, so an interrupted PUT
  // (ECONNRESET) can no longer leave the channel empty and unrepairable.
  const isLatest = ([f]) => path.basename(f) === 'latest.yml'
  const ordered = [...channelFiles.filter((e) => !isLatest(e)), ...channelFiles.filter(isLatest)]
  const previous = await channelVersion(base)
  for (const [f, name] of ordered) {
    const stat = fs.statSync(f)
    const url = `${base}/${encodeURIComponent(name)}`
    const put = async () =>
      fetch(url, {
        method: 'PUT',
        headers: { Authorization: `token ${env.GIT_TOKEN}`, 'Content-Type': 'application/octet-stream', 'Content-Length': String(stat.size) },
        body: fs.createReadStream(f),
        duplex: 'half'
      })
    let resp = await put()
    console.log(`  put ${name}: HTTP ${resp.status}`)
    if (!resp.ok && (resp.status === 409 || resp.status === 422)) {
      if (/\d+\.\d+\.\d+/.test(name)) {
        // Version-named payloads are immutable per release: accept a stored
        // copy only when it has exactly the same size.
        if ((await channelFileSize(url)) === stat.size) {
          console.log(`  ${name} is already published with the same size, kept`)
          continue
        }
      } else {
        // latest.yml / release-notes.md change every release and the atomic
        // flow no longer wipes the channel up front, so replace them in place.
        // The swap window is one small file (sub-second), not the whole channel.
        const del = await fetch(url, { method: 'DELETE', headers: { Authorization: `token ${env.GIT_TOKEN}` } })
        console.log(`  delete old ${name}: HTTP ${del.status}`)
        resp = await put()
        console.log(`  put ${name}: HTTP ${resp.status}`)
      }
    }
    if (!resp.ok) {
      const detail = (await resp.text()).slice(0, 200)
      throw new Error(`channel put failed (${resp.status}) for ${name}: ${detail}`)
    }
  }
  await pruneChannel(base, previous)
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
    body: JSON.stringify({ tag_name: `v${V}`, name: `OpenTerminal v${V}`, body: notes, draft: false, prerelease: false }),
    ...(proxyAgent ? { dispatcher: proxyAgent } : {})
  })
  if (!resp.ok) { throw new Error(`GitHub release create failed: ${resp.status} ${(await resp.text()).slice(0, 300)}`) }
  const rel = await resp.json()
  console.log('release created, id =', rel.id)
  const up = `https://uploads.github.com/repos/billowliu2/OpenTerminal/releases/${rel.id}/assets`
  for (const f of [...files, path.join(R, `OpenTerminal-${V}-setup.exe.blockmap`), path.join(R, 'latest.yml')]) {
    await upload(up, f, env.GH_TOKEN, 'Bearer', true)
  }
}

async function main() {
  // --channel-only: the release and its assets already exist (or are not needed),
  // so republish just the update channel — the repair path for a channel upload
  // that died halfway.
  if (CHANNEL_ONLY) {
    await giteaChannel()
    console.log('done (channel only)')
    return
  }
  if (!SKIP_GITEA) { await gitea(); await giteaChannel() }
  if (!SKIP_GH) await github()
  console.log('done')
}
main().catch((e) => { console.error(e); process.exit(1) })
