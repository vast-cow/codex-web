export function pathname(url: string): string {
  try {
    return decodeURIComponent(new URL(url, "http://localhost").pathname);
  } catch {
    return "";
  }
}

export function assetCategory(path: string): string {
  if (/\.js$/i.test(path)) return "javascript";
  if (/\.css$/i.test(path)) return "css";
  if (/\.map$/i.test(path)) return "source-map";
  return "other";
}

// Keep aligned with src/browser/routes.ts, rather than allowing arbitrary paths.
export function isPage(path: string): boolean {
  return (
    path === "/" || path === "/share/receive" || /^\/thread\/[^/]+$/.test(path)
  );
}
