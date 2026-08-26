# bunmsh

- `bunmsh` is a dependency-free, mksh-inspired cross-platform command shell for Bun JavaScript
  * Bun Modern Shell
- Early releases focus on a small, usable command interpreter rather than full mksh compatibility.

## Usage

### Install Bun first

- bunmsh requires [Bun](https://bun.com)
- On Android, install it in Termux:

```sh
npm install -g bun
```

On other platforms, follow the
[official Bun installation guide](https://bun.com/docs/installation).

No project dependencies need to be installed with `npm install` or `bun install`.

#### Prompt note for frequent SSH users

- By default bunmsh prompts don't show user@host
- Show them by a custom `PS1`:

```sh
PS1=$(printf "$(id -un)@$(hostname):\\w\n%s" '$ ') npx bunmsh
```

### Option 1: Run with npx

```sh
# Interactive shell
npx bunmsh
```

```sh
npx bunmsh -c 'print $PATH'

# Call cmd; this can call bunmsh builtins too
npx bunmsh -cc echo 'hello world' '*.txt' '$HOME'

npx bunmsh script.sh argv1 argv2
```

`-cc` means **call cmd**. Every argument after it is forwarded as an
already-quoted word, without another round of bunmsh parsing or expansion. The
example calls the `echo` builtin and prints `hello world *.txt $HOME` literally.

`npx` installs and launches the package, but the `bunmsh` executable itself
uses Bun. Bun must therefore already be available on `PATH`.

### Option 2: Run with git clone

- Interactive shell

```sh
git clone https://github.com/jjtseng93/bunmsh.git
cd bunmsh

bun ./bunmsh
```

- Running commands or scripts

```sh
bun ./bunmsh -c 'print $PATH'

# Call cmd; this can call bunmsh builtins too
bun ./bunmsh -cc echo 'hello world' '*.txt' '$HOME'

bun ./bunmsh script.sh argv1 argv2
```

`-cc` means **call cmd**. Every argument after it is forwarded as an
already-quoted word, without another round of bunmsh parsing or expansion. The
example calls the `echo` builtin and prints `hello world *.txt $HOME` literally.

### Useful CLI options

| Option | Effect |
| --- | --- |
| `-c SCRIPT_TEXT [argv...]` | Treat command text as a shell script, then parse and execute it |
| `-cc COMMAND [argv...]` | Call a command with argv as-is; no shell parsing or shell expansions |
| `-i` | Enter interactive mode, including after running a script |
| `--mouse` | Start with terminal mouse tracking enabled |
| `--builtin-only` | Skip direct command-name lookup through `PATH` |

`-c` treats its command text as a shell script and performs the normal parse
and execute flow. Arguments after the script text become its argv array:

```sh
bunmsh -c 'echo "$0" "$1"' Hello world
# Hello world
```

`-cc` means **Call Command**. It can call an alias, builtin, or command from
`PATH`. Every following argument is passed as-is, without shell parsing or
shell expansions:

```sh
bunmsh -cc echo '$HOME' '*.js'
# $HOME *.js

bunmsh -cc lsfancy -lh
# List cwd with emojis
```

In other words, the argv following `-cc` is already quoted. Metacharacters,
variables, and glob patterns remain literal instead of being interpreted by
bunmsh.

Mouse tracking can alternatively be enabled with `BUNMSH_MOUSE=1`; `true`,
`on`, and `yes` are also accepted case-insensitively. It is opt-in because
application mouse tracking prevents normal scrollback gestures in terminals
such as Termux and xterm.

In `--builtin-only` mode, regular and fallback builtins, aliases, and functions
remain available. An explicit executable path containing `/` can still run.
The `which` builtin always searches the current `PATH`, so `$(which COMMAND)`
can explicitly select a PATH executable while this mode is active. Use
`tab path` interactively to toggle this setting; `tab path on`/`true` enables
direct PATH lookup and `tab path off`/`false` disables it.

### Highest-priority JavaScript mode

```console
# Read a Bun value; non-undefined results are printed automatically
📁 ~/bunmsh
$ Bun.version

# Promises are awaited automatically
📁 ~/bunmsh
$ Bun.file("package.json").text()
📁 ~/bunmsh
$ Bun.sleep(500).then(() => "finished")

# Run arbitrary JavaScript statements or an expression
📁 ~/bunmsh
$ Bun.e; const numbers = [1, 2, 3]; numbers.reduce((a, b) => a + b, 0)
6
📁 ~/bunmsh
$ Bun.e, ({ cwd: process.cwd(), pid: process.pid })

# Share a value across later commands and cwd tabs in this bunmsh process
📁 ~/bunmsh
$ Bun.sha.var_name = { value: 123 }
{ value: 123 }
📁 ~/bunmsh
$ Bun.sha.var_name.value
123

# JavaScript inside ordinary shell command substitution
📁 ~/bunmsh
$ echo "Bun version: $(Bun.version)"

# Feed a JavaScript result into ordinary shell flow control
📁 ~/bunmsh
$ if [ $(Bun.e, Math.PI<3 ) = true ] ; then echo right ; else echo wrong ; fi
wrong
📁 ~/bunmsh
$ if [ $(Bun.e, Math.PI>3 ) = true ] ; then echo right ; else echo wrong ; fi
right
```

bunmsh can evaluate Bun JavaScript directly. Before tokenising, quoting, or
performing any shell expansion, it removes leading whitespace and checks the
first four characters of the original input. If they are exactly `Bun.`, the
entire input is passed directly to JavaScript `eval` instead of the shell
parser. Everything else continues through the normal shell parser.

A non-`undefined` result is printed automatically. Promises are awaited, so
asynchronous Bun APIs do not need explicit top-level `await`. Errors are
printed to standard error with a stack trace and set the shell status to `1`;
successful evaluation sets it to `0`, and an `undefined` result prints nothing.

#### Use `Bun.e;` or `Bun.e,` to run arbitrary JavaScript

The `Bun.` prefix is only the switch that selects JavaScript mode; the code
does not otherwise have to call a Bun API. `Bun.e` is a convenient no-op prefix
that permits arbitrary JavaScript while keeping the required first four
characters. The `e` property does not need to exist because reading a missing
JavaScript property simply produces `undefined`.

Technically, any property name works because only the leading `Bun.` is
checked; for example, `Bun.x;` and `Bun.anything,` also enter JavaScript mode.
This README uses `e` conventionally because it stands for **eval** (or
**evaluate**), is short, and makes the intent recognisable. Use `Bun.e;` before
one or more statements and `Bun.e,` before a single expression.

`Bun.e;` discards the `Bun.e` value and starts a new statement. `Bun.e,`
discards it through JavaScript's comma operator and returns the expression on
the right. Neither form invokes Bun Shell by itself; their purpose here is
only to enter the highest-priority evaluator and then execute unrestricted
JavaScript.

#### Use `Bun.sha` as a shared area (hack)

`Bun.sha` is normally Bun's SHA hashing function. JavaScript functions are
objects, and the function is extensible in current Bun versions, so properties
such as `Bun.sha.var_name` can serve as a lightweight process-wide shared area.

These lines already begin with `Bun.`, so they enter the highest-priority
JavaScript evaluator directly. Values remain available to later commands,
tabs and command substitutions running in the same bunmsh process. They do
not survive a bunmsh restart and are not inherited as JavaScript objects by
external child processes.

This is deliberately a hack, not an official Bun storage API. Use fresh
property names. A function already has reserved or behaviour-sensitive names
such as `name`, `length`, `call`, `apply`, `bind`, `caller`, `arguments`,
`constructor` and `toString`. In the tested Bun version, `name` and `length`
are read-only and assignment throws a `TypeError`; shadowing other Function
properties can break normal function behaviour. Before choosing a direct
property name, check it with `Bun.e, Object.hasOwn(Bun.sha, "var_name")`.

#### JavaScript inside shell command substitution

This mode also composes with shell command substitution. The outer command is
parsed as shell, while the contents of `$(...)` are evaluated again and can
trigger JavaScript mode independently.

#### Flow control with JavaScript values

JavaScript command substitution can feed ordinary shell tests and flow
control. The outer `if`, `[`, `then`, `else`, and `fi` remain shell syntax;
only the contents of each `$(...)` enter the JavaScript evaluator.

> **Security:** this is unrestricted JavaScript execution with the same file,
> process, environment and network permissions as bunmsh. Never pass untrusted
> input to this mode or expose it as a remote command interface.

### Imported history

Interactive bunmsh loads its own saved history and imports both Bash and Fish
history once at startup. Imported commands immediately participate in
history-based ghost completion, but the Bash and Fish source files are
read-only and are never modified by bunmsh:

```text
~/.bash_history
~/.local/share/fish/fish_history
```

Fish history uses Fish's documented YAML-style records; it is not treated as
standards-compliant YAML. Empty entries, Bash timestamp records and duplicate
commands are removed while keeping the most recent occurrence.
`BUNMSH_IMPORT_HISTORY` controls only the Bash and Fish imports; saved bunmsh
history is still loaded. Set it to disable external startup imports:

```sh
BUNMSH_IMPORT_HISTORY=0 bunmsh
```

`false`, `off` and `no` are also accepted, case-insensitively.

bunmsh never saves history automatically. Use `tab s` or `tab save` when you
want to persist the current interactive history. A newly opened bunmsh loads
that file for both Up/Down arrow recall and ghost completion. The standard path
is `$XDG_DATA_HOME/bunmsh/history`, falling back to
`~/.local/share/bunmsh/history`. Windows uses
`%LOCALAPPDATA%/bunmsh/history`.

### Tab system

| Command | Effect |
| --- | --- |
| `tab` | Create a second tab when only one exists; otherwise cycle right |
| `tab n` | Create and activate a new tab at the current cwd |
| `tab NUMBER` | Activate a tab by its 1-based number |
| `tab l` | Cycle left |
| `tab r` | Cycle right |
| `tab x`, `tab c` | Close the active tab |

bunmsh includes lightweight cwd tabs and starts with one tab. A tab stores only
its working directory; variables, environment, aliases, readonly names,
positional arguments, command status, and other shell state remain shared.
Switching tabs changes `cwd` and updates `PWD` without changing `OLDPWD`.

When more than one tab exists, the prompt displays every remembered path:

```text
📁 ~/project  📂 ~/project/src
[2]$
```

`📂` marks the active tab and `📁` marks inactive tabs. The complete active
entry is highlighted in cyan-blue. The default prompt includes the active
tab's 1-based number only when multiple tabs exist.

Left and right movement wrap at the ends. Closing a tab selects the tab that
moves into the same position, or the previous tab when closing the rightmost
one. The final remaining tab cannot be closed.

A typical workflow is:

```sh
cd ~/project
tab n
cd src
tab l      # back to ~/project
tab r      # back to ~/project/src
```

## Special Interactions

### Keyboard shortcuts

- `Ctrl-T`: Calls `builtin tab` without adding a command to history. It creates
  a tab when only one exists, or switches to the next tab otherwise. Any
  command text currently being edited is preserved.

- `Alt-T`: Calls `builtin tab l` without adding a command to history, switching
  to the tab on the left while preserving the command currently being edited.

- `Alt-L`: Calls `builtin lsfancy` without adding a command to history. It
  immediately rereads and lists the active tab's cwd while preserving the
  command currently being edited.

- `Alt-U` / `Alt-P`: Calls `builtin lsfancy ..` to list the Parent (upper)
  folder without changing cwd, adding a command to history, or discarding the
  command currently being edited.

- `Alt-C`: Calls `builtin tab x` to close the active tab without adding a
  command to history. `tab c` is an equivalent command form.

### Mouse interactions

- Mouse tab click: With mouse tracking enabled, left-clicking a tab's icon or
  path activates it. Spaces between tabs are not clickable. Wrapped tab paths
  remain clickable.

- Mouse tracking control: `tab mouse` toggles tracking. `tab mouse on`/`true`
  explicitly enables it, while `tab mouse off`/`false` disables it.

- Mouse tab double-click: Double-clicking the same tab within 400 ms activates
  it and calls `builtin lsfancy`, immediately rereading the directory without
  using the completion cache.

- Mouse prompt-number click: When multiple tabs exist, clicking the number at
  the start of the `$` prompt calls `builtin tab n` to create and activate a
  new tab.

- Mouse foreground behavior: Mouse reporting is disabled while a foreground
  command owns the terminal, so full-screen editors and other TUI programs
  receive their own mouse input. bunmsh restores it when the command returns.

### Terminal behavior

- `↩️`: When a command finishes without a trailing newline, bunmsh prints this
  marker and then inserts a newline before drawing the next prompt. The marker
  makes it clear where the program's exact output ended; it is not part of the
  command's output. Commands that end their own output with a newline do not
  show the marker.

### Very short aliases

- `?`: When the entire command is exactly this single character, prints the
  previous exit status. It is equivalent to `echo $?` and prints `0` after a
  successful command. After a command fails, only the `$` in the next prompt
  is shown in red. For Fish users, the corresponding expression is
  `echo $status` because Fish uses `$status` where POSIX-style shells use `$?`.

- `..`: As a standalone command, changes to the parent directory. Equivalent
  to `cd ..`.

- `//`: As a standalone command, returns to the most recently visited child
  directory below the current cwd. Equivalent to `cd //`.

- `~`: As a standalone command, changes to `$HOME`. Equivalent to `cd`.

- `-`: As a standalone command, changes to `$OLDPWD` and prints the selected
  path. Equivalent to `cd -`.

## Built-in commands and supported flags

This section documents the options implemented by bunmsh itself. It is not a
claim of complete POSIX, mksh or GNU compatibility. Shell builtins are resolved
before `PATH`. Fallback builtins are used only when no executable with the same
name is found in `PATH`; use `builtin NAME ...` to select either kind explicitly.

Run `builtin` with no arguments to print the registered names at runtime.

### Shell builtins (before PATH)

| Command | Supported flags/forms |
| --- | --- |
| `:`, `true`, `false` | No flags |
| `command` | `-p`, `-v`, `-V`, `--` |
| `builtin`, `__builtin` | `--`; no operand lists all builtins (`builtin` only) |
| `whence` | `-p`, `-v`, `--` |
| `which` | `--` |
| `type` | Names only |
| `alias` | `alias`, `alias NAME`, `alias NAME=VALUE` |
| `unalias` | `-a`, `--` |
| `test`, `[` | `!`, `-n`, `-z`, `-e`, `-f`, `-d`, `-b`, `-c`, `-p`, `-S`, `-L`, `-h`, `-s`, `-r`, `-w`, `-x`; string `=`, `==`, `!=`; integer `-eq`, `-ne`, `-gt`, `-ge`, `-lt`, `-le`; file `-nt`, `-ot`, `-ef`; `-a`, `-o` |
| `echo` | `-n` |
| `print` | `-r`, `-R`, `-n`, `-l`, `-N`, `-u1`, `-u2`, `--` |
| `printf` | `%s`, `%d`, `%i`, `%%`, numeric field width and zero padding; basic backslash escapes |
| `read` | `-r`, `--`; defaults to `REPLY` when no name is given |
| `pwd` | No flags |
| `cd`, `chdir` | `cd`, `cd DIR`, `cd -`, `cd //` |
| `tab` | `n`, `x`, `c`, `l`, `r`, `s`, `save`, `mouse [on\|off\|true\|false]`, `path [on\|off\|true\|false]`, or a 1-based tab number |
| `-`, `~`, `..`, `//` | Directory-navigation shortcuts |
| `export` | `NAME`, `NAME=VALUE` |
| `unset` | `-v`, `--` |
| `readonly` | `-p`, `--`, `NAME`, `NAME=VALUE` |
| `env` | `-i`, `--ignore-environment`, `-u NAME`, `--unset NAME`, `--unset=NAME`, `--` |
| `exec` | Command and arguments; no command is a no-op |
| `exit` | Optional numeric status |
| `shift` | Optional non-negative count |
| `getopts` | `getopts OPTSTRING NAME [ARG ...]` |
| `eval` | Arguments are joined and evaluated as shell source |
| `.`, `source` | `FILE [ARG ...]` |
| `realpath` | One or more paths |
| `umask` | No operand to display, or an octal mask |
| `kill` | `-l`, `-SIGNAL`, `-NUMBER` |
| `set` | No operand to list variables; `-- ARG ...` sets positional arguments |
| `time` | Command and arguments; reports `real` elapsed time in milliseconds, with each decimal magnitude group shown in a different color |
| `yes` | Optional output words; no flags |

### PATH-fallback builtins

| Command | Supported flags/forms |
| --- | --- |
| `basename` | `--`, optional suffix |
| `dirname` | `--` |
| `cat` | `--`; files and `-` for stdin; no other options |
| `head` | `-n N`, `-N`, `-c N`, `-cN` |
| `tail` | `-n N`, `-N`; `-n +N` and `-n+N` output starting at line N |
| `wc` | `-l`, `-w`, `-c`, combinable |
| `tr` | `-d`; simple ranges such as `a-z` |
| `tee` | `-a` |
| `sleep` | Durations with `ms`, `s`, `m`, `h` suffixes; seconds by default |
| `clear` | No flags |
| `rmdir` | `-p`, `--parents` |
| `mktemp` | `-d`; template must end in `XXXXXX` |
| `sort` | `-r`, `-n`, `-u`, combinable |
| `date` | `+FORMAT`; `%Y`, `%m`, `%d`, `%H`, `%M`, `%S`, `%s`, `%F`, `%T`, `%%` |
| `md5sum`, `sha256sum` | Files or stdin; no flags |
| `grep` | `-E`, `-F`, `-i`, `-q`, `-v`, `-n`, `-o`, `-r`, `-x`, combinable; `--color[=always\|auto\|never]` (`--colour` also accepted) |
| `sed` | `-n`, `-e SCRIPT`, `-eSCRIPT`, `-E`, `-r`, `-i`; numeric `p`; `s///` with `g` and `p` |
| `cut` | `-c LIST`, `-cLIST` |
| `ln` | `-s`, `-f`, `-T`, combinable (including `-sfT`) |
| `chmod` | Octal modes, `+x`, `a+x` |
| `uname` | `-a`, `-s`, `-n`, `-r`, `-v`, `-m`, `-p`, combinable (including `-mprs`); uses Node's OS APIs on Windows without `/proc` |
| `find` | Paths plus `-name`, `-iname`, `-path`, `-ipath`, `-type f/d/l`, `-mindepth`, `-maxdepth`, `-print`, `-print0`, `!`/`-not`, `-exec COMMAND {} \;`, `-exec COMMAND {} +`; regular builtin on Windows, PATH fallback elsewhere |
| `bunmsh` | Forwards all following arguments to this bunmsh entry point |
| `bun` | Forwards all following arguments to the active Bun runtime |
| `lsfancy` | Emoji and terminal-width-aware directory listing; `-a`, `-A`, `-d`, `-l`, `-h`, `-t`, `-r`, `-R`, combinable (including `-lh` and `-ltr`); always reads the directory without using the completion cache |
| `ls` | Bun Shell currently implements `-a`, `-A`, `-d`, `-l`, `-R` |
| `mv` | Bun Shell currently accepts `-f`, `-h`, `-i`, `-n`, `-v`, but they do not change its behaviour; notably, `-i` and `-n` do not prevent overwriting |
| `rm` | Bun Shell currently implements `-f`, `-r`, `-R`, `-v`, `-d`, `-i`, `-I`, `--recursive`, `--verbose`, `--dir`, and `--interactive=never|once|always`; `--preserve-root` and `--no-preserve-root` are accepted but currently have no effect |
| `mkdir` | Bun Shell currently implements `-p`, `-v`, `--parents`, and `--vebose` (Bun's currently accepted spelling) |
| `seq` | Bun Shell currently accepts `-s`/`--separator`, `-t`/`--terminator`, and `-w`/`--fixed-width`; its formatting differs from GNU `seq` (`-w` does not currently pad, and a custom separator may also be emitted after the final item) |
| `touch` | Bun Shell fallback currently supports no flags |
| `cp` | `-r`, `-R`, `-v`; bunmsh converts `-r` to Bun Shell's `-R`. Bun Shell also accepts `-n`, but it currently has no effect |

Fallback commands preserve the system-command-first rule. For example, if
`/bin/grep` exists it runs instead of the fallback; `builtin grep ...` forces
the implementation described above.

The Bun Shell rows above describe the currently tested Bun implementation, not
a permanent compatibility guarantee. Their supported flags and exact behaviour
may change with later Bun releases; see [bunshell.md](bunshell.md) for the
detailed compatibility snapshot.

## What's implemented

- Interactive use, stdin and script files, `-c` shell text, and direct `-cc`
  argv forwarding.
- Highest-priority `Bun.*` JavaScript evaluation, including awaited promises,
  command substitution, and the `Bun.e;`/`Bun.e,` arbitrary-JavaScript forms.
- Concurrent streaming pipelines and streamed redirects built on `Bun.spawn`,
  including large output and early-closing consumers.
- Shell lists, pipelines, negation, functions, subshells, and `if`, `case`,
  `while`, `until`, and `for` compound commands.
- Quotes, parameter/command/arithmetic expansion, IFS field splitting, tilde,
  brace, and pathname expansion.
- Environment assignments, aliases, readonly names, positional parameters,
  shell functions, common redirections, and `2>&1` descriptor duplication.
- Regular builtins, system-command-first fallback builtins, Bun Shell fallbacks,
  and explicit lookup through `command`, `builtin`, `whence`, `type`, and
  `which`.
- Interactive history import/save/recall, command and file completion, ghost
  suggestions, cwd tabs, keyboard shortcuts, optional mouse interactions, and
  fancy directory listings.
- Linux, Android/Termux, macOS, and Windows-aware paths, plus standalone builds
  and dynamic-linker re-execution support.

See [PORTING.md](PORTING.md) for detailed semantics, implementation boundaries,
platform notes, and the remaining mksh/POSIX compatibility work.

## Test

```sh
bun test
```

## Built-in documentation

Show the README or changelog in the terminal with ANSI formatting:

```sh
bunmsh --readme
bunmsh --changelog
```

Both commands read their embedded copy first when running a standalone
executable, then fall back to `README.md` or `CHANGELOG.md` in the repository
during development.

## Standalone executable

Build a single-file executable for the current platform:

```sh
bun ./src/main.js --build-exe
./bmsh --version
```

Cross-compile for a Bun-supported target:

```sh
bun ./src/main.js --build-for bun-linux-x64
```

The build writes `./bmsh` and leaves the repository's `./bunmsh` launcher
unchanged. The executable includes the runtime assets declared in
`package.json`, currently including its README and changelog. See
[`single-exe/README.md`](single-exe/README.md) for asset-management options.

## License

The original bunmsh JavaScript implementation is released under the
[MIT License](LICENSE), Copyright (c) 2026 Dr. John (醫者小智).

mksh is a separate upstream project and is **not** relicensed under MIT. Its
complete licence terms remain in [LICENSE-MKSH](LICENSE-MKSH).
