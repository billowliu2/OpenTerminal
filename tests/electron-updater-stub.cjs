// Stand-in for the `electron-updater` package under plain Node (tests only).
//
// The real package loads Electron's app/browser-window machinery at require
// time, so it cannot be exercised in the offline harness. `tests/build-bundles.cjs`
// aliases `electron-updater` to this file, which means it is *INLINED* into the
// updater bundle — the bundle does not require this path at runtime, so the test
// process cannot reach the bundle's instance by requiring it either. Control
// therefore flows through a global set up by the test before it requires the
// bundle:
//
//   globalThis.__otAutoUpdater = {
//     checkForUpdates: () => Promise,      // called by the service under test
//     downloadUpdate: () => Promise,
//     quitAndInstallCalls: [],             // quitAndInstall(...) arguments
//     feeds: [],                           // setFeedURL argument per call
//     proxies: [],                         // netSession.setProxy argument per call
//     live                                 // the instance the bundle wired (see on())
//   }
//
// Every field is optional; missing hooks fall back to a resolving promise so a
// test only has to configure what it asserts on.
const { EventEmitter } = require('node:events')
const { CancellationError } = require('builder-util-runtime')

function ctl() {
  return (globalThis.__otAutoUpdater ??= {})
}

class FakeAutoUpdater extends EventEmitter {
  constructor() {
    super()
    this.logger = null
    this.autoDownload = true
    this.autoInstallOnAppQuit = false
    this.netSession = {
      setProxy: async (cfg) => {
        ctl().proxies?.push(cfg)
      }
    }
  }

  /**
   * Whoever subscribes is the instance the app under test actually drives, so
   * that one is published as `live`. This matters because the bundle INLINES
   * this file: the test process holds two instances (its own require of this
   * path, plus the bundle's copy), and emitting on the wrong one is a no-op.
   */
  on(event, listener) {
    ctl().live = this
    return super.on(event, listener)
  }

  setFeedURL(cfg) {
    ctl().feeds?.push(cfg)
  }

  checkForUpdates() {
    const impl = ctl().checkForUpdates
    return impl ? impl(ctl()) : Promise.resolve(null)
  }

  downloadUpdate(token) {
    // Keep the token around so a test can assert the app actually cancelled the
    // transfer it handed to electron-updater (the watchdog calls `token.cancel()`).
    if (token !== undefined) ctl().lastToken = token
    if (token === undefined) {
      const impl = ctl().downloadUpdate
      return impl ? impl(ctl(), token) : Promise.resolve([])
    }
    // The real library settles the in-flight promise when the token is cancelled:
    // racing the hook against the token's cancel gives a never-settling hook the
    // same shape (reject with a CancellationError) so the watchdog cancel is
    // actionable under test — whichever settles first wins, the other is ignored.
    const base = (() => {
      const impl = ctl().downloadUpdate
      return impl ? impl(ctl(), token) : Promise.resolve([])
    })()
    return new Promise((resolve, reject) => {
      token.onCancel(() => reject(new CancellationError()))
      Promise.resolve(base).then(resolve, reject)
    })
  }

  quitAndInstall(...args) {
    ctl().quitAndInstallCalls?.push(args)
  }
}

const autoUpdater = new FakeAutoUpdater()

module.exports = { autoUpdater }
