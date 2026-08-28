## cat

Concatenate files or stdin.

### Usage

```sh
cat [--] [FILE ...]
```

### Options and forms

- `--`: Stop option parsing.
- `-`: Read from stdin at that operand position. No other options are supported.

### Example

```sh
printf 'hello\n' | builtin cat
```

Output:

```text
hello
```
