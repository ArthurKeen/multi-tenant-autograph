import { defineConfig, loadEnv, type Connect } from "vite";
import react from "@vitejs/plugin-react";
import type { IncomingMessage } from "node:http";

/**
 * Dev proxy plugin.
 *
 * The browser only ever talks to same-origin /api/* routes. This Node-side
 * middleware:
 *   - mints a short-lived JWT from ArangoDB (/_open/auth) using the ARANGO_*
 *     credentials in .env (kept SERVER-SIDE; never shipped to the browser),
 *   - injects `Authorization: Bearer <jwt>` on every forwarded request,
 *   - forwards to the AutoGraph, Retriever, and File Manager backends.
 *
 * This avoids CORS and keeps credentials/tokens out of the client bundle,
 * matching PRD §5 / §6.4.
 */
function backendProxy(env: Record<string, string>) {
  const endpoint = (env.ARANGO_ENDPOINT || "").replace(/\/$/, "");
  const db = env.ARANGO_DATABASE || "multitenant_demo";
  const user = env.ARANGO_USERNAME || "root";
  const pass = env.ARANGO_PASSWORD || "";
  const autograph = (env.VITE_AUTOGRAPH_BASE_URL || "").replace(/\/$/, "");
  const retriever = (env.VITE_RETRIEVERS_BASE_URL || "").replace(/\/$/, "");

  // Demo cluster may use a self-signed cert; relax TLS for the dev proxy only.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  let cachedJwt = "";
  let jwtExp = 0;

  function secondsLeft(jwt: string): number {
    try {
      const payload = JSON.parse(
        Buffer.from(jwt.split(".")[1], "base64").toString(),
      );
      return (payload.exp || 0) - Math.floor(Date.now() / 1000);
    } catch {
      return 0;
    }
  }

  async function getJwt(): Promise<string> {
    if (cachedJwt && jwtExp - Math.floor(Date.now() / 1000) > 120) return cachedJwt;
    const res = await fetch(`${endpoint}/_open/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user, password: pass }),
    });
    if (!res.ok) throw new Error(`auth failed: ${res.status} ${await res.text()}`);
    const j = (await res.json()) as { jwt: string };
    cachedJwt = j.jwt;
    jwtExp = Math.floor(Date.now() / 1000) + secondsLeft(j.jwt);
    return cachedJwt;
  }

  function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.from(c)));
      req.on("end", () => resolve(Buffer.concat(chunks)));
    });
  }

  function target(url: string): string | null {
    if (url.startsWith("/api/ag/")) return `${autograph}/${url.slice("/api/ag/".length)}`;
    if (url.startsWith("/api/rt/")) return `${retriever}/${url.slice("/api/rt/".length)}`;
    if (url.startsWith("/api/fm/rag-input"))
      return `${endpoint}/_platform/filemanager/_db/${db}/rag-input`;
    return null;
  }

  async function arango(path: string, method: string): Promise<Response> {
    const jwt = await getJwt();
    return fetch(`${endpoint}${path}`, {
      method,
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    });
  }

  async function aql(query: string): Promise<unknown[]> {
    const jwt = await getJwt();
    const res = await fetch(`${endpoint}/_db/${db}/_api/cursor`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) return [];
    return ((await res.json()) as { result?: unknown[] }).result || [];
  }

  /** Read-only Layer 3 knowledge-graph status: per-partition document/entity counts. */
  async function kgStatus(): Promise<unknown> {
    const jwt = await getJwt();
    const colRes = await fetch(`${endpoint}/_db/${db}/_api/collection`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const cols: string[] = colRes.ok
      ? ((await colRes.json()) as { result: Array<{ name: string; isSystem: boolean }> }).result
          .filter((c) => !c.isSystem)
          .map((c) => c.name)
      : [];
    const hasDocs = cols.includes(`${db}_Documents`);
    const hasEntities = cols.includes(`${db}_Entities`);
    const byPartition: Record<string, { documents: number; entities: number }> = {};
    const add = (p: string, key: "documents" | "entities", n: number) => {
      byPartition[p] = byPartition[p] || { documents: 0, entities: 0 };
      byPartition[p][key] = n;
    };
    if (hasDocs) {
      for (const row of (await aql(
        `FOR d IN ${db}_Documents COLLECT p = d.partition_id WITH COUNT INTO n RETURN {p, n}`,
      )) as Array<{ p: string; n: number }>)
        add(row.p, "documents", row.n);
    }
    if (hasEntities) {
      for (const row of (await aql(
        `FOR e IN ${db}_Entities COLLECT p = e.partition_id WITH COUNT INTO n RETURN {p, n}`,
      )) as Array<{ p: string; n: number }>)
        add(row.p, "entities", row.n);
    }
    return { layer3Exists: hasDocs, byPartition };
  }

  /** Drop and recreate the demo database for a clean slate. */
  async function resetDatabase(): Promise<{ ok: boolean; detail: string }> {
    const del = await arango(`/_api/database/${db}`, "DELETE");
    const jwt = await getJwt();
    const createRes = await fetch(`${endpoint}/_api/database`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: db }),
    });
    return {
      ok: createRes.ok || createRes.status === 409,
      detail: `drop=${del.status} create=${createRes.status}`,
    };
  }

  const middleware: Connect.NextHandleFunction = async (req, res, next) => {
    const url = req.url || "";
    if (!url.startsWith("/api/")) return next();

    // Admin: read-only knowledge-graph status.
    if (url.startsWith("/api/admin/kg-status") && req.method === "GET") {
      try {
        const status = await kgStatus();
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify(status));
      } catch (e) {
        res.statusCode = 502;
        return res.end(JSON.stringify({ error: String(e) }));
      }
    }

    // Admin: reset the demo database (drop + recreate).
    if (url.startsWith("/api/admin/reset") && req.method === "POST") {
      try {
        const result = await resetDatabase();
        res.statusCode = result.ok ? 200 : 500;
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify(result));
      } catch (e) {
        res.statusCode = 502;
        return res.end(JSON.stringify({ error: String(e) }));
      }
    }

    const dest = target(url);
    if (!dest) {
      res.statusCode = 404;
      return res.end("unknown api route");
    }
    try {
      const jwt = await getJwt();
      let body = ["GET", "HEAD"].includes(req.method || "GET")
        ? undefined
        : await readBody(req);
      const headers: Record<string, string> = { Authorization: `Bearer ${jwt}` };
      const ct = req.headers["content-type"];
      if (ct) headers["Content-Type"] = ct;

      // Inject the chat API key into orchestrate server-side (importer needs it;
      // keep the key out of the browser). PRD §5.
      if (url.startsWith("/api/ag/v1/orchestrate") && body && env.OPENAI_API_KEY) {
        try {
          const parsed = JSON.parse(body.toString() || "{}");
          if (!parsed.chat_api_keys?.length) parsed.chat_api_keys = [env.OPENAI_API_KEY];
          body = Buffer.from(JSON.stringify(parsed));
        } catch {
          /* leave body as-is */
        }
      }

      const upstream = await fetch(dest, { method: req.method, headers, body });
      res.statusCode = upstream.status;
      const ctype = upstream.headers.get("content-type");
      if (ctype) res.setHeader("Content-Type", ctype);
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.end(buf);
    } catch (e) {
      res.statusCode = 502;
      res.end(JSON.stringify({ error: String(e) }));
    }
  };

  return {
    name: "backend-proxy",
    configureServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), backendProxy(env)],
    server: { port: 5173 },
  };
});
