## catfancy

Render Markdown and colorized parsed structured data; pass other formats through.

### Usage

```sh
catfancy [--] [FILE ...]
```

### Options and forms

- `--`: Stop option parsing.
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
