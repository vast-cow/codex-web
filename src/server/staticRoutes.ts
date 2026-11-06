import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import { routeCategory } from "./diagnostics/core";

type Diagnostic = (
  level: "debug",
  event: string,
  fields: Record<string, unknown>,
) => void;

import { pathname, assetCategory, isPage } from "./pageRoutes";

export async function registerStaticRoutes(
  app: FastifyInstance,
  root: string,
  diagnostic: Diagnostic,
): Promise<void> {
  // Missing metadata conservatively revalidates (e.g. an unbuilt checkout).
  const immutableAssets = new Set<string>();
  try {
    const entries: unknown = JSON.parse(
      await readFile(path.join(root, ".immutable-assets.json"), "utf8"),
    );
    if (Array.isArray(entries))
      for (const entry of entries) {
        if (typeof entry === "string") immutableAssets.add(entry);
      }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const starts = new WeakMap<object, number>();
  const fallbacks = new WeakSet<object>();
  app.addHook("onRequest", async (request) => {
    starts.set(request, performance.now());
  });
  app.addHook("onResponse", async (request, reply) => {
    const type = String(reply.getHeader("content-type") ?? "").split(";")[0];
    const asset = assetCategory(pathname(request.url));
    const length = reply.getHeader("content-length");
    const bytes = length === undefined ? undefined : Number(length);
    diagnostic("debug", "http.response", {
      route: routeCategory(request.url),
      status: reply.statusCode,
      durationMs:
        performance.now() - (starts.get(request) ?? performance.now()),
      kind: type?.includes("html")
        ? "html"
        : type?.includes("javascript")
          ? "javascript"
          : "other",
      asset,
      action: fallbacks.has(request)
        ? "spa-fallback"
        : reply.statusCode === 404
          ? "not-found"
          : asset !== "other" && reply.statusCode < 400
            ? "static-response"
            : "other",
      ...(bytes !== undefined && Number.isSafeInteger(bytes) && bytes >= 0
        ? { bytes }
        : {}),
    });
  });

  await app.register(fastifyStatic, {
    root: "/",
    prefix: "/@fs/",
    decorateReply: false,
    cacheControl: false,
    setHeaders(response) {
      response.setHeader("Cache-Control", "no-cache");
    },
  });
  await app.register(fastifyStatic, {
    root,
    prefix: "/",
    preCompressed: true,
    cacheControl: false,
    setHeaders(response, file) {
      const relative = path.relative(root, file).split(path.sep).join("/");
      const immutable = immutableAssets.has(
        relative.replace(/\.(?:br|gz)$/, ""),
      );
      response.setHeader(
        "Cache-Control",
        immutable ? "public, max-age=31536000, immutable" : "no-cache",
      );
      response.setHeader("Vary", "Accept-Encoding");
    },
  });
  app.get("/", async (_request, reply) => reply.sendFile("index.html"));
  app.setNotFoundHandler((request, reply) => {
    const path = pathname(request.url);
    if (
      request.method === "GET" &&
      !path.startsWith("/@fs/") &&
      assetCategory(path) === "other" &&
      isPage(path)
    ) {
      fallbacks.add(request);
      diagnostic("debug", "http.spa-fallback", {
        route: routeCategory(request.url),
        asset: "other",
      });
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "Not Found" });
  });
}
