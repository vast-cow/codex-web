# Builds and reusable assets

`npm run build` runs `prepare:asar`, `build:browser`, then `build:server`.
`build:server` runs TypeScript; `build:browser` bundles the Desktop preload and
browser shim with Vite (without minification), then precompresses JavaScript and
CSS for runtime serving. Both source compilation commands still run on each build.
`npm run server` also rebuilds both wrappers through `preserver`.

`npm install` runs `prepare`: it downloads the pinned Desktop zip unless
`HOSTED_CODEX_APP_ZIP` is provided, prepares Desktop assets, then builds both
wrappers. Nix supplies that variable and continues to run `npm run build`.
For local rebuilds, keep it pointing to the desired Desktop zip, for example
inside `nix develop`.

Alternatively, install with pnpm (tested with **pnpm 10.34.9**):

```bash
HOSTED_CODEX_APP_ZIP=/path/to/desktop.zip pnpm install
pnpm run server
```

Ordinary `pnpm install` runs the project preparation/build and the dependency
scripts approved in `pnpm-workspace.yaml`: `better-sqlite3` for the server,
`sharp` for asset preparation, and `electron` for the existing Electron development
commands. Dependency scripts are not enabled globally. npm and Nix workflows
remain supported; this does not replace the committed npm lockfile or adopt a
pnpm lockfile.

Do not reuse one `node_modules` directory across package managers. Use a fresh
checkout or remove the dependency directory before switching, then reinstall
with the chosen package manager.

Before listening, the server opens an in-memory SQLite database, executes
`SELECT 1`, and closes it. A missing or incompatible native binding stops startup
with the original error and Node version. From the project directory, repair the
binding with the package manager used to install it:

```bash
pnpm rebuild better-sqlite3
# For npm installations:
npm rebuild better-sqlite3
```

Rebuild after changing Node versions as well. If rebuilding fails, address the
reported compiler/runtime error and reinstall dependencies with the same package
manager. Startup never rebuilds automatically or touches application databases.
`--help` bypasses this check. The in-memory check does not certify access to the
application's on-disk database or full application readiness.

Desktop extraction, copying local assets, Sharp PWA icon generation, Prettier,
and patch application now run behind `scripts/prepare-assets.cjs`.
The existing icon dimensions, padding, white background, PNG format, formatting,
and patch order are unchanged. A content manifest under `scratch/asset-cache`
checks the archive bytes, local assets, patches, preparation scripts, package
metadata/lockfile, Prettier configuration, `DEV`, and tool versions. Version alone
is never used to decide reuse. Changes to any of these rebuild the prepared
snapshot. Missing or changed snapshot files also rebuild it.

The prepared snapshot is separate from the live `scratch/asar` tree. On reuse,
missing or overwritten prepared files are restored, while browser-generated files
remain in place. New preparation always starts from a fresh extraction, so patches
and image operations never consume previously transformed outputs. Removed
prepared files are removed from the live tree on the next successful preparation.
Do not edit the snapshot; change `assets/`, patches, or preparation scripts instead.

Compression caches each JS/CSS source hash together with the gzip/Brotli output
hashes. Unchanged files skip compression even if Vite rewrites identical bytes.
Changed sources, missing/corrupted sidecars, changed compression code/settings,
or Node/compression-library versions regenerate the sidecars. Gzip level 9 and
Brotli quality 9, filenames, and timestamp preservation remain unchanged. Source
maps are excluded as before. Cache metadata is committed atomically only after a
successful stage; failures cannot certify incomplete output. Logs report prepared,
restored, compressed, and skipped work. The cache is local and can be deleted.

Force all asset work while still compiling both wrappers:

```bash
FORCE_ASSETS=1 npm run build
```

For individual stages, use `npm run prepare:asar -- --force` or
`node scripts/precompress-assets.cjs --force`. `npm run build:browser` and
`npm run build:server` remain usable independently after Desktop preparation.

Vite's gzip-size report is disabled by default. It performs extra compression
solely to print bundle sizes, separately from runtime sidecar generation. Enable
it explicitly with `REPORT_COMPRESSED_SIZE=1 npm run build:browser`.

Focused cache and compression checks:

```bash
node --test scripts/asset-cache.test.cjs scripts/precompress-assets.test.cjs
```
