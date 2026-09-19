#!/bin/sh
# The guest's first process.
#
# This script is what the kernel executes, but it does not stay: it prepares
# the machine and then `exec`s this repository's own shell, so bunmsh replaces
# it and *is* PID 1. In web mode jsgotty is started first, as a separate
# process beside the shell rather than above it.
#
# Configuration arrives on the kernel command line:
#   bunmsh.mode=console|web   bunmsh.port=8080   bunmsh.addr=0.0.0.0
#   bunmsh.shell=<name|path>  bunmsh.credential.b64=<base64 of user:pass>
#   bunmsh.buninu=<version>   npm version of the buninu package to fetch for
#                             jsgotty when the image does not carry it
#   bunmsh.pid1=shell|init    shell (default) execs the shell as PID 1;
#                             init keeps this script as PID 1 and supervises

set -u

PATH=/opt/bunmsh:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

BUNINU_DIR=/opt/buninu
JSGOTTY_LOG=/var/log/jsgotty.log

log() { printf '\033[36m[bunmsh-vm]\033[0m %s\n' "$*"; }

mount -t proc     -o nosuid,noexec,nodev proc   /proc  2>/dev/null
mount -t sysfs    -o nosuid,noexec,nodev sysfs  /sys   2>/dev/null
mount -t devtmpfs -o nosuid,mode=0755    devtmpfs /dev 2>/dev/null
mkdir -p /dev/pts /dev/shm /run /tmp /var/log
mount -t devpts -o nosuid,noexec,gid=5,mode=0620,ptmxmode=0666 devpts /dev/pts 2>/dev/null
mount -t tmpfs  -o nosuid,nodev tmpfs /dev/shm 2>/dev/null
mount -t tmpfs  -o nosuid,nodev tmpfs /run     2>/dev/null
mount -t tmpfs  -o nosuid,nodev tmpfs /tmp     2>/dev/null

MODE=console
PORT=8080
ADDR=0.0.0.0
SHELL_NAME=bunmsh
PID1=shell
BUNINU_VERSION=latest
CREDENTIAL=
CREDENTIAL_REQUESTED=no

for arg in $(cat /proc/cmdline 2>/dev/null); do
  case "$arg" in
    bunmsh.mode=*)   MODE=${arg#*=} ;;
    bunmsh.port=*)   PORT=${arg#*=} ;;
    bunmsh.addr=*)   ADDR=${arg#*=} ;;
    bunmsh.shell=*)  SHELL_NAME=${arg#*=} ;;
    bunmsh.pid1=*)   PID1=${arg#*=} ;;
    bunmsh.buninu=*) BUNINU_VERSION=${arg#*=} ;;
    bunmsh.credential.b64=*)
      CREDENTIAL_REQUESTED=yes
      CREDENTIAL=$(printf '%s' "${arg#*=}" | base64 -d 2>/dev/null) ;;
  esac
done

# A password that was asked for but could not be decoded must never degrade
# into an open terminal.
if [ "$CREDENTIAL_REQUESTED" = yes ] && [ -z "$CREDENTIAL" ]; then
  log "the credential on the kernel command line could not be decoded; refusing to start"
  poweroff -f 2>/dev/null
  while :; do sleep 60; done
fi

# The real serial device, not /dev/console: opening it as a session leader is
# what gives PID 1 a controlling terminal, and without one the shell has no
# job control, no Ctrl-C and no window size.
CONSOLE=/dev/console
for arg in $(cat /proc/cmdline 2>/dev/null); do
  case "$arg" in
    console=*)
      device=${arg#*=}
      device=${device%%,*}
      [ -c "/dev/$device" ] && CONSOLE=/dev/$device ;;
  esac
done

# --- devices -------------------------------------------------------------
for module in virtio virtio_ring virtio_pci virtio_mmio failover net_failover \
              virtio_net virtio_rng virtio_console; do
  modprobe -q "$module" 2>/dev/null
done

# --- network -------------------------------------------------------------
# QEMU user-mode networking: 10.0.2.15/24 behind the gateway 10.0.2.2, with
# 10.0.2.3 as the resolver. DHCP first, the well-known static addresses after.
hostname bunmsh 2>/dev/null
ip link set lo up 2>/dev/null

if ip link show eth0 >/dev/null 2>&1; then
  ip link set eth0 up 2>/dev/null
  configured=no
  if [ -x /usr/share/udhcpc/default.script ]; then
    if udhcpc -i eth0 -n -q -t 4 -T 1 >/dev/null 2>&1; then
      configured=yes
    fi
  fi
  if [ "$configured" = no ]; then
    ip addr add 10.0.2.15/24 dev eth0 2>/dev/null
    ip route add default via 10.0.2.2 2>/dev/null
    printf 'nameserver 10.0.2.3\n' > /etc/resolv.conf
  fi
else
  log "no eth0: the guest has no network"
fi

# --- session -------------------------------------------------------------
export HOME=/root
export USER=root
export LOGNAME=root
export TERM=${TERM:-xterm-256color}
export COLORTERM=truecolor
export LANG=C.UTF-8
export BUNMSH_HOME=/opt/bunmsh

cd /root || cd /

# Single-quote a value for safe reuse inside a shell command string.
sq() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# jsgotty is not part of this repository; it ships in the npm buninu package,
# which has no dependencies, so the published tarball is the whole install.
# The image may already carry it (--build-arg BUNINU_VERSION=...); otherwise
# it is fetched now, into the initramfs, which lives in RAM — so this happens
# again on every boot.
ensure_jsgotty() {
  [ -f "$BUNINU_DIR/bin/init.js" ] && return 0

  log "jsgotty is not in this image; downloading buninu@${BUNINU_VERSION} from npm"
  if [ "$BUNINU_VERSION" = latest ]; then
    url=$(curl -fsSL https://registry.npmjs.org/buninu/latest 2>/dev/null \
      | sed -n 's/.*"tarball":"\([^"]*\)".*/\1/p')
  else
    url="https://registry.npmjs.org/buninu/-/buninu-${BUNINU_VERSION}.tgz"
  fi
  if [ -z "${url:-}" ]; then
    log "cannot resolve the buninu tarball URL; no browser terminal"
    return 1
  fi

  rm -rf /tmp/buninu-download
  mkdir -p /tmp/buninu-download
  if ! curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors "$url" \
      | tar -xz -C /tmp/buninu-download 2>/dev/null; then
    log "downloading buninu failed; no browser terminal"
    return 1
  fi
  if [ ! -f /tmp/buninu-download/package/bin/init.js ]; then
    log "the buninu tarball does not contain bin/init.js; no browser terminal"
    return 1
  fi
  rm -rf "$BUNINU_DIR"
  mv /tmp/buninu-download/package "$BUNINU_DIR"
  rmdir /tmp/buninu-download 2>/dev/null
  return 0
}

# jsgotty, in its own session so it neither holds nor loses the console.
# Its output goes to a log file instead of the console, which the shell on
# that console is using; the listening URL is echoed once, below.
#
# This uses init.js's --jsgotty entry point, which skips the shell/startup
# command flow and hands the shell to jsgotty directly. The ordinary
# `--shell bunmsh` flow wraps buninu.command in a snippet ending
# `fi; exec "$0"`, and bunmsh cannot parse a command after `fi;`
# ("syntax error: unterminated if"), so the browser session would die the
# moment it opened.
start_jsgotty() {
  shell_path=$(command -v "$SHELL_NAME" 2>/dev/null || printf '%s' "$SHELL_NAME")
  # init.js spawns jsgotty with its own installation directory as the working
  # directory, and every browser session inherits it. This one-line wrapper
  # puts the session in the home directory instead, where the console shell
  # already starts.
  session="cd \"\$HOME\" 2>/dev/null || cd /; exec $(sq "$shell_path")"
  command="exec bun $(sq "$BUNINU_DIR/bin/init.js") --jsgotty --reconnect -r -w --webgl"
  command="$command -a $(sq "$ADDR") --port $(sq "$PORT")"
  # Without this the tab would be titled after the wrapper, "/bin/sh@bunmsh".
  command="$command --title-format $(sq "$SHELL_NAME@{{ .hostname }}")"
  [ -n "$CREDENTIAL" ] && command="$command --credential $(sq "$CREDENTIAL")"
  command="$command /bin/sh -c $(sq "$session")"
  setsid /bin/sh -c "$command > $JSGOTTY_LOG 2>&1" < /dev/null &
  log "jsgotty started on ${ADDR}:${PORT} with shell $shell_path (log: $JSGOTTY_LOG)"
}

# jsgotty's URL carries a random path segment, so it has to be reported. This
# waits in the foreground on purpose: once PID 1 is the shell, nothing reaps
# orphans, so a background helper would linger as a zombie.
announce_url() {
  waited=0
  while [ "$waited" -lt 20 ]; do
    if grep -q "listening" "$JSGOTTY_LOG" 2>/dev/null; then
      sed -n '/listening/,/Access mode/p' "$JSGOTTY_LOG"
      return 0
    fi
    waited=$((waited + 1))
    sleep 1
  done
  log "jsgotty has not reported a listening address yet; see $JSGOTTY_LOG"
}

if [ "$MODE" = web ]; then
  if ensure_jsgotty; then
    start_jsgotty
    announce_url
  else
    log "continuing with the console shell alone"
  fi
fi

if [ "$PID1" = init ]; then
  # Supervised: this script stays PID 1, the shell runs as its child, and the
  # guest powers off cleanly when that shell exits.
  log "starting $SHELL_NAME on $CONSOLE (supervised)"
  setsid -c /bin/sh -c "exec $(sq "$SHELL_NAME")" <> "$CONSOLE" >&0 2>&0
  status=$?
  log "session exited (status $status); powering off"
  sync
  poweroff -f 2>/dev/null
  printf 'o' > /proc/sysrq-trigger 2>/dev/null
  while :; do sleep 60; done
fi

# PID 1 is the shell itself. Take the console as this session's controlling
# terminal, then hand the process over: no supervisor, no wrapper.
#
# Because PID 1 is the shell, leaving it is a kernel panic ("Attempted to kill
# init"), and panic=N on the command line turns that into a reset that QEMU,
# started with -no-reboot, exits on. `poweroff -f` is the graceful way out.
log "handing PID 1 to $SHELL_NAME on $CONSOLE"
exec <"$CONSOLE" >"$CONSOLE" 2>&1
exec "$SHELL_NAME"
