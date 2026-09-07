// Minimal electron stub for bundling src/main/pty.ts under plain Node
// (tests/ssh-session-e2e.mjs). Only what broadcast.ts touches.
module.exports = {
  BrowserWindow: {
    getAllWindows: () => []
  },
  app: {},
  ipcMain: {},
  safeStorage: {
    isEncryptionAvailable: () => false
  }
}
