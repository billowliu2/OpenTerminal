// Real-server SFTP verification (M4). Credentials from env (never hardcoded):
//   JD_HOST / JD_USER / JD_PASS
// Prereq bundles: tests/.session-e2e.cjs (pty session layer), tests/.sftp-svc.cjs (sftp service)
import { createRequire } from 'module'
import { randomUUID } from 'crypto'
import { promises as fsp } from 'fs'
const require_ = createRequire(import.meta.url)
const sessionLayer = require_('./.session-e2e.cjs')
const sftpMod = await import('./.sftp-svc.mjs')
sftpMod.registerSftpClientProvider((id) => sessionLayer.getSshClient(id))

const events = []
sessionLayer.configureSessionRuntime({
  broadcast: (channel, payload) => events.push({ channel, payload }),
  getConnection: () => ({
    id: 'jd',
    name: 'test',
    host: process.env.JD_HOST,
    port: 22,
    username: process.env.JD_USER,
    auth: 'password',
    askPasswordAtConnect: false,
    askPassphraseAtConnect: false,
    keepaliveIntervalSec: 30,
    createdAt: Date.now(),
    savedAuth: { hasPassword: true, hasKeyContent: false, hasPassphrase: false }
  }),
  getSecret: () => process.env.JD_PASS,
  touch: () => {},
  knownHosts: { check: () => ({ status: 'match' }), accept: () => {} },
  promptHostKey: () => { throw new Error('unexpected prompt') }
})

const fail = (m) => { console.error('FAIL:', m); process.exit(1) }
if (!process.env.JD_HOST) { console.error('set JD_HOST/JD_USER/JD_PASS'); process.exit(2) }

console.log('[sftp] connecting ...')
const { id } = await sessionLayer.openSession({ kind: 'ssh', connectionId: 'jd' })
console.log('[sftp] session ready')

const root = await sftpMod.listRemote(id, '/')
if (!root.some((e) => e.isDir)) fail('no directories listed in /')
console.log('[sftp] listRemote(/) ok,', root.length, 'entries')

const dir = '/root/ot_sftp_test'
// tolerate leftovers from earlier aborted runs
await sftpMod.deleteRemote(id, [dir]).catch(() => undefined)
await sftpMod.mkdirRemote(id, '/root', 'ot_sftp_test')
console.log('[sftp] mkdir ok')

const content = randomUUID() + '\n' + 'x'.repeat(256 * 1024)
const localFile = `./.sftp-test-${Date.now()}.bin`
await fsp.writeFile(localFile, content, 'utf8')
console.log('[debug] alive before upload:', !!sessionLayer.getSshClient(id))
try {
  await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('upload timeout 60s')), 60000)
  sftpMod.uploadRemote(id, [localFile], dir, (e) => {
    if (e.state === 'done') { clearTimeout(timer); resolve() }
    if (e.state === 'error') { clearTimeout(timer); reject(new Error(e.error ?? 'upload error')) }
  })
})
  console.log('[debug] alive after upload:', !!sessionLayer.getSshClient(id))
} catch (err) {
  console.error('[debug] upload error:', err.message)
  console.error('[debug] alive:', !!sessionLayer.getSshClient(id))
  console.error('[debug] alive:', !!sessionLayer.getSshClient(id))
  console.error('[debug] exits:', JSON.stringify(events.filter((e) => e.channel === 'pty:exit')))
  console.error('[debug] all events:', JSON.stringify(events.map((e) => e.channel)))
  throw err
}
await new Promise((r) => setTimeout(r, 500))
console.log('[debug] alive after 500ms sleep:', !!sessionLayer.getSshClient(id))
console.log('[debug] events so far:', JSON.stringify(events.map((e) => e.channel)))
const uploaded = await sftpMod.listRemote(id, dir)
const entry = uploaded.find((e) => e.name.endsWith('.bin'))
if (!entry || entry.size !== Buffer.byteLength(content)) fail(`upload size mismatch: ${entry?.size}`)
console.log('[sftp] upload ok,', entry.size, 'bytes')

const dlDir = `./.sftp-dl-${Date.now()}`
await fsp.mkdir(dlDir, { recursive: true })
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('download timeout 60s')), 60000)
  sftpMod.downloadRemote(id, [entry.path], dlDir, (e) => {
    if (e.state === 'done') { clearTimeout(timer); resolve() }
    if (e.state === 'error') { clearTimeout(timer); reject(new Error(e.error ?? 'download error')) }
  })
})
const back = await fsp.readFile(`${dlDir}/${entry.name}`, 'utf8')
if (back !== content) fail('download content mismatch')
console.log('[sftp] download round-trip ok')

await sftpMod.deleteRemote(id, [dir])
try {
  await sftpMod.listRemote(dir)
  fail('dir still exists after delete')
} catch {
  // expected — dir gone
}
console.log('[sftp] recursive delete ok')

const exits = events.filter((e) => e.channel === 'pty:exit')
console.log('[sftp] unexpected exits:', exits.length)

await fsp.rm(localFile, { force: true })
await fsp.rm(dlDir, { recursive: true, force: true })
sessionLayer.killPty(id)
console.log('[sftp] ALL CHECKS PASSED')
setTimeout(() => process.exit(0), 300)
