/**
 * Local-path admission for the files the main process is asked to read or write
 * on behalf of the renderer (SFTP transfers, ZMODEM send/receive).
 *
 * Threat model: the renderer is the untrusted half of the app. Every local path
 * it sends over IPC used to be taken at face value, so a compromised renderer
 * (a navigation that slipped past the frame guard, a future caller that forgets
 * the dialog) could make the main process read or write anywhere the user can
 * reach. Local paths are therefore *granted* first, and the only grant source is
 * a native file / directory dialog (sftp.ts's pickFiles / pickDirectory) — an
 * explicit choice the user made with their own hands.
 *
 * Granting and checking both go through realpath: the registry stores resolved
 * paths, and a candidate that does not resolve (missing file, dead drive,
 * unreadable parent) is never granted and never accepted. Comparing only the
 * literal spelling would let a symlinked parent steer a path that *looks* like
 * it sits inside a granted directory somewhere else entirely — the resolved path
 * is the only one that answers "where would this actually read/write?".
 *
 * Grant lifetime is the process: a directory the user picked as a save target
 * stays valid for later transfers into it. Each dialog returns at most a handful
 * of paths, so both sets stay tiny.
 *
 * `grantedPaths` is the real policy and the DEFAULT for every consumer, so a
 * caller that forgets to inject one is still enforced. `LocalPathPolicy` exists
 * only so the offline test harnesses (which have no dialog to grant from) can
 * supply a double; it is never reachable from renderer input.
 */
import { realpathSync, statSync } from 'fs'
import { basename, join, sep } from 'path'

/**
 * What the transfer engines need to know about local paths. Implemented by
 * `grantedPaths` below; tests inject a permissive double.
 *
 * The methods return the *resolved* path to use rather than a boolean, so the
 * caller opens exactly what was checked — re-joining or re-reading the original
 * spelling would reopen the symlink window the check just closed.
 */
export interface LocalPathPolicy {
  /** The local file an upload may read, or null when it must be refused. */
  readSource(path: unknown): string | null
  /** The local directory a download may be written into, or null. */
  readDirectory(dir: unknown): string | null
  /**
   * The local path a write of `fileName` into `dir` may go to, or null when it
   * must be refused. `fileName` comes off the wire (a remote file's basename,
   * or the name a ZMODEM peer offered).
   */
  writeTarget(dir: unknown, fileName: unknown): string | null
}

const grantedFiles = new Set<string>()
const grantedDirs = new Set<string>()

/**
 * Windows compares paths case-insensitively; drive-letter and name casing must
 * not decide whether a granted path matches. Applied to comparisons only — a
 * path handed back to a caller keeps the casing the filesystem reported.
 */
const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)

/** Real path of an existing regular file, or null. */
function realFile(p: unknown): string | null {
  if (typeof p !== 'string' || p === '') return null
  try {
    const real = realpathSync(p)
    return statSync(real).isFile() ? real : null
  } catch {
    return null
  }
}

/** Real path of an existing directory, or null. */
function realDir(p: unknown): string | null {
  if (typeof p !== 'string' || p === '') return null
  try {
    const real = realpathSync(p)
    return statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

/** Whether a folded, already-resolved directory sits at or under a granted dir. */
function isGrantedKey(key: string): boolean {
  for (const dir of grantedDirs) {
    if (key === dir || key.startsWith(dir + sep)) return true
  }
  return false
}

/** A single path segment: no separators, no `.`/`..`, not empty. */
function isPlainLeaf(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name !== '' &&
    name !== '.' &&
    name !== '..' &&
    basename(name) === name
  )
}

/**
 * Grant the files a native "open file" dialog just returned. A non-file in the
 * list (a path that vanished between the dialog and here) grants nothing —
 * everything reaches the engine through realpath, so an unresolvable entry can
 * never match later either.
 */
export function grantPickedFiles(paths: unknown): void {
  if (!Array.isArray(paths)) return
  for (const p of paths) {
    const real = realFile(p)
    if (real !== null) grantedFiles.add(fold(real))
  }
}

/** Grant the directory a native "open directory" dialog just returned. */
export function grantPickedDirectory(dir: unknown): void {
  const real = realDir(dir)
  if (real !== null) grantedDirs.add(fold(real))
}

/**
 * The real policy. Every method re-resolves the path at check time: a file that
 * has since been deleted, replaced by a directory, or had a symlink swapped in
 * over it fails, even though it was granted earlier.
 */
export const grantedPaths: LocalPathPolicy = {
  readSource(path: unknown): string | null {
    const real = realFile(path)
    return real !== null && grantedFiles.has(fold(real)) ? real : null
  },

  readDirectory(dir: unknown): string | null {
    const real = realDir(dir)
    return real !== null && isGrantedKey(fold(real)) ? real : null
  },

  writeTarget(dir: unknown, fileName: unknown): string | null {
    const dirReal = realDir(dir)
    if (dirReal === null) return null
    const key = fold(dirReal)
    if (!isGrantedKey(key)) return null
    // Checked as a plain leaf first: a name still carrying a separator, or the
    // bare `..`, must not climb out of the directory the user chose.
    if (!isPlainLeaf(fileName)) return null
    // The join is made against the *resolved* directory, so the containment
    // check and the actual write agree on the target.
    const target = join(dirReal, fileName)
    let resolved: string
    try {
      resolved = realpathSync(target)
    } catch {
      // Not on disk yet: a fresh file created directly inside the granted dir.
      return target
    }
    // Something is already there. Resolve it too: a symlink planted at that
    // name would otherwise land the bytes somewhere else entirely while the
    // write still looks like it targets the download folder.
    const targetKey = fold(resolved)
    if (targetKey === key || !targetKey.startsWith(key + sep)) return null
    return target
  }
}
