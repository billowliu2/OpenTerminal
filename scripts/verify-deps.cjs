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

/* Classification gate: only packages that src/main/ or src/preload/ actually
   import may sit in `dependencies`. The renderer is fully bundled by Vite
   (externalizeDepsPlugin does not apply to it), so a renderer-only package in
   `dependencies` is dead weight in the installer — and, far worse, a
   main-process package DEMOTED to devDependencies gets externalized by the
   build and silently dropped from the packaged app. */
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const runtimeDeps = Object.keys(pkg.dependencies ?? {})
const devDeps = Object.keys(pkg.devDependencies ?? {})
// `electron` is imported by src/main everywhere but lives in devDependencies
// (electron-vite injects it at build time); Node builtins are not packages.
const BUILTINS = new Set(require('node:module').builtinModules)
const IGNORED = new Set(['electron'])

/** Bare (non-relative) specifiers actually imported at runtime under a directory.
 *
 *  Parsed with the TypeScript compiler API (not a regex): a regex like
 *  /(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/ also matches
 *  `from '...'` inside comments and string literals, which lets a commented-out
 *  import keep a now-unused package "legitimately" in `dependencies` — exactly
 *  the drift this gate exists to catch. The AST sees only real tokens:
 *   - static imports/exports (incl. the bare `import 'x'` side-effect form),
 *   - `require('x')` and dynamic `import('x')` call expressions;
 *  and `import type` / `import { type T }` are NOT runtime imports, so a
 *  type-only usage never counts as "main process imports this package". */
function bareImports(dir) {
  const found = new Set()
  const ts = require('typescript')
  const walkDir = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name)
      if (entry.isDirectory()) walkDir(p)
      else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) {
        const src = fs.readFileSync(p, 'utf8')
        let sourceFile
        try {
          sourceFile = ts.createSourceFile(p, src, ts.ScriptTarget.Latest, true)
        } catch (err) {
          // Fail closed: a source we cannot parse must not silently pass the
          // classification gate (an unparsed file could hide a real import).
          console.error(`verify-deps: cannot parse ${p}: ${err?.message ?? err}`)
          process.exit(1)
        }
        const consider = (spec) => {
          if (typeof spec !== 'string') return
          if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('@shared/')) return
          if (spec.startsWith('node:')) return
          // `pkg/sub` -> `pkg`; `@scope/pkg/sub` -> `@scope/pkg`
          const name = spec.startsWith('@')
            ? spec.split('/').slice(0, 2).join('/')
            : spec.split('/')[0]
          if (IGNORED.has(name) || BUILTINS.has(name)) return
          found.add(name)
        }
        const visit = (node) => {
          if (ts.isImportDeclaration(node)) {
            // `import type { T } from 'x'` declares no runtime binding.
            if (node.importClause?.isTypeOnly) return
            // A per-binding type modifier inside a non-type-only clause (e.g.
            // `import { type T, val } from 'x'`) still means the specifier is
            // genuinely imported at runtime via `val`, so only a fully
            // type-only clause is skipped. `import 'x'` (no importClause) is a
            // runtime side effect.
            if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
              consider(node.moduleSpecifier.text)
            }
          } else if (ts.isExportDeclaration(node)) {
            // `export type { T } from 'x'` re-exports types only.
            if (node.isTypeOnly) return
            if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
              consider(node.moduleSpecifier.text)
            }
          } else if (ts.isCallExpression(node)) {
            // `require('x')` (CommonJS) and dynamic `import('x')`.
            const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
            const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
            if ((isRequire || isDynamicImport) && node.arguments.length === 1) {
              const arg = node.arguments[0]
              if (ts.isStringLiteral(arg)) consider(arg.text)
            }
          }
          ts.forEachChild(node, visit)
        }
        visit(sourceFile)
      }
    }
  }
  walkDir(dir)
  return found
}

const mainImports = new Set([
  ...bareImports(path.join(ROOT, 'src', 'main')),
  ...bareImports(path.join(ROOT, 'src', 'preload'))
])

const misclassified = []
for (const name of runtimeDeps) {
  if (!mainImports.has(name)) misclassified.push(`${name} is in dependencies but src/main|preload never imports it`)
}
for (const name of devDeps) {
  if (IGNORED.has(name) || BUILTINS.has(name)) continue
  if (mainImports.has(name)) misclassified.push(`${name} is imported by src/main|preload but sits in devDependencies`)
}

if (misclassified.length) {
  console.error('dependency classification is wrong:')
  for (const line of misclassified) console.error(`  ${line}`)
  console.error('\n只有 src/main/ 或 src/preload/ 实际 import 的包才能进 dependencies。')
  process.exit(1)
}

console.log(`dependencies ok: ${checked} packages verified, ${skippedOptional} optional entries skipped`)
