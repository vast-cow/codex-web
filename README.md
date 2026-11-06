# codex-web

a browser frontend for codex desktop, running on a machine you control.

https://github.com/user-attachments/assets/0a33cbd8-741c-412c-9e75-46dfe9324596

## motivation

the agents were never meant to stay trapped in a terminal window for long.
codex desktop brought the power of agents to your local computer, where your
files, credentials, and tools already live.

codex-web brings codex desktop to the browser while keeping the backend on a
machine you control (a linux box in the cloud, your home lab, or a desktop / mac
mini). agents keep running after your laptop closes. you can reconnect from any
device with a browser.

this project aims to be as thin a wrapper as possible to ensure upstream changes
to the codex desktop app can be integrated quickly.

## Prerequisites

- Node.js 22.12+ and npm (Vite requires Node 20.19+ or 22.12+).
- Git, Bash, curl, unzip, and patch on the host. Native dependencies may
  require a compiler toolchain and Python if prebuilt binaries are unavailable.
- Codex CLI installed on the host and available as `codex` on `PATH`.
  Sign in before starting the server:

  ```bash
  codex login --device-auth
  ```

## Clone and install

Source installation is the standard setup:

```bash
git clone https://github.com/vast-cow/codex-web.git
cd codex-web
npm ci
```

`npm ci` runs the preparation scripts: they download the required Codex Desktop
archive, extract and patch its assets, then build the browser bridge and server.
Internet access is required; do not disable npm lifecycle scripts.

## Run locally

```bash
npm run server
```

Open <http://127.0.0.1:8214>. This serves the built application and backend,
bound to loopback by default. The command rebuilds the server and browser frontend
before launching.

### Built mode

To serve the backend and built frontend together on port 4173:

```bash
# Build the frontend
npm run build:browser

# Build the backend
npm run build:server

# Serve the backend and built frontend
npm run server -- --port 4173
```

Open <http://127.0.0.1:4173>. No Vite development server is needed.
`npm run server` also rebuilds both components through its `preserver` hook.

## Local development

Run `npm run server` in one terminal and `npm run dev:browser` in another.
Open <http://127.0.0.1:4173> for the Vite development frontend.
See [local development](docs/local-development.md) for editable source paths,
rebuilds, and the difference between the two ports.

## Tailscale remote access

With both processes running and devices on the same trusted tailnet:

```bash
tailscale serve --https=4173 http://127.0.0.1:4173
```

Open the HTTPS URL printed by Serve, such as
`https://example.tailnet.ts.net:4173`. Only the frontend needs Serve; Vite proxies
backend traffic. See [Tailscale setup and hostname configuration](docs/local-development.md#tailscale-serve).

## Troubleshooting

For blocked hostnames, failed preparation, or stale changes, see
[troubleshooting](docs/local-development.md#troubleshooting).
[Diagnostics](docs/diagnostics.md) describes opt-in logging and capture.
[Separate app-server operation](docs/app-server-proxy.md) covers the advanced
proxy workflow, including its optional Nix environment.

## Security considerations

run `codex-web` only on trusted networks. treat anyone who can reach the
`codex-web` server as someone who can operate codex on the host machine as the
same user running the server.

if you need authn or authz, implement it outside of `codex-web`: proxy it through
wireguard, tailscale, or an ssh tunnel and put an authentication gateway or
reverse proxy in front.

someone with access to the web ui may be able to:

- run commands on the host, limited only by the permissions of the `codex-web`
  server process.
- read or modify files, environment variables, credentials, ssh keys, and other
  local resources that are accessible to that process.
- use the codex / chatgpt account already signed in on the host. this may
  consume usage quota or billing credits, and may expose account metadata shown
  by the app or cli, such as name or email address.

Keep the backend bound to `127.0.0.1`. Use Tailscale Serve for private access
within a trusted tailnet, with tailnet access rules restricted to trusted users.
Do not expose this application publicly with Tailscale Funnel.
Vite's `allowedHosts` is not authentication or authorization; prefer explicitly
allowed hostnames over `allowedHosts: true`.

## features

- hostable on macOS, Linux (and anything codex cli + node will run on)
- reachable from the browser
- thin wrapper, so updates should land fast
- working today:
  - subagents
  - inline images
  - editor sidepanel
  - transcription

## roadmap

some parts of the desktop experience are not wired up yet:

- browser panel support, likely rebuilt around iframes
- computer use on linux, which could become a very powerful feature
- terminal support
- git worker integration
- whatever else people find and file issues for

## issues welcome

if something is broken, missing, or rough around the edges, please file an
issue.

using `codex-web` in an interesting way? post about it on x and tag me
[@0xcaff](https://x.com/0xcaff).

using this at a company and need something more tailored? email me and we can
talk.

## alternatives

- [davej/pocodex](https://github.com/davej/pocodex) i used this until the wheels fell off. i needed subagents
  and an inline image viewer. this didn't have them and was having a hard time
  keeping up with upstream codex updates.
- the native codex remote feature (behind a feature flag) is great for
  connecting to remote codex hosts over ssh to manage long running tasks but
  this only works if you have codex desktop on your client device. this means it
  doesn't work on mobile.
- upcoming first party mobile app from openai. `codex-web` exists and works
  today. i can't wait for the mobile app but judging by the other openai mobile
  apps, i'm a little bit skeptical about the quality of the mobile experience.
  time will tell.

For opt-in local logging and capture instructions, see [diagnostics](docs/diagnostics.md).
