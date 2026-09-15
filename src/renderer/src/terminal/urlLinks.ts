/**
 * Clickable URLs in terminal output.
 *
 * xterm has no link detection of its own for plain text (OSC 8 hyperlinks are
 * a separate, opt-in protocol the CLI must emit), so a link provider scans the
 * buffer line and hands back ranges. Two shapes are recognised:
 *   1. fully qualified `http(s)://host[:port][/path][?query]`;
 *   2. the scheme-less dev-server forms `localhost:5000`, `127.0.0.1:8080`,
 *      `0.0.0.0:3000` — opened as http.
 *
 * Because PTY output wraps long URLs across buffer rows, the provider rebuilds
 * the whole *logical* line (walking back through `isWrapped` rows and forward
 * to the last wrapped one) before matching, so a link split by the terminal
 * width still resolves as one range.
 */

/** Characters that end a URL: whitespace, quotes, brackets, CJK punctuation. */
const URL_BODY = `[^\\s"'\`<>()\\[\\]{}，。；：、]+`

const SCHEME_URL = new RegExp(`\\bhttps?://${URL_BODY}`, 'gi')
const FTP_URL = new RegExp(`\\bftp://${URL_BODY}`, 'gi')
const WWW_HOST = new RegExp(`\\bwww\\.[A-Za-z0-9-]+\\.[A-Za-z]{2,}(?::\\d{1,5})?(?:/${URL_BODY})?`, 'gi')
const BARE_HOST = new RegExp(`\\b(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0)(?::\\d{1,5})(?:/${URL_BODY})?`, 'gi')

/** Trailing punctuation that belongs to the sentence, not the URL. */
const TRAILING = /[.,;:!?)\]}>"'，。；：、]+$/

export interface FoundLink {
  /** absolute offset of the first character, within the logical line */
  start: number
  /** absolute offset one past the last character */
  end: number
  /** the clickable target, scheme guaranteed */
  url: string
}

/** Match every URL in one logical line of text. */
export function findUrls(text: string): FoundLink[] {
  const out: FoundLink[] = []
  const scan = (re: RegExp, withScheme: boolean): void => {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const trimmed = m[0].replace(TRAILING, '')
      if (!trimmed) continue
      out.push({
        start: m.index,
        end: m.index + trimmed.length,
        url: withScheme ? trimmed : `http://${trimmed}`
      })
    }
  }
  scan(SCHEME_URL, true)
  scan(FTP_URL, true)
  // `www.…` (and the bare host forms) get an http:// target when opened.
  scan(WWW_HOST, false)
  scan(BARE_HOST, false)
  // A bare host inside a scheme URL (`http://localhost:5000`) matches both
  // patterns; keep the longer, scheme-carrying one.
  out.sort((a, b) => a.start - b.start || b.end - a.end)
  const kept: FoundLink[] = []
  for (const link of out) {
    if (kept.some((k) => link.start < k.end && link.end > k.start)) continue
    kept.push(link)
  }
  return kept
}
