# Changelog

All notable user-visible changes to bunmsh are documented here.

## [0.1.8] - 2026-08-27

### Added

- Add the `serve [directory]` fallback builtin and standalone `serve.js` as a
  minimal replacement for `python3 -m http.server`. File routes are indexed at
  startup through Bun's static route table for native HTTP Range support, while
  directory routes provide linked, `lsfancy`-style HTML listings.
- Add `🔍` preview links to `serve` directory pages. Markdown is rendered by
  `Bun.markdown.html`; JSON, JSON5, JSONC, JSONL/NDJSON, YAML, and TOML are
  parsed by their corresponding runtime parser and pretty-printed as HTML.
  XML is also previewed when the running Bun provides `Bun.XML.parse`.

### Fixed

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
