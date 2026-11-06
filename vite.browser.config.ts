import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { pathname, assetCategory, isPage } from "./src/server/pageRoutes";

const configDir = path.dirname(fileURLToPath(import.meta.url));
const asarPackagePath = path.resolve(configDir, "scratch/asar/package.json");
const webviewRoot = path.resolve(configDir, "scratch/asar/webview");
const preloadEntryPath = path.resolve(
  configDir,
  "scratch/asar/.vite/build/preload.js",
);
const browserNodeEnv = process.env.NODE_ENV ?? "production";
const asarPackageJson = JSON.parse(readFileSync(asarPackagePath, "utf8")) as {
  version?: unknown;
};

if (typeof asarPackageJson.version !== "string" || !asarPackageJson.version) {
  throw new Error(`Expected a version string in ${asarPackagePath}`);
}

export default defineConfig({
  root: webviewRoot,
  appType: "mpa",
  plugins: [
    {
      name: "explicit-page-fallback",
      configureServer(server) {
        // Vite has already tried transforms, proxies and static files. Replace
        // its broad SPA rewrite with the browser's explicit page contract.
        return () =>
          server.middlewares.use((request, _response, next) => {
            const path = pathname(request.url ?? "");
            if (
              (request.method === "GET" || request.method === "HEAD") &&
              assetCategory(path) === "other" &&
              isPage(path)
            ) {
              request.url = "/index.html";
            }
            next();
          });
      },
    },
  ],
  define: {
    __CODEX_APP_VERSION__: JSON.stringify(asarPackageJson.version),
    "process.env.NODE_ENV": JSON.stringify(browserNodeEnv),
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    allowedHosts: true,
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
  resolve: {
    alias: {
      electron: path.resolve(configDir, "src/browser/shim.ts"),
    },
  },
  build: {
    commonjsOptions: {
      include: [/scratch\/asar\/\.vite\/build\/preload\.js/, /node_modules/],
      requireReturnsDefault: "auto",
      transformMixedEsModules: true,
    },
    emptyOutDir: false,
    minify: false,
    outDir: path.resolve(webviewRoot, "assets"),
    sourcemap: true,
    lib: {
      entry: preloadEntryPath,
      fileName: () => "preload.js",
      formats: ["es"],
    },
    rollupOptions: {
      output: {
        entryFileNames: "preload.js",
      },
    },
  },
});
