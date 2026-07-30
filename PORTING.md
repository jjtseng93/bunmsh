# mksh to Bun porting status

This document deliberately distinguishes implemented behaviour from planned
compatibility. `bunmsh` 0.0.1 is a clean JavaScript implementation inspired by
mksh's user-facing model; it is not yet a drop-in mksh replacement.

## Implemented core

| Area | 0.0.1 status |
| --- | --- |
| CLI | Interactive mode, stdin, script file, `-c`, help and version |
| Lexing | Words, whitespace, comments at word boundaries, quotes, escapes |
| Lists | `;`, newline, `&&`, `||` |
| Pipelines | Basic stdout-to-stdin pipelines |
| Expansion | Simple parameters and positional parameters |
| Redirection | stdin, stdout/stderr truncate and append |
| Processes | External commands use `Bun.spawn` with cwd and environment |
| State | Persistent cwd, environment, last status and exit status |
| Builtins | Minimal practical set documented in README |

## Important 0.0.1 differences

- Pipelines are buffered and run stage-by-stage, not concurrently. This works
  for finite filters but not infinite producers, interactive filters or tools
  that require streaming/backpressure.
- Builtins in a pipeline use copied shell state. External stages are real
  processes; builtin stages are JavaScript functions.
- Unquoted parameter expansion currently produces one argument. POSIX IFS
  field splitting is not implemented.
- Filename generation/globbing is not implemented.
- The builtin `printf` supports only `%%`, `%s`, `%d`, `%i` and simple numeric
  width/zero-padding. It is not yet POSIX-complete.
- `print` implements the common `-r`, `-R`, `-n`, `-l`, `-N`, `-u2` forms,
  not every mksh extension.
- Append redirection currently reads and rewrites the destination through
  Bun's file APIs; atomic OS-level append semantics are still pending.
- File descriptor duplication (`2>&1`, `n>&m`) and arbitrary descriptor
  management are not implemented.
- `cd` validates directories with `Bun.file().stat()` and lexically normalises
  paths. Physical symlink resolution equivalent to mksh `cd -P` is pending.

## Not started

### Shell grammar

- Compound commands: `if`, `for`, `while`, `until`, `case`, `select`
- Functions and function scope
- Brace groups and subshell groups
- Here-documents and here-strings
- Background jobs (`&`) and coprocesses
- Arithmetic commands and `[[ ... ]]`
- `time`, `!` pipeline negation and reserved-word parsing

### Expansion

- Command substitution: `$(...)` and legacy backticks
- Arithmetic expansion: `$((...))`
- Full parameter operators such as `${x:-default}`, trimming and replacement
- Arrays, associative arrays and namerefs
- IFS field splitting
- Pathname expansion and extended glob patterns
- Brace expansion, process substitution and mksh `${| ...; }` forms

### Runtime and job control

- Concurrent streaming pipelines
- Process groups, controlling terminal and foreground/background job control
- Signals, traps and `wait`
- Shell options (`set -e`, `-u`, `pipefail`, `xtrace`, POSIX mode, etc.)
- Startup files, login/privileged/restricted shell modes
- Command hash tables, `PATH` tracking, `FPATH` and autoloaded functions
- Resource limits and `ulimit`

### Interactive editing

- Persistent history and `fc`
- Emacs/Vi line editors, key bindings and completion
- Multiline continuation prompts
- Terminal-aware width, Unicode editing and completion display

### Builtins and compatibility

- Most mksh special and regular builtins
- Complete `test`/`[` and `getopts`
- Complete `typeset`, `alias`, `whence`, `command`, `read`, `trap`, `kill`
- mksh-compatible diagnostics and exit statuses in all edge cases
- POSIX conformance suite and upstream `check.t` compatibility
- OS/2, EBCDIC, MirBSD-specific and legacy lksh modes

## Suggested next milestones

1. Replace buffered pipelines with concurrent `Bun.spawn` stream wiring.
2. Add command substitution, arithmetic expansion, IFS splitting and globbing.
3. Add compound commands and functions with lexical execution scopes.
4. Implement redirection descriptor duplication and here-documents.
5. Add shell options, traps and non-interactive POSIX compatibility tests.
