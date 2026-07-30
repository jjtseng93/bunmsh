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

## What's implemented

- Interactive prompt, standard-input scripts, script files and `-c`
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
