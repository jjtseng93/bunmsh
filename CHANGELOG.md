# Changelog

All notable user-visible changes to bunmsh are documented here.

## [0.1.10] - 2026-08-27

### Added

- Add `<<`/`<<-` here-documents. An unquoted, unescaped delimiter expands
  parameters, command substitution, and arithmetic in the body like a
  double-quoted string; a quoted or backslash-escaped delimiter (`<<'EOF'`,
  `<<\EOF`) leaves it literal. `<<-` strips leading tabs from the body and the
  terminator. Here-documents work on plain command lines, in pipelines, across
  multiple heredocs on one command, and inside `if`/`while`/`for`/`case`
  bodies. Like dash and bash, a script that ends before the terminator line
  appears uses whatever was read as the body instead of raising a syntax
  error.
- Add `<<<` here-strings, matching mksh's `DOHERESTR | DOSCALAR` word
  expansion: parameter, command, and arithmetic substitution run, but there is
  no field splitting, pathname expansion, or tilde expansion, and a trailing
  newline is appended before the word becomes stdin.
- Fix an unrelated pre-existing crash surfaced while adding here-documents: any
  tokenizer syntax error (for example an unterminated quote) raised while
  probing whether a script uses compound (`if`/`while`/`for`/`case`) syntax
  used to escape as an unhandled exception instead of the usual
  `bunmsh: syntax error: ...` message.
- Show mksh's `PS2` continuation prompt (default `"> "`) in interactive mode
  while a here-document, an open quote/substitution, or an unfinished
  `if`/`while`/`for`/`case` body is still being typed, instead of running each
  line on its own as soon as Enter is pressed. Ctrl-C during a continuation
  discards it and returns to the primary prompt; Ctrl-D runs whatever was
  typed so far — the same leniency the non-interactive here-document fallback
  above already has — and then keeps the shell running (Node's `readline`
  closes itself on an empty-line Ctrl-D, so this transparently rebuilds it),
  the same as mksh, instead of exiting the whole session.
- `lsfancy -l` now shows a symlink's target (`link -> target`), including a
  broken one, matching real `ls` — this was missing from both `lsfancy` and
  the Bun Shell `ls` fallback it is compared against. Reading it works the
  same way on Windows as on POSIX platforms.
- Give a symlink whose target does not resolve (missing, or a cycle) a
  distinct 🚫 icon instead of the normal 🔗, in both the plain and `-l`
  listing forms.

### Fixed

- Fix an unrelated pre-existing hang found while working on the above: a
  pipeline whose downstream stage closes early (`yes | head -n 3`) could
  leave the killed upstream stage's own output-forwarding stuck forever —
  Bun never releases the reader lock it holds on that pipeline link's read
  side once the stage reading it has exited, so a write already in flight
  into it backpressures permanently and cannot be canceled from outside.
  That write is now abandoned instead of waited on once the downstream stage
  is known to be done, and the shell forces its own exit once a script or
  `-c` command finishes rather than leaving that abandoned operation to keep
  the process running forever.
- Fix `lsfancy -l` showing every file's modification time in UTC instead of
  local time (it built the column from `Date.prototype.toISOString()`, which
  is always UTC) — a pre-existing bug, not something the symlink-target work
  above introduced.

## [0.1.9] - 2026-08-27

### Added

- Render Markdown previews in `serve` with heading anchors, passing
  `{ headings: true }` to `Bun.markdown.html`, so long documents get linkable
  section ids.
- Document `serve` in its own README section, pulled out of the fallback
  builtin table: port selection and its fallback, the `q`/`quit`/`exit` and `o`
  controls, exit codes, directory listings and previews, and the
  non-interactive forms such as `bmsh -cc builtin serve <directory>` that start
  it from another shell or a script.
- Document packing a folder into a single executable without a source
  checkout — `npx bunmsh --build-exe --asset /absolute/path/mysite`, then
  `bmsh -cc builtin serve 'B:/~BUN/mysite'` — including the absolute-path
  requirement, the PowerShell and `cmd.exe` spellings, and the trade-off
  against the `package.json` `assets` route, which is what makes the same file
  readable through `readAssetText` from a checkout and from the binary.
- Document that `serve` always answers a directory with its listing rather than
  the directory's `index.html`, and point site hosting at `npx serve` or Bun
  1.4's `{ dir }` routes, which do send it.
- Document that HTTP Range is not honoured for files inside a compiled binary:
  Bun answers those with the whole body and a `200`.

## [0.1.8] - 2026-08-27

### Added

- Add the `serve [directory]` fallback builtin and standalone `serve.js` as a
  minimal replacement for `python3 -m http.server`. It provides live directory
  listings, reflects filesystem changes, and serves whole `Bun.file` responses
  with Bun's native HTTP Range support.
- Add `🔍` preview links to `serve` directory pages. Markdown is rendered by
  `Bun.markdown.html`; JSON, JSON5, JSONC, JSONL/NDJSON, YAML, and TOML are
  parsed by their corresponding runtime parser and pretty-printed as HTML.
  XML is also previewed when the running Bun provides `Bun.XML.parse`.
- Add basic syntax colouring to structured-data previews, following the
  statement, string, escape, number, and constant groups from jsmdcui's
  `runtime/syntax/json.yaml` after parser output is pretty-printed as JSON.
- Add interactive `serve` controls: `q`, `quit`, and `exit` stop the server,
  while `o` opens its URL through `xdg-open`.
- Accept both `/$bunfs/...` and `B:/~BUN/...` serve paths on every platform,
  translating either spelling through the compiled module's
  `import.meta.dirname` to the bunfs mount accepted by the current runtime.

### Fixed

- Keep `serve` running after malformed preview data or any other uncaught
  request-handler exception; parser failures return 422 and the outer request
  boundary converts unexpected failures to an isolated HTTP 500 response.
- Prevent Termux foreground/resume terminal resize events from repainting the
  shell's cwd prompt over a running server or other foreground command.
- Keep the interactive shell alive when Ctrl-C interrupts the prompt or a
  foreground `serve`. Like mksh, SIGINT now abandons the current operation and
  returns to a fresh prompt; Ctrl-D on an empty input remains the way to send
  EOF and leave the shell.

## [0.1.5] - 2026-08-26

### Added

- Mark shell-inserted line endings with `↩️`, making the exact boundary of a
  command's output visible when the command does not emit a trailing newline.
- Document this marker under **Special Interactions → Terminal behavior**.

### Fixed

- Preserve the final line of any interactive command whose output has no
  trailing newline, including streamed external commands such as
  `printf hello`. bunmsh now queries the terminal cursor before repainting the
  prompt and only inserts a marked newline when the cursor remains mid-line.

## [0.1.4] - 2026-08-26

### Added

- Added `Alt-P` as a second shortcut for `builtin lsfancy ..`, matching
  `Alt-U` and listing the Parent (upper) folder without changing cwd or
  discarding the current edit buffer.

### Fixed

- Preserve short `Alt-L`, `Alt-U`, `Alt-P`, and tab-double-click `lsfancy`
  output when readline redraws the prompt. A two-line prompt previously moved
  upward and erased a one-line listing, which was especially visible for the
  parent of the Termux home directory.
- Derive `HOME` on Windows from `USERPROFILE`, or from `HOMEDRIVE` plus
  `HOMEPATH`, when the environment does not define it. Bare `cd`, `~`, `$HOME`,
  prompt home shortening, and child environments now share a usable home path.
- Normalise Windows HOME paths to forward slashes and compare HOME/cwd without
  case sensitivity when deciding whether a prompt path should use `~`.
- Treat Android's `/data/data/PACKAGE` and `/data/user/0/PACKAGE` app-sandbox
  paths as equivalent for prompt home shortening, so Termux HOME and its
  descendants display as `~` even when HOME and cwd use different aliases.
