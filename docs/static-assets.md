# Static asset delivery and startup measurements

Built mode (`npm run build:browser`, then the Fastify server) serves the extracted
webview through `@fastify/static`. The browser build produces the mutable
`assets/preload.js` bridge; it does not rebundle the upstream application.
The final build step creates `.br` and `.gz` sidecars for compressible JS, CSS,
HTML, JSON, SVG, text and Wasm of at least 1 KiB, keeping only smaller results.
Sidecars are regenerated on every build, including mutable files. Requests do
not compress anything. Missing sidecars fall back to identity delivery.

The installed plugin negotiates Brotli/gzip using Accept-Encoding and serves
file metadata and streams through `@fastify/send`. Content-Length and weak
ETag refer to the selected representation. Vary: Accept-Encoding separates
cached variants, including identity and 304 responses. Byte ranges address the
selected representation: a compressed 206 contains a slice of compressed bytes,
not a separately compressed slice of the original. Use Accept-Encoding: identity
when inspecting human-readable ranges. Stale If-Range returns the full response;
unsatisfiable ranges return 416. A 206 alone does not diagnose slow delivery.
See the [plugin documentation](https://github.com/fastify/fastify-static#precompressed).

Only `assets/<name>-<12 hexadecimal digits>.{js,css,woff,woff2,png,svg}` uses
`public, max-age=31536000, immutable`, matching upstream content-hash naming and listed in build-generated
`.immutable-assets.json`. Files targeted by repository webview patches are excluded
because their names no longer describe their patched content. Missing metadata
conservatively revalidates everything. Restart the server after deploying metadata.
All other static resources, HTML, page fallbacks and /@fs files use `no-cache`
(storage with revalidation). The stable bridge filename must revalidate.
Unknown naming schemes conservatively revalidate.

Deploy complete matching HTML, assets and sidecars together; do not run a build
against a directory being served to users. Preserve previous hashed assets for
open tabs and lazy imports across deployments. Never replace bytes at an
immutable URL, including upstream patches: if a patch changes a hashed asset,
rename it and update its references or purge that URL from all caches before
rollout. The server cannot make a reused content-hash URL safe. Existing open
tabs cannot be protected from removed old chunks by HTTP headers alone.

Vite (`npm run dev:browser`) is a separate development path: it transforms the
bridge and injects development tooling, while serving extracted upstream assets.
It does not use Fastify's precompression or production cache policy. Compare
built mode to built mode when measuring this optimization. Missing upstream
source maps can produce Vite warnings and limit profiling attribution.

## Reproduce a browser measurement

1. Run built mode and open Chrome DevTools before navigating. Use the same
   machine, URL, connection, throttling and CPU settings for both runs. In
   Application, inspect/bypass any service worker so it cannot mask HTTP results.
2. In Network, enable Disable cache and clear the log. Reload, filter by JS,
   and select the large script. Record URL, status, protocol, request Range and
   Accept-Encoding, response Content-Encoding, Content-Length, Content-Range,
   Cache-Control, ETag and Vary. Add the Size and Time columns; hover Size to
   distinguish transferred bytes from decoded resource bytes.
3. In Timing, record Waiting for server response (TTFB), Content Download and
   total duration separately. The diagnostics `http.response.durationMs` measures
   server request-to-response completion (including streaming/backpressure),
   not browser download alone and not JavaScript parsing/execution. The earlier
   approximately 12 MB / 18 s observation cannot establish which stage dominated.
4. Uncheck Disable cache, clear browser cache once, and reload to populate it.
   Reload again with caching enabled. Record memory/disk-cache hits for hashed
   assets and revalidation (usually 304) for mutable files. A forced reload may
   revalidate even immutable assets; use ordinary reload/navigation for this run.
5. Capture a Performance recording of reload to isolate script compilation,
   evaluation and main-thread work. Network timing alone cannot measure these.
   Repeat at least three times per condition and retain HAR/recordings locally
   (they can contain private URLs and credentials).

For raw server transfer checks, choose the exact JS URL from Network:

```bash
curl -sS -o /dev/null -H 'Accept-Encoding: identity' -w 'status=%{http_code} bytes=%{size_download} ttfb=%{time_starttransfer} total=%{time_total}\n' "$JS_URL"
curl -sS -o /dev/null -H 'Accept-Encoding: br' -w 'status=%{http_code} bytes=%{size_download} ttfb=%{time_starttransfer} total=%{time_total}\n' "$JS_URL"
curl -sS -D - -o /dev/null -H 'Accept-Encoding: identity' -H 'Range: bytes=0-99' "$JS_URL"
```

These curl timings exclude browser parsing and execution. Compression reduces
transfer bytes, not decoded script size or application work. No browser startup
speedup is established until the controlled measurements above are collected.

## Conservative extracted-entry minification

`prepare:asar` now runs pinned esbuild after the final successful patch. Only
`assets/app-initial-<upstream hash>.js` is transformed. Whitespace is minified;
identifier/syntax minification, bundling, tree shaking and target lowering are
disabled. Other chunks, the Electron host and upstream source remain unchanged.
Vite's bridge build remains separate. Legal comments stay inline. Old entry
source maps and compressed sidecars are deleted; `build:browser` regenerates
compression after all transformations.

Compatibility risks were assessed before implementation: exports and function
names can be observable, dynamic imports and cyclic modules must retain their
identity, and aggressive syntax rewriting may change behavior. Whitespace-only
transformation still changes function source text and stack trace positions.
Code relying on `Function.prototype.toString()` formatting remains a risk.
Source maps for the transformed entry are deliberately unavailable.

The upstream filename is retained as a module identifier, **not a valid digest
of patched/minified bytes**. Renaming this entry alone would break imports from
many lazy chunks; recursively rehashing its cyclic graph is outside this change.
`.minified-assets.json` explicitly excludes transformed assets from immutable
caching, even if the patch list changes. Thus this solution preserves references
and uses revalidation rather than claiming new content hashes. Deployments that
require every filename to hash its final bytes need a graph-aware rebuild and
should not enable this post-processing in isolation. Purge any previously cached
immutable version of the entry before rollout. Do not override its `no-cache`
policy at a CDN. Deploy assets and metadata together and restart the server.

To compare with the unoptimized baseline, use identical clean extractions of the
same archive and apply all patches in both; omit only the final
`node scripts/minify-webview.cjs` invocation for the baseline. Build the bridge
and sidecars in both cases. The minifier prints decoded before/after byte counts;
compare `.br`/`.gz` separately with `wc -c`. Do not rerun the patch preparation on
already minified files: preparation starts from the archive each time.

Run `node --test tests/minify-webview.cjs` for export/name, dynamic import,
literal, license, stale-sidecar, cache exclusion and invalid-input checks.
These tests cannot establish application-level compatibility.

For each baseline and optimized browser run, follow the recording procedure
above. In Performance, select navigation through `codex-web:routes-mounted` in
Timings. In Bottom-up, group by activity and record Compile Script and Evaluate
Script total/self times (event labels vary by Chrome version). Inspect the Main
thread to associate each event with the entry URL. Record navigation-to-bootstrap,
route-mount and first usable composer separately; report medians and ranges for
at least three cold and three warm runs with identical CPU/network conditions.
A smaller decoded script does not establish faster compilation or execution.

Before rollout, test login/logout and session restoration, sidebar navigation,
existing and lazy-loaded threads, sending a message and streamed replies. In
Network's WS panel, confirm the `/__backend/ipc` upgrade and bidirectional frames,
and check reconnect after a reload. Record console errors and failed chunk
requests. Authentication and message tests require an interactive authenticated
browser; automated static-route tests alone do not cover them.

### Local validation result

Re-extracting the entry from the available ASAR, formatting it, and applying its
patch sections in preparation order produced 18,311,503 bytes. The final
whitespace-only configuration produced 12,799,644 bytes: 5,511,859 bytes (30.10%)
smaller. These are decoded file sizes, not transfer sizes or timing results.
The focused minifier tests (2), static/Vite route tests (4), diagnostics tests
(17), and Git watcher test (1) passed. Browser and server builds passed. Vite
reported upstream missing source maps and an unanalyzable dynamic import.
No interactive browser was available, so authenticated startup, thread loading,
messaging, application WebSocket traffic and Compile/Evaluate Script timing
remain unverified. No startup speed improvement is claimed. A server process
reported its listening address, but a direct HTTP smoke request did not complete
within five seconds; this is not evidence of successful application startup.
