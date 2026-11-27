/**
 * Release downgrade-guard feed selection self-test (release-feeds.mjs).
 *
 * The guard must check exactly the feeds THIS RUN WILL WRITE. It used to pick
 * the GitHub feed whenever GitHub was not skipped — including a
 * `--channel-only` run, which never touches GitHub. Because the GitHub probe
 * is fail-closed (a network error aborts), a GitHub or proxy outage killed the
 * domestic channel-repair path that the two-feed split exists to protect.
 *
 * Run: node tests/release-feeds.mjs   (must exit 0)
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { feedsToGuard } = require('../scripts/releaseFeeds.cjs')

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}

const readers = { channel: async () => undefined, github: async () => undefined }
const labels = (opts) => feedsToGuard(opts, readers).map(([label]) => label)

console.log('[feeds to guard]')
{
  ok(
    labels({ skipGitea: false, skipGitHub: false, channelOnly: false }).length === 2,
    'a full publish guards both feeds'
  )
  ok(
    labels({ skipGitea: false, skipGitHub: false, channelOnly: true }).length === 1,
    'a channel-only publish guards the channel only'
  )
  ok(
    labels({ skipGitea: false, skipGitHub: true, channelOnly: false }).length === 1,
    '--skip-github guards the channel only'
  )
  ok(
    labels({ skipGitea: true, skipGitHub: false, channelOnly: false }).length === 1,
    '--skip-gitea guards the GitHub feed only'
  )
  ok(
    labels({ skipGitea: true, skipGitHub: true, channelOnly: false }).length === 0,
    'skipping both guards nothing'
  )
}

console.log('[the guard never probes a feed it will not write]')
{
  const guarded = feedsToGuard({ skipGitea: false, skipGitHub: false, channelOnly: true }, readers)
  ok(
    !guarded.some(([label]) => label.includes('GitHub')),
    'a channel-only publish never reads the GitHub feed'
  )
}

if (failed > 0) {
  console.error(`\n[release-feeds] ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('\n[release-feeds] ALL CHECKS PASSED')