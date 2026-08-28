## catfancy

Render Markdown and colorized parsed structured data; pass other formats through.

### Usage

```sh
catfancy [--exclude PATTERN]... [--] [FILE ...]
```

### Options and forms

- `--`: Stop option parsing.
- `--exclude PATTERN`/`--exclude=PATTERN`: Omit matching file operands using
  `Bun.Glob` patterns. Repeat the option to exclude more patterns; quote a
  pattern to prevent the shell from expanding it first.
- `-`: Read unformatted stdin; file previews are selected from filename extensions.

### Example

```sh
builtin catfancy package.json
```

Output:

```text
{
  "name": "bunmsh",
  "version": "0.1.10"
}  # colorized
```
