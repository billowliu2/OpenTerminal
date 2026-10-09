/**
 * SSH connections-store self-test (connections-store.mjs).
 *
 * Bundles src/main/connectionsStore.ts for plain Node with the in-memory
 * electron stub, then verifies against a temp userData dir: bookmark CRUD,
 * input coercion, the public/secret split (no `*_enc` value ever leaves the
 * store, secrets come back only through getSecret) and the corrupt-file
 * backup guard.
 *
 * The stub reports safeStorage as unavailable, so the store takes its
 * documented dev fallback and persists secrets as `plain:<base64>`; the tests
 * below assert on that prefix rather than on OS-encrypted ciphertext.
 *
 * Build: npx esbuild src/main/connectionsStore.ts --bundle --platform=node \
 *        --format=cjs --outfile=tests/.connections-store.cjs \
 *        --alias:electron=./tests/electron-stub.cjs
 * Run:   node tests/connections-store.mjs   (must exit 0)
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'module'
const require_ = createRequire(import.meta.url)

const fail = (msg) => {
  console.error(`FAIL: ${msg}`)
  process.exit(1)
}
const ok = (cond, msg) => {
  if (!cond) fail(msg)
  console.log(`  ok: ${msg}`)
}

// ---- 1. Bundle the store once (assumes tests/.connections-store.cjs exists) -----
const userData = mkdtempSync(join(tmpdir(), 'm-conn-'))
process.env.OT_STUB_USERDATA = userData
let mod
try {
  mod = require_('./.connections-store.cjs')
} catch {
  fail('bundle not found — run: node tests/build-bundles.cjs (or the esbuild line in the header)')
}

// ---- 2. Store over a temp file -------------------------------------------------
const file = join(userData, 'connections.json')
ok(
  mod.defaultConnectionsPath(userData) === `${userData}/connections.json`,
  'defaultConnectionsPath is <userData>/connections.json'
)
const store = new mod.ConnectionsStore(file)
const rawList = () => JSON.parse(readFileSync(file, 'utf8'))

ok(store.listConnections().length === 0, 'missing file -> empty list, no throw')

// ---- 3. Create + the public/secret split ---------------------------------------
const a = store.saveConnection({
  name: 'web',
  host: '10.0.0.1',
  port: 22,
  username: 'root',
  auth: 'password',
  askPasswordAtConnect: false,
  askPassphraseAtConnect: false,
  keepaliveIntervalSec: 30,
  password: 's3cret',
  highlightProfileId: 'prof-1'
})
ok(typeof a.id === 'string' && a.id.length > 0, 'saveConnection assigns an id + createdAt')
ok(a.savedAuth.hasPassword === true, 'savedAuth.hasPassword reflects the stored secret')
ok(!('password' in a) && !('password_enc' in a), 'the returned record carries no secret field')
ok(a.highlightProfileId === 'prof-1', 'highlightProfileId round-trips')

const persistedA = rawList().find((c) => c.id === a.id)
ok(persistedA.password_enc.startsWith('plain:'), 'secret is persisted via the safeStorage fallback marker')
ok(!('password' in persistedA), 'plaintext secret is never written to disk')
ok(store.getSecret(a, 'password') === 's3cret', 'getSecret decrypts the stored password')
ok(store.getSecret(a, 'keyContent') === undefined, 'getSecret of an absent secret is undefined')

// ---- 4. Update in place: omitted secrets survive, '' clears ---------------------
const updated = store.saveConnection({
  id: a.id,
  name: 'web-2',
  host: '10.0.0.2',
  port: 2222,
  username: 'admin',
  auth: 'privateKey',
  askPasswordAtConnect: false,
  askPassphraseAtConnect: true,
  keepaliveIntervalSec: 0,
  keyContent: 'KEY'
})
ok(store.listConnections().length === 1, 'update by id keeps the count at 1')
ok(updated.name === 'web-2' && updated.host === '10.0.0.2' && updated.port === 2222, 'public fields updated')
ok(updated.createdAt === a.createdAt, 'update preserves createdAt')
ok(updated.savedAuth.hasPassword === true, 'omitting a secret keeps the previously stored one')
ok(store.getSecret(updated, 'password') === 's3cret', 'and that secret still decrypts')
ok(store.getSecret(updated, 'keyContent') === 'KEY', 'newly supplied secret is stored')
ok(updated.highlightProfileId === undefined, 'an omitted highlightProfileId clears the binding')

const cleared = store.saveConnection({
  id: a.id,
  name: 'web-2',
  host: '10.0.0.2',
  port: 2222,
  username: 'admin',
  auth: 'password',
  askPasswordAtConnect: true,
  askPassphraseAtConnect: false,
  keepaliveIntervalSec: 0,
  password: ''
})
ok(cleared.savedAuth.hasPassword === false, 'an empty secret string clears the stored value')
ok(store.getSecret(cleared, 'password') === undefined, 'and the cleared secret reads back undefined')

// ---- 5. Malformed input is coerced, never persisted as-is -----------------------
const coerced = store.saveConnection({
  name: 'bad',
  host: '  10.9.9.9  ',
  port: '22',
  username: 'u',
  auth: 'nope',
  askPasswordAtConnect: 'yes',
  askPassphraseAtConnect: 1,
  keepaliveIntervalSec: Number.NaN,
  group: '',
  keyPath: '',
  highlightProfileId: ''
})
ok(coerced.port === 22, 'a string port is coerced to a number')
ok(coerced.host === '10.9.9.9', 'host is trimmed')
ok(coerced.auth === 'password', 'unknown auth falls back to password')
ok(coerced.askPasswordAtConnect === false, 'a non-boolean ask flag collapses to false')
ok(coerced.keepaliveIntervalSec === 0, 'a NaN keepalive collapses to 0')
ok(coerced.group === undefined && coerced.keyPath === undefined, 'empty optional strings collapse to undefined')
ok(coerced.highlightProfileId === undefined, 'an empty highlightProfileId collapses to undefined')
const outOfRange = store.saveConnection({
  name: 'bad-port',
  host: 'h',
  port: 70000,
  username: 'u',
  auth: 'password',
  askPasswordAtConnect: false,
  askPassphraseAtConnect: false,
  keepaliveIntervalSec: -5
})
ok(outOfRange.port === 22 && outOfRange.keepaliveIntervalSec === 0, 'out-of-range numbers fall back to defaults')

// ---- 6. touch / delete ---------------------------------------------------------
store.touch(coerced.id, 1234567890)
const touched = store.listConnections().find((c) => c.id === coerced.id)
ok(touched.lastConnectedAt === 1234567890, 'touch persists lastConnectedAt')
const beforeTouch = rawList().length
store.touch('no-such-id')
ok(rawList().length === beforeTouch, 'touch of an unknown id is a no-op')

store.deleteConnection(coerced.id)
ok(!store.listConnections().some((c) => c.id === coerced.id), 'deleteConnection removes the bookmark')
const afterDelete = rawList().length
store.deleteConnection('no-such-id')
ok(rawList().length === afterDelete, 'delete of an unknown id is a no-op')

// ---- 7. Corrupt connections.json is backed up, never silently replaced ----------
// A file that exists but cannot be parsed used to be treated exactly like a
// missing one: the next write (a bookmark edit, or just a touch() after
// connecting) rewrote the file from an empty list, destroying every saved host
// and its credentials. The original must be copied aside first.
const survivors = rawList()
const corrupt = `${JSON.stringify(survivors).slice(0, 40)}` // truncated JSON: parses nowhere
writeFileSync(file, corrupt, 'utf8')
store.saveConnection({
  name: 'after-corruption',
  host: 'h',
  port: 22,
  username: 'u',
  auth: 'password',
  askPasswordAtConnect: false,
  askPassphraseAtConnect: false,
  keepaliveIntervalSec: 0
})
const bak = `${file}.bak`
ok(existsSync(bak), 'corrupt connections.json is backed up to .bak')
ok(readFileSync(bak, 'utf8') === corrupt, '.bak holds the corrupt original byte for byte')
const rewritten = rawList()
ok(Array.isArray(rewritten) && rewritten.length === 1 && rewritten[0].name === 'after-corruption', 'the new bookmark is written normally after the backup')

// A second corrupt episode must not overwrite the first backup.
writeFileSync(file, 'not json at all', 'utf8')
store.listConnections()
ok(readFileSync(bak, 'utf8') === corrupt, 'an existing .bak is kept (earliest evidence wins)')

// A store whose file does not exist yet (first run) backs up nothing.
const freshDir = mkdtempSync(join(tmpdir(), 'm-conn-fresh-'))
const fresh = new mod.ConnectionsStore(join(freshDir, 'connections.json'))
fresh.saveConnection({
  name: 'first',
  host: 'h',
  port: 22,
  username: 'u',
  auth: 'password',
  askPasswordAtConnect: false,
  askPassphraseAtConnect: false,
  keepaliveIntervalSec: 0
})
ok(!existsSync(join(freshDir, 'connections.json.bak')), 'a missing file (ENOENT) is not backed up')
ok(existsSync(join(freshDir, 'connections.json')), 'and the first write lands normally')
rmSync(freshDir, { recursive: true, force: true })

// ---- 7b. Valid JSON of the wrong shape is backed up too --------------------------
// `{}` parses fine, so the parse-catch never saw it: the file used to be treated
// exactly like a missing one and the next write replaced every bookmark with an
// empty list. A file that is not the array we wrote is unreadable, not empty —
// same backup + empty-state exit as the corrupt case above.
const shapeDir = mkdtempSync(join(tmpdir(), 'm-conn-shape-'))
const shapeFile = join(shapeDir, 'connections.json')
const shapeStore = new mod.ConnectionsStore(shapeFile)
const wrongShape = '{"connections":[]}'
writeFileSync(shapeFile, wrongShape, 'utf8')
ok(shapeStore.listConnections().length === 0, 'a wrong-shaped connections.json loads as an empty list')
const shapeBak = `${shapeFile}.bak`
ok(existsSync(shapeBak), 'a wrong-shaped connections.json is backed up to .bak')
ok(readFileSync(shapeBak, 'utf8') === wrongShape, '.bak holds the wrong-shaped original byte for byte')
const shapeSaved = shapeStore.saveConnection({
  name: 'after-shape-mismatch',
  host: 'h',
  port: 22,
  username: 'u',
  auth: 'password',
  askPasswordAtConnect: false,
  askPassphraseAtConnect: false,
  keepaliveIntervalSec: 0
})
const shapeList = JSON.parse(readFileSync(shapeFile, 'utf8'))
ok(
  Array.isArray(shapeList) && shapeList.length === 1 && shapeList[0].id === shapeSaved.id,
  'the new bookmark is written normally after the backup'
)

// A second wrong-shape episode must not overwrite the first backup.
writeFileSync(shapeFile, '{"nope":true}', 'utf8')
shapeStore.listConnections()
ok(readFileSync(shapeBak, 'utf8') === wrongShape, 'an existing .bak is kept (earliest evidence wins)')
rmSync(shapeDir, { recursive: true, force: true })

// An unreadable path (here: a directory) must still load as empty and never
// throw — the backup is best effort and may itself fail.
const dirCase = mkdtempSync(join(tmpdir(), 'm-conn-dir-'))
mkdirSync(join(dirCase, 'connections.json'))
const dirStore = new mod.ConnectionsStore(join(dirCase, 'connections.json'))
let listed
let threw = false
try {
  listed = dirStore.listConnections()
} catch {
  threw = true
}
ok(!threw && listed.length === 0, 'an unreadable file (EISDIR) loads as empty instead of throwing')
ok(!existsSync(join(dirCase, 'connections.json.bak')), 'and a backup that cannot be made leaves no litter')
rmSync(dirCase, { recursive: true, force: true })

// All stores wrote into temp dirs; drop them so repeated runs do not litter.
rmSync(userData, { recursive: true, force: true })

console.log('\n[connections] ALL CHECKS PASSED')
process.exit(0)
