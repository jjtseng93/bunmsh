# bunmsh in a VM.
#
# Stage 1 builds a Linux kernel + initramfs whose entire userspace is this
# repository: Bun as the runtime and bunmsh as the shell — and as PID 1.
# Stage 2 is a thin QEMU image that boots it.
#
#   docker build -t bunmsh-vm .
#   docker run --rm -it bunmsh-vm                       # bunmsh on the serial console
#   docker run --rm -it -p 8080:8080 bunmsh-vm web      # browser terminal (jsgotty)
#   docker run --rm -it bunmsh-vm /bin/sh               # a shell in the container itself
#
# When 8080 is already taken on the host, Docker fails rather than picking
# another port. Either move both sides together, or let docker/run.sh find a
# free host port by walking 8080, 8081, 8082, ...:
#
#   docker run --rm -it -p 8081:8081 bunmsh-vm web --port 8081
#   docker/run.sh web
#
# The guest runs on the same architecture as the image (x86_64 or aarch64).
#
# web mode needs jsgotty, which lives in the npm `buninu` package rather than
# in this repository. By default the guest fetches it at boot, so web mode
# needs outbound network on first start; --build-arg BUNINU_VERSION=latest
# bakes it into the image instead.

ARG ALPINE_VERSION=3.21

FROM alpine:${ALPINE_VERSION} AS vmbuilder

ARG ALPINE_VERSION=3.21
# "latest", or a Bun version such as 1.2.21
ARG BUN_VERSION=latest
# "none" (the default), "latest", or a buninu version such as 0.4.9. Anything
# but "none" bakes jsgotty into the image, so web mode needs no network.
ARG BUNINU_VERSION=none

RUN apk add --no-cache curl unzip cpio gzip kmod

# ---------------------------------------------------------------------------
# A minimal Alpine root filesystem, built with apk from the host's own
# repositories. linux-virt brings both the kernel and its modules. This step
# pulls roughly 100 MB from dl-cdn and apk downloads as it installs, so its
# duration is whatever the link gives you: measured runs ranged from 3 seconds
# to 5 minutes. The layer caches, so only the first build pays for it.
# ---------------------------------------------------------------------------
RUN set -eu; \
    mkdir -p /rootfs/etc/apk; \
    cp -a /etc/apk/keys /rootfs/etc/apk/keys; \
    printf '%s\n' \
      "https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION}/main" \
      "https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION}/community" \
      > /rootfs/etc/apk/repositories; \
    apk add --root /rootfs --initdb --no-cache \
      --repositories-file /rootfs/etc/apk/repositories \
      alpine-base \
      linux-virt \
      kmod \
      iproute2 \
      libgcc \
      libstdc++ \
      ca-certificates \
      ncurses-terminfo-base \
      bash \
      curl

# Pull the kernel out of the rootfs, drop module trees a VM never touches,
# then rebuild the dependency index.
RUN set -eu; \
    mkdir -p /out; \
    cp /rootfs/boot/vmlinuz-virt /out/vmlinuz; \
    rm -rf /rootfs/boot; \
    kver=$(ls /rootfs/lib/modules); \
    for dir in drivers/gpu drivers/media drivers/infiniband drivers/net/wireless sound; do \
      rm -rf "/rootfs/lib/modules/$kver/kernel/$dir"; \
    done; \
    depmod -b /rootfs "$kver"

# ---------------------------------------------------------------------------
# Bun. The x86_64 guest may run under TCG emulation without AVX2, so use the
# baseline build there; both are the musl builds, for Alpine.
# ---------------------------------------------------------------------------
RUN set -eu; \
    case "$(apk --print-arch)" in \
      x86_64)  asset=bun-linux-x64-musl-baseline.zip ;; \
      aarch64) asset=bun-linux-aarch64-musl.zip ;; \
      *) echo "unsupported architecture: $(apk --print-arch)" >&2; exit 1 ;; \
    esac; \
    if [ "$BUN_VERSION" = latest ]; then \
      url="https://github.com/oven-sh/bun/releases/latest/download/$asset"; \
    else \
      url="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/$asset"; \
    fi; \
    curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors \
      -o /tmp/bun.zip "$url"; \
    unzip -j -o /tmp/bun.zip '*/bun' -d /rootfs/usr/local/bin; \
    chmod 0755 /rootfs/usr/local/bin/bun; \
    rm -f /tmp/bun.zip

# ---------------------------------------------------------------------------
# jsgotty, optionally. It ships in the npm `buninu` package, which has no
# dependencies of its own, so the published tarball is the whole install.
# vm-init.sh looks for /opt/buninu/bin/init.js and downloads it at boot when
# it is not there.
# ---------------------------------------------------------------------------
RUN set -eu; \
    if [ "$BUNINU_VERSION" = none ]; then \
      echo "BUNINU_VERSION=none: web mode will fetch jsgotty at boot"; \
    else \
      if [ "$BUNINU_VERSION" = latest ]; then \
        url=$(curl -fsSL https://registry.npmjs.org/buninu/latest \
          | sed -n 's/.*"tarball":"\([^"]*\)".*/\1/p'); \
      else \
        url="https://registry.npmjs.org/buninu/-/buninu-${BUNINU_VERSION}.tgz"; \
      fi; \
      [ -n "$url" ] || { echo "cannot resolve the buninu tarball URL" >&2; exit 1; }; \
      mkdir -p /tmp/buninu; \
      curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors "$url" \
        | tar -xz -C /tmp/buninu; \
      test -f /tmp/buninu/package/bin/init.js; \
      mkdir -p /rootfs/opt; \
      mv /tmp/buninu/package /rootfs/opt/buninu; \
      rm -rf /tmp/buninu; \
    fi

# ---------------------------------------------------------------------------
# The userspace itself: this repository, and the init that starts it.
# ---------------------------------------------------------------------------
COPY docker/vm-init.sh /rootfs/init
COPY . /rootfs/opt/bunmsh

RUN set -eu; \
    chmod 0755 /rootfs/init /rootfs/opt/bunmsh/bunmsh /rootfs/opt/bunmsh/index.js; \
    rm -rf /rootfs/opt/bunmsh/.git \
           /rootfs/opt/bunmsh/Dockerfile \
           /rootfs/opt/bunmsh/.dockerignore \
           /rootfs/opt/bunmsh/docker; \
    ln -sf /opt/bunmsh/bunmsh /rootfs/usr/local/bin/bunmsh; \
    mkdir -p /rootfs/root; \
    printf 'bunmsh\n' > /rootfs/etc/hostname; \
    printf '127.0.0.1 localhost bunmsh\n' > /rootfs/etc/hosts; \
    printf 'nameserver 10.0.2.3\n' > /rootfs/etc/resolv.conf

RUN set -eu; \
    cd /rootfs && find . -print0 \
      | cpio --null --create --format=newc --quiet \
      | gzip -6 > /out/initramfs.gz; \
    ls -lh /out

# ---------------------------------------------------------------------------
# Stage 2: QEMU, the kernel, and the initramfs.
# ---------------------------------------------------------------------------
FROM alpine:${ALPINE_VERSION}

RUN set -eu; \
    case "$(apk --print-arch)" in \
      x86_64)  apk add --no-cache qemu-system-x86_64 ;; \
      aarch64) apk add --no-cache qemu-system-aarch64 ;; \
      *) echo "unsupported architecture: $(apk --print-arch)" >&2; exit 1 ;; \
    esac

COPY --from=vmbuilder /out/vmlinuz /out/initramfs.gz /srv/bunmsh/
COPY docker/entrypoint.sh /usr/local/bin/bunmsh-vm
RUN chmod 0755 /usr/local/bin/bunmsh-vm

ENV BUNMSH_MODE=console \
    BUNMSH_PID1=shell \
    BUNMSH_PORT=8080 \
    BUNMSH_MEMORY=2048 \
    BUNMSH_CPUS=2 \
    BUNMSH_SHELL=bunmsh

EXPOSE 8080

# The mode lives in CMD, so `docker run bunmsh-vm web` and
# `docker run bunmsh-vm /bin/sh` both just replace it; the entrypoint runs any
# first argument that names an executable instead of booting the VM.
ENTRYPOINT ["/usr/local/bin/bunmsh-vm"]
CMD ["console"]
