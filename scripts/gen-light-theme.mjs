import { darkenToRatio, mix } from '../src/renderer/src/theme/semantic.ts'

const ANSI_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
]

const UPSTREAM = [
  {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    background: '#eff1f5',
    foreground: '#4c4f69',
    cursor: '#dc8a78',
    ansi: '#bcc0cc,#d20f39,#40a02b,#df8e1d,#1e66f5,#ea76cb,#179299,#5c5f77,#acb0be,#e7103f,#46b02f,#e49931,#3878f6,#ef95d7,#19a1a8,#6c6f85'
  },
  {
    id: 'gruvbox-light',
    name: 'Gruvbox Light',
    background: '#fbf1c7',
    foreground: '#3c3836',
    cursor: '#3c3836',
    ansi: '#fbf1c7,#cc241d,#98971a,#d79921,#458588,#b16286,#689d6a,#7c6f64,#928374,#9d0006,#79740e,#b57614,#076678,#8f3f71,#427b58,#3c3836'
  }
]

for (const source of UPSTREAM) {
    const foreground = darkenToRatio(source.foreground, source.background, 7)
    const colors = {
      background: source.background,
      foreground,
      cursor: darkenToRatio(source.cursor, source.background, 3),
      cursorAccent: source.background,
      selectionBackground: mix(source.background, foreground, 0.12)
    }
  source.ansi.split(',').forEach((color, index) => {
    colors[ANSI_KEYS[index]] = darkenToRatio(color, source.background, 4.5)
  })
  console.log(`${source.id}:`)
  console.log(JSON.stringify(colors, null, 2))
}
