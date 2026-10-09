/**
 * Working-directory tracking self-test (terminal-cwd.mjs).
 *
 * `src/renderer/src/terminal/cwdTracker.ts` is the renderer half of cwd memory:
 * it turns a submitted command line into a cd argument (or null) and unwraps
 * ConEmu's OSC 9 payload. Everything platform-specific — path resolution,
 * existence checks, quote stripping, `cd -` rejection — lives in the main
 * process (`src/main/cwd.ts`), so the contract pinned here is deliberately
 * narrow, and the table says which side owns what:
 *
 *   - the cd family per shell (cd / chdir / sl / Set-Location / pushd /
 *     Push-Location) and the bare `d:` drive switch;
 *   - an EMPTY STRING means "bare cd" (home) and is NOT the same answer as
 *     null ("not a cd line") — the caller only resolves on non-null;
 *   - quotes and trailing arguments are handed to main verbatim: this module is
 *     not a shell parser, so `cd "D:\Program Files"` keeps its quotes and
 *     `cd /tmp && ls` keeps its separator;
 *   - lookalikes (`cdrom`, `cdx`, `sleep 1`, `VAR=x cd y`) never match, since a
 *     false positive would move the remembered directory on an unrelated line.
 *
 * Unlike the esbuild-bundled tests, this one imports the .ts module directly:
 * it has no imports and no runtime-only TS syntax, and Node >= 22.18 strips the
 * type annotations itself. Run: node tests/terminal-cwd.mjs   (must exit 0)
 */
import { cdArgument, conemuCwd } from '../src/renderer/src/terminal/cwdTracker.ts'

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}

/** Table-driven: [line, expected] — `null` = "not a cd line", `''` = bare cd. */
const table = (label, cases, fn) => {
  console.log(label)
  for (const [input, expected] of cases) {
    const got = fn(input)
    ok(
      got === expected,
      `${JSON.stringify(input)} -> ${JSON.stringify(got)}${got === expected ? '' : ` (want ${JSON.stringify(expected)})`}`
    )
  }
}

table(
  'the cd family returns the raw argument (main does the path work)',
  [
    ['cd /path', '/path'],
    ['cd\t/tmp', '/tmp'],
    ['cd\n/tmp', '/tmp'],
    ['cd ~/x', '~/x'],
    ['cd ../x', '../x'],
    ['cd -', '-'],
    ['cd .', '.'],
    ['cd D:\\projects', 'D:\\projects'],
    ['cd "D:\\Program Files"', '"D:\\Program Files"'],
    ["cd '~/src'", "'~/src'"],
    ['cd ""', '""']
  ],
  cdArgument
)

table(
  'every shell spelling is recognised, case-insensitively',
  [
    ['CD /tmp', '/tmp'],
    ['Cd /tmp', '/tmp'],
    ['  cD  /tmp  ', '/tmp'],
    ['chdir C:\\x', 'C:\\x'],
    ['CHDIR ..', '..'],
    ['sl .', '.'],
    ['sl', ''],
    ['Set-Location /a', '/a'],
    ['set-location /a', '/a'],
    ['pushd ../b', '../b'],
    ['Push-Location ~/c', '~/c']
  ],
  cdArgument
)

table(
  'bare cd is the empty-string sentinel, not null',
  [
    ['cd', ''],
    ['cd ', ''],
    ['  cd   ', ''],
    ['cd\t', '']
  ],
  cdArgument
)

table(
  'trailing arguments and separators stay in the argument',
  [
    ['cd /tmp   ', '/tmp'],
    ['cd /a b', '/a b'],
    ['cd /tmp extra', '/tmp extra'],
    ['cd /tmp && ls', '/tmp && ls'],
    ['cd /tmp; ls', '/tmp; ls'],
    ['cd /tmp | more', '/tmp | more']
  ],
  cdArgument
)

table(
  'the bare drive switch resolves to the drive root',
  [
    ['d:', 'D:\\'],
    ['D:', 'D:\\'],
    [' d: ', 'D:\\'],
    ['a:', 'A:\\'],
    ['z:', 'Z:\\']
  ],
  cdArgument
)

table(
  'lines that are not a cd are null (no false positives)',
  [
    ['', null],
    ['   ', null],
    ['cdx /tmp', null],
    ['cdrom', null],
    ['cdemo /x', null],
    ['slack', null],
    ['sleep 1', null],
    ['VAR=x cd y', null],
    ['sudo cd /x', null],
    ['echo cd /x', null],
    ['ls -la', null],
    ['d:\\', null],
    ['..', null],
    ['~', null]
  ],
  cdArgument
)

console.log('the empty-string answer is distinct from "not a cd line"')
ok(cdArgument('cd') === '', 'a bare cd answers with the empty string')
ok(cdArgument('cd') !== null, 'and is not null, so the caller still resolves it')
ok(cdArgument('ls') === null, 'a non-cd line answers null')

table(
  'ConEmu OSC 9;9 carries a bare path',
  [
    ['9;/home/a', '/home/a'],
    ['9;C:\\Users\\a', 'C:\\Users\\a'],
    ['9;C:\\Program Files', 'C:\\Program Files'],
    ['9;/a\n', '/a'],
    ['9; /a ', '/a'],
    ['9;  ', null],
    ['9;', null],
    ['9', null],
    ['90;x', null],
    ['9;;x', ';x'],
    ['', null],
    ['7;file://host/p', null],
    ['8;/a', null]
  ],
  conemuCwd
)

console.log('OSC 9 payloads that are not ConEmu cwd reports are rejected')
ok(conemuCwd('9;1;2') === '1;2', 'the remainder after the convention marker is the path')
ok(conemuCwd('9;file://host/p') === 'file://host/p', 'a file:// body is passed through for main to normalize')

if (failed > 0) {
  console.error(`\n[terminal-cwd] ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('\n[terminal-cwd] ALL CHECKS PASSED')
