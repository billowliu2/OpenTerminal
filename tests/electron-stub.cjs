// Minimal electron stub for bundling src/main/*.ts under plain Node
// (tests/ssh-session-e2e.mjs, tests/commands-store.mjs). Only what the bundled
// modules touch.
//
// `app.getPath('userData')` is configurable via `__setUserData` so a test can
// point the settings store at a temp dir and exercise settings-driven behavior.
let userDataPath = process.env.OT_STUB_USERDATA || ''
module.exports = {
  BrowserWindow: {
    getAllWindows: () => []
  },
  app: {
    getPath: (name) => {
      if (name === 'userData' && userDataPath) return userDataPath
      throw new Error(`electron stub: app.getPath(${name}) is not configured`)
    },
    setLoginItemSettings: () => {},
    isPackaged: false
  },
  ipcMain: {
    handle: () => {},
    on: () => {}
  },
  globalShortcut: {
    register: () => true,
    unregister: () => {},
    unregisterAll: () => {},
    isRegistered: () => false
  },
  webContents: {},
  powerSaveBlocker: {
    start: () => 1,
    stop: () => {},
    isStarted: () => false
  },
  shell: {
    openPath: async () => ''
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
    static getBounds() {
      return { x: 0, y: 0, width: 0, height: 0 }
    }
  },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) })
  },
  __setUserData: (p) => {
    userDataPath = p
  }
}
