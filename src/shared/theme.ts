/**
 * Terminal color theme model. Palette layout mirrors xterm.js ITheme.
 * Values of builtin themes come from the public-domain iTerm2-Color-Schemes / xterm-theme collections.
 */

export interface ThemeColors {
  background: string
  foreground: string
  cursor: string
  /** accent block behind cursor text; falls back to foreground if omitted */
  cursorAccent?: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export interface TerminalTheme {
  id: string
  name: string
  builtin: boolean
  colors: ThemeColors
}

export const DEFAULT_DARK: TerminalTheme = {
  id: 'default-dark',
  name: 'OpenTerminal Dark',
  builtin: true,
  colors: {
    background: '#1e1e1e',
    foreground: '#cccccc',
    cursor: '#ffffff',
    cursorAccent: '#1e1e1e',
    selectionBackground: '#264f78',
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#ffffff'
  }
}

export const BUILTIN_THEMES: TerminalTheme[] = [
  DEFAULT_DARK,
  {
    id: 'dracula',
    name: 'Dracula',
    builtin: true,
    colors: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      cursorAccent: '#282a36',
      selectionBackground: '#44475a',
      black: '#21222c',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
      brightBlack: '#6272a4',
      brightRed: '#ff6e6e',
      brightGreen: '#69ff94',
      brightYellow: '#ffffa5',
      brightBlue: '#d6acff',
      brightMagenta: '#ff92df',
      brightCyan: '#a4ffff',
      brightWhite: '#ffffff'
    }
  },
  {
    id: 'one-half-dark',
    name: 'One Half Dark',
    builtin: true,
    colors: {
      background: '#282c34',
      foreground: '#dcdfe4',
      cursor: '#61afef',
      cursorAccent: '#282c34',
      selectionBackground: '#3e4451',
      black: '#282c34',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#e5c07b',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#dcdfe4',
      brightBlack: '#5c6370',
      brightRed: '#e06c75',
      brightGreen: '#98c379',
      brightYellow: '#e5c07b',
      brightBlue: '#61afef',
      brightMagenta: '#c678dd',
      brightCyan: '#56b6c2',
      brightWhite: '#ffffff'
    }
  },
  {
    id: 'one-half-light',
    name: 'One Half Light',
    builtin: true,
    colors: {
      background: '#fafafa',
      foreground: '#383a42',
      cursor: '#383a42',
      cursorAccent: '#fafafa',
      selectionBackground: '#d2d6db',
      black: '#383a42',
      red: '#c2493e',
      green: '#40813f',
      yellow: '#9a6a01',
      blue: '#0177a9',
      magenta: '#a626a4',
      cyan: '#07798f',
      white: '#717171',
      brightBlack: '#4f525e',
      brightRed: '#b3565e',
      brightGreen: '#5b7549',
      brightYellow: '#7e6a44',
      brightBlue: '#3f729b',
      brightMagenta: '#955aa6',
      brightCyan: '#38767e',
      brightWhite: '#737373'
    }
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    builtin: true,
    colors: {
      background: '#002b36',
      foreground: '#839496',
      cursor: '#93a1a1',
      cursorAccent: '#002b36',
      selectionBackground: '#073642',
      black: '#002b36',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#073642',
      brightRed: '#cb4b16',
      brightGreen: '#586e75',
      brightYellow: '#657b83',
      brightBlue: '#839496',
      brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1',
      brightWhite: '#fdf6e3'
    }
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    builtin: true,
    colors: {
      background: '#fdf6e3',
      foreground: '#586e75',
      cursor: '#586e75',
      cursorAccent: '#fdf6e3',
      selectionBackground: '#eee8d5',
      black: '#073642',
      red: '#d1302d',
      green: '#647300',
      yellow: '#886700',
      blue: '#2076b3',
      magenta: '#c8337c',
      cyan: '#207972',
      white: '#6b6860',
      brightBlack: '#677171',
      brightRed: '#c14715',
      brightGreen: '#586e75',
      brightYellow: '#5b6f76',
      brightBlue: '#626f71',
      brightMagenta: '#6166b0',
      brightCyan: '#677171',
      brightWhite: '#726f66'
    }
  },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    builtin: true,
    colors: {
      background: '#282828',
      foreground: '#ebdbb2',
      cursor: '#ebdbb2',
      cursorAccent: '#282828',
      selectionBackground: '#504945',
      black: '#282828',
      red: '#cc241d',
      green: '#98971a',
      yellow: '#d79921',
      blue: '#458588',
      magenta: '#b16286',
      cyan: '#689d6a',
      white: '#a89984',
      brightBlack: '#928374',
      brightRed: '#fb4934',
      brightGreen: '#b8bb26',
      brightYellow: '#fabd2f',
      brightBlue: '#83a598',
      brightMagenta: '#d3869b',
      brightCyan: '#8ec07c',
      brightWhite: '#ebdbb2'
    }
  },
  {
    id: 'nord',
    name: 'Nord',
    builtin: true,
    colors: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#d8dee9',
      cursorAccent: '#2e3440',
      selectionBackground: '#434c5e',
      black: '#3b4252',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      white: '#e5e9f0',
      brightBlack: '#4c566a',
      brightRed: '#bf616a',
      brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1',
      brightMagenta: '#b48ead',
      brightCyan: '#8fbcbb',
      brightWhite: '#eceff4'
    }
  },
  {
    id: 'monokai',
    name: 'Monokai',
    builtin: true,
    colors: {
      background: '#272822',
      foreground: '#f8f8f2',
      cursor: '#f8f8f0',
      cursorAccent: '#272822',
      selectionBackground: '#49483e',
      black: '#272822',
      red: '#f92672',
      green: '#a6e22e',
      yellow: '#f4bf75',
      blue: '#66d9ef',
      magenta: '#ae81ff',
      cyan: '#a1efe4',
      white: '#f8f8f2',
      brightBlack: '#75715e',
      brightRed: '#f92672',
      brightGreen: '#a6e22e',
      brightYellow: '#f4bf75',
      brightBlue: '#66d9ef',
      brightMagenta: '#ae81ff',
      brightCyan: '#a1efe4',
      brightWhite: '#f9f8f5'
    }
  },
  {
    id: 'github-light',
    name: 'GitHub Light',
    builtin: true,
    colors: {
      background: '#f6f8fa',
      foreground: '#4d4d4c',
      cursor: '#4d4d4c',
      cursorAccent: '#f6f8fa',
      selectionBackground: '#dcdcdc',
      black: '#3e3e3e',
      red: '#c91b00',
      green: '#007e00',
      yellow: '#777600',
      blue: '#0225c7',
      magenta: '#bf2ebd',
      cyan: '#007677',
      white: '#6d6d6d',
      brightBlack: '#676767',
      brightRed: '#b34c48',
      brightGreen: '#307d34',
      brightYellow: '#737331',
      brightBlue: '#5860d9',
      brightMagenta: '#a64da6',
      brightCyan: '#2b7273',
      brightWhite: '#666666'
    }
  },
  {
    id: 'afterglow',
    name: 'Afterglow',
    builtin: true,
    colors: {
      background: '#1f1f1f',
      foreground: '#d0d0d0',
      cursor: '#f5f5f5',
      cursorAccent: '#1f1f1f',
      selectionBackground: '#4a4a4a',
      black: '#1f1f1f',
      red: '#ac4142',
      green: '#7e8e50',
      yellow: '#e5b567',
      blue: '#6c99bb',
      magenta: '#9f4e85',
      cyan: '#508451',
      white: '#d0d0d0',
      brightBlack: '#5a5a5a',
      brightRed: '#ac4142',
      brightGreen: '#7e8e50',
      brightYellow: '#e5b567',
      brightBlue: '#6c99bb',
      brightMagenta: '#9f4e85',
      brightCyan: '#508451',
      brightWhite: '#f5f5f5'
    }
  },
  {
    id: 'material-dark',
    name: 'Material Dark',
    builtin: true,
    colors: {
      background: '#263238',
      foreground: '#eeffff',
      cursor: '#ffffff',
      cursorAccent: '#263238',
      selectionBackground: '#2a4153',
      black: '#263238',
      red: '#f07178',
      green: '#c3e88d',
      yellow: '#ffcb6b',
      blue: '#82aaff',
      magenta: '#c792ea',
      cyan: '#89ddff',
      white: '#eeeeee',
      brightBlack: '#546e7a',
      brightRed: '#f07178',
      brightGreen: '#c3e88d',
      brightYellow: '#ffcb6b',
      brightBlue: '#82aaff',
      brightMagenta: '#c792ea',
      brightCyan: '#89ddff',
      brightWhite: '#ffffff'
    }
  },
  // Upstream: mbadolato/iTerm2-Color-Schemes yaml/Catppuccin Mocha.yml; selection normalized to mix(bg, fg, 0.16).
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    builtin: true,
    colors: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      cursorAccent: '#1e1e2e',
      selectionBackground: '#3a3b4e',
      black: '#45475a',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#f5c2e7',
      cyan: '#94e2d5',
      white: '#bac2de',
      brightBlack: '#585b70',
      brightRed: '#f7aec2',
      brightGreen: '#c2ecbf',
      brightYellow: '#fcd682',
      brightBlue: '#aeccfc',
      brightMagenta: '#f398da',
      brightCyan: '#b1eae1',
      brightWhite: '#a6adc8'
    }
  },
  // Upstream: mbadolato/iTerm2-Color-Schemes yaml/Catppuccin Frappe.yml; selection normalized to mix(bg, fg, 0.16).
  {
    id: 'catppuccin-frappe',
    name: 'Catppuccin Frappe',
    builtin: true,
    colors: {
      background: '#303446',
      foreground: '#c6d0f5',
      cursor: '#f2d5cf',
      cursorAccent: '#303446',
      selectionBackground: '#484d62',
      black: '#51576d',
      red: '#e78284',
      green: '#a6d189',
      yellow: '#e5c890',
      blue: '#8caaee',
      magenta: '#f4b8e4',
      cyan: '#81c8be',
      white: '#b5bfe2',
      brightBlack: '#626880',
      brightRed: '#eda0a2',
      brightGreen: '#b9dba2',
      brightYellow: '#ecd7ae',
      brightBlue: '#adc2f3',
      brightMagenta: '#f38ed8',
      brightCyan: '#98d2ca',
      brightWhite: '#a5adce'
    }
  },
  // Upstream: mbadolato/iTerm2-Color-Schemes yaml/Catppuccin Latte.yml; ANSI darkened to WCAG AA, selection = mix(bg, fg, 0.12).
  {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    builtin: true,
    colors: {
      background: '#eff1f5',
      foreground: '#4c4f69',
      cursor: '#bb7566',
      cursorAccent: '#eff1f5',
      selectionBackground: '#dbdee4',
      black: '#676a70',
      red: '#d20f39',
      green: '#307820',
      yellow: '#915c13',
      blue: '#1d61e9',
      magenta: '#984d84',
      cyan: '#12757a',
      white: '#5c5f77',
      brightBlack: '#676a72',
      brightRed: '#d00e39',
      brightGreen: '#317b21',
      brightYellow: '#946320',
      brightBlue: '#3066d1',
      brightMagenta: '#8f5981',
      brightCyan: '#13797e',
      brightWhite: '#67697e'
    }
  },
  // Upstream: mbadolato/iTerm2-Color-Schemes kitty/TokyoNight Night.conf; selection normalized to mix(bg, fg, 0.16).
  {
    id: 'tokyonight-night',
    name: 'TokyoNight Night',
    builtin: true,
    colors: {
      background: '#1a1b26',
      foreground: '#c0caf5',
      cursor: '#c0caf5',
      cursorAccent: '#1a1b26',
      selectionBackground: '#353747',
      black: '#15161e',
      red: '#f7768e',
      green: '#9ece6a',
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#a9b1d6',
      brightBlack: '#414868',
      brightRed: '#f7768e',
      brightGreen: '#9ece6a',
      brightYellow: '#e0af68',
      brightBlue: '#7aa2f7',
      brightMagenta: '#bb9af7',
      brightCyan: '#7dcfff',
      brightWhite: '#c0caf5'
    }
  },
  // Upstream: mbadolato/iTerm2-Color-Schemes kitty/Everforest Dark Soft.conf; selection normalized to mix(bg, fg, 0.16).
  {
    id: 'everforest-dark-soft',
    name: 'Everforest Dark Soft',
    builtin: true,
    colors: {
      background: '#293136',
      foreground: '#d3c6aa',
      cursor: '#e69875',
      cursorAccent: '#293136',
      selectionBackground: '#444949',
      black: '#7a8478',
      red: '#e67e80',
      green: '#a7c080',
      yellow: '#dbbc7f',
      blue: '#7fbbb3',
      magenta: '#d699b6',
      cyan: '#83c092',
      white: '#f2efdf',
      brightBlack: '#a6b0a0',
      brightRed: '#f85552',
      brightGreen: '#8da101',
      brightYellow: '#dfa000',
      brightBlue: '#3a94c5',
      brightMagenta: '#df69ba',
      brightCyan: '#35a77c',
      brightWhite: '#fffbef'
    }
  },
  // Upstream: mbadolato/iTerm2-Color-Schemes yaml/One Dark Two.yml; selection normalized to mix(bg, fg, 0.16).
  {
    id: 'one-dark-two',
    name: 'One Dark Two',
    builtin: true,
    colors: {
      background: '#21252b',
      foreground: '#e6e6e6',
      cursor: '#e6e6e6',
      cursorAccent: '#21252b',
      selectionBackground: '#414449',
      black: '#1d1f23',
      red: '#e27881',
      green: '#98c379',
      yellow: '#eac786',
      blue: '#71b9f4',
      magenta: '#c88bda',
      cyan: '#62bac6',
      white: '#c9ccd3',
      brightBlack: '#4a505a',
      brightRed: '#e68991',
      brightGreen: '#a8cc8e',
      brightYellow: '#edcf97',
      brightBlue: '#8dc7f6',
      brightMagenta: '#d3a2e2',
      brightCyan: '#78c4ce',
      brightWhite: '#e6e6e6'
    }
  },
  // Upstream: mbadolato/iTerm2-Color-Schemes yaml/Gruvbox Light.yml; ANSI darkened to WCAG AA, selection = mix(bg, fg, 0.12).
  {
    id: 'gruvbox-light',
    name: 'Gruvbox Light',
    builtin: true,
    colors: {
      background: '#fbf1c7',
      foreground: '#3c3836',
      cursor: '#3c3836',
      cursorAccent: '#fbf1c7',
      selectionBackground: '#e4dbb6',
      black: '#716c5a',
      red: '#cc241d',
      green: '#727114',
      yellow: '#8c6315',
      blue: '#3b7174',
      magenta: '#965372',
      cyan: '#4e7650',
      white: '#76695f',
      brightBlack: '#75695d',
      brightRed: '#9d0006',
      brightGreen: '#736e0d',
      brightYellow: '#915e10',
      brightBlue: '#076678',
      brightMagenta: '#8f3f71',
      brightCyan: '#3f7554',
      brightWhite: '#3c3836'
    }
  }
]

/** Resolve a theme by id; falls back to the default dark theme. */
export function getThemeById(id: string, customThemes: TerminalTheme[] = []): TerminalTheme {
  return [...BUILTIN_THEMES, ...customThemes].find((t) => t.id === id) ?? DEFAULT_DARK
}
