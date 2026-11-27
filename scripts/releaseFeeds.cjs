/* Which update feeds a publish run must check for a downgrade.

   The guard is fail-closed: a feed it cannot read aborts the publish. That is
   right for a feed this run is ABOUT TO WRITE, and wrong for one it will not
   touch: a `--channel-only` run (the repair path for a channel upload that
   died halfway) never touches GitHub, but it used to probe the GitHub feed
   anyway — so a GitHub or proxy outage aborted the domestic channel repair
   that the two-feed split exists to protect.

   The rule is simply "check the feeds this run writes".

   The readers are passed in because the ones live inside release.cjs
   (channelVersion / githubLatestVersion); this module only decides WHICH feeds
   to guard. */
'use strict'

/**
 * Pick the update feeds this publish run must check for a downgrade.
 *
 * @param {{ skipGitea: boolean, skipGitHub: boolean, channelOnly: boolean }} opts
 * @param {{ channel: () => Promise<string|undefined>, github: () => Promise<string|undefined> }} readers
 * @returns {Array<[string, () => Promise<string|undefined>]>} label + reader pairs
 */
function feedsToGuard({ skipGitea, skipGitHub, channelOnly }, readers) {
  const feeds = []
  if (!skipGitea) feeds.push(['update channel', readers.channel])
  if (!skipGitHub && !channelOnly) feeds.push(['GitHub release feed', readers.github])
  return feeds
}

module.exports = { feedsToGuard }