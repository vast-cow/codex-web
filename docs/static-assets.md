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
