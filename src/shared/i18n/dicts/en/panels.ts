/** Namespace: panels (command panel, session-log panel, transfer panel). Owner: panels area. */
const panels: Record<string, string> = {
  // Command panel
  'panels.commands.sectionTitle': 'Commands',
  'panels.commands.target': 'Send to',
  'panels.commands.targetSsh': 'SSH server',
  'panels.commands.targetTerminal': 'Terminal',
  'panels.commands.tabHistory': 'History',
  'panels.commands.tabLibrary': 'Library',
  'panels.commands.historyTitle': 'Command history',
  'panels.commands.clearTitle': 'Clear all command history?',
  'panels.commands.clear': 'Clear',
  'panels.commands.noHistory': 'No command history',
  'panels.commands.loading': 'Loading…',
  'panels.commands.libraryTitle': 'Command library',
  'panels.commands.libraryEmpty': 'The command library is empty',
  'panels.commands.add': 'Add command',
  'panels.commands.name': 'Name',
  'panels.commands.optional': '(optional)',
  'panels.commands.command': 'Command',
  'panels.commands.commandPlaceholder': 'e.g. ls -la',
  'panels.commands.note': 'Note',
  'panels.commands.deleteTitle': 'Delete this command?',
  'panels.commands.deleteAria': 'Delete command',

  // Transfer panel
  'panels.transfer.failed': 'Transfer failed',
  'panels.transfer.cancelled': 'Cancelled',
  'panels.transfer.done': 'Transfer complete',
  'panels.transfer.uploading': 'Uploading',
  'panels.transfer.downloading': 'Downloading',
  'panels.transfer.zmodemUploading': 'ZMODEM uploading',
  'panels.transfer.zmodemDownloading': 'ZMODEM downloading'
}

export default panels
