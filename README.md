# Multi-Tenant GraphRAG Isolation Prototype

A small, self-contained prototype that demonstrates **tenant data isolation** in a single,
shared ArangoDB-backed knowledge graph. It proves that documents ingested by different
tenants stay isolated end to end: a natural-language query issued as one tenant never
surfaces another tenant's data.

It is built on the ArangoDB **AutoGraph** (ingestion / corpus build / orchestration) and
**GraphRAG Retriever** (query) services, with a lightweight React UI on top.

> See [`PRD.md`](./PRD.md) for the full product requirements, architecture, the three-layer
> data model, and validated integration notes.

## What it shows

- A tenant selector (Tenant A / B / C), each mapped to an isolated **module**.
- Per-tenant onboarding pipeline: **File Manager upload → import → corpus build → RAG
  strategizer → knowledge-graph build (orchestrate)** — with live status.
- A chat panel that queries **only the active tenant's partitions**, with a visible
  "scoped to partitions" indicator and a live knowledge-graph status dot.
- One-click **isolation probes**: ask the active tenant about another tenant's project and
  confirm it returns "no relevant data".

## Architecture (at a glance)

```
Browser (React SPA)
   │  same-origin /api/*   (no credentials in the browser)
   ▼
Vite dev proxy  ── mints a JWT from ArangoDB /_open/auth, injects Authorization, forwards to:
   ├─ /api/ag/*  → AutoGraph         (import, corpus build, strategizer, orchestrate)
   ├─ /api/rt/*  → GraphRAG Retriever (chat / graphrag-query)
   └─ /api/fm/*  → Platform File Manager (RAG-input upload)
                         │
                         ▼
                    ArangoDB cluster
```

The proxy lives in [`vite.config.ts`](./vite.config.ts). Credentials stay server-side; the
browser never sees the database password or JWT.

## Prerequisites

- **Node.js 18+** and npm.
- Access to an ArangoDB deployment with the **AutoGraph** and **GraphRAG Retriever** GenAI
  services available (the platform / "Agentic AI Suite").
- An **OpenAI API key** (used by the services for extraction + embeddings).

## Setup

```bash
git clone https://github.com/ArthurKeen/multi-tenant-autograph.git
cd multi-tenant-autograph
npm install
cp .env.example .env   # then fill in the values below
```

Edit `.env` (it is gitignored — never commit it):

| Variable | Purpose |
| --- | --- |
| `ARANGO_ENDPOINT` | Deployment endpoint, e.g. `https://your-cluster.example.com` |
| `ARANGO_DATABASE` | Target database (created on first deploy/reset) |
| `ARANGO_USERNAME` / `ARANGO_PASSWORD` | DB credentials (proxy mints JWTs from these) |
| `OPENAI_API_KEY` | Chat + embedding key for the services |
| `LLM_EXTRACTION_MODEL` / `EMBEDDING_MODEL` | e.g. `gpt-4o` / `text-embedding-3-small` |
| `VITE_AUTOGRAPH_BASE_URL` / `VITE_RETRIEVERS_BASE_URL` | Service URLs (written by the deploy script) |
| `VITE_GENAI_PROJECT_NAME` | GenAI project name (prefixes collections) |
| `VITE_TENANT_*_MODULE` / `VITE_TENANT_*_LABEL` | Tenant → module mapping and display labels |

## Deploy the backend services

The services are deployed against your database via the GenAI control plane. This script is
**idempotent** — it reuses existing services for the database instead of creating duplicates,
and writes the resolved service URLs back into `.env`:

```bash
python3 scripts/deploy_services.py            # reuse if present, else install
python3 scripts/deploy_services.py --dry-run  # print payloads, deploy nothing
python3 scripts/deploy_services.py --force     # force new instances (e.g. to clear a stuck lock)
```

> The database is **not** created automatically by deploying — create it first (or use the
> in-app "Reset database" button, which drops + recreates it).

Tidy up superseded/orphaned services for this demo's database/project at any time:

```bash
python3 scripts/cleanup_services.py        # dry run (shows what would be deleted)
python3 scripts/cleanup_services.py --yes  # actually delete orphans, keep the in-use pair
```

## Run the UI

```bash
npm run dev      # http://localhost:5173
npm run build    # type-check + production build
npm run preview  # preview the production build
```

In the UI, for each tenant: **Load sample docs → Ingest & activate**, watch the live status,
then chat. Try the amber **isolation probes** to confirm cross-tenant queries return nothing.

> _Screenshot:_ add a capture of the running UI at `docs/ui.png` and it will render here.

## Demo script

A repeatable ~10-minute walkthrough that proves tenant isolation:

1. **Onboard the tenants.** For **Tenant A**: click **Load sample docs (Tenant A)** → **Ingest &
   activate Tenant A**. Watch the live status go through upload → import → corpus build →
   strategizer → knowledge graph. Wait for the green **"ready"** dot (it only turns green once
   the graph is actually queryable). Repeat for **Tenant B** and **Tenant C**.
   - Onboarding is sequential by design — one tenant builds at a time (see PRD §2.4).
2. **Positive query.** With **Tenant A** selected, click the suggestion **"What is Project
   Ironclad?"** → you get a detailed answer about Northwind Grid Authority's substation program.
   Note the **"scoped to partitions: tenant_a_0_a"** indicator under the chat header.
3. **The isolation money shot.** Switch the dropdown to **Tenant B**, then click the amber
   isolation probe **"What is Project Ironclad?"** → it returns **"No relevant data found."**
   Same data, same shared knowledge graph — but Tenant B cannot see Tenant A's content.
4. **Prove it both ways.** As **Tenant C**, probe **"What is Project Tidewatch?"** (Tenant B's
   project) → nothing. As **Tenant A**, probe **"What is Project Helios Fields?"** (Tenant C's
   project) → nothing. Each tenant only answers about its own projects.
5. **(Optional) Headless proof.** Run `python3 scripts/smoke_test.py` to execute the same
   isolation checks from the terminal and print PASS/FAIL.

**Talking points while it runs:** isolation is enforced **server-side** (module scoping at
ingest, `partition_ids` filtering at query) — the tenant dropdown is just a demo convenience.
The same documents live in one shared ArangoDB knowledge graph; only the partition scoping
keeps them apart.

## Test data

`test-data/` contains three fictional, energy-sector tenant document sets with **disjoint**
entities (so leakage is unambiguous). See [`test-data/README.md`](./test-data/README.md).
Everything is invented — no real organizations or data.

## End-to-end smoke test (optional)

Runs the full pipeline headlessly and asserts cross-tenant isolation:

```bash
python3 scripts/smoke_test.py             # ingest A+B → build → strategize → orchestrate → isolation checks
python3 scripts/smoke_test.py --query-only # just re-run the isolation queries against a built KG
```

## Notes & limitations

- **Isolation is enforced server-side** by the backend (module scoping at ingest,
  `partition_ids` filtering at query). The tenant selector is a client-side demo affordance.
- AutoGraph allows only **one corpus build and one orchestration at a time** per instance
  (HTTP 409 otherwise), so tenant operations serialize.
- This is a **prototype/demo**, not production software. Do not commit real secrets; rotate
  any keys placed in a local `.env`.
