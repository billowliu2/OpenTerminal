/** Namespace: ssh (ssh connections, host key prompt, file panel, zmodem, monitor). Owner: ssh area. */
const ssh: Record<string, string> = {
  // Auth method / secret kind
  'ssh.auth.password': 'Password',
  'ssh.auth.privateKey': 'Private key',
  'ssh.auth.agent': 'Agent',
  'ssh.secret.passphrase': 'Passphrase',

  // Connection dialog: auth fields
  'ssh.fields.agentDesc':
    'Authenticate with a key already loaded in the local SSH Agent; this app stores nothing for you.',
  'ssh.fields.askPasswordLabel': 'Ask for password on connect',
  'ssh.fields.askPasswordHint':
    'Prompts for the password on every connection instead of using the saved one',
  'ssh.fields.passwordPlaceholder': 'Leave empty to keep the saved password',
  'ssh.fields.keyPath': 'Private key file path (on this computer, optional)',
  'ssh.fields.keyContent': 'Private key content',
  'ssh.fields.keyContentPlaceholder':
    'Paste the private key; leave empty to use the path above (leave empty while editing to keep the saved key)',
  'ssh.fields.askPassphraseLabel': 'Ask for passphrase on connect',
  'ssh.fields.askPassphraseHint': 'Prompts for the key passphrase on every connection',
  'ssh.fields.passphrase': 'Key passphrase',
  'ssh.fields.passphrasePlaceholder': 'Leave empty to keep the saved passphrase',

  // Connection dialog
  'ssh.dialog.titleEdit': 'Edit connection',
  'ssh.dialog.titleNew': 'New connection',
  'ssh.dialog.saveFailed': 'Save failed. Check your input and try again.',
  'ssh.dialog.name': 'Name',
  'ssh.dialog.nameRequired': 'Please enter a connection name',
  'ssh.dialog.namePlaceholder': 'e.g. Production server',
  'ssh.dialog.group': 'Group',
  'ssh.dialog.groupPlaceholder': 'Pick or type a new group; leave empty for “Default”',
  'ssh.dialog.host': 'Host',
  'ssh.dialog.hostRequired': 'Please enter a host address',
  'ssh.dialog.hostPlaceholder': '192.168.1.10 or example.com',
  'ssh.dialog.port': 'Port',
  'ssh.dialog.portRange': 'Port must be between 1 and 65535',
  'ssh.dialog.username': 'Username',
  'ssh.dialog.usernameRequired': 'Please enter a username',
  'ssh.dialog.authMethod': 'Authentication',
  'ssh.dialog.savedSecret': 'A {kind} is saved; leave empty to keep it',
  'ssh.dialog.keepalive': 'Keepalive interval (seconds)',
  'ssh.dialog.keepaliveTooltip': '0 disables keepalive',
  'ssh.dialog.keepaliveMin': 'Cannot be negative',
  'ssh.dialog.highlightProfile': 'Highlight rule set',
  'ssh.dialog.highlightProfileDefault': 'Default (all rules)',

  // Connection sidebar
  'ssh.sidebar.defaultGroup': 'Default',
  'ssh.sidebar.timeJustNow': 'just now',
  'ssh.sidebar.timeMinutesAgo': '{n} min ago',
  'ssh.sidebar.timeHoursAgo': '{n} h ago',
  'ssh.sidebar.timeDaysAgo': '{n} d ago',
  'ssh.sidebar.modeTerminal': 'Terminal workspace',
  'ssh.sidebar.modeSsh': 'SSH workspace',
  'ssh.sidebar.title': 'Connections',
  'ssh.sidebar.newConnection': 'New connection',
  'ssh.sidebar.sectionTerminals': 'Terminals',
  'ssh.sidebar.noLocalTerminals': 'No local terminal open',
  'ssh.sidebar.local': 'Local',
  'ssh.sidebar.sectionServers': 'SSH servers',
  'ssh.sidebar.empty': 'No connections yet — click + to create one',
  'ssh.sidebar.loading': 'Loading…',
  'ssh.sidebar.recent': 'Recent sessions',
  'ssh.sidebar.dblClickConnect': 'Double-click to connect to {host}',
  'ssh.sidebar.deleteTitle': 'Delete this connection?',
  'ssh.sidebar.deleteDesc':
    'A deleted connection cannot be restored. Its saved key material is removed as well.',

  // Host key verification
  'ssh.hostKey.changedTitle': 'Host fingerprint changed!',
  'ssh.hostKey.unknownHost': 'Unknown host',
  'ssh.hostKey.accept': 'Accept and connect',
  'ssh.hostKey.reject': 'Reject',
  'ssh.hostKey.mitmTitle': 'Possible man-in-the-middle attack',
  'ssh.hostKey.mitmDesc':
    'The remote host key fingerprint differs from the one recorded earlier. Unless you changed the server key yourself, someone may be impersonating this host.',
  'ssh.hostKey.firstConnect':
    'First connection to this host; its fingerprint has not been recorded yet.',
  'ssh.hostKey.target': 'Host: {target}',
  'ssh.hostKey.fingerprint': 'Fingerprint: {fingerprint}',

  // SSH workspace: file panel container, host badge
  'ssh.bottomPanel.resize': 'Resize the file panel',
  'ssh.hostBadge.aria': 'SSH host {label}',

  // ZMODEM
  'ssh.zmodem.done': 'ZMODEM transfer complete',
  'ssh.zmodem.failed': 'ZMODEM transfer failed: {message}',
  'ssh.zmodem.unknownError': 'unknown error',
  'ssh.zmodem.titleReceive': 'Download to local',
  'ssh.zmodem.titleSend': 'Upload to server',
  'ssh.zmodem.pickDir': 'Choose save folder',
  'ssh.zmodem.pickFiles': 'Choose files',
  'ssh.zmodem.receiveDesc':
    'An sz download request was detected (the remote side is sending files). Choose the local folder to save them in.',
  'ssh.zmodem.sendDesc':
    'An rz upload request was detected (the remote side is receiving files). Choose the files to upload.',

  // File panel (SFTP)
  'ssh.file.up': 'Parent folder',
  'ssh.file.refresh': 'Refresh',
  'ssh.file.uploadFile': 'Upload files',
  'ssh.file.overwriteTitle': 'Overwrite existing file?',
  'ssh.file.overwriteDesc': 'A file with the same name exists in the target directory; uploading will overwrite its contents.',
  'ssh.file.downloadSelected': 'Download selection',
  'ssh.file.permOwner': 'Permissions / owner',
  'ssh.file.open': 'Open',
  'ssh.file.download': 'Download',
  'ssh.file.upload': 'Upload…',
  'ssh.file.rename': 'Rename',
  'ssh.file.new': 'New',
  'ssh.file.newFolder': 'New folder',
  'ssh.file.copyPath': 'Copy path',
  'ssh.file.copyPathFailed': 'Failed to copy the path',
  'ssh.file.pathCopied': 'Path copied',
  'ssh.file.permission': 'Permissions…',
  'ssh.file.deleteTitle': 'Delete?',
  'ssh.file.loading': 'Loading…',
  'ssh.file.empty': 'Empty folder',
  'ssh.file.modeUnavailable': 'Permissions unavailable',
  'ssh.file.folderName': 'Folder name',
  'ssh.file.create': 'Create',
  'ssh.file.renameTitle': 'Rename {name}',
  'ssh.file.permTitle': 'Permissions · {name}',
  'ssh.file.permApplied': 'Permissions applied',
  'ssh.file.octal': 'Octal',
  'ssh.file.octalPlaceholder': 'e.g. 755',
  'ssh.file.keepEmpty': 'Leave empty to keep',
  'ssh.file.ownerHint': 'Leave UID/GID empty to keep the current owner',
  'ssh.file.permRowOwner': 'Owner',
  'ssh.file.permRowGroup': 'Group',
  'ssh.file.permRowOther': 'Other',
  'ssh.file.permColRead': 'Read',
  'ssh.file.permColWrite': 'Write',
  'ssh.file.permColExec': 'Execute',

  // System monitor
  'ssh.monitor.collecting': 'Collecting…',
  'ssh.monitor.interrupted': 'Sampling stopped: {error}',
  'ssh.monitor.mem': 'Memory',
  'ssh.monitor.disks': 'Disks',
  'ssh.monitor.net': 'Network',
  'ssh.monitor.cores': '{n} cores',
  'ssh.monitor.loadavg': 'Load {value}',
  'ssh.monitor.uptime': 'Uptime',
  'ssh.monitor.uptimeSeconds': '{n}s',
  'ssh.monitor.uptimeMinutes': '{n} min',
  'ssh.monitor.uptimeHours': '{h} h {m} min',
  'ssh.monitor.uptimeDays': '{n} d'
}

export default ssh
