#!/usr/bin/env bash
# Operator-only driver for a separately authorized disposable staging VM.
# Never invoked by the offline memory runner.
set -euo pipefail
umask 077
stage=$(realpath "${1:?staging root required}")
[[ $stage == /var/tmp/codex-staging-* ]]
[[ $(stat -c %u "$stage") == "$(id -u)" ]]
[[ $(stat -c %a "$stage") == 700 ]]
[[ $(cat /proc/self/cgroup) == *'/codex-staging-stack.service' ]]
[[ $HOME == "$stage/parent-home" && $CODEX_HOME == "$stage/parent-home/codex" ]]
[[ -x $stage/bin/codex && -x $stage/bin/chrome ]]
[[ -s $stage/control/deployment.json && -s $stage/control/launcher.cjs ]]
for name in OPENAI_API_KEY CODEX_ACCESS_TOKEN CODEX_API_BASE_URL NODE_OPTIONS CODEX_WEB_SHARED_TRANSPORT; do
  [[ ! -v $name ]]
done
mkdir -p "$stage"/{tailscale,evidence/node,backend-home/{codex,config,cache,data},parent-home/{codex,config,cache,data},browser-profile,tmp}
[[ ! -e $stage/control/app-server.sock && ! -e $stage/control/codex.sock && ! -e $stage/control/parent-tmux.sock ]]
for port in 18214 18215 19222; do
  [[ -z $(ss -H -ltn "sport = :$port") ]]
done
tailscaled --tun=userspace-networking --port=0 \
  --socket="$stage/tailscale/tailscaled.sock" \
  --state="$stage/tailscale/tailscaled.state" --statedir="$stage/tailscale" \
  > "$stage/evidence/tailscaled.private.log" 2>&1 &
edge_pid=$!
env HOME="$stage/backend-home" CODEX_HOME="$stage/backend-home/codex" \
  XDG_CONFIG_HOME="$stage/backend-home/config" XDG_CACHE_HOME="$stage/backend-home/cache" XDG_DATA_HOME="$stage/backend-home/data" \
  "$stage/bin/codex" app-server --listen "unix://$stage/control/app-server.sock" \
  > "$stage/evidence/app-server.private.log" 2>&1 &
backend_pid=$!
for ((attempt=0; attempt<150; attempt++)); do
  [[ -S $stage/control/app-server.sock ]] && break
  kill -0 "$backend_pid"
  sleep .1
done
[[ -S $stage/control/app-server.sock ]]
# A fresh VM has no production daemon; fail if the socket cannot be hard-linked.
python3 - "$stage" <<'PY'
import os
from pathlib import Path
import stat
import sys
root = Path(sys.argv[1])
target = (root / "control/app-server.sock").resolve(strict=True)
assert stat.S_ISSOCK(target.stat().st_mode)
assert target.stat().st_uid == os.getuid()
os.link(target, root / "control/codex.sock")
assert os.stat(target).st_ino == os.stat(root / "control/codex.sock").st_ino
os.chmod(root / "control/codex.sock", 0o600)
PY
"$stage/bin/chrome" --headless --user-data-dir="$stage/browser-profile" \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=19222 about:blank \
  > "$stage/evidence/chromium.private.log" 2>&1 &
browser_pid=$!
export TERM=xterm
export XDG_CONFIG_HOME="$stage/parent-home/config"
export XDG_CACHE_HOME="$stage/parent-home/cache"
export XDG_DATA_HOME="$stage/parent-home/data"
socket="$stage/control/parent-tmux.sock"
tmux -S "$socket" -f /dev/null new-session -d -s parent \
  "$stage/bin/codex" --cd "$stage/work" --sandbox workspace-write --no-alt-screen
printf 'Staging parent: tmux -S %q attach -t parent\n' "$socket"
while tmux -S "$socket" has-session -t parent 2>/dev/null; do
  kill -0 "$edge_pid" "$backend_pid" "$browser_pid"
  sleep .2
done
# systemd KillMode=control-group owns cleanup of every remaining descendant.
