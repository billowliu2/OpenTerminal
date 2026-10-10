// Minimal electron stub for bundling src/main/*.ts under plain Node
// (tests/ssh-session-e2e.mjs, tests/commands-store.mjs). Only what the bundled
// modules touch.
//
// Every mutable piece of state lives on `globalThis.__otElectronStub` rather
// than in this module's scope: the bundles INLINE this file (esbuild aliases
// `electron` to it), so a test requiring both `./electron-stub.cjs` and a
// bundle would otherwise get two independent copies, and registrations made by
// the bundled code would be invisible to the test.
//
// `app.getPath('userData')` defaults to `OT_STUB_USERDATA` and is also settable
// via `__setUserData`, so a test can point the settings store at a temp dir and
// exercise settings-driven behavior.
const state = (globalThis.__otElectronStub ??= {
  handlers: new Map(),
  userDataPath: process.env.OT_STUB_USERDATA || '',
  isPackaged: false,
  sessions: new Map()
})

/** Fetch double for the updater bundle: `net.fetch` and every session's fetch. */
const noFetch = async () => ({
  ok: false,
  status: 404,
  text: async () => '',
  json: async () => []
})
const callFetch = (url, init) =>
  globalThis.__otFetch ? globalThis.__otFetch(url, init) : noFetch()

const fakeSession = (name) => {
  let s = state.sessions.get(name)
  if (!s) {
    s = {
      name,
      proxyCalls: [],
      setProxy: async (cfg) => {
        s.proxyCalls.push(cfg)
      },
      fetch: callFetch
    }
    state.sessions.set(name, s)
  }
  return s
}

module.exports = {
  BrowserWindow: {
    // Configurable so a test can drive the "is a window visible?" guards (the
    // update balloons, the session snapshot). Like the rest of the stub state
    // this lives on the shared global, and the default is "no window open".
    getAllWindows: () => state.windows ?? []
  },
  app: {
    getPath: (name) => {
      if (name === 'userData' && state.userDataPath) return state.userDataPath
      throw new Error(`electron stub: app.getPath(${name}) is not configured`)
    },
    getVersion: () => '0.0.0-stub',
    setLoginItemSettings: () => {},
    get isPackaged() {
      return state.isPackaged
    }
  },
  ipcMain: {
    handle: (channel, listener) => {
      state.handlers.set(channel, listener)
    },
    on: (channel, listener) => {
      state.handlers.set(`on:${channel}`, listener)
    }
  },
  session: {
    fromPartition: (name) => fakeSession(name)
  },
  net: {
    fetch: callFetch
  },
  globalShortcut: {
    register: () => true,
    unregister: () => {},
    unregisterAll: () => {},
    isRegistered: () => false
  },
  webContents: {},
  powerMonitor: {
    getSystemIdleTime: () => 0
  },
  powerSaveBlocker: {
    start: () => 1,
    stop: () => {},
    isStarted: () => false
  },
  shell: {
    openPath: async () => ''
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] })
  },
  safeStorage: {
    isEncryptionAvailable: () => false
  },
  nativeTheme: {
    shouldUseDarkColors: true,
    on: () => {}
  },
  Menu: {
    buildFromTemplate: () => ({ popup: () => {} }),
    setApplicationMenu: () => {}
  },
  Tray: class {
    setToolTip() {}
    setContextMenu() {}
    on() {}
    destroy() {}
    /**
     * Balloons (`notifyUpdate`, the minimize hint) have no other observable
     * effect, so they are recorded instead of dropped. The sink is a global for
     * the same reason as the rest of the state: the bundle inlines this file, so
     * a test's require of this path is a different module instance.
     */
    displayBalloon(options) {
      const sink = (globalThis.__otBalloons ??= [])
      sink.push(options)
    }
    static getBounds() {
      return { x: 0, y: 0, width: 0, height: 0 }
    }
  },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) })
  },
  __setUserData: (p) => {
    state.userDataPath = p
  },
  __setPackaged: (v) => {
    state.isPackaged = v
  },
  /** Fake window list `BrowserWindow.getAllWindows()` hands the bundled code. */
  __setWindows: (wins) => {
    state.windows = wins
  },
  /** channel -> listener (invoke), `on:<channel>` -> listener (send). */
  get __handlers() {
    return state.handlers
  },
  get __sessions() {
    return state.sessions
  }
}
