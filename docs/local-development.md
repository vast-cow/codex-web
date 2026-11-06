# Local development and remote access

Complete the [source setup](../README.md#clone-and-install) first, including
Codex CLI authentication on the host.

## Development mode

Keep two processes running from the repository root.

Terminal 1 — backend:

```bash
npm run server
```

Terminal 2 — Vite frontend:

```bash
npm run dev:browser
```

| URL                     | Purpose                                              |
| ----------------------- | ---------------------------------------------------- |
| `http://127.0.0.1:8214` | Backend and built application; no Vite live updates  |
| `http://127.0.0.1:4173` | Vite development frontend, using the backend on 8214 |

Vite serves `scratch/asar/webview` and watches frontend modules. Supported module
changes update through hot module replacement; other changes may reload the page.
Reload manually if an extracted asset or bridge change does not appear.

`vite.browser.config.ts` aliases Electron imports to `src/browser/shim.ts`.
Its existing proxy routes are:

- `/__backend/ipc`: `ws://127.0.0.1:8214`, with WebSocket forwarding enabled.
- `/__backend/upload`: `http://127.0.0.1:8214`, for HTTP uploads.

Both use `changeOrigin: true`. Keep these settings when adding hostname rules.
The browser connects through the frontend origin; it does not need direct remote
access to port 8214.

### Where to make changes

- `src/browser/`: browser bridge/shim, routes, file handling, dialogs, and icons.
- `src/server/`: backend TypeScript, including `main.ts`, `module.ts`, the Electron
  shim under `electron/`, and diagnostics under `diagnostics/`.
- `assets/`: files copied into the extracted webview during preparation.
- `patches/*.patch`: persistent modifications to the upstream Desktop assets.
- `vite.browser.config.ts`: frontend build, development host, and proxy settings.
- `scripts/prepare` and `scripts/prepare_asar`: asset download and preparation.

`scratch/asar` contains generated, extracted Desktop files. You can experiment
there, but preparation may overwrite your edits. Preserve lasting upstream asset
changes in `patches/`, and source assets in `assets/`. Reapply preparation when
changing patches or copied assets; it is not a live patch watcher.

The backend has no TypeScript watch/restart process. After server edits, stop the
backend, run `npm run build:server`, then restart with `npm run server`. The
`preserver` lifecycle hook also rebuilds server and browser code on each start.
Vite does not restart the backend for you.

## Built application without Vite

After making changes:

```bash
npm run build:browser
npm run build:server
npm run server
```

Open <http://127.0.0.1:8214>; no Vite process is needed. The explicit build steps
are also repeated by `npm run server` through `preserver` (server first, then
browser). Browser builds compile the preload bridge into the prepared webview;
they do not re-extract the Desktop archive or reapply patches.

`npm ci` runs `prepare`, which calls `scripts/prepare` to download the pinned
Desktop archive. `scripts/prepare_asar` extracts it, copies assets, generates the
PWA icon, formats patched files, and applies patches. Then `prepare` builds the
browser and server. To repeat extraction with your own archive, set
`HOSTED_CODEX_APP_ZIP` when running `npm run prepare:asar`; `npm run build` also
requires that variable because it starts with `prepare:asar`.

## Tailscale Serve

Assume Tailscale is installed and both devices are in the same tailnet. Start the
backend and Vite as above, then run on the host:

```bash
tailscale serve --https=4173 http://127.0.0.1:4173
```

This uses the [supported Serve syntax](https://tailscale.com/docs/reference/tailscale-cli/serve):
`--https=4173` selects the tailnet HTTPS listener, and the HTTP URL is the local
proxy target. Follow any Serve prompt to enable HTTPS for your tailnet. Keep the
foreground command running, and open its printed URL from the other device:

```text
https://example.tailnet.ts.net:4173
```

Replace the example with the host's actual Tailscale HTTPS hostname. Tailnet
access rules must allow the client to reach that host and port. Expose only
4173: Vite forwards the relevant HTTP and WebSocket requests to loopback port 8214. Keep both local listeners on `127.0.0.1`.

### Vite allowedHosts

If Vite reports:

```text
Blocked request. This host ("example.tailnet.ts.net") is not allowed.
```

Edit `vite.browser.config.ts`, adding `allowedHosts` inside the existing `server`
object (replace an existing local setting instead of adding a duplicate key):

```typescript
server: {
  host: "127.0.0.1",
  port: 4173,
  strictPort: true,
  allowedHosts: ["example.tailnet.ts.net"],
  proxy: {
    "/__backend/ipc": {
      target: `ws://127.0.0.1:8214`,
      changeOrigin: true,
      ws: true,
    },
    "/__backend/upload": {
      target: `http://127.0.0.1:8214`,
      changeOrigin: true,
    },
  },
},
```

Choose one of these [Vite hostname settings](https://v8.vite.dev/config/server-options#server-allowedhosts):

| Option          | Setting                                     | Use                                                                       |
| --------------- | ------------------------------------------- | ------------------------------------------------------------------------- |
| A (recommended) | `allowedHosts: ["example.tailnet.ts.net"],` | Only your specific hostname                                               |
| B               | `allowedHosts: [".ts.net"],`                | The `ts.net` domain and all its subdomains; broader than your own tailnet |
| C               | `allowedHosts: true,`                       | Any hostname, for flexible local development                              |

Option C disables Vite's hostname validation and carries DNS rebinding risks,
including source-code disclosure. Prefer A; do not make C the repository default.
`allowedHosts` provides neither authentication nor authorization. Restart Vite
after changing its configuration and preserve both proxy routes above.

## Troubleshooting

- **Preparation fails:** confirm Bash, curl, unzip, and patch are installed and
  the Desktop download is reachable. Inspect the failing script output; ensure
  npm lifecycle scripts were not disabled. Native dependency builds may need
  Python and a compiler toolchain. Rerunning preparation can overwrite
  `scratch/asar` edits, so preserve them first.
- **Codex is missing or signed out:** ensure `command -v codex` works in the
  server's shell and run `codex login --device-auth` on the host. The `server`
  npm script sets `CODEX_CLI_PATH` from `which codex`; a custom exported value is
  overwritten by this script. For direct launches, the backend can use
  `CODEX_CLI_PATH` instead.
- **Changes do not appear:** use 4173 for Vite, rebuild/restart server TypeScript,
  or rebuild the browser bridge and reload 8214 for the built application.
- **Port conflict:** Vite fails with `Port 4173 is already in use` instead of
  silently choosing another port. Stop the conflicting process and restart.
  An intentional override (`npm run dev:browser -- --port 4175`) must also
  update the reverse proxy target. The external HTTPS listener may use a
  different port; keep its target pointed at the chosen local Vite port.
  The backend independently needs port 8214.
- **Remote page or uploads fail:** check both processes, Serve's printed URL,
  tailnet permissions, hostname rules, and the two Vite proxy routes. Restart
  Vite after config edits. Do not expose 8214 publicly to work around a proxy
  error.

Anyone with access may execute commands, access local files and credentials,
and use the signed-in account with the host process's permissions. Use only
trusted tailnet access, never Tailscale Funnel. Read the full
[security considerations](../README.md#security-considerations).
