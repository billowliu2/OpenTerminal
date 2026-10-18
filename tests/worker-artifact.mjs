/**
 * Probe-worker build artifact smoke test (worker-artifact.mjs).
 *
 * The ReDoS gate is only real if the SHIPPED worker chunk is real. The pool's
 * factory is the `?nodeWorker` import in `main/index.ts`, which electron-vite
 * emits into `out/main` — and nothing else in the suite ever loads that file:
 * `tests/redos-validator.mjs` spawns its own esbuild bundle of the same source,
 * so a build that stopped emitting the worker (a renamed entry, a plugin that
 * no longer fires, a broken chunk) would leave every unit test green while the
 * packaged app reported every custom rule as "pending" forever.
 *
 * So this is a BUILD test, not a unit test: it runs against `out/main` and is
 * wired into `npm run build` / `npm run dist` / `npm run dist:dir` (after the
 * build, before electron-builder). It is deliberately NOT in `npm test`: CI runs
 * `npm test` before `npm run build`, so a test that requires build output would
 * fail a clean checkout.
 *
 * What it proves, in a real thread: the artifact loads, answers a benign pattern
 * within budget with the corpus size and probe version the source declares, and
 * reports a pattern that does not compile as `invalid-regex` instead of crashing.
 *
 * Run: node tests/worker-artifact.mjs   (must exit 0; needs a completed build)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { PROBE_BUDGET_MS, PROBE_VERSION, REDOS_PROBES } from '../src/shared/redosProbes.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_MAIN = join(__dirname, '..', 'out', 'main')

/** How long the artifact gets to answer one request before it counts as broken. */
const REPLY_TIMEOUT_MS = 10_000

/**
 * Content fallback for the case where the emitted chunk no longer looks like the
 * worker by name (a build-tool rename must not silently turn this test into a
 * no-op). `parentPort` is the worker ENTRY marker — the corpus literal is not
 * usable here, because electron-vite emits it as its own shared data chunk that
 * is `require`d by both the worker and the main bundle.
 */
const WORKER_MARKERS = ['parentPort', 'worker_threads']

let failed = 0
let passed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
  else passed += 1
}

/** Every `.js`/`.cjs`/`.mjs` file under a directory, recursively. */
function listScripts(dir) {
  const out = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listScripts(full))
    else if (/\.(js|cjs|mjs)$/.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * The emitted worker chunk: by name when the build still names it after the
 * source file, otherwise by the content markers a worker entry point must carry.
 */
function findWorkerArtifact(scripts) {
  const byName = scripts.filter((file) => /redosProbeWorker/i.test(relative(OUT_MAIN, file)))
  if (byName.length > 0) return { files: byName, how: 'file name' }
  const byContent = scripts.filter((file) => {
    try {
      if (statSync(file).size >= 5_000_000) return false
      const text = readFileSync(file, 'utf8')
      return WORKER_MARKERS.every((marker) => text.includes(marker))
    } catch {
      return false
    }
  })
  return { files: byContent, how: 'worker markers' }
}

/** One request/answer round trip against the artifact, in a real thread. */
function ask(artifact, request, timeoutMs = REPLY_TIMEOUT_MS) {
  const worker = new Worker(artifact)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate()
      reject(new Error(`no reply within ${timeoutMs}ms`))
    }, timeoutMs)
    const done = (fn, value) => {
      clearTimeout(timer)
      fn(value)
    }
    worker.on('message', (message) => done(resolve, message))
    worker.on('error', (err) => done(reject, err))
    worker.on('exit', (code) => done(reject, new Error(`worker exited (code ${code}) before answering`)))
    worker.postMessage(request)
  }).finally(() => {
    void worker.terminate()
  })
}

console.log('[worker artifact]')
{
  const scripts = listScripts(OUT_MAIN)
  if (scripts.length === 0) {
    console.error(`\n[worker-artifact] FAILED: no build output under ${OUT_MAIN} — run "npm run build" first`)
    process.exit(1)
  }
  const { files, how } = findWorkerArtifact(scripts)
  ok(files.length > 0, `the probe worker chunk is present in out/main (found by ${how})`)
  if (files.length === 0) {
    console.error(`\n[worker-artifact] FAILED: ${scripts.length} build script(s) scanned, none is the probe worker`)
    process.exit(1)
  }
  console.log(`  info: ${files.map((file) => relative(OUT_MAIN, file)).join(', ')}`)

  const artifact = files[0]

  // 1. a benign rule: the answer carries the corpus it actually ran.
  let reply
  try {
    reply = await ask(artifact, { id: 7, pattern: '\\bOK\\b', flags: 'g' })
  } catch (err) {
    ok(false, `the artifact answers a benign probe (${err instanceof Error ? err.message : String(err)})`)
    reply = null
  }
  if (reply !== null) {
    ok(reply.id === 7, `the answer echoes the request id (${reply.id})`)
    ok(reply.ok === true, `a benign pattern is reported as ok (${JSON.stringify(reply)})`)
    ok(reply.probeVersion === PROBE_VERSION, `the answer carries the source probe version (${reply.probeVersion})`)
    ok(
      reply.probes === REDOS_PROBES.length,
      `the shipped corpus is what ran (${reply.probes} of ${REDOS_PROBES.length} probes)`
    )
    ok(
      typeof reply.worstMs === 'number' && Number.isFinite(reply.worstMs) && reply.worstMs >= 0,
      `the slowest probe is a real measurement (${reply.worstMs}ms)`
    )
    ok(
      typeof reply.worstMs === 'number' && reply.worstMs < PROBE_BUDGET_MS,
      `a benign rule stays inside the budget (${reply.worstMs}ms < ${PROBE_BUDGET_MS}ms)`
    )
  }

  // 2. a pattern that does not compile: a verdict, not a crash.
  let invalid
  try {
    invalid = await ask(artifact, { id: 8, pattern: '(', flags: 'g' })
  } catch (err) {
    ok(false, `the artifact survives an uncompilable pattern (${err instanceof Error ? err.message : String(err)})`)
    invalid = null
  }
  if (invalid !== null) {
    ok(invalid.ok === false && invalid.reason === 'invalid-regex', `an uncompilable pattern is reported as such (${JSON.stringify(invalid)})`)
    ok(invalid.id === 8, 'the failure answer echoes the request id too')
  }
}

console.log(`\n[worker-artifact] ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.error(`\n[worker-artifact] ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('\n[worker-artifact] ALL CHECKS PASSED')
