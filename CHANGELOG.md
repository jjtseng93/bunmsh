# Changelog

All notable user-visible changes to bunmsh are documented here.

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
