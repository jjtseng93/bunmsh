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

### Option 1: Run with npx

```sh
# Interactive shell
npx bunmsh
```

```sh
npx bunmsh -c 'print $PATH'

# Call cmd; this can call bunmsh builtins too
npx bunmsh -cc echo 'hello world' '*.txt' '$HOME'
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

# bun ./bunmsh script.sh arg1 arg2
```

`-cc` means **call cmd**. Every argument after it is forwarded as an
already-quoted word, without another round of bunmsh parsing or expansion. The
example calls the `echo` builtin and prints `hello world *.txt $HOME` literally.

### Highest-priority JavaScript mode

bunmsh can evaluate Bun JavaScript directly. Before tokenising, quoting or
performing any shell expansion, it removes leading whitespace and checks the
first four characters of the original input. If they are exactly `Bun.`, the
entire input is passed directly to JavaScript `eval` instead of the shell
parser:

```text
raw input beginning with Bun.  -> JavaScript eval
everything else                -> normal shell parser
```

The simplest example returns the current Bun version:

```js
Bun.version
```

A non-`undefined` result is printed automatically. Promises are awaited, so
asynchronous Bun APIs can be used without adding top-level `await`:

```js
Bun.file("package.json").text()
Bun.sleep(500).then(() => "finished")
Bun.hash("hello")
```

Because the check applies only to the beginning of the input, a `Bun.`
expression can be followed by arbitrary JavaScript statements:

```js
Bun.version; const numbers = [1, 2, 3]; numbers.reduce((a, b) => a + b, 0)
Bun.version; console.log(process.cwd()); console.log(process.platform)
```

#### Use `Bun.e;` or `Bun.e,` to run arbitrary JavaScript

The `Bun.` prefix is only the switch that selects JavaScript mode. The code
does not otherwise have to call a Bun API. `Bun.e` can be evaluated and
discarded as a convenient no-op prefix, allowing arbitrary JavaScript to
follow while the raw input still begins with the required four characters.
The `e` property does not need to exist: reading a missing JavaScript property
simply produces `undefined`.

Technically, any property name works because only the leading `Bun.` is
checked; for example, `Bun.x;` and `Bun.anything,` also enter JavaScript mode.
This README uses `e` as the conventional spelling because it stands for
**eval** (or **evaluate**), is short, and makes the intent recognisable:

```js
Bun.e; arbitraryJavaScriptStatement()
Bun.e, arbitraryJavaScriptExpression()
```

Use `Bun.e;` before one or more JavaScript statements:

```js
Bun.e; const numbers = [1, 2, 3]; numbers.reduce((a, b) => a + b, 0)
Bun.e; const message = "arbitrary JavaScript"; console.log(message)
```

Use the comma operator form `Bun.e,` before a single expression:

```js
Bun.e, 1 + 2
Bun.e, process.platform
Bun.e, ({ cwd: process.cwd(), pid: process.pid })
```

`Bun.e;` discards the `Bun.e` value and starts a new statement. `Bun.e,`
discards it through JavaScript's comma operator and returns the expression on
the right. Neither form invokes Bun Shell by itself; their purpose here is
only to enter the highest-priority evaluator and then execute unrestricted
JavaScript.

#### Use `Bun.sha` as a shared area (hack)

`Bun.sha` is normally Bun's SHA hashing function. JavaScript functions are
objects, and the function is extensible in current Bun versions, so custom
properties can be attached to it as a lightweight process-wide shared area:

```js
Bun.sha.var_name = { value: 123 }
Bun.sha.var_name.value
Bun.sha.counter = (Bun.sha.counter ?? 0) + 1
```

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
properties can break normal function behaviour.

For a lower collision risk, keep all shared values below one uniquely named
namespace:

```js
Bun.sha.bunmsh ??= Object.create(null)
Bun.sha.bunmsh.var_name = { value: 123 }
Bun.sha.bunmsh.var_name
```

Before choosing a direct property name, it can be checked explicitly:

```js
Bun.e, Object.hasOwn(Bun.sha, "var_name")
```

#### JavaScript inside shell command substitution

This mode also composes with shell command substitution. The outer command is
parsed as shell, while the contents of `$(...)` are evaluated again and can
trigger JavaScript mode independently:

```sh
echo "Bun version: $(Bun.version)"
```

Errors are printed to standard error with a stack trace and set the shell
status to `1`. Successful evaluation sets it to `0`; an `undefined` result
prints nothing.

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
that file for both Up/Down arrow recall and ghost completion. The standard path is
`$XDG_DATA_HOME/bunmsh/history`, falling back to
`~/.local/share/bunmsh/history`. Windows uses
`%LOCALAPPDATA%/bunmsh/history`.

### Tab system

bunmsh includes lightweight cwd tabs. A tab stores only its working directory;
variables, environment, aliases, readonly names, positional arguments, command
status and other shell state remain shared. Switching tabs changes `cwd` and
updates `PWD` without changing `OLDPWD`.

When more than one tab exists, the prompt displays every remembered path:

```text
📁 ~/project  📂 ~/project/src
$
```

`📂` marks the active tab and `📁` marks inactive tabs.

The shell starts with one tab. With no argument, `tab` creates a second tab
when only one exists; after that it cycles to the tab on the right:

```sh
tab
```

The explicit operations are:

```sh
tab n      # create and activate a new tab at the current cwd
tab 1      # activate tab 1 (numbers are 1-based)
tab 2      # activate tab 2
tab l      # cycle left
tab r      # cycle right
tab x      # close the active tab
tab s      # save interactive history (same as tab save)
tab save   # save interactive history; never done automatically
```

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
| `tab` | `n`, `x`, `l`, `r`, `s`, `save`, or a 1-based tab number |
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
| `time` | Command and arguments; reports milliseconds |
| `yes` | Optional output words; no flags |

### PATH-fallback builtins

| Command | Supported flags/forms |
| --- | --- |
| `basename` | `--`, optional suffix |
| `dirname` | `--` |
| `cat` | `--`; files and `-` for stdin; no other options |
| `head` | `-n N`, `-N`, `-c N`, `-cN` |
| `tail` | `-n N`, `-N` |
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
| `grep` | `-E`, `-F`, `-i`, `-q`, `-v`, `-n`, `-o`, `-r`, `-x`, combinable; accepts `--color=auto` |
| `sed` | `-n`, `-e SCRIPT`, `-eSCRIPT`, `-E`, `-r`, `-i`; numeric `p`; `s///` with `g` and `p` |
| `cut` | `-c LIST`, `-cLIST` |
| `ln` | `-s`, `-f`, `-T`, combinable (including `-sfT`) |
| `chmod` | Octal modes, `+x`, `a+x` |
| `uname` | `-a`, `-s`, `-n`, `-r`, `-v`, `-m`, combinable |
| `bunmsh` | Forwards all following arguments to this bunmsh entry point |
| `bun` | Forwards all following arguments to the active Bun runtime |
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

- Interactive prompt, standard-input scripts, script files and `-c`
- Highest-priority raw `Bun.*` JavaScript evaluation with `Bun.e;`/`Bun.e,` escape prefixes
- External commands through `Bun.spawn`
- Sequential pipelines (`a | b`)
- Command lists with `;`, `&&` and `||`
- Single quotes, double quotes and backslash quoting
- `$NAME`, `${NAME}`, `$?`, `$$`, `$#`, `$0` through `$9` .
- Leading environment assignments and persistent assignment-only commands
- `<`, `>`, `>>`, `2>` and `2>>`
- `cd`, `pwd`, `export`, `unset`, `env`, `exit`, `set`, `:`, `true`, `false`,
  `echo`, `print` and a small `printf` .

- See [PORTING.md](PORTING.md) for semantic limitations and the remaining mksh work.

## Test

```sh
bun test
```

## Built-in README

Show this README in the terminal with ANSI formatting:

```sh
bunmsh --readme
```

`--readme` reads the embedded copy first when running a standalone executable,
then falls back to the repository's `README.md` during development.

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
unchanged. The executable includes `README.md` as an internal asset. See
[`single-exe/README.md`](single-exe/README.md) for asset-management options.

## License

The original bunmsh JavaScript implementation is released under the
[MIT License](LICENSE), Copyright (c) 2026 Dr. John (醫者小智).

mksh is a separate upstream project and is **not** relicensed under MIT. Its
complete licence terms remain in [LICENSE-MKSH](LICENSE-MKSH).
