import type { FastifyInstance } from "fastify";
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
  });
  await app.register(fastifyStatic, { root, prefix: "/" });
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
