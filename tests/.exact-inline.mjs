// Decisive test: exact sftp.ts upload code, inline (no esbuild bundle).
import { createRequire } from 'module'
import { promises as fsp } from 'fs'
const require_ = createRequire(import.meta.url)
const ssh2 = require_('ssh2')
const sessionLayer = require_('D:/Coding/Terminal/tests/.session-e2e.cjs')

let clientProvider
function p(fn) {
  return new Promise((resolve, reject) => {
    fn((err, res) => (err ? reject(err) : resolve(res)))
  })
}

sessionLayer.configureSessionRuntime({
  broadcast: () => {},
  getConnection: () => ({
    id: 'jd', name: 't', host: process.env.JD_HOST, port: 22, username: process.env.JD_USER,
    auth: 'password', askPasswordAtConnect: false, askPassphraseAtConnect: false,
    keepaliveIntervalSec: 30, createdAt: Date.now(),
    savedAuth: { hasPassword: true, hasKeyContent: false, hasPassphrase: false }
  }),
  getSecret: () => process.env.JD_PASS,
  touch: () => {},
  knownHosts: { check: () => ({ status: 'match' }), accept: () => {} },
  promptHostKey: () => { throw new Error('x') }
})

const { id } = await sessionLayer.openSession({ kind: 'ssh', connectionId: 'jd' })
const client = sessionLayer.getSshClient(id)

// --- exact sftp.ts upload pattern ---
const transfer = { kind: 'upload', cancelled: false }
const emit = (e) => console.log('[evt]', e.state, e.file, e.bytes + '/' + e.totalBytes, e.error ?? '')
const local = './.exact-test.bin'
const content = Buffer.alloc(256 * 1024, 2)
await fsp.writeFile(local, content)
const remote = '/root/ot_exact.bin'

await new Promise((resolve, reject) => {
  client.sftp((err, sftp) => (err != null ? reject(err) : resolve(sftp)))
})
const sftp = await new Promise((resolve, reject) => {
  client.sftp((err, sftp_) => (err != null ? reject(err) : resolve(sftp_)))
})
console.log('[exact] sftp channel open, calling fastPut')
await new Promise((resolve, reject) => {
  sftp.fastPut(local, remote, {
    concurrency: 4,
    step: (totalTransferred, _chunk, total) => {
      console.log('[exact] step', totalTransferred, '/', total)
      if (transfer.cancelled) {
        reject(new Error('已取消'))
        return
      }
    }
  }, (err) => (err ? reject(err) : resolve()))
})
const st = await new Promise((resolve, reject) => {
  sftp.stat(remote, (err, s) => (err ? reject(err) : resolve(s)))
})
console.log('[exact] OK, remote size:', st.size, 'expected:', content.length)
await new Promise((resolve, reject) => sftp.unlink(remote, (e) => (e ? reject(e) : resolve())))
await fsp.rm(local, { force: true })
sessionLayer.killPty(id)
process.exit(0)
