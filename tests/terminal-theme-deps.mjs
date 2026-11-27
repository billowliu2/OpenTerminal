/**
 * Terminal theme-effect dependency self-test (terminal-theme-deps.mjs).
 *
 * xterm 6.1 builds and discards a TextureAtlas on EVERY `options.theme`
 * assignment (xtermjs/xterm.js#6291, unfixed upstream), so the theme effect
 * must depend on EXACTLY what the assignment consumes: the theme id, the
 * custom themes and whether a background image is set.
 *
 * The effect used to depend on the whole theme/bg option groups, which also
 * carry the contrast floor and the scrim opacity/dim — so dragging the
 * background-opacity slider re-assigned `options.theme` on every open pane
 * and burned a texture atlas per assignment.
 *
 * This is a structural test: the dependency array is the contract, and it is
 * the part a refactor is most likely to widen again.
 *
 * Run: node tests/terminal-theme-deps.mjs   (must exit 0)
 */
import { readFileSync } from 'node:fs'

const SRC = 'src/renderer/src/terminal/TerminalView.tsx'
const src = readFileSync(SRC, 'utf8')

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}

// Every `useEffect(() => { ... }, [deps])` block in the component.
const effects = [...src.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[([^\]]*)\]\)/g)].map((m) => ({
  body: m[1],
  deps: m[2]
}))

console.log('[theme effect dependencies]')
{
  const themeEffect = effects.find((e) => e.body.includes('term.options.theme'))
  ok(themeEffect !== undefined, 'the theme effect exists')
  if (themeEffect) {
    ok(
      themeEffect.deps.trim() === 'themeOpts',
      `the theme effect depends on EXACTLY themeOpts (deps: ${JSON.stringify(themeEffect.deps.trim())})`
    )
    ok(
      !/minimumContrastRatio/.test(themeEffect.body),
      'the theme effect does not set the contrast floor'
    )
  }
}

console.log('[contrast floor has its own effect]')
{
  const contrastEffect = effects.find((e) => e.body.includes('term.options.minimumContrastRatio'))
  ok(contrastEffect !== undefined, 'the contrast floor is assigned in an effect')
  if (contrastEffect) {
    ok(
      contrastEffect.deps.trim() === 'contrastOpts',
      `the contrast effect depends on EXACTLY contrastOpts (deps: ${JSON.stringify(contrastEffect.deps.trim())})`
    )
    ok(
      !contrastEffect.body.includes('term.options.theme'),
      'the contrast effect does not touch options.theme'
    )
  }
}

if (failed > 0) {
  console.error(`\n[terminal-theme-deps] ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('\n[terminal-theme-deps] ALL CHECKS PASSED')