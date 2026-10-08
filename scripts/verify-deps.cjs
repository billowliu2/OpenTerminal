/* Dependency consistency gate: node_modules must match package-lock.json.

   Usage: node scripts/verify-deps.cjs   (runs first in `predist`)

   Why it exists: v1.0.21 shipped an input-method fix that never reached the
   build. @xterm/xterm had been pinned to 6.1.0-beta.304 in package.json, but
   node_modules still held 6.0.0 from an older install — `npm install
   --package-lock-only` (the last step of predist) rewrites only the lockfile,
   so the lockfile agreed with package.json while the tree on disk stayed
   stale, and the bundler took the stale tree. An install that never happened
   is invisible to every other check, so it gets its own gate here.

   Scope: version equality only, for every entry the lockfile lists under
   node_modules. The root entry ("") is deliberately excluded — bumping
   package.json makes the lockfile root version lag by design until the
   `npm install --package-lock-only` at the end of predist rewrites it. */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'))
const packages = lock.packages ?? {}

const mismatched = []
let checked = 0
// Optional entries are the cross-platform variants (darwin/linux/arm64 …) that
// npm records in the lockfile but never installs on this machine. Their absence
// is expected, not drift.
let skippedOptional = 0

for (const [key, entry] of Object.entries(packages)) {
  if (key === '' || !key.startsWith('node_modules/')) continue
  // The key is the path under node_modules, so it also resolves nested
  // ("node_modules/a/node_modules/b") and scoped ("node_modules/@scope/pkg")
  // entries without any name reconstruction.
  let installed
  try {
    installed = JSON.parse(fs.readFileSync(path.join(ROOT, key, 'package.json'), 'utf8')).version
  } catch {
    installed = undefined
  }
  if (installed === undefined) {
    if (entry.optional) skippedOptional++
    else mismatched.push([key, entry.version, 'MISSING'])
    continue
  }
  checked++
  if (installed !== entry.version) mismatched.push([key, entry.version, installed])
}

if (mismatched.length) {
  console.error('node_modules does not match package-lock.json:')
  for (const [name, expected, actual] of mismatched) {
    console.error(`  ${name}: lockfile expects ${expected}, installed ${actual}`)
  }
  console.error('\nnode_modules 与 package-lock.json 不一致，请运行 npm ci 重装依赖')
  process.exit(1)
}
console.log(`dependencies ok: ${checked} packages verified, ${skippedOptional} optional entries skipped`)
