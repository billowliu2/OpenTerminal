// OpenTerminal release publisher
// Usage: node scripts/release.cjs <version> [--skip-github] [--skip-gitea-release] [--skip-gitea] [--channel-only]
//   node scripts/release.cjs 1.0.2
//   node scripts/release.cjs 1.0.2 --channel-only        # update channel only (repair)
// Flags:
//   --skip-github          skip the GitHub release (assets included)
//   --skip-gitea-release   skip only the Gitea *release*; the Gitea update
//                          channel still runs (this is what you want if the
//                          release already exists / is not needed)
//   --skip-gitea           skip the Gitea release AND the Gitea update channel
//                          — Chinese users then never see this version; prefer
//                          --skip-gitea-release unless you really mean both
//   --channel-only         update channel only (repair); no release, no GitHub
// Reads release notes from RELEASE_NOTES.md (repo root, gitignored).
// Credentials from .env (repo root, gitignored): GIT_TOKEN, GH_TOKEN.
// If HTTPS_PROXY / HTTP_PROXY (env or .env) is set, traffic goes through it
// (needed for api.github.com / uploads.github.com in some networks).
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const V = process.argv[2]
if (!V || !/^\d+\.\d+\.\d+$/.test(V)) {
  console.error('usage: node scripts/release.cjs <x.y.z> [--skip-github] [--skip-gitea-release] [--skip-gitea] [--channel-only]')
  console.error('  --skip-github          skip the GitHub release')
  console.error('  --skip-gitea-release   skip only the Gitea release; the update channel still runs')
  console.error('  --skip-gitea           skip the Gitea release AND the update channel (CN users get no update)')
  console.error('  --channel-only         update channel only (repair)')
  process.exit(1)
}
const SKIP_GH = process.argv.includes('--skip-github')
const SKIP_GITEA = process.argv.includes('--skip-gitea')
const SKIP_GITEA_RELEASE = process.argv.includes('--skip-gitea-release')
const CHANNEL_ONLY = process.argv.includes('--channel-only')

/** Strip one pair of matching quotes. A .env quotes its values for the shell
    that would source it, so the quotes are syntax, not part of the token. */
function unquote(value) {
  const q = value[0]
  return (q === '"' || q === "'") && value.length > 1 && value.endsWith(q) ? value.slice(1, -1) : value
}
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')
    // Trim before the comment check: an indented `# comment = x` is a comment,
    // not an env entry.
    .map((l) => l.trim())
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => {
      // `export KEY=v` is a common way to write an env file: the prefix is
      // shell syntax, not part of the key.
      const body = l.startsWith('export ') ? l.slice('export '.length).trim() : l
      const i = body.indexOf('=')
      return [body.slice(0, i).trim(), unquote(body.slice(i + 1).trim())]
    })
)
const notes = fs.readFileSync(path.join(ROOT, 'RELEASE_NOTES.md'), 'utf8')
const R = path.join(ROOT, 'release')
const exe = path.join(R, `OpenTerminal-${V}-setup.exe`)
const files = [exe]
// Only the NSIS exe is built (the MSI was dropped in v1.0.22 — electron-updater
// never supported it). The channel's own file list is validated in
// giteaChannel().
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
  // A failed listing must not read as "nothing attached": that would re-POST
  // every already-uploaded installer and abort the run on the duplicate-name
  // rejection, before the channel update could run. Fail loudly instead — a
  // re-run then resumes correctly.
  if (!listed.ok) throw new Error(`Gitea asset listing failed: HTTP ${listed.status}`)
  const attached = new Set((await listed.json()).map((a) => a.name))
  for (const f of files) {
    const name = path.basename(f)
    if (attached.has(name)) { console.log(`  asset ${name}: already attached, skipped`); continue }
    await upload(`${base}/releases/${rel.id}/assets`, f, env.GIT_TOKEN, 'token')
  }
}

const CHANNEL_BASE = 'https://git.codingplan.site/api/packages/admin/generic/openterminal-update/stable'

/** Numeric compare of two x.y.z versions: negative, zero or positive. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

/** Refuse to publish a version older than the one the channel already serves.
    The guard rails above only compare the *local* artifacts with V, so
    publishing from an old branch passes all three of them, overwrites
    latest.yml with an older version — and pruneChannel() then deletes the newer
    binaries from the live channel, silently rolling every installed client
    back. Runs before anything is uploaded. */
async function assertNoDowngrade() {
  const live = await channelVersion(CHANNEL_BASE)
  if (!live) return
  if (compareVersions(live, V) > 0) {
    throw new Error(`refusing to publish v${V}: the update channel already serves v${live} — an older version would overwrite latest.yml and delete the newer binaries. Publish from the newer branch, or bump the version.`)
  }
  console.log(`channel currently serves v${live}`)
}

/** Version the update channel serves right now (read from its latest.yml).
    Fail-closed: only an *empty* channel (HTTP 404) reports "unknown". A network
    error, a non-404 failure or a body without a version all throw — otherwise a
    probe that fails for any reason would read as "no live version" and let a
    downgrade through the guard below. */
async function channelVersion(base) {
  let resp
  try {
    resp = await fetch(`${base}/latest.yml`)
  } catch (e) {
    throw new Error(`cannot reach update channel (${e.message})`)
  }
  // 404 = nothing published yet; that is a legal empty channel, not an error.
  if (resp.status === 404) return undefined
  if (!resp.ok) throw new Error(`update channel latest.yml returned HTTP ${resp.status}`)
  const version = (await resp.text()).match(/^version:\s*(\S+)/m)?.[1]
  if (!version) throw new Error('update channel latest.yml carries no version field')
  return version
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

/** sha512 of a local file, base64 — the encoding latest.yml records. */
function fileSha512(file) {
  return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64')
}

/** sha512 (base64) that release/latest.yml declares for a channel payload, or
    undefined when the yml is unreadable or does not describe that file (the
    blockmap, for one, is not listed). */
function declaredSha512(name) {
  try {
    let url
    for (const line of fs.readFileSync(ymlPath, 'utf8').split('\n')) {
      const entry = line.match(/^\s*-\s*url:\s*(\S+)/)
      if (entry) { url = entry[1]; continue }
      const sha = line.match(/^\s*sha512:\s*(\S+)/)
      if (sha && url && (url === name || decodeURIComponent(url) === name)) return sha[1]
    }
  } catch { /* unreadable yml: the caller falls back to the size check */ }
  return undefined
}

async function giteaChannel() {
  console.log('=== Gitea update channel ===')
  const base = CHANNEL_BASE
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
  // Best effort by design: this probe only decides whether the previous
  // version's binaries get pruned afterwards. It now throws on a failed probe
  // (fail-closed for the downgrade guard), and by the time we are here the new
  // latest.yml is about to be live — a hiccup in a cleanup helper must never
  // abort the tail of the publish.
  let previous
  try {
    previous = await channelVersion(base)
  } catch (e) {
    console.log(`  cannot read the live channel version (${e.message}) — skipping prune of the previous release`)
  }
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
        // copy only when it is demonstrably the artifact we just built.
        // latest.yml records the sha512 electron-builder computed for this
        // file, so hashing the file on disk proves it is that build; a size
        // match alone would just as happily keep a truncated or stale upload.
        const declared = declaredSha512(name)
        const stored = await channelFileSize(url)
        if (declared) {
          if (fileSha512(f) !== declared) {
            throw new Error(`${name} does not match the sha512 release/latest.yml declares for it — this is not the artifact that build produced`)
          }
          if (stored === stat.size) {
            console.log(`  ${name} is already published with the same sha512, kept`)
            continue
          }
        } else if (stored === stat.size) {
          // Not described by latest.yml (the blockmap, for one): the stored
          // size is the only cheap signal left.
          console.log(`  ${name} is already published with the same size, kept`)
          continue
        }
      } else {
        // latest.yml / release-notes.md change every release and the atomic
        // flow no longer wipes the channel up front, so replace them in place.
        // The swap window is one small file (sub-second), not the whole channel.
        const del = await fetch(url, { method: 'DELETE', headers: { Authorization: `token ${env.GIT_TOKEN}` } })
        console.log(`  delete old ${name}: HTTP ${del.status}`)
        // A delete that did not happen leaves the PUT below facing the same
        // conflict, so fail here instead of after a pointless retry loop.
        // 404 means the file is already gone, which is what we wanted.
        if (!del.ok && del.status !== 404) throw new Error(`channel delete failed (${del.status}) for ${name}`)
        // Retry: the delete→put gap is the one moment the channel serves no
        // latest.yml at all, so closing it fast matters more than request count.
        for (let attempt = 1; ; attempt++) {
          resp = await put()
          console.log(`  put ${name}: HTTP ${resp.status}`)
          if (resp.ok || attempt >= 3) break
          console.log(`  put ${name} failed (HTTP ${resp.status}), retrying in ${attempt}s…`)
          await new Promise((r) => setTimeout(r, attempt * 1000))
        }
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
  const api = 'https://api.github.com/repos/billowliu2/OpenTerminal'
  const ghHeaders = {
    Authorization: `Bearer ${env.GH_TOKEN}`,
    'Content-Type': 'application/json',
    'User-Agent': 'OpenTerminal',
    Accept: 'application/vnd.github+json'
  }
  const gh = (url, init) =>
    fetch(url, { ...init, headers: ghHeaders, ...(proxyAgent ? { dispatcher: proxyAgent } : {}) })
  // Idempotent like gitea(): a re-run after a partial publish must reuse the
  // release it created last time instead of dying on 422 already_exists and
  // leaving GitHub permanently half-uploaded until someone deletes it by hand.
  const byTag = () => gh(`${api}/releases/tags/v${V}`)
  let resp = await byTag()
  let rel
  if (resp.ok) {
    rel = await resp.json()
    console.log('release already exists, reusing id =', rel.id)
  } else {
    resp = await gh(`${api}/releases`, {
      method: 'POST',
      body: JSON.stringify({ tag_name: `v${V}`, name: `OpenTerminal v${V}`, body: notes, draft: false, prerelease: false })
    })
    if (resp.ok) {
      rel = await resp.json()
      console.log('release created, id =', rel.id)
    } else {
      const detail = (await resp.text()).slice(0, 300)
      // 422 already_exists = the tag carries a release from an earlier partial run.
      const again = resp.status === 422 ? await byTag() : undefined
      if (!again || !again.ok) throw new Error(`GitHub release create failed: ${resp.status} ${detail}`)
      rel = await again.json()
      console.log('release already exists, reusing id =', rel.id)
    }
  }
  const up = `https://uploads.github.com/repos/billowliu2/OpenTerminal/releases/${rel.id}/assets`
  // Skip assets a previous partial run already uploaded — the upload POST
  // 422s on duplicates, so without this a retry could never get past them.
  const assetsResp = await gh(`${api}/releases/${rel.id}/assets?per_page=100`)
  // A failed listing must not read as "nothing uploaded": that re-POSTs every
  // already-uploaded asset, 422s on the duplicate name and only gives up after
  // three retries. Fail loudly, exactly like the Gitea side — a re-run then
  // resumes correctly instead of stalling.
  if (!assetsResp.ok) throw new Error(`GitHub asset listing failed: HTTP ${assetsResp.status}`)
  const existing = new Set((await assetsResp.json()).map((a) => a.name))
  for (const f of [...files, path.join(R, `OpenTerminal-${V}-setup.exe.blockmap`), path.join(R, 'latest.yml')]) {
    if (existing.has(path.basename(f))) {
      console.log(`  skip ${path.basename(f)} (already uploaded)`)
      continue
    }
    // Large uploads through a proxy flake; retry transient network errors.
    for (let attempt = 1; ; attempt++) {
      try {
        await upload(up, f, env.GH_TOKEN, 'Bearer', true)
        break
      } catch (e) {
        if (attempt >= 3) throw e
        console.log(`  upload ${path.basename(f)} failed (${e.message}), retrying in 5s…`)
        await new Promise((r) => setTimeout(r, 5000))
      }
    }
  }
}

async function main() {
  // Before anything is uploaded: a downgrade breaks the GitHub release clients
  // read first and the channel they fall back to.
  await assertNoDowngrade()
  // --channel-only: the release and its assets already exist (or are not needed),
  // so republish just the update channel — the repair path for a channel upload
  // that died halfway.
  if (CHANNEL_ONLY) {
    await giteaChannel()
    console.log('done (channel only)')
    return
  }
  if (SKIP_GITEA) {
    console.warn('*** WARNING: --skip-gitea skips the Gitea release AND the Gitea update channel. ***')
    console.warn('*** Domestic users will NOT receive this version — it is only on GitHub, which most ***')
    console.warn('*** of them cannot reach. To skip just the release, use --skip-gitea-release. ***')
  }
  // --skip-gitea-release: the release object already exists (or is not wanted),
  // but the channel still has to be fed — that is the whole update path at home.
  if (!SKIP_GITEA && !SKIP_GITEA_RELEASE) await gitea()
  if (!SKIP_GITEA) await giteaChannel()
  if (!SKIP_GH) await github()
  console.log('done')
}
main().catch((e) => { console.error(e); process.exit(1) })
