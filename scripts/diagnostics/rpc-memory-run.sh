#!/usr/bin/env bash
# Reuse prebuilt isolated A/B artifacts; never build or write a production tree.
set -euo pipefail
umask 077
artifacts=$(realpath "${1:?isolated artifact root required}")
launcher=$(realpath "${2:?launcher source required}")
order=${3:-}
policy=${4:-legacy}
idle_seconds=${5:-180}
[[ $idle_seconds =~ ^[0-9]+$ && $idle_seconds -ge 30 && $idle_seconds -le 300 ]]
[[ $policy == legacy || $policy == two-phase || $policy == two-phase-characterize ]]
runtime_limit=340
[[ $policy == legacy ]] || runtime_limit=1800
repo=$(realpath "$(dirname "$0")/../..")
[[ $artifacts == /tmp/rpc-shared.* ]]
stage=$(mktemp -d /tmp/rpc-shared.memory-XXXXXX)
mkdir -p "$stage"/{A,B,bin,node_modules,work,control/daemon,control/memory,profile/{codex,config,cache,data,tmp}}
cp --reflink=auto "$artifacts/bin/codex" "$artifacts/bin/codex_remote_proxy" "$stage/bin/"
cp "$launcher" "$stage/control/launcher.cjs"
cp "$repo"/scripts/diagnostics/{rpc-shared-rehearsal,rpc-core,rpc-memory-node,rpc-memory-observer,rpc-memory-policy}.cjs "$stage/control/"
cp "$repo/docs/bootstrap-diag-20261117-01/chunk-timings.csv" "$stage/control/bootstrap-chunks.csv"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=localhost -addext subjectAltName=DNS:localhost -keyout "$stage/control/key.pem" -out "$stage/control/cert.pem" > "$stage/control/openssl.log" 2>&1
cat > "$stage/control/session.sh" <<'SESSION'
#!/usr/bin/env bash
umask 077
stage=$1
/usr/bin/node-22 "$stage/control/rpc-shared-rehearsal.cjs" "$stage" > "$stage/control/session.log" 2>&1
printf '%s\n' "$?" > "$stage/control/session.exit"
SESSION
cat > "$stage/control/tmux-run.sh" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
stage=$1
export TERM=xterm
socket="$stage/control/tmux.sock"
tmux -S "$socket" -f /dev/null new-session -d -s rehearsal /usr/bin/bash --noprofile --norc "$stage/control/session.sh" "$stage"
while [[ ! -s "$stage/control/session.exit" ]]; do
  if ! tmux -S "$socket" has-session -t rehearsal 2>/dev/null; then
    test -s "$stage/control/session.exit"
    break
  fi
  sleep .2
done
exit "$(cat "$stage/control/session.exit")"
TMUX
printf '%s\n' "$stage"
systemd-run --user --unit="rpc-memory-${stage##*-}" --wait --pipe --collect \
  -p MemoryMax=2G -p MemorySwapMax=0 -p OOMPolicy=stop \
  -p KillMode=control-group -p TimeoutStopSec=8 -p "RuntimeMaxSec=$runtime_limit" \
  "$HOME/.local/bin/bwrap" \
  --ro-bind / / --tmpfs "$HOME" --tmpfs /tmp --dir "$stage" --bind "$stage" "$stage" --dev /dev --proc /proc \
  --ro-bind "$artifacts/A" "$stage/A" --ro-bind "$artifacts/B" "$stage/B" --ro-bind "$artifacts/node_modules" "$stage/node_modules" \
  --dir /tmp/codex-daemon-1000 --bind "$stage/control/daemon" /tmp/codex-daemon-1000 \
  --ro-bind /tmp/astro-generator-browser /tmp/astro-generator-browser --ro-bind /tmp/codex-browsers /tmp/codex-browsers \
  --unshare-user --unshare-pid --unshare-net --unshare-ipc --clearenv \
  --setenv PATH /usr/local/bin:/usr/bin:/usr/sbin --setenv HOME "$stage/profile" --setenv CODEX_HOME "$stage/profile/codex" \
  --setenv XDG_CONFIG_HOME "$stage/profile/config" --setenv XDG_CACHE_HOME "$stage/profile/cache" --setenv XDG_DATA_HOME "$stage/profile/data" --setenv TMPDIR "$stage/profile/tmp" \
  --setenv PLAYWRIGHT_MODULE /tmp/astro-generator-browser/node_modules/playwright --setenv CHROMIUM_PATH /tmp/codex-browsers/chromium-1254/chrome-linux64/chrome \
  --setenv REHEARSAL_PARENT_NETNS "$(readlink /proc/self/ns/net)" --setenv REHEARSAL_PARENT_PIDNS "$(readlink /proc/self/ns/pid)" \
  --setenv REHEARSAL_PRODUCTION_HOME "$HOME" --setenv REHEARSAL_MEMORY_DIRECTORY "$stage/control/memory" \
  --setenv REHEARSAL_MEMORY_ORDER "$order" \
  --setenv REHEARSAL_TWO_PHASE "$([[ $policy == two-phase* ]] && echo 1 || true)" \
  --setenv REHEARSAL_MEMORY_CHARACTERIZE "$([[ $policy == two-phase-characterize ]] && echo 1 || true)" \
  --setenv REHEARSAL_IDLE_SECONDS "$idle_seconds" \
  --chdir "$stage" /usr/bin/bash "$stage/control/tmux-run.sh" "$stage"
