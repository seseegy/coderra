#!/usr/bin/env bash
# shellcheck disable=SC2016  # the checks run through "bash -c" and expand their variables there, on purpose
# Runs INSIDE a throwaway container (see bootstrap-in-container.sh) as root: runs bootstrap.sh for real and checks what
# it left behind. systemd and the container runtime are not available there, so loginctl/systemctl are stubs and the
# box is skipped; everything else (apt, useradd, install, authorized_keys, the Node download) is the real thing.
set -euo pipefail

fails=0
ok() { printf 'PASS  %s\n' "$*"; }
bad() { printf 'FAIL  %s\n' "$*"; fails=$((fails + 1)); }
check() { # check "description" command...
	local what=$1
	shift
	if "$@" >/dev/null 2>&1; then ok "$what"; else bad "$what"; fi
}

PUB1="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEKEYONEEXAMPLEKEYONEEXAMPLEKEYONE00 coderra-app"
PUB2="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITHESECONDKEYTHESECONDKEYTHESECONDKEY0000 other"
OPTS='restrict,pty,port-forwarding,permitopen="127.0.0.1:*",permitlisten="127.0.0.1:1"'

# Stand-ins for what a container does not have. The log must be writable by the account bootstrap.sh creates, because
# the systemctl stub runs as that user.
: > /tmp/stub.log
chmod 666 /tmp/stub.log
for tool in loginctl systemctl; do
	printf '#!/bin/sh\necho "%s $*" >> /tmp/stub.log\n' "$tool" > "/usr/local/bin/$tool"
	chmod 755 "/usr/local/bin/$tool"
done
export BOOTSTRAP_WAIT_SECONDS=1
# A real server has an sshd with host keys; the image does not.
ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/ssh_host_ed25519_key 2>/dev/null || { apt-get update -qq && apt-get install -y -qq openssh-client >/dev/null && ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/ssh_host_ed25519_key; }

echo "--- bad input is refused"
for bad_key in "ssh-ed25519" "command=\"rm -rf /\" $PUB1" "$PUB1"$'\n'"ssh-rsa AAAAB3NzaC1yc2E" "ssh-ed25519 not*base64"; do
	if /server/bootstrap.sh --no-box --pubkey "$bad_key" >/tmp/out.txt 2>&1; then bad "accepted a bad key: ${bad_key:0:40}"; else ok "refused a bad key: $(printf '%s' "${bad_key:0:30}" | tr '\n' ' ')"; fi
done
check "refuses --harden-ssh without an admin" bash -c '! /server/bootstrap.sh --no-box --pubkey "'"$PUB1"'" --harden-ssh'
check "refuses an odd address" bash -c '! /server/bootstrap.sh --no-box --pubkey "'"$PUB1"'" --address "a;rm -rf /"'
check "creates no user when refused" bash -c '! id coderra'

echo "--- first run"
/server/bootstrap.sh --no-box --pubkey "$PUB1" --address test.example.com > /tmp/run1.txt 2>&1 || { cat /tmp/run1.txt; bad "bootstrap failed"; exit 1; }

check "user exists" id coderra
check "not in sudo/docker groups" bash -c '! id -nG coderra | tr " " "\n" | grep -qxE "sudo|docker|root"'
check "has sub-uid range" grep -q '^coderra:' /etc/subuid
check "node installed at the requested version" bash -c '[ "$(/usr/local/bin/node -v)" = v24.22.0 ]'
check "fd is available" command -v fd
for f in bin/coderra-attach bin/box; do check "$f is executable and owned by coderra" bash -c "[ -x /home/coderra/.coderra/$f ] && [ \"\$(stat -c %U /home/coderra/.coderra/$f)\" = coderra ]"; done
check "Containerfile installed" test -f /home/coderra/.coderra/box/Containerfile
check "unit installed" test -f /home/coderra/.config/systemd/user/coderra-hostd.service
check ".coderra is private (700)" bash -c '[ "$(stat -c %a /home/coderra/.coderra)" = 700 ]'
check ".pi/agent is private (700)" bash -c '[ "$(stat -c %a /home/coderra/.pi/agent)" = 700 ]'
check "env file is private and holds a 64-hex key" bash -c '[ "$(stat -c %a /home/coderra/.coderra/env)" = 600 ] && grep -qE "^ANDROPI_STORE_KEY=[0-9a-f]{64}$" /home/coderra/.coderra/env'
printf '%s %s\n' "$OPTS" "$PUB1" > /tmp/expected_auth
check "authorized_keys is private (600)" bash -c '[ "$(stat -c %a /home/coderra/.ssh/authorized_keys)" = 600 ]'
check "authorized_keys has exactly the restricted line" cmp /tmp/expected_auth /home/coderra/.ssh/authorized_keys
check "lingering was enabled" grep -qx 'loginctl enable-linger coderra' /tmp/stub.log
check "unit enabled for the user" grep -q 'systemctl --user enable coderra-hostd.service' /tmp/stub.log
check "unit is not started yet (the host is not there)" bash -c '! grep -q "systemctl --user start\|enable --now" /tmp/stub.log'

echo "--- setup code"
code=$(grep -o 'coderra1:[A-Za-z0-9+/=]*' /tmp/run1.txt | head -1)
check "setup code printed" test -n "$code"
json=$(printf '%s' "${code#coderra1:}" | base64 -d)
check "setup code decodes to the address, port and user" bash -c 'printf "%s" '"'$json'"' | grep -q "\"host\":\"test.example.com\".*\"user\":\"coderra\""'
check "setup code carries a host key line" bash -c 'printf "%s" '"'$json'"' | grep -qE "\"hostKey\":\"ssh-(ed25519|rsa|ecdsa-sha2-[a-z0-9]+) [A-Za-z0-9+/=]+\""'

echo "--- second run changes nothing it should keep"
key_before=$(cat /home/coderra/.coderra/env)
/server/bootstrap.sh --no-box --pubkey "$PUB1" --address test.example.com > /tmp/run2.txt 2>&1 || { cat /tmp/run2.txt; bad "second run failed"; }
check "encryption key unchanged" bash -c '[ "$(cat /home/coderra/.coderra/env)" = "'"$key_before"'" ]'
check "same key is not added twice" bash -c '[ "$(wc -l < /home/coderra/.ssh/authorized_keys)" = 1 ]'

echo "--- a second key is added next to the first; a re-run for it replaces only its own line"
/server/bootstrap.sh --no-box --pubkey "$PUB2" > /tmp/run3.txt 2>&1 || bad "third run failed"
check "two keys now" bash -c '[ "$(wc -l < /home/coderra/.ssh/authorized_keys)" = 2 ]'
printf '%s %s\n%s %s\n' "$OPTS" "$PUB1" "$OPTS" "$PUB2" > /tmp/expected_two
check "both are restricted, first key kept in place" cmp /tmp/expected_two /home/coderra/.ssh/authorized_keys
check "first key still there" grep -qF "$PUB1" /home/coderra/.ssh/authorized_keys
/server/bootstrap.sh --no-box --pubkey "$PUB2" > /tmp/run4.txt 2>&1 || bad "fourth run failed"
check "re-adding the second key keeps two lines" bash -c '[ "$(wc -l < /home/coderra/.ssh/authorized_keys)" = 2 ]'

echo "--- an existing account keeps its files"
echo "keep me" > /home/coderra/workspace/note.txt
/server/bootstrap.sh --no-box --pubkey "$PUB1" > /tmp/run5.txt 2>&1 || bad "fifth run failed"
check "workspace content untouched" grep -qx 'keep me' /home/coderra/workspace/note.txt

echo "--- a custom account name"
/server/bootstrap.sh --no-box --user agent2 --pubkey "$PUB1" > /tmp/run6.txt 2>&1 || bad "custom user run failed"
check "second account is separate" bash -c 'id agent2 && test -f /home/agent2/.coderra/env && ! cmp -s /home/agent2/.coderra/env /home/coderra/.coderra/env'

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASSED"; else echo "$fails FAILED"; exit 1; fi
