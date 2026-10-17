/**
 * Fail-closed guard for the --ot-* semantic layer's NAMES (not values).
 *
 * CSS custom properties are case-sensitive, so `setProperty('--ot-dangerFg')`
 * does NOT satisfy `var(--ot-danger-fg)`: the reference just falls back to the
 * dark :root literal and the light theme silently loses its fix. Value tests
 * (semantic-theme / theme-contrast) cannot see that, so this test locks the
 * three sets together:
 *   1) every var(--ot-*) referenced in renderer source is actually emitted;
 *   2) the :root static fallback block declares exactly the emitted names;
 *   3) both semanticVars() branches emit the same key set (a key that only
 *      exists on one branch leaves the other theme with a stale :root value).
 * It also asserts the keys ARE the final CSS names (lowercase --ot-*), so the
 * camelCase intermediate naming that broke v1.0.29 can never come back.
 * Run: node tests/ot-var-names.mjs  (must exit 0)
 */
import fs from 'node:fs'
import path from 'node:path'
import { semanticVars } from '../src/renderer/src/theme/semantic.ts'

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}

const ROOT = path.resolve('src/renderer/src')
// Single naming system: semanticVars() keys ARE the custom property names, so
// what chrome.ts writes is exactly what this test inspects.
const names = (vars) => new Set(Object.keys(vars).filter((k) => k !== 'color-scheme'))

// --- what JS emits, per branch ---------------------------------------------
const darkVars = semanticVars({ background: '#1e1e1e', foreground: '#cccccc' }, false)
const lightVars = semanticVars({ background: '#f6f8fa', foreground: '#383a42' }, true)
const darkNames = names(darkVars)
const lightNames = names(lightVars)

// --- self-test: the keys must BE the final CSS names ------------------------
// Custom properties are case-sensitive: a camelCase key would never satisfy
// var(--ot-text-muted), so a miss here is the silent-fallback regression.
console.log('keys are final CSS names (lowercase --ot-*):')
for (const [label, vars] of [['dark', darkVars], ['light', lightVars]]) {
  const keys = Object.keys(vars).filter((k) => k !== 'color-scheme')
  const bad = keys.filter((k) => !/^--ot-[a-z0-9-]+$/.test(k)).sort()
  ok(bad.length === 0, `${label}: all ${keys.length} keys match /^--ot-[a-z0-9-]+$/${bad.length ? ` — bad: ${bad.join(', ')}` : ''}`)
  ok(keys.length > 0, `${label}: emits names (guard is not vacuous)`)
}
ok(Object.keys(darkVars).some((k) => k === '--ot-text-muted'), 'multi-word name is kebab-case (--ot-text-muted)')
ok(Object.keys(darkVars).some((k) => k === '--ot-danger-fg'), 'compound name is kebab-case (--ot-danger-fg)')

console.log('branches emit the same key set:')
const onlyDark = [...darkNames].filter((n) => !lightNames.has(n)).sort()
const onlyLight = [...lightNames].filter((n) => !darkNames.has(n)).sort()
ok(onlyDark.length === 0, `no dark-only keys${onlyDark.length ? ` (${onlyDark.join(', ')})` : ''}`)
ok(onlyLight.length === 0, `no light-only keys${onlyLight.length ? ` (${onlyLight.join(', ')})` : ''}`)
ok(darkVars['color-scheme'] === 'dark' && lightVars['color-scheme'] === 'light', 'color-scheme switches per branch')

// --- what the CSS references ------------------------------------------------
function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    if (fs.statSync(p).isDirectory()) walk(p, out)
    else if (/\.(css|tsx|ts)$/.test(f)) out.push(p)
  }
  return out
}
const referenced = new Set()
for (const file of walk(ROOT)) {
  for (const m of fs.readFileSync(file, 'utf8').matchAll(/var\((--ot-[A-Za-z0-9-]+)/g)) referenced.add(m[1])
}

console.log('every referenced var is emitted:')
const dangling = [...referenced].filter((n) => !darkNames.has(n)).sort()
ok(dangling.length === 0, dangling.length ? `dangling: ${dangling.join(', ')}` : `${referenced.size} reference(s) all emitted`)

// --- the static :root block in global.css ----------------------------------
const css = fs.readFileSync(path.join(ROOT, 'global.css'), 'utf8')
const rootBlock = /:root\s*\{([\s\S]*?)\}/.exec(css)
const declared = new Set()
if (rootBlock) for (const m of rootBlock[1].matchAll(/(--ot-[A-Za-z0-9-]+)\s*:/g)) declared.add(m[1])

console.log(':root fallback block matches the emitted set (no dark-only leftovers):')
const undeclared = [...darkNames].filter((n) => !declared.has(n)).sort()
const extra = [...declared].filter((n) => !darkNames.has(n)).sort()
ok(rootBlock !== null, ':root block found in global.css')
ok(undeclared.length === 0, undeclared.length ? `emitted but not declared: ${undeclared.join(', ')}` : 'all emitted names declared')
ok(extra.length === 0, extra.length ? `declared but never emitted: ${extra.join(', ')}` : 'no extra declared names')

if (failed > 0) {
  console.error(`ot-var-names: ${failed} check(s) failed`)
  process.exit(1)
}
console.log('ot-var-names: all ok')
