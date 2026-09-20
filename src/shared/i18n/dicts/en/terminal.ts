/** Namespace: terminal (terminal view: context menu, search, paste confirm, toolbar, hints). Owner: workspace/terminal. */
const terminal: Record<string, string> = {
  'terminal.menu.find': 'Find',
  'terminal.menu.selectAll': 'Select all',
  'terminal.menu.clear': 'Clear',
  'terminal.search.placeholder': 'Search',
  'terminal.search.prev': 'Previous',
  'terminal.search.next': 'Next',
  'terminal.search.found': 'Found',
  'terminal.search.notFound': 'Not found',
  'terminal.suggest.hint': '↑/↓ select · Tab accept · Esc close',
  'terminal.rec.start': 'Start recording',
  'terminal.rec.stop': 'Stop recording',
  'terminal.rec.startLog': 'Start session log',
  'terminal.rec.stopLog': 'Stop session log',
  'terminal.rec.openLogs': 'Open logs folder',
  'terminal.rec.openCwd': 'Open working directory',
  'terminal.paste.title': 'Confirm paste',
  'terminal.paste.message': 'Multi-line or potentially risky input detected. Paste it into the terminal?',
  'terminal.paste.noPrompt': "Don't ask again this session",
  'terminal.paste.disableDetection': 'Disable paste detection from now on',
  'terminal.paste.hint':
    'You can turn it back on or change the detection policy in the general terminal settings.',
  'terminal.dead.message': 'Process exited (code {code})'
}

export default terminal
