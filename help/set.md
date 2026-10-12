## set

Print variables, replace positional parameters, or change shell options.

### Usage

```sh
set [-eufxv] [+eufxv] [-o NAME | +o NAME] [-- [ARG ...]]
```

### Options and forms

- No arguments: print variables.
- `--`: replace positional parameters, including clearing them with no following arguments.
- `-e` / `+e`: enable/disable exit on untested failures. Conditions, negation and non-final AND/OR commands suppress it.
- `-u` / `+u`: enable/disable errors for unset parameters; explicit defaults still work.
- `-f` / `+f`: disable/enable pathname expansion.
- `-x` / `+x`: enable/disable execution tracing.
- `-o` / `+o` without a name: list named option states / reusable set commands.
- Names: `errexit`, `nounset`, `noglob`, `xtrace`, `verbose`. CLI `-v` prints initial input; incremental verbose reading is not yet implemented.
- `-o posix`: accepted for configure compatibility, not a guarantee of complete POSIX semantics.

### Example

```sh
set -- alpha beta
echo "$1/$2"
```

Output:

```text
alpha/beta
```
