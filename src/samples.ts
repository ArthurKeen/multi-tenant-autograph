// Bundle the repo's test documents into the app so a tenant can be loaded with
// one click (no manual file selection, survives refreshes). Vite inlines the
// .txt contents at build time via import.meta.glob(..., as raw).
const rawFiles = import.meta.glob("../test-data/tenant-*/*.txt", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Return File objects for a tenant folder id ("a" | "b" | "c"). */
export function sampleFiles(tenantId: string): File[] {
  const out: File[] = [];
  for (const [path, content] of Object.entries(rawFiles)) {
    const m = path.match(/tenant-([a-z0-9]+)\/([^/]+\.txt)$/i);
    if (!m || m[1] !== tenantId) continue;
    out.push(new File([content], m[2], { type: "text/plain" }));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function hasSamples(tenantId: string): boolean {
  return sampleFiles(tenantId).length > 0;
}
