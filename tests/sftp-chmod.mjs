// Real-server chmod/chown + mode-string verification (M4). Credentials from env:
//   JD_HOST / JD_USER / JD_PASS
// Prereq bundles: tests/.session-e2e.cjs (pty session layer), tests/.sftp-svc.mjs (sftp service)
import { createRequire } from 'module'
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

console.log('[chmod] connecting ...')
const { id } = await sessionLayer.openSession({ kind: 'ssh', connectionId: 'jd' })
console.log('[chmod] session ready')

// 1. mode-string format from a live listing
const root = await sftpMod.listRemote(id, '/')
const sample = root.find((e) => e.mode && e.mode.length === 10)
if (!sample) fail('no entry carries a mode string in /')
const expectedType = sample.isDir ? 'd' : '-'
if (sample.mode[0] !== expectedType) fail(`mode type bit wrong: ${sample.mode} isDir=${sample.isDir}`)
const permPart = sample.mode.slice(1)
if (!/^[rwx-]{9}$/.test(permPart)) fail(`perm digits malformed: ${sample.mode}`)
console.log('[chmod] mode string ok:', sample.mode,
  'uid=' + sample.uid, 'gid=' + sample.gid)

// 2. chmod a scratch dir, verify, restore
const dir = '/root/ot_chmod_test'
await sftpMod.deleteRemote(id, [dir]).catch(() => undefined)
await sftpMod.mkdirRemote(id, '/root', 'ot_chmod_test')
try {
  const before = (await sftpMod.listRemote(id, '/root')).find((e) => e.path === dir)
  if (!before || !before.mode) fail('scratch dir missing or lacks mode')
  console.log('[chmod] before:', before.mode)

  await sftpMod.chmodRemote(id, dir, '700')
  const after700 = (await sftpMod.listRemote(id, '/root')).find((e) => e.path === dir)
  if (after700.mode !== 'drwx------') fail(`expected drwx------ got ${after700.mode}`)
  console.log('[chmod] chmod 700 ->', after700.mode)

  await sftpMod.chmodRemote(id, dir, '755')
  const after755 = (await sftpMod.listRemote(id, '/root')).find((e) => e.path === dir)
  if (after755.mode !== 'drwxr-xr-x') fail(`expected drwxr-xr-x got ${after755.mode}`)
  console.log('[chmod] chmod 755 ->', after755.mode)
} finally {
  await sftpMod.deleteRemote(id, [dir]).catch(() => undefined)
}
console.log('[chmod] cleanup ok')

const exits = events.filter((e) => e.channel === 'pty:exit')
console.log('[chmod] unexpected exits:', exits.length)

sessionLayer.killPty(id)
console.log('[chmod] ALL CHECKS PASSED')
setTimeout(() => process.exit(0), 300)