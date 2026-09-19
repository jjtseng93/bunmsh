# bunmsh-vm

`bunmsh` — a dependency-free, mksh-inspired command shell for
[Bun](https://bun.com) — running as **PID 1** inside a Linux guest, booted by
QEMU inside the container. No init, no getty, no supervisor above it.

> ### Attribution
>
> **This image is an unofficial build published from a fork.** The shell, and
> everything the guest runs, is the work of the upstream project:
>
> - **Upstream repository:** <https://github.com/jjtseng93/bunmsh>
> - **Original author:** Dr. John (醫者小智) — MIT licensed, Copyright (c) 2026
> - **This image is built from:** a fork of that repository, which adds only
>   the Docker/QEMU packaging (`Dockerfile`, `docker/`) — no change to the
>   shell itself.
>
> The image is **not** published, endorsed or supported by the upstream
> author. Bugs in `bunmsh` belong upstream; bugs in the image or its boot
> path belong to this fork. `mksh` is a separate upstream project and is not
> relicensed under MIT (see `LICENSE-MKSH` inside the image); the shell-syntax
> colouring rules are transcribed from [micro](https://github.com/zyedidia/micro),
> MIT, Copyright (c) 2016-2020 Zachary Yedidia et al. (see `LICENSE-MICRO`).

## Quick start

```sh
docker run --rm -it hcyuser/bunmsh-vm
```

`-it` is required: the shell is PID 1 on the guest's serial console, so it
needs a terminal. `poweroff -f` stops the guest; leaving the shell panics the
kernel by design, which also stops the container.

A terminal in the browser instead, on a random URL path printed to the log:

```sh
docker run -d --name bunmsh -p 8080:8080 hcyuser/bunmsh-vm web
docker logs bunmsh | grep -A1 listening
```

If 8080 is already taken on the host, Docker fails with *port is already
allocated* rather than choosing another port. Move both sides together —
`--port` is the image's own spelling of `BUNMSH_PORT`:

```sh
docker run -d --name bunmsh -p 8081:8081 hcyuser/bunmsh-vm web --port 8081
```

The repository's `docker/run.sh` does this for you, walking 8080, 8081,
8082, ... until it finds a free host port.

## What is inside

```text
Docker container
└── QEMU
    └── Linux kernel (Alpine linux-virt)
        ├── PID 1  bun /opt/bunmsh/src/main.js     ← on /dev/ttyS0 or /dev/ttyAMA0
        └── PID n  jsgotty                          ← web mode only, a sibling
```

Alpine supplies the kernel and base utilities, Bun is the runtime, and the
whole userspace is the bunmsh repository at `/opt/bunmsh`. It is a RAM-only
initramfs rather than a disk image, so nothing in the guest survives a stop.

## Tags

| Tag | Meaning |
| --- | --- |
| `latest` | The most recent released bunmsh version |
| `X.Y.Z`, `X.Y` | A specific bunmsh release, matching `version` in `package.json` |
| `edge` | A manual build from the fork's default branch |

Published for `linux/amd64` and `linux/arm64`. The guest runs on the same
architecture as the image.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `BUNMSH_MODE` | `console` | `console` is the shell alone, `web` also starts jsgotty beside it |
| `BUNMSH_PID1` | `shell` | `shell` makes bunmsh PID 1; `init` keeps a supervisor above it |
| `BUNMSH_PORT` | `8080` | Guest port, forwarded to the same port on the container |
| `BUNMSH_SHELL` | `bunmsh` | Shell the session starts; `bash` or `sh` also work |
| `BUNMSH_CREDENTIAL` | *(unset)* | `user:pass` for the browser terminal |
| `BUNMSH_BUNINU_VERSION` | `latest` | npm version of `buninu` the guest fetches for jsgotty |
| `BUNMSH_MEMORY` | `2048` | Guest RAM in MiB — the whole userspace lives in it |
| `BUNMSH_CPUS` | `2` | Guest vCPUs |
| `BUNMSH_QEMU_EXTRA` | *(unset)* | Extra QEMU arguments |

The mode can be given as the first argument, optionally followed by
`--port PORT`; anything after that is passed to QEMU.

`BUNMSH_CREDENTIAL` reaches the guest on the kernel command line, so it is
visible to anything that can read `/proc/cmdline` in the guest.

## Documentation

- Shell usage, builtins and JavaScript mode: the upstream
  [README](https://github.com/jjtseng93/bunmsh#readme)
- The image, its boot path, and what PID 1 = bunmsh costs:
  [`docker/README.md`](https://github.com/jjtseng93/bunmsh/blob/main/docker/README.md)

## License

MIT for bunmsh itself — `LICENSE`, `LICENSE-MKSH` and `LICENSE-MICRO` all
travel inside the image at `/opt/bunmsh`.
