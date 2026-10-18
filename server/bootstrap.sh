#!/usr/bin/env bash
# CoderRa server setup. Run once, as root, on the machine the agent will live on (Ubuntu or Debian):
#
#   sudo ./bootstrap.sh --pubkey "ssh-ed25519 AAAA... coderra-app" --address agent.example.com
#
# It creates an unprivileged user (coderra) with no sudo, installs what the host needs, sets up the rootless container
# the agent's shell runs in, installs the systemd user service, and lets the app's key in over ssh. It prints a setup code
# at the end; paste that into the app (Settings > Server agent) and the app takes it from there, copying the host over
# and starting it.
#
# Safe to run again: existing users, keys and settings are kept, the rest is brought up to date.
#
# Options
#   --pubkey KEY        the app's ssh public key (required; the app shows it)
#   --address HOST      name or IP the app should connect to (default: this machine's first address)
#   --user NAME         the account to create (default: coderra)
#   --node-version X.Y.Z  Node.js to install if the system has none that is new enough (default: 24.22.0)
#   --no-box            do not set up Podman and the container (the agent's shell then runs directly on the server)
#   --harden-ssh        turn off password logins and root login. Needs --admin-user, so you cannot lock yourself out.
#   --admin-user NAME   an account that must keep ssh access (repeatable); only used with --harden-ssh
#   --dry-run           print what would be done, change nothing (works without root)
#   -h, --help
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

USER_NAME=coderra
NODE_VERSION=24.22.0
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=19
PUBKEY=""
ADDRESS=""
INSTALL_BOX=1
HARDEN_SSH=0
ADMIN_USERS=()
DRY_RUN=0

# What the app's key may do. restrict turns everything off; then only what the app needs is turned back on:
#   pty              the terminal tab
#   port-forwarding  -L tunnels, but only to this machine's own loopback (permitopen)
#   permitlisten     no remote (-R) forwards: the only address allowed is a privileged port nobody can bind
KEY_OPTIONS='restrict,pty,port-forwarding,permitopen="127.0.0.1:*",permitlisten="127.0.0.1:1"'

PACKAGES=(git ripgrep fd-find rsync curl ca-certificates tmux openssh-client xz-utils)
BOX_PACKAGES=(podman uidmap slirp4netns passt catatonit dbus-user-session fuse-overlayfs)

say() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}
usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }

# Runs a command, or only shows it with --dry-run.
run() {
	if [ "$DRY_RUN" = 1 ]; then
		printf '+'
		printf ' %q' "$@"
		printf '\n'
	else
		"$@"
	fi
}

# ---------------------------------------------------------------------------
# Arguments

while [ "$#" -gt 0 ]; do
	case "$1" in
		--pubkey) PUBKEY=${2:-}; shift 2 ;;
		--address) ADDRESS=${2:-}; shift 2 ;;
		--user) USER_NAME=${2:-}; shift 2 ;;
		--node-version) NODE_VERSION=${2:-}; shift 2 ;;
		--no-box) INSTALL_BOX=0; shift ;;
		--harden-ssh) HARDEN_SSH=1; shift ;;
		--admin-user) ADMIN_USERS+=("${2:-}"); shift 2 ;;
		--dry-run) DRY_RUN=1; shift ;;
		-h | --help) usage; exit 0 ;;
		*) die "unknown option: $1 (see --help)" ;;
	esac
done

[ -n "$PUBKEY" ] || die "--pubkey is required: the app's ssh public key (the app shows it under Settings > Server agent)"
# One line, a key type we know, base64 key material, optional comment. No leading options: they would be ours to set.
[[ "$PUBKEY" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com)\ [A-Za-z0-9+/]+=*(\ [^[:cntrl:]]*)?$ ]] \
	|| die "--pubkey does not look like a single ssh public key line (for example: ssh-ed25519 AAAA... name)"
[[ "$USER_NAME" =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || die "--user must be a plain lowercase account name"
[[ "$NODE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "--node-version must look like 24.22.0"
if [ -n "$ADDRESS" ]; then
	[[ "$ADDRESS" =~ ^[A-Za-z0-9._:-]+$ ]] || die "--address must be a host name or an IP address"
fi
for a in "${ADMIN_USERS[@]+"${ADMIN_USERS[@]}"}"; do
	[[ "$a" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "--admin-user '$a' is not a plain account name"
done
if [ "$HARDEN_SSH" = 1 ] && [ "${#ADMIN_USERS[@]}" -eq 0 ]; then
	die "--harden-ssh needs at least one --admin-user: the account that keeps ssh access when passwords and root logins are off"
fi

# ---------------------------------------------------------------------------
# Preflight

if [ "$DRY_RUN" = 0 ] && [ "$(id -u)" -ne 0 ]; then
	die "run this as root (sudo ./bootstrap.sh ...), or add --dry-run to see what it would do"
fi
[ "$DRY_RUN" = 1 ] && say "dry run: nothing will be changed"

OS_ID=unknown
if [ -r /etc/os-release ]; then
	# shellcheck disable=SC1091
	OS_ID=$(. /etc/os-release && echo "${ID:-unknown}")
fi
case "$OS_ID" in
	ubuntu | debian) ;;
	*) warn "this script is written for Ubuntu and Debian; found '$OS_ID'. Package names may not match." ;;
esac

case "$(uname -m)" in
	x86_64) NODE_ARCH=x64 ;;
	aarch64) NODE_ARCH=arm64 ;;
	*) die "unsupported CPU: $(uname -m)" ;;
esac

for f in coderra-attach coderra-hostd.service box/box box/Containerfile; do
	[ -f "$HERE/$f" ] || die "$HERE/$f is missing: run this from a complete copy of the server/ folder"
done

if getent passwd "$USER_NAME" >/dev/null; then
	HOME_DIR=$(getent passwd "$USER_NAME" | cut -d: -f6)
else
	HOME_DIR=/home/$USER_NAME
fi
CODERRA_DIR=$HOME_DIR/.coderra

# ---------------------------------------------------------------------------
# Packages and Node.js

install_packages() {
	say "installing packages"
	local pkgs=("${PACKAGES[@]}")
	[ "$INSTALL_BOX" = 1 ] && pkgs+=("${BOX_PACKAGES[@]}")
	run apt-get update -qq
	run env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${pkgs[@]}"
	# Debian and Ubuntu call fd "fdfind".
	if ! command -v fd >/dev/null 2>&1 && [ -x /usr/bin/fdfind ]; then
		run ln -sf /usr/bin/fdfind /usr/local/bin/fd
	elif ! command -v fd >/dev/null 2>&1; then
		[ "$DRY_RUN" = 1 ] && run ln -sf /usr/bin/fdfind /usr/local/bin/fd
	fi
}

node_is_new_enough() {
	command -v node >/dev/null 2>&1 || return 1
	local v major minor
	v=$(node -p 'process.versions.node' 2>/dev/null) || return 1
	major=${v%%.*}
	minor=${v#*.}
	minor=${minor%%.*}
	[ "$major" -gt "$NODE_MIN_MAJOR" ] || { [ "$major" -eq "$NODE_MIN_MAJOR" ] && [ "$minor" -ge "$NODE_MIN_MINOR" ]; }
}

install_node() {
	if node_is_new_enough; then
		say "node $(node -v) is new enough; keeping it"
		return
	fi
	say "installing Node.js $NODE_VERSION"
	local file=node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz
	local url=https://nodejs.org/dist/v$NODE_VERSION
	local tmp
	tmp=$(mktemp -d)
	run curl -fsSL "$url/$file" -o "$tmp/$file"
	run curl -fsSL "$url/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
	if [ "$DRY_RUN" = 1 ]; then
		echo "+ (verify $file against SHASUMS256.txt with sha256sum -c)"
	else
		(cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c -) || die "the Node.js download does not match its published checksum"
	fi
	run tar -xJf "$tmp/$file" -C /opt
	run ln -sfn "/opt/node-v$NODE_VERSION-linux-$NODE_ARCH" /opt/node
	for b in node npm npx; do run ln -sf "/opt/node/bin/$b" "/usr/local/bin/$b"; done
	rm -rf "$tmp"
}

# ---------------------------------------------------------------------------
# The account

create_user() {
	if getent passwd "$USER_NAME" >/dev/null; then
		say "user $USER_NAME exists"
	else
		say "creating user $USER_NAME (no sudo, not in the docker group)"
		run useradd --create-home --shell /bin/bash "$USER_NAME"
	fi
	if [ "$DRY_RUN" = 0 ]; then
		local g
		for g in sudo docker lxd adm root; do
			if id -nG "$USER_NAME" | tr ' ' '\n' | grep -qx "$g"; then
				warn "$USER_NAME is in the '$g' group, which gives it power over this machine. The agent runs as this user: remove it (gpasswd -d $USER_NAME $g)."
			fi
		done
	fi
	# Rootless containers need a range of sub-ids. useradd normally hands one out; if not, take the next free block.
	if [ "$DRY_RUN" = 0 ] && ! grep -q "^$USER_NAME:" /etc/subuid 2>/dev/null; then
		local start
		start=$(awk -F: '{e=$2+$3; if (e>m) m=e} END {print (m>100000?m:100000)}' /etc/subuid /etc/subgid 2>/dev/null || echo 100000)
		run usermod --add-subuids "$start-$((start + 65535))" --add-subgids "$start-$((start + 65535))" "$USER_NAME"
	elif [ "$DRY_RUN" = 1 ] && ! getent passwd "$USER_NAME" >/dev/null; then
		echo "+ (make sure $USER_NAME has sub-uid/sub-gid ranges in /etc/subuid and /etc/subgid)"
	fi
	say "keeping $USER_NAME's services running without a login (lingering)"
	run loginctl enable-linger "$USER_NAME"
}

as_user() {
	local uid
	uid=$(id -u "$USER_NAME" 2>/dev/null || echo 1000)
	run runuser -u "$USER_NAME" -- env "HOME=$HOME_DIR" "XDG_RUNTIME_DIR=/run/user/$uid" \
		"DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus" "$@"
}

wait_for_user_manager() {
	[ "$DRY_RUN" = 1 ] && return
	local uid
	uid=$(id -u "$USER_NAME")
	for _ in $(seq 1 "${BOOTSTRAP_WAIT_SECONDS:-30}"); do
		[ -S "/run/user/$uid/bus" ] && return
		sleep 1
	done
	warn "$USER_NAME's systemd user manager did not come up; the service and container steps may fail"
}

# ---------------------------------------------------------------------------
# Files

install_files() {
	say "installing files into $CODERRA_DIR"
	local d
	for d in "$CODERRA_DIR" "$CODERRA_DIR/bin" "$CODERRA_DIR/box" "$HOME_DIR/.pi" "$HOME_DIR/.pi/agent" "$HOME_DIR/.ssh"; do
		run install -d -o "$USER_NAME" -g "$USER_NAME" -m 700 "$d"
	done
	run install -d -o "$USER_NAME" -g "$USER_NAME" -m 755 "$HOME_DIR/workspace"
	run install -d -o "$USER_NAME" -g "$USER_NAME" -m 755 "$HOME_DIR/.config" "$HOME_DIR/.config/systemd" "$HOME_DIR/.config/systemd/user"

	run install -o "$USER_NAME" -g "$USER_NAME" -m 755 "$HERE/coderra-attach" "$CODERRA_DIR/bin/coderra-attach"
	run install -o "$USER_NAME" -g "$USER_NAME" -m 755 "$HERE/box/box" "$CODERRA_DIR/bin/box"
	run install -o "$USER_NAME" -g "$USER_NAME" -m 644 "$HERE/box/Containerfile" "$CODERRA_DIR/box/Containerfile"
	run install -o "$USER_NAME" -g "$USER_NAME" -m 644 "$HERE/coderra-hostd.service" "$HOME_DIR/.config/systemd/user/coderra-hostd.service"

	# The key that encrypts tokens at rest (agent/src/secure.ts). Created once and never replaced: a new key would
	# make everything already stored unreadable.
	local env_file=$CODERRA_DIR/env
	if [ -f "$env_file" ] && grep -q '^ANDROPI_STORE_KEY=[0-9a-f]\{64\}$' "$env_file"; then
		say "keeping the existing encryption key"
	else
		say "creating the encryption key for stored tokens"
		if [ "$DRY_RUN" = 1 ]; then
			echo "+ (write $env_file with a new random ANDROPI_STORE_KEY, mode 600)"
		else
			(umask 077 && printf 'ANDROPI_STORE_KEY=%s\n' "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" > "$env_file")
			chown "$USER_NAME:$USER_NAME" "$env_file"
		fi
	fi
}

authorize_key() {
	say "letting the app in over ssh (restricted key)"
	local file=$HOME_DIR/.ssh/authorized_keys
	local body
	body=$(printf '%s' "$PUBKEY" | awk '{print $2}')
	if [ "$DRY_RUN" = 1 ]; then
		echo "+ (put this line in $file, replacing any line with the same key):"
		echo "  $KEY_OPTIONS $PUBKEY"
		return
	fi
	local tmp
	tmp=$(mktemp)
	# Keep the other keys, replace any earlier line for this same key, and add ours with its restrictions.
	if [ -f "$file" ]; then
		grep -vF "$body" "$file" > "$tmp" || true
	fi
	printf '%s %s\n' "$KEY_OPTIONS" "$PUBKEY" >> "$tmp"
	install -o "$USER_NAME" -g "$USER_NAME" -m 600 "$tmp" "$file"
	rm -f "$tmp"
}

# ---------------------------------------------------------------------------
# Service and container

enable_service() {
	say "enabling the host service (it starts once the app has copied the host over)"
	as_user systemctl --user daemon-reload
	as_user systemctl --user enable coderra-hostd.service
}

setup_box() {
	say "setting up the rootless container"
	if [ "$DRY_RUN" = 1 ]; then
		as_user podman build -t localhost/coderra-box -f "$CODERRA_DIR/box/Containerfile" "$CODERRA_DIR/box"
		as_user podman run --rm localhost/coderra-box true
		return
	fi
	if ! as_user podman info >/dev/null 2>&1; then
		warn "rootless podman does not work for $USER_NAME yet. See why with: runuser -u $USER_NAME -- env XDG_RUNTIME_DIR=/run/user/\$(id -u $USER_NAME) podman info"
		warn "On Ubuntu 24.04 and later AppArmor restricts user namespaces; the 'apparmor' package ships a profile for podman, so check that /etc/apparmor.d/podman exists and is loaded (aa-status). The container was not built."
		return
	fi
	as_user podman build -t localhost/coderra-box -f "$CODERRA_DIR/box/Containerfile" "$CODERRA_DIR/box"
	if as_user podman run --rm localhost/coderra-box true; then
		say "the container works"
	else
		warn "the container image was built but would not run; see the message above"
	fi
}

harden_ssh() {
	say "turning off password logins and root login over ssh"
	local allow="$USER_NAME ${ADMIN_USERS[*]}"
	local conf=/etc/ssh/sshd_config.d/10-coderra.conf
	if [ "$DRY_RUN" = 1 ]; then
		echo "+ (write $conf: PasswordAuthentication no, PermitRootLogin no, AllowUsers $allow; check with sshd -t; reload ssh)"
		return
	fi
	local a
	for a in "${ADMIN_USERS[@]}"; do
		getent passwd "$a" >/dev/null || die "--admin-user $a does not exist"
		[ -s "$(getent passwd "$a" | cut -d: -f6)/.ssh/authorized_keys" ] \
			|| die "$a has no ~/.ssh/authorized_keys: with passwords off it would be locked out. Add a key for it first."
	done
	# Named 10- so it wins over cloud-init's 50-cloud-init.conf: sshd uses the first value it sees.
	printf 'PasswordAuthentication no\nPermitRootLogin no\nAllowUsers %s\n' "$allow" > "$conf.new"
	mv "$conf.new" "$conf"
	if ! sshd -t; then
		rm -f "$conf"
		die "sshd rejected the new settings; they were removed"
	fi
	systemctl reload ssh 2>/dev/null || systemctl reload sshd
}

# ---------------------------------------------------------------------------
# The code the app reads

setup_code() {
	local key_file="" f port host
	for f in ssh_host_ed25519_key.pub ssh_host_ecdsa_key.pub ssh_host_rsa_key.pub; do
		if [ -r "/etc/ssh/$f" ]; then
			key_file=/etc/ssh/$f
			break
		fi
	done
	local host_key="(host key not found)"
	if [ -n "$key_file" ]; then
		host_key=$(cut -d' ' -f1,2 "$key_file")
	elif [ "$DRY_RUN" = 0 ]; then
		# The app pins this key; a setup code without it would be useless, or worse, trust whatever answers first.
		die "no ssh host key found in /etc/ssh. Is openssh-server installed? (apt-get install openssh-server)"
	fi
	port=$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2; exit}' || true)
	port=${port:-22}
	host=$ADDRESS
	[ -n "$host" ] || host=$(hostname -I 2>/dev/null | awk '{print $1}')
	[ -n "$host" ] || host="(unknown: re-run with --address)"
	local json code
	json=$(printf '{"v":1,"host":"%s","port":%s,"user":"%s","hostKey":"%s"}' "$host" "$port" "$USER_NAME" "$host_key")
	code=coderra1:$(printf '%s' "$json" | base64 -w0)

	echo
	echo "Done. In the app, open Settings > Server agent and paste this setup code:"
	echo
	echo "  $code"
	echo
	echo "  address:  $host:$port   (if that is a private address, run again with --address <public name or IP>)"
	echo "  host key: $host_key"
	if [ -z "$ADDRESS" ]; then
		echo "  (the address was guessed; pass --address to be sure)"
	fi
	if [ "$INSTALL_BOX" = 1 ]; then
		echo
		echo "Note: the agent's container shares this machine's network, so it can reach anything this machine can."
		echo "Use a server that runs nothing else you would not want an agent to reach."
	fi
}

# ---------------------------------------------------------------------------

install_packages
install_node
create_user
install_files
authorize_key
wait_for_user_manager
enable_service
if [ "$INSTALL_BOX" = 1 ]; then
	setup_box
else
	say "skipping the container (--no-box): the agent's shell will run directly on the server"
fi
if [ "$HARDEN_SSH" = 1 ]; then
	harden_ssh
else
	say "ssh settings left as they are (use --harden-ssh --admin-user NAME to disable passwords and root login)"
fi
setup_code
