/** Namespace: main (main-process strings: tray, close prompt, updater). Owner: main process. */
const main: Record<string, string> = {
  'main.tray.showWindow': 'Show main window',
  'main.tray.closeAction': 'Close button action',
  'main.tray.askEveryTime': 'Ask every time',
  'main.tray.minimizeToTray': 'Minimize to tray',
  'main.tray.exitDirectly': 'Exit directly',
  'main.tray.exit': 'Exit',
  'main.tray.balloonTitle': 'Minimized to tray',
  'main.tray.balloonContent': 'Terminal sessions keep running in the background. Click the tray icon to restore the window.',
  'main.tray.closeTitle': 'Close OpenTerminal',
  'main.tray.closeMessage': 'Minimize to tray, or exit now?',
  'main.tray.closeDetail': 'Minimizing to tray keeps your terminal sessions running.',
  'main.tray.rememberChoice': 'Remember my choice, never ask again',

  'main.updater.feedFailed': 'Domestic feed: {gitea}; GitHub: {github}',

  'main.ssh.connectTimeout': 'Connection timed out ({host}:{port})',
  'main.ssh.saveFingerprintFailed': 'Failed to save the host fingerprint: {detail}',
  'main.ssh.hostKeyRejected': 'The user rejected the host key',
  'main.ssh.connectFailed': 'Connection failed {host}:{port}: {detail}',
  'main.ssh.shellOpenFailed': 'Could not open the SSH shell ({host}:{port}): {detail}',
  'main.ssh.initFailed': 'SSH connection initialization failed ({host}:{port}): {detail}',
  'main.ssh.readKeyFailed': 'Could not read the private key file {path}: {detail}',

  'main.sftp.sessionGone': 'The SSH session does not exist or has disconnected',
  'main.sftp.deleteFailed': 'Delete failed: {detail}',
  'main.sftp.invalidMode': 'Invalid permission value: {mode}',
  'main.sftp.invalidUidGid': 'Invalid uid/gid',
  'main.sftp.commandExitCode': 'Command exited with code {code}',
  'main.sftp.cancelled': 'Cancelled',

  'main.zmodem.transferFailed': 'Transfer failed',
  'main.zmodem.transferTimeout': 'Transfer timed out',
  'main.zmodem.sendFailed': 'Sending failed',
  'main.zmodem.uploadFailed': 'Upload failed',
  'main.zmodem.receiveFailed': 'Receiving failed',
  'main.zmodem.abnormal': 'ZMODEM transfer error',
  'main.zmodem.cancelled': 'Cancelled',
  'main.zmodem.offerTimedOut': 'No files selected, cancelled',
  'main.zmodem.sessionInvalid': 'The session is no longer valid',
  'main.zmodem.sessionCreateFailed': 'Could not establish the ZMODEM session',
  'main.zmodem.noSaveDir': 'No save directory specified',
  'main.zmodem.noFiles': 'No files selected',

  'main.ipc.connectionMissing': 'Connection bookmark not found ({id})',

  'main.sysinfo.sessionGone': 'SSH session is missing or disconnected',
  'main.sysinfo.execFailed': 'SSH exec failed',
  'main.sysinfo.parseFailed': 'Parse failed: {message}',
  'main.pty.serviceNotReady': 'SSH session service is not initialised yet',
  'main.pty.missingConnectionId': 'SSH session is missing its connectionId',
  'main.log.tuiOmitted': 'full-screen (TUI) output omitted'
}

export default main
