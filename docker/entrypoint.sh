#!/bin/sh
# Boots the bunmsh guest under QEMU.
#
#   bunmsh-vm [console|web] [--port PORT] [extra qemu args...]
#   bunmsh-vm <command> [args...]
#
# The second form is the way out of the VM: when the first argument is neither
# a mode nor an option and names something the *container* can execute, it is
# run as-is, so `docker run --rm -it bunmsh-vm /bin/sh` gives a shell in the
# image instead of handing /bin/sh to QEMU. Put `--` first to force the VM and
# pass everything after it to QEMU untouched.
#
# --port is the same setting as BUNMSH_PORT below, and wins over it. Note that
# it only moves the port *inside* the container: the host side is Docker's own
# -p, so the two have to agree (docker/run.sh picks a free pair for you).
#
# Everything else comes from the environment:
#   BUNMSH_MODE=console|web     both give bunmsh as PID 1 on the container's
#                               terminal (needs -it); web also starts jsgotty
#                               beside it as a separate process, for a
#                               terminal in the browser
#   BUNMSH_PID1=shell|init      shell (default) makes bunmsh itself PID 1;
#                               init keeps a supervisor that powers the guest
#                               off when the shell exits
#   BUNMSH_PORT=8080            guest port, forwarded to the same container
#                               port; jsgotty listens on it in web mode, and
#                               in console mode it is simply free for whatever
#                               the guest binds to it, `serve` included
#   BUNMSH_SHELL=bunmsh         shell the session starts
#   BUNMSH_CREDENTIAL=user:pass password for the browser terminal
#   BUNMSH_BUNINU_VERSION=latest  version of the npm buninu package the guest
#                               downloads for jsgotty when the image does not
#                               already carry it
#   BUNMSH_MEMORY=2048          guest RAM in MiB
#   BUNMSH_CPUS=2               guest vCPUs
#   BUNMSH_QEMU_EXTRA=...       extra QEMU arguments

set -eu

VM_DIR=/srv/bunmsh
KERNEL=$VM_DIR/vmlinuz
INITRD=$VM_DIR/initramfs.gz

MODE=${BUNMSH_MODE:-console}
PID1=${BUNMSH_PID1:-shell}
PORT=${BUNMSH_PORT:-8080}
SHELL_NAME=${BUNMSH_SHELL:-bunmsh}
CREDENTIAL=${BUNMSH_CREDENTIAL:-}
BUNINU_VERSION=${BUNMSH_BUNINU_VERSION:-latest}
MEMORY=${BUNMSH_MEMORY:-2048}
CPUS=${BUNMSH_CPUS:-2}

# `docker run bunmsh-vm /bin/sh` should give a shell in the container rather
# than feed /bin/sh to QEMU: anything that is not one of our own words and does
# resolve to an executable is simply run. `--` skips the check, for the rare
# QEMU argument that also names a command.
case "${1:-}" in
  --) shift ;;
  ''|-*|web|console) ;;
  *)
    if command -v "$1" >/dev/null 2>&1 || { [ -f "$1" ] && [ -x "$1" ]; }; then
      exec "$@"
    fi ;;
esac

case "${1:-}" in
  web|console) MODE=$1; shift ;;
  -h|--help)
    sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'
    exit 0 ;;
esac

# --port is read here rather than left to QEMU: it is the same knob as
# BUNMSH_PORT, in the spelling that is quicker to type on a `docker run` line.
# Everything after it still goes to QEMU untouched.
while :; do
  case "${1:-}" in
    --port) [ $# -ge 2 ] || { echo "bunmsh-vm: --port needs a value" >&2; exit 2; }
            PORT=$2; shift 2 ;;
    --port=*) PORT=${1#*=}; shift ;;
    *) break ;;
  esac
done

case "$PORT" in
  ''|*[!0-9]*) echo "bunmsh-vm: invalid port: $PORT" >&2; exit 2 ;;
esac

arch=$(uname -m)
case "$arch" in
  x86_64)
    qemu=qemu-system-x86_64
    machine="q35"
    console_dev=ttyS0
    net_device=virtio-net-pci
    rng_device=virtio-rng-pci
    ;;
  aarch64)
    qemu=qemu-system-aarch64
    machine="virt"
    console_dev=ttyAMA0
    net_device=virtio-net-device
    rng_device=virtio-rng-device
    ;;
  *)
    echo "bunmsh-vm: unsupported architecture: $arch" >&2
    exit 1 ;;
esac

# KVM when the container can reach it, plain emulation otherwise. Docker
# Desktop on macOS and Windows has no /dev/kvm, so the guest runs under TCG.
if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
  accel="-accel kvm -cpu host"
  echo "[bunmsh-vm] KVM available: the guest runs accelerated"
else
  accel="-accel tcg -cpu max"
  echo "[bunmsh-vm] no /dev/kvm: the guest runs under emulation (slower boot)"
fi

# panic=3: with the shell as PID 1, leaving it kills init. The kernel then
# resets after three seconds and QEMU, started with -no-reboot, exits.
cmdline="console=${console_dev} panic=3 loglevel=4 bunmsh.mode=${MODE} bunmsh.port=${PORT} bunmsh.shell=${SHELL_NAME} bunmsh.pid1=${PID1} bunmsh.buninu=${BUNINU_VERSION}"
if [ -n "$CREDENTIAL" ]; then
  cmdline="$cmdline bunmsh.credential.b64=$(printf '%s' "$CREDENTIAL" | base64 | tr -d '\n')"
fi

if [ "$MODE" = web ]; then
  echo "[bunmsh-vm] browser terminal on port ${PORT}; the URL, which carries a random path, is printed once jsgotty is up"
  if [ -z "$CREDENTIAL" ]; then
    echo "[bunmsh-vm] no BUNMSH_CREDENTIAL set: anything that can reach this port and path gets a shell"
  fi
fi
if [ "$PID1" = shell ]; then
  echo "[bunmsh-vm] ${SHELL_NAME} runs as PID 1: type 'poweroff -f' to stop the guest; leaving the shell panics the kernel by design"
fi
echo "[bunmsh-vm] run with -it for the console, and leave QEMU with Ctrl-a x"

# shellcheck disable=SC2086
exec "$qemu" \
  -machine "$machine" \
  $accel \
  -smp "$CPUS" \
  -m "$MEMORY" \
  -kernel "$KERNEL" \
  -initrd "$INITRD" \
  -append "$cmdline" \
  -netdev "user,id=net0,hostfwd=tcp::${PORT}-:${PORT}" \
  -device "$net_device,netdev=net0" \
  -device "$rng_device" \
  -nographic \
  -no-reboot \
  ${BUNMSH_QEMU_EXTRA:-} \
  "$@"
