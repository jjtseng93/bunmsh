# bunmsh in QEMU

A Docker image that boots a Linux kernel under QEMU and hands the whole
userspace to this repository. There is no OpenRC, no getty and no login, and
no supervisor either: the kernel starts [`vm-init.sh`](vm-init.sh), which
mounts the pseudo filesystems, brings up the network, and then `exec`s the
shell — so **`bunmsh` itself is PID 1**.

The guest is an `Alpine + Bun + bunmsh` stack, built as a RAM-only initramfs
rather than a disk image: Alpine supplies the kernel and the base utilities,
Bun is the runtime, and everything else is this repository at `/opt/bunmsh`.

```text
Docker container
└── QEMU
    └── Linux kernel (Alpine linux-virt)
        ├── PID 1  bun /opt/bunmsh/src/main.js     ← on /dev/ttyS0 or /dev/ttyAMA0
        └── PID n  bun buninu/bin/init.js --jsgotty …   ← web mode only, a sibling
                   └── bun apps/jsgotty/gotty.js
                       └── bunmsh, one per browser session
```

Seen from inside the running guest, with one browser tab open:

```text
PID   COMMAND
    1 bun /opt/bunmsh/src/main.js
  445 bun /opt/buninu/bin/init.js --jsgotty --reconnect -r -w --webgl \
      -a 0.0.0.0 --port 8080 --title-format bunmsh@{{ .hostname }} \
      /bin/sh -c cd "$HOME" 2>/dev/null || cd /; exec '/opt/bunmsh/bunmsh'
  458 bun /opt/buninu/bin/../apps/jsgotty/gotty.js --reconnect …
  492 bun /opt/bunmsh/src/main.js
```

PID 1 takes the serial device as its controlling terminal, so job control,
Ctrl-C and window resizing work (`tty` answers `/dev/ttyAMA0`). The browser
session at PID 492 is a separate bunmsh on its own PTY (`/dev/pts/0`).

The `/bin/sh -c` wrapper is there because init.js spawns jsgotty with its own
installation directory as the working directory, which every browser session
would otherwise inherit; the wrapper starts the session in `$HOME` instead,
where the console shell already starts. `--title-format` restores the tab
title the wrapper would otherwise turn into `/bin/sh@bunmsh`.

This arrangement comes from
[jjtseng93/buninu#4](https://github.com/jjtseng93/buninu/pull/4), where the
userspace is the whole Buninu tree; here it is bunmsh alone, and jsgotty is
pulled in from npm only when the browser terminal is wanted.

## Build

```sh
docker build -t bunmsh-vm .
```

The guest is built for the image's own architecture: an x86_64 host produces an
x86_64 guest, an arm64 host an aarch64 one. Bun comes from the official musl
build (the baseline variant on x86_64, so it also runs on emulated CPUs
without AVX2). Pin it with `--build-arg BUN_VERSION=1.2.21` if `latest` ever
breaks.

| Build argument | Default | Meaning |
| --- | --- | --- |
| `ALPINE_VERSION` | `3.21` | Alpine release the kernel and base system come from |
| `BUN_VERSION` | `latest` | Bun release installed into the guest |
| `BUNINU_VERSION` | `none` | `latest` or a version bakes jsgotty into the image; `none` leaves web mode to fetch it at boot |

## Publishing to Docker Hub

[`DOCKERHUB.md`](DOCKERHUB.md) is the repository overview to paste into Docker
Hub's *Description* field. It opens with the attribution that matters for a
published build: the image is an unofficial one from a fork, and the shell is
the upstream author's work.

The image name has to carry the account for a push to be accepted, so the
easiest route is to tag it that way at build time:

```sh
docker login -u ACCOUNT
docker build -t ACCOUNT/bunmsh-vm:0.3.6 -t ACCOUNT/bunmsh-vm:latest .
docker push --all-tags ACCOUNT/bunmsh-vm
```

A personal access token from Docker Hub's *Account Settings → Personal access
tokens* works as the password and can be revoked on its own. An image that is
already built needs no rebuild, only a second name:

```sh
docker tag bunmsh-vm ACCOUNT/bunmsh-vm:0.3.6
```

The version tag is worth keeping in step with `version` in `package.json`,
since the repository travels inside the image and `latest` says nothing about
which bunmsh is in there. The repository is created on first push and is
public; a private one has to be created on the website beforehand.

### Both architectures

The guest is built for the image's own architecture, so an image pushed from
an arm64 machine is arm64 alone and an x86_64 host cannot run it. `buildx`
builds and pushes both at once:

```sh
docker buildx create --use --name bunmsh-builder
docker buildx build --platform linux/amd64,linux/arm64 \
  --build-arg BUNINU_VERSION=latest \
  -t ACCOUNT/bunmsh-vm:0.3.6 -t ACCOUNT/bunmsh-vm:latest --push .
```

`--push` uploads directly and leaves nothing in the local image list. The
foreign architecture is emulated during the build, which the ~100 MB of Alpine
packages and ~50 MB of Bun make slow the first time — expect this to take
considerably longer than a native build. Pushing a single architecture and
saying so in the description is a reasonable alternative.

`BUNINU_VERSION=latest` is worth adding for a published image specifically:
without it every `docker run … web` downloads jsgotty again before the browser
terminal comes up, on a machine whose network is not yours.

### Building it in CI

[`.github/workflows/docker.yml`](../.github/workflows/docker.yml) does all of
the above on a tag push (`0.3.6` or `v0.3.6`), and on demand from the Actions
tab. It publishes to this repository's own GitHub Container Registry, which
needs no secrets at all — `GITHUB_TOKEN` is the login:

```sh
docker pull ghcr.io/jjtseng93/bunmsh-vm:latest
```

Running it by hand is the *Run workflow* button on the workflow's page in the
Actions tab, or:

```sh
gh workflow run docker.yml                 # publishes :edge
gh workflow run docker.yml -f tag=0.3.6    # publishes :0.3.6 as well
gh run watch
```

GitHub only offers that button once the workflow file is on the **default
branch**, so it stays invisible while this lives on a feature branch — merge
it to `main` first, then the manual run works from any branch you pick in the
dialog.

A package pushed there starts out **private**, so the first publish has to be
made public by hand once, under the package's *Package settings → Change
visibility*, before anyone else can pull it.

Each architecture is built on a runner of its own architecture — `ubuntu-latest`
for amd64, `ubuntu-24.04-arm` for arm64 (free for public repositories) — and
pushed by digest; a final job joins the two digests into one manifest list and
puts the tags on it. That avoids emulating the Alpine and Bun downloads, which
is what makes a local `buildx --platform` build so slow. Layers are cached
between runs through the Actions cache, per architecture. Images are built
with `BUNINU_VERSION=latest`, so a published image runs `web` mode without
reaching the network at boot.

Docker Hub is optional and off unless it is configured: set the repository
*variable* `DOCKERHUB_USERNAME` and the *secret* `DOCKERHUB_TOKEN`, and the
finished manifest is copied to `docker.io/USERNAME/bunmsh-vm` under the same
tags. Without the variable those steps are skipped and GHCR is the only
destination.

## The console

This is the default mode, and the whole point of the image: bunmsh on the
container's own terminal, as PID 1.

```sh
docker run --rm -it bunmsh-vm
```

`-it` is required — without a terminal attached there is nothing for the shell
to talk to.

`BUNMSH_PORT` (8080 by default) is forwarded from the container to the same
port in the guest whatever the mode, so a server started inside the shell is
reachable from the host. bunmsh's own file server takes its port from `PORT`:

```sh
docker run --rm -it -p 8080:8080 bunmsh-vm
```

```text
$ PORT=8080 builtin serve /opt/bunmsh
```

### When 8080 is already taken

Docker does not pick another port for you: if something on the host already
holds 8080, `docker run -p 8080:8080` fails with *port is already allocated*
and that is the end of it. Three ways out, in order of convenience:

```sh
docker/run.sh web
```

`docker/run.sh` walks 8080, 8081, 8082, ... until it finds a free host port,
then publishes that port *and* sets `BUNMSH_PORT` to the same number, so the
URL jsgotty prints is the URL that works from the host. `BUNMSH_PORT` sets
where the walk starts and `BUNMSH_PORT_TRIES` (10 by default) how far it goes;
every other `BUNMSH_*` variable is passed through to the image, and anything
after the mode goes to `docker run`.

```text
[bunmsh-run] port 8080 is in use; using 8081 instead
```

Or pick the port yourself, on both sides at once — `--port` is the image's own
spelling of `BUNMSH_PORT`:

```sh
docker run --rm -it -p 8081:8081 bunmsh-vm web --port 8081
```

Or move only the host side and leave the guest on 8080. The printed URL then
names the guest's port, so substitute the host's when opening it:

```sh
docker run --rm -it -p 8081:8080 bunmsh-vm web
```

## The browser terminal

`web` mode additionally starts [jsgotty](https://www.npmjs.com/package/buninu),
a terminal in the browser, as a *sibling* of PID 1:

```sh
docker run -d --name bunmsh -p 8080:8080 bunmsh-vm web
```

`-d` is fine here: QEMU does not pass the host's stdin EOF into the guest, so
PID 1 keeps running without a terminal attached. Use `-it` instead when you
also want the console shell.

The URL carries a random path segment, so it has to be read from the log:

```sh
docker logs bunmsh | grep -A1 listening
```

```text
HTTP server is listening at:
    http://0.0.0.0:8080/8OKed5SNei7dfJuf/
```

Open that path on `localhost` — `http://localhost:8080/8OKed5SNei7dfJuf/` —
and you get bunmsh in the browser, on the same guest, beside the PID 1 shell.
Each browser tab gets its own bunmsh on its own PTY; closing the tab ends that
session and leaves the guest running. jsgotty's own log is at
`/var/log/jsgotty.log` inside the guest.

That random path is the only thing protecting the terminal by default, and
anyone who can reach the port and the path gets a working shell. Set a password
when the port is not purely local:

```sh
docker run -d --name bunmsh -p 8080:8080 -e BUNMSH_CREDENTIAL=user:pass bunmsh-vm web
```

### Where jsgotty comes from

jsgotty is not part of this repository — it ships in the npm
[`buninu`](https://www.npmjs.com/package/buninu) package, which has no
dependencies of its own. By default the image does not carry it, and
`vm-init.sh` downloads it into the guest at boot, so **web mode needs outbound
network on every start** (the root filesystem is the initramfs, so nothing it
downloads survives a restart). Bake it into the image instead when that is not
wanted:

```sh
docker build -t bunmsh-vm --build-arg BUNINU_VERSION=latest .
```

`BUNMSH_BUNINU_VERSION` pins what a non-baked guest fetches. If the download
fails, the guest says so and continues with the console shell alone.

### Why jsgotty is started through `--jsgotty`

`vm-init.sh` launches it as `bun bin/init.js --jsgotty ... /opt/bunmsh/bunmsh`
rather than the ordinary `bin/init.js --shell bunmsh` flow, because that flow
wraps `buninu.command` in a snippet that ends `fi; exec "$0"` and bunmsh cannot
parse a command after `fi;`:

```sh
bunmsh -c 'if [ 1 -ne 0 ]; then echo a; fi'            # a
bunmsh -c 'if [ 1 -ne 0 ]; then echo a; fi; echo b'    # syntax error: unterminated if
```

Through the ordinary flow the browser session dies the moment it opens
("Connection Closed"). This is a bunmsh parser limitation rather than a VM one,
and it reproduces on the host with any bunmsh up to 0.3.6 — so once bunmsh
parses that construct, `start_jsgotty` can go back to the plain flow. The
trade-off today is that `buninu.command`'s welcome message does not run in the
browser session.

A second gap found the same way, also unrelated to the VM: `>&2` is treated as
a target filename instead of a file-descriptor duplication, so
`bunmsh -c 'echo hello >&2'` creates a file named `&2` instead of writing to
stderr.

## Stopping the guest

`poweroff -f` inside the shell is the graceful way out: the guest powers down,
QEMU exits, the container stops.

Leaving the shell (`exit`, Ctrl-D) is *not* graceful, and that is inherent to
the design: PID 1 exiting is a kernel panic. The command line carries `panic=3`,
so the kernel resets three seconds later and QEMU, started with `-no-reboot`,
exits — the container still stops, just with a panic message on the way out.

`Ctrl-a x` quits QEMU from outside the guest.

## What PID 1 = bunmsh costs

Two things a normal init would do, nobody does here:

- **Orphans are not reaped.** Any process whose parent dies becomes a child of
  PID 1, and bunmsh does not `wait()` for them, so they stay as zombies. This
  is why the startup URL is printed synchronously rather than by a background
  helper.
- **No clean shutdown path.** Nothing flushes or stops services on the way
  down; `poweroff -f` resets the machine immediately.

If either matters, `BUNMSH_PID1=init` keeps `vm-init.sh` as PID 1 instead: it
runs the shell as a child under `setsid -c`, reaps orphans, and powers the
guest off cleanly when the shell exits.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `BUNMSH_MODE` | `console` | `console` is the shell alone, `web` also starts jsgotty beside it |
| `BUNMSH_PID1` | `shell` | `shell` makes bunmsh PID 1; `init` keeps a supervisor above it |
| `BUNMSH_PORT` | `8080` | Guest port, forwarded to the same port on the container |
| `BUNMSH_SHELL` | `bunmsh` | Shell the session starts; `bash` or `sh` also work |
| `BUNMSH_CREDENTIAL` | *(unset)* | `user:pass` for the browser terminal |
| `BUNMSH_BUNINU_VERSION` | `latest` | npm version of buninu the guest fetches for jsgotty |
| `BUNMSH_MEMORY` | `2048` | Guest RAM in MiB — the whole userspace lives in it |
| `BUNMSH_CPUS` | `2` | Guest vCPUs |
| `BUNMSH_QEMU_EXTRA` | *(unset)* | Extra QEMU arguments |
| `BUNMSH_PORT_TRIES` | `10` | `docker/run.sh` only: how many consecutive host ports it walks over |
| `BUNMSH_IMAGE` | `bunmsh-vm` | `docker/run.sh` only: image to run |
| `BUNMSH_DOCKER` | `docker` | `docker/run.sh` only: container CLI — `podman` works too |

The mode can also be given as the first argument, followed optionally by
`--port PORT`; anything after that is passed to QEMU:

```sh
docker run --rm -it -p 8080:8080 bunmsh-vm web -m 4096
docker run --rm -it -p 9000:9000 bunmsh-vm web --port 9000 -m 4096
```

A first argument that is neither a mode nor an option, and that names an
executable the container has, is run as-is instead of booting the VM — so the
image behaves like any other when you want to look inside it:

```sh
docker run --rm -it bunmsh-vm /bin/sh
docker run --rm bunmsh-vm ls /srv/bunmsh
```

The mode itself is only the image's `CMD` (`console`), so overriding it is all
that happens here. For the rare QEMU argument that also names a command, put
`--` first and everything after it goes to QEMU untouched.

## Speed

Measured on an M-series Mac under Docker Desktop, which exposes no `/dev/kvm`
and therefore runs the guest under TCG emulation: **7 seconds** from
`docker run` to a bunmsh prompt in console mode. With `/dev/kvm` available
(Linux host, `--device /dev/kvm`) it is faster still. The entrypoint prints
which accelerator it picked.

web mode adds however long it takes the guest to download the ~12 MB buninu
tarball, unless the image was built with `BUNINU_VERSION`.

The build itself is dominated by pulling ~100 MB of `linux-virt` from dl-cdn
and ~50 MB of Bun from GitHub, and it is worth knowing that Docker Desktop's
NAT can throttle those transfers badly — one observed run fetched the kernel
package at 60 KB/s while the host managed 25 MB/s on the same URL. The layer
caches, so only the first build pays for it.

## Notes

- The root filesystem is the initramfs, so it lives entirely in guest RAM and
  nothing written inside the VM survives a restart. Mount a host directory into
  the *container* and pass it on with `BUNMSH_QEMU_EXTRA` if you need
  persistence.
- Networking is QEMU user-mode (`10.0.2.15/24`, gateway `10.0.2.2`, DNS
  `10.0.2.3`), which gives the guest outbound access without any host
  privileges. `vm-init.sh` tries DHCP first and falls back to those addresses.
- `BUNMSH_CREDENTIAL` reaches the guest on the kernel command line, so it is
  readable from `/proc/cmdline` inside the VM.
- The repository's test suite travels with the image, so `cd /opt/bunmsh &&
  bun test` runs it inside the guest.
