# Git repository watcher

The extracted `.vite/build/worker.js` dynamically imports `@parcel/watcher`.
The macOS application archive used by preparation does not supply that package
in the current extracted runtime. The host must install it as a production
dependency, at the version used by the upstream application (currently 2.5.6).

Node ESM resolution walks from `scratch/asar/.vite/build/` through ancestor
`node_modules` directories to the host project's `node_modules`. The CommonJS
Electron alias hook does not handle this dynamic import. Preparation removes
any extracted watcher copy so it cannot shadow the host package with macOS
native code. The Nix package retains this same ancestor directory layout.

The watcher uses Node-API native binaries selected by OS, architecture, and
(on Linux) libc. Install dependencies on the target host, preserving optional
dependencies (`npm ci --include=optional`); do not copy macOS `node_modules` to
Linux. Both the JavaScript wrapper and the matching native package are needed.
Linux uses the upstream adapter's `inotify` backend. Missing prebuilds require
a supported source build and compiler toolchain. System inotify limits still
apply. Linux x64 glibc has been tested; musl, ARM, macOS, and Nix builds require
separate validation.

After preparation, run `npm run test:git-watcher`. This loads the actual
extracted Linux adapter from beside the worker, initializes its native watcher,
modifies a tracked file in a temporary Git repository, checks the typed update
notification, and disposes the subscription. It fails if dependency resolution
or native loading fails. The test references upstream adapter symbols and must
be updated if an application upgrade renames them. It verifies adapter delivery;
it does not exercise browser delivery through the running server.
