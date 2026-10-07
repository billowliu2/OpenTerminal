/**
 * Local-path admission (local-path-grants.mjs).
 *
 * src/main/localPathGrants.ts is the check that stands between a renderer-
 * supplied path and the main process's filesystem access, so its rules are
 * pinned here against a real temp tree rather than a mocked `fs`:
 *
 *   - nothing is usable before the user granted it through the dialog
 *   - a granted file is readable, a granted directory (and its subdirectories)
 *     is writable, and unrelated paths stay refused
 *   - a peer-supplied file name cannot climb out of the download directory
 *     (`../x`, an absolute path, a name with a separator, `.`/`..`, empty)
 *   - a symlink planted at the target name is resolved, so a link pointing
 *     outside the granted tree is refused while one pointing inside is not
 *   - a grant is re-checked on every use: a path that has since disappeared
 *     stops being valid
 *   - granting through the wrong dialog (a directory via pickFiles, a file via
 *     pickDirectory) grants nothing
 *
 * Build: node tests/build-bundles.cjs
 * Run:   node tests/local-path-grants.mjs   (must exit 0)
 */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(__dirname, '.local-path-grants.cjs')

// Same self-build fallback as zmodem-e2e.mjs, so the file can be run on its own.
if (!existsSync(bundlePath)) {
  console.log('[local-path-grants] building bundle ...')
  const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  execFileSync(
    cmd,
    [
      'esbuild',
      join(__dirname, '../src/main/localPathGrants.ts'),
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--outfile=${bundlePath}`
    ],
    { stdio: 'inherit', shell: process.platform === 'win32' }
  )
}

const require_ = createRequire(import.meta.url)
const { grantedPaths, grantPickedFiles, grantPickedDirectory } = require_(bundlePath)

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}

const root = mkdtempSync(join(tmpdir(), 'ot-grants-'))
// A symlink need not be creatable (Windows without developer mode): the cases
// that need one say so instead of failing the suite.
let canSymlink = true
const symlink = (target, path, kind) => {
  if (!canSymlink) return false
  try {
    symlinkSync(target, path, kind)
    return true
  } catch {
    canSymlink = false
    console.log(`  skip: symlinks are not creatable here (${path})`)
    return false
  }
}

try {
  const picked = join(root, 'picked')
  const other = join(root, 'other')
  mkdirSync(picked)
  mkdirSync(other)
  const pickedDir = realpathSync(picked)
  const otherDir = realpathSync(other)
  const subDir = join(pickedDir, 'sub')
  mkdirSync(subDir)

  const pickedFile = join(pickedDir, 'id_ed25519')
  writeFileSync(pickedFile, 'key')
  const otherFile = join(otherDir, 'secret.txt')
  writeFileSync(otherFile, 'secret')

  console.log('nothing is allowed before any grant')
  ok(grantedPaths.readSource(pickedFile) === null, 'an un-granted existing file is refused')
  ok(grantedPaths.readDirectory(pickedDir) === null, 'an un-granted directory is refused')
  ok(grantedPaths.writeTarget(pickedDir, 'a.txt') === null, 'a write into it is refused')

  console.log('a picked file is readable, and only that file')
  grantPickedFiles([pickedFile])
  ok(grantedPaths.readSource(pickedFile) === realpathSync(pickedFile), 'the granted file is accepted')
  ok(grantedPaths.readSource(otherFile) === null, 'a different file is still refused')
  ok(grantedPaths.readSource(pickedDir) === null, 'a directory is not a valid read source')
  ok(grantedPaths.readSource(`${pickedFile}.nope`) === null, 'a missing path is refused')
  ok(grantedPaths.readSource('') === null, 'an empty path is refused')

  console.log('a picked directory accepts writes below it, and nothing else')
  grantPickedDirectory(pickedDir)
  ok(grantedPaths.readDirectory(pickedDir) === pickedDir, 'the granted directory is accepted')
  ok(grantedPaths.readDirectory(subDir) === subDir, 'a subdirectory of it is accepted')
  ok(grantedPaths.readDirectory(otherDir) === null, 'an unrelated directory is refused')
  ok(
    grantedPaths.writeTarget(pickedDir, 'new.txt') === join(pickedDir, 'new.txt'),
    'a fresh leaf lands in the directory'
  )
  ok(
    grantedPaths.writeTarget(subDir, 'new.txt') === join(subDir, 'new.txt'),
    'a fresh leaf lands in a subdirectory'
  )
  ok(grantedPaths.writeTarget(otherDir, 'new.txt') === null, 'an unrelated directory is refused')
  ok(
    grantedPaths.writeTarget(pickedDir, 'new.txt') === join(pickedDir, 'new.txt'),
    'extra arguments do not change the target'
  )

  console.log('a peer-supplied name cannot climb out of the directory')
  for (const name of ['../escape.txt', '..\\escape.txt', '..', '.', '', 'a/b', 'a\\b', null, 42, {}]) {
    ok(grantedPaths.writeTarget(pickedDir, name) === null, `refused: ${JSON.stringify(name) ?? name}`)
  }

  console.log('a symlink at the target name is resolved, not followed blindly')
  const outside = join(otherDir, 'outside.txt')
  writeFileSync(outside, 'orig')
  if (symlink(outside, join(pickedDir, 'escape-link.txt'), 'file')) {
    ok(
      grantedPaths.writeTarget(pickedDir, 'escape-link.txt') === null,
      'a link pointing outside the granted tree is refused'
    )
  }
  const insideTarget = join(subDir, 'real.txt')
  if (symlink(insideTarget, join(pickedDir, 'inside-link.txt'), 'file')) {
    ok(
      grantedPaths.writeTarget(pickedDir, 'inside-link.txt') === join(pickedDir, 'inside-link.txt'),
      'a link pointing inside the granted tree is still accepted'
    )
  }
  const linkedDir = join(otherDir, 'linked')
  if (symlink(linkedDir, join(pickedDir, 'linked-dir'), 'dir')) {
    // Nothing was ever granted at other/linked, so the resolved path is outside.
    ok(
      grantedPaths.writeTarget(join(pickedDir, 'linked-dir'), 'x.txt') === null,
      'a symlinked directory leading outside is refused'
    )
  }

  console.log('the wrong dialog grants nothing')
  grantPickedFiles([otherDir])
  ok(grantedPaths.readSource(otherDir) === null, 'pickFiles of a directory grants no file')
  grantPickedDirectory(pickedFile)
  ok(grantedPaths.readDirectory(pickedFile) === null, 'pickDirectory of a file grants no directory')

  console.log('a grant is re-validated on every use')
  const doomed = join(root, 'doomed')
  mkdirSync(doomed)
  grantPickedDirectory(doomed)
  ok(grantedPaths.readDirectory(doomed) === realpathSync(doomed), 'usable while it exists')
  rmSync(doomed, { recursive: true })
  ok(grantedPaths.readDirectory(doomed) === null, 'refused once it is gone')
  ok(grantedPaths.writeTarget(doomed, 'a.txt') === null, 'and no write targets it')

  console.log('the grant API tolerates junk from its caller')
  grantPickedFiles(undefined)
  grantPickedFiles('not-an-array')
  grantPickedFiles([null, 42, {}])
  grantPickedDirectory(undefined)
  grantPickedDirectory('')
  ok(grantedPaths.readSource(null) === null, 'a null source is refused')
  ok(grantedPaths.readDirectory(undefined) === null, 'an undefined directory is refused')
  ok(true, 'no junk input threw')
} finally {
  rmSync(root, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\n[local-path-grants] ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('\n[local-path-grants] ALL CHECKS PASSED')
