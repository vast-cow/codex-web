import type { FastifyStaticOptions } from "@fastify/static";

// Only the packaged webview registration uses this; /@fs and IPC are unaffected.
export const staticAssetDelivery: Partial<FastifyStaticOptions> = {
  preCompressed: true,
  setHeaders(response) {
    response.setHeader("Vary", "Accept-Encoding");
  },
};
