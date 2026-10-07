// Download stats: Gitea releases (domestic channel) + GitHub releases (intl).
// Usage: node scripts/download-stats.cjs
// Credentials from .env (repo root, gitignored): GIT_TOKEN, GH_TOKEN.
// GitHub traffic honors HTTPS_PROXY / HTTP_PROXY (env or .env); Gitea is
// always direct — same policy as scripts/release.cjs.
//
// Caveats the printed report also states:
// - The auto-update channel (Gitea generic package `openterminal-update`)
//   does not expose download counts, so updater traffic is not included.
// - Counts reflect currently existing release assets only; re-uploaded
//   assets restart from zero.
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)

const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || env.HTTPS_PROXY || env.PROXY
// Fallback for shells without the env set: the local proxy documented in
// AGENTS.md is how GitHub traffic gets out on this network; a direct call
// dies with ECONNRESET.
const ghAgent = (p) => (p ? new (require('undici').ProxyAgent)(p) : undefined)
const GH_FALLBACK_PROXY = 'http://127.0.0.1:7897'

const GITEA = 'https://git.codingplan.site/api/v1/repos/admin/OpenTerminal'
const GITHUB = 'https://api.github.com/repos/billowliu2/OpenTerminal'

/** Sum download counts per release, split by exe/msi/other. */
function tally(releases) {
  let total = 0, exe = 0, msi = 0
  const rows = []
  for (const r of releases) {
    let n = 0, e = 0, m = 0
    for (const a of r.assets || []) {
      n += a.download_count || 0
      if (a.name.endsWith('.exe')) e += a.download_count || 0
      else if (a.name.endsWith('.msi')) m += a.download_count || 0
    }
    rows.push({ tag: r.tag_name || r.name, total: n, exe: e, msi: m })
    total += n; exe += e; msi += m
  }
  rows.sort((a, b) => b.total - a.total)
  return { rows, total, exe, msi }
}

async function giteaReleases() {
  // Paginated: Gitea caps `limit` at 50.
  const all = []
  for (let page = 1; ; page++) {
    const resp = await fetch(`${GITEA}/releases?limit=50&page=${page}`, {
      headers: { Authorization: `token ${env.GIT_TOKEN}` }
    })
    if (!resp.ok) throw new Error(`gitea HTTP ${resp.status}`)
    const batch = await resp.json()
    all.push(...batch)
    if (batch.length < 50) return all
  }
}

async function githubFetch(url) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'openterminal-download-stats',
    ...(env.GH_TOKEN ? { Authorization: `Bearer ${env.GH_TOKEN}` } : {})
  }
  const attempts = [{}, { dispatcher: ghAgent(proxy) }, { dispatcher: ghAgent(GH_FALLBACK_PROXY) }]
  let lastErr
  for (const extra of attempts) {
    try {
      const resp = await fetch(url, { headers, ...extra })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      return resp.json()
    } catch (e) { lastErr = e }
  }
  throw lastErr
}

async function githubReleases() {
  const all = []
  for (let page = 1; ; page++) {
    const batch = await githubFetch(`${GITHUB}/releases?per_page=100&page=${page}`)
    all.push(...batch)
    if (batch.length < 100) return all
  }
}

function print(source, t) {
  console.log(`\n== ${source} ==`)
  for (const r of t.rows) {
    if (!r.total) continue
    console.log(`${r.tag.padEnd(12)} total ${String(r.total).padStart(5)}  exe ${String(r.exe).padStart(5)}  msi ${String(r.msi).padStart(4)}`)
  }
  console.log(`   小计 ${t.total}（exe ${t.exe} / msi ${t.msi} / 其他 ${t.total - t.exe - t.msi}）`)
}

async function main() {
  let gh, gt
  const fails = []
  try { gt = tally(await giteaReleases()) } catch (e) { fails.push(`Gitea: ${e.message}`) }
  try { gh = tally(await githubReleases()) } catch (e) { fails.push(`GitHub: ${e.message}`) }

  if (gt) print('国内 · Gitea Releases', gt)
  if (gh) print('国外 · GitHub Releases', gh)

  if (gt && gh) {
    const total = gt.total + gh.total
    console.log(`\n合计（可计数部分）: ${total}`)
  }
  console.log('\n口径说明：')
  console.log('- 应用内自动更新走 Gitea 通用包通道（openterminal-update），该通道无下载计数接口，未计入。')
  console.log('- 计数只反映当前存活的 release 资产，重传过的资产从零累计。')
  if (fails.length) {
    console.error('\n部分来源失败:')
    for (const f of fails) console.error(' -', f)
    process.exitCode = 1
  }
}

main()
