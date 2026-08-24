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
```

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

# bun ./bunmsh script.sh arg1 arg2
```

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
