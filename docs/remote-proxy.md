# Remote app-server proxy

Running app-server separately lets it continue executing commands across
codex-web crashes or restarts. The `scripts/codex_remote_proxy` helper bridges
stdio to an existing app-server control Unix socket using `websocat`.

## Setup

Start a long-lived app-server:

```bash
mkdir -p /tmp/codex-app-server
cd /tmp/codex-app-server
codex app-server --listen unix://codex-app-server.sock
```

Then start codex-web with the proxy helper:

```bash
nix shell github:0xcaff/codex-web github:0xcaff/codex-web#codex_remote_proxy -c bash -lc '
  export CODEX_UNIX_SOCKET=/tmp/codex-app-server/codex-app-server.sock
  export CODEX_CLI_PATH="$(command -v codex_remote_proxy)"
  codex-web
'
```

For a local checkout, install `websocat`, set `CODEX_CLI_PATH` to the full path
of `scripts/codex_remote_proxy`, and export `CODEX_UNIX_SOCKET` as above.
`npm run server` preserves an exported `CODEX_CLI_PATH`; otherwise it selects
`codex` from PATH.

`codex app-server proxy --sock ...` is a raw stdio protocol bridge for another
program to use. Running it directly in a terminal waits for protocol input.

## Startup validation

Before creating the HTTP/WebSocket bridge, codex-web checks that a nonempty
`CODEX_CLI_PATH` resolves to an executable file. Absolute and relative paths,
command names resolved through PATH, and directories containing `codex` are
supported. An unset or blank override leaves discovery to the upstream app.

Executables named `codex_remote_proxy`, including symlinks resolving to that
name, also run in `--preflight` mode. For a renamed copy or custom proxy wrapper,
explicitly set `CODEX_CLI_KIND=remote-proxy`. These wrappers must forward
`--preflight` to the helper or implement the same validation-only contract:
return zero on success, return nonzero with diagnostics on stderr on failure,
and exit without launching app-server or websocat. Validation has a five-second
timeout. Other CLI executables are not invoked during preflight and do not
require websocat or a socket.

The helper's `--preflight` mode reuses its normal defensive validation:

- `websocat` must be available in the proxy's PATH. Dependencies supplied by a
  wrapper, such as the Nix package, are included.
- `CODEX_UNIX_SOCKET` must be nonempty and point to an existing Unix domain socket.
- The current user must be able to traverse its parent directories and have
  read and write access to the socket.

Failures print diagnostics to stderr and exit nonzero before binding any HTTP
or WebSocket port or printing `IPC bridge listening`. Install websocat if
missing; verify the socket path and app-server process if the socket is missing;
check parent directory search permissions and socket ownership and permissions
if access is denied. Only grant access to users who should control app-server.

You can run the same check independently:

```bash
"$CODEX_CLI_PATH" --preflight
```

Preflight checks filesystem accessibility without connecting to app-server.
It does not verify protocol health or guarantee that a socket remains available
after startup. The proxy repeats its checks whenever invoked in app-server mode.

## Tests

Run the full suite with `npm test`. Startup integration tests compile the actual
server into a temporary directory, substitute a minimal upstream entrypoint,
and use mocked executables and temporary Unix sockets. No real app-server is
required. They check failures before any listen attempt, valid HTTP/WebSocket
startup, and regular CLI behavior without proxy dependencies.
