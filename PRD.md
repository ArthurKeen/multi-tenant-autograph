# Product Requirements Document (PRD)

**Project Name:** Multi-Tenant GraphRAG Isolation Prototype

**Status:** Draft

**Target Audience:** Engineering, Product Architecture, and platform integration stakeholders

---

## 1. Overview & Objective

Many platforms operate a single, shared, multi-tenant database while needing to offer
agentic AI and natural-language query features over tenant data. The hard requirement in
that setting is **data isolation**: a query issued in the context of Tenant B must never
surface data ingested by Tenant A, even when both tenants share the same physical
database and knowledge graph collections.

This prototype demonstrates, end to end, that **AutoGraph** (ingestion + corpus build +
orchestration) and the **GraphRAG Retrievers** query service can securely segregate tenant
data inside a single ArangoDB-backed knowledge graph. It proves two things visually and
repeatably:

1. Documents ingested under different tenants are isolated within the knowledge graph.
2. Natural-language queries respect tenant boundaries with **no cross-tenant leakage**.

The deliverable is a lightweight front-end prototype plus the orchestration glue needed to
run the demonstration script in Section 7.

### 1.1 What this prototype is and is not

- **It is** a demonstration of isolation guarantees and a reusable front-end component set.
- **It is not** a production application, an authentication system, or a full ABAC policy
  engine. Tenant isolation is enforced **server-side** by the backend services; the
  prototype's persona selector is a client-side convenience for the demo only.

---

## 2. Background: How the Backend Actually Works

> This section reflects the real backend API surface (verified against the AutoGraph and
> GraphRAG Retrievers codebases). The prototype must build against these, not a simplified
> mental model.

The workflow spans **three backend services**:

| Service | Role | Default REST port |
| --- | --- | --- |
| **AutoGraph** | Ingest documents, build the corpus graph, run the RAG strategizer, orchestrate knowledge-graph builds | `8080` (Go gRPC-Gateway → Python gRPC `9090`) |
| **GraphRAG Importer** | Materializes the Layer 3 knowledge graph (invoked *by* AutoGraph orchestration, not by the UI) | internal |
| **GraphRAG Retrievers** | Serves natural-language / chat queries over the knowledge graph | `8080` (separate deployment) |

### 2.1 Three-layer data model

| Layer | Owner | Isolation key | Notes |
| --- | --- | --- | --- |
| **Layer 1 – Modules** | Set by caller on import (`module` field) | `module` | Primary corpus-level isolation. No cross-module similarity edges; clustering runs per module. **This is where "tenant" lives at ingest time.** |
| **Layer 2 – Corpus graph** | AutoGraph | `module` | Sources, similarities, domains, clusters. |
| **Layer 3 – Knowledge graph** | GraphRAG Importer | `partition_id` (a.k.a. `rag_partition_id`) | Entities, chunks, communities, relations live in shared collections, keyed by partition. **This is where "tenant" maps at query time.** |

**Critical nuance:** a single `module` (tenant) produces **one or more** `rag_partition_id`
values after the strategizer runs (clusters × strategy suffix). The query service filters by
`partition_ids` — an array of `rag_partition_id` values — **not** by the raw module name. The
prototype must capture the mapping `tenant → module → [rag_partition_id...]` from the
strategizer output and use it at query time.

### 2.2 Canonical end-to-end pipeline

```
[UI] upload (module = tenant)        → AutoGraph  POST /v1/import-multiple
[UI] build corpus                    → AutoGraph  POST /v1/corpus/builds
[UI] poll until complete             → AutoGraph  GET  /v1/corpus/builds/{id}
[UI] run strategizer                 → AutoGraph  POST /v1/rag-strategizer/analyze
[UI] read strategy (partition map)   → AutoGraph  GET  /v1/rag-strategizer/strategy
[UI] build knowledge graph           → AutoGraph  POST /v1/orchestrate
[UI] chat (partition_ids = tenant's) → Retrievers POST /v1/graphrag-query-stream
```

### 2.3 Validated integration notes (verified end-to-end against a live deployment)

The following were confirmed by running the full pipeline (ingest → build → strategize →
orchestrate → query) against a deployed AutoGraph + Retriever stack. They are easy to miss
and the prototype **must** account for them:

1. **The ArangoDB database must exist first.** Creating a GenAI project does **not** create
   the database. If it is missing, every service call returns **HTTP 403 "Database access
   denied"**. Provision the database (e.g. `POST /_api/database`) before deploying/using
   services.
2. **File Manager upload is a required pre-step.** `POST /v1/import-multiple` does **not**
   register files in File Manager. Before a corpus build (without explicit `file_ids`), each
   document must be uploaded to the platform File Manager:
   `POST {endpoint}/_platform/filemanager/_db/{db}/rag-input` (multipart `name` + `file`).
   Otherwise the build fails with *"files were not found in File Manager"*.
3. **Basenames must be globally unique per database.** File Manager resolves files by
   **basename across the whole database**, not per module. Two tenants uploading the same
   filename (e.g. `overview.txt`) would collide on one `file_id`, and the Layer 3 importer
   would fetch the **same bytes for both tenants — silently breaking isolation**. Prefix every
   document name with its tenant/module (e.g. `tenant_a_overview.txt`).
4. **Multi-module ingest must be done per module.** A second `import-multiple` call wipes the
   previous call's disk staging, so a single build after two imports retains only the **last**
   module. Correct pattern: **import + build each module separately**, using `incremental:
   false` with an explicit single-module `modules: ["tenant_a"]` list (modules not listed are
   preserved). Verified: this yields one `rag_partition_id` per tenant.
5. **Use Local or Global query type, not Unified.** In the tested deployment, retriever
   `query_type: 3` (Unified) returns *"No response available"*, while `query_type: 2` (Local,
   entity-level, supports `partition_ids` + citations) and `query_type: 1` (Global) work. The
   UI should default to **Local (2)**.
6. **REST responses are camelCase.** The gRPC-gateway serializes responses in camelCase
   (`corpusBuildId`, `ragPartitionId`, `orchestrationId`), even though request bodies accept
   snake_case. Clients must read camelCase keys.
7. **Cross-tenant isolation confirmed.** With the above in place, a query scoped to Tenant B's
   `partition_ids` returns *"No relevant data found"* for Tenant A's entities (e.g. "Project
   Ironclad"), in both directions — the core guarantee the prototype exists to demonstrate.

> Reference implementation of all of the above lives in `scripts/deploy_services.py`
> (service deployment) and `scripts/smoke_test.py` (full pipeline + isolation checks).

### 2.4 Multi-tenant ingestion challenges (modules as tenants)

Using one **module per tenant** keeps tenant *data* cleanly isolated (no cross-module
similarity/clustering; queries filter by `partition_ids`). The challenges are all on the
**onboarding / operations** side, and a real multi-tenant deployment must account for them:

1. **Onboarding is one tenant at a time.** Each `import-multiple` call tags a single module
   and **wipes the previously staged import**, so you cannot load several tenants in one pass —
   it is import-and-build Tenant A, then B, then C.
2. **Tenant operations cannot run in parallel.** AutoGraph allows only **one corpus build and
   one orchestration at a time** per instance (HTTP 409 otherwise). Tenant B's onboarding waits
   for Tenant A's to finish.
3. **Filename collisions silently break isolation.** File Manager resolves files by **basename
   across the whole database**, not per module. Two tenants uploading `overview.txt` collide on
   one `file_id`, and the importer can fetch one tenant's bytes for the other. **Mitigation:**
   make filenames globally unique per tenant (this prototype prefixes every doc with the module,
   e.g. `tenant_a_overview.txt`).
4. **One stuck job blocks every tenant.** All tenants share one control plane, so a hung
   build/orchestration freezes onboarding for everyone — and there is no per-tenant cancel; you
   restart the service to clear the in-memory lock.
5. **Throughput does not scale with tenant count.** Because operations serialize, onboarding N
   tenants is N sequential build + extraction jobs, not N in parallel.

**Bottom line:** data isolation is solid; the constraints are operational — ingestion is
sequential, shared, and filename-sensitive, which matters at scale (many tenants).

---

## 3. User Stories

- **As a Demo Presenter**, I want to select a mock "Tenant Persona" from a dropdown so I can
  simulate operating as different organizations without standing up a full auth backend.
- **As a Tenant User**, I want to upload text/PDF documents scoped to my tenant so they are
  ingested into the knowledge graph under my module.
- **As a Tenant User**, I want to run the build → strategize → orchestrate pipeline from the
  UI and see clear progress, because these steps are asynchronous.
- **As a Tenant User**, I want to chat with an AI agent about my documents and receive answers
  drawn **only** from data I am authorized to see.
- **As a Demo Presenter**, I want to switch between tenants (A, B, C) and prove the agent
  cannot reach another tenant's data while operating as a given tenant.
- **As a Skeptical Reviewer**, I want the UI to show *which* `partition_ids` a query was scoped
  to, so the isolation claim is auditable rather than taken on faith.

---

## 4. Functional Requirements

### 4.1 UI layout & state management

Single Page Application (SPA) with global state for the active tenant.

- **Tenant Selector** — persistent dropdown/toggle in the header. Options: `Tenant A`,
  `Tenant B`, `Tenant C` (labels configurable). Changing it updates the active tenant context
  used to derive `module` (ingest) and `partition_ids` (query).
- **Pipeline Panel** — surfaces the multi-step async workflow (import → build → strategize →
  orchestrate) with per-step status, IDs, and polling state. This replaces the PRD's earlier
  assumption that ingestion is a single synchronous call.
- **File Upload** — drag-and-drop accepting `.txt` and `.pdf`. Files are base64-encoded into
  the `content` field of the import request.
- **Chat Interface** — conversational UI with streaming responses and a visible "scoped to
  partitions: [...]" indicator on each answer.

### 4.2 API integration matrix (corrected)

All endpoints require an `Authorization: Bearer <JWT>` header (see Section 5).

| Step | Service | Endpoint | Key payload |
| --- | --- | --- | --- |
| **Ingest** | AutoGraph | `POST /v1/import-multiple` | `files[]` with base64 `content`; `module` = active tenant |
| **Build corpus** | AutoGraph | `POST /v1/corpus/builds` | `embedding_strategy`, optional `modules[]`, `file_ids[]`, `incremental` → returns `corpus_build_id` |
| **Poll build** | AutoGraph | `GET /v1/corpus/builds/{corpus_build_id}` | poll until `completed` |
| **Strategize** | AutoGraph | `POST /v1/rag-strategizer/analyze` | produces `rags` records with `rag_partition_id`s |
| **Read strategy** | AutoGraph | `GET /v1/rag-strategizer/strategy` | UI reads `rag_partition_id`s per module to build the tenant→partition map |
| **Orchestrate** | AutoGraph | `POST /v1/orchestrate` | optional `partition_ids[]` filter (values are `rag_partition_id`s) |
| **Chat (stream)** | GraphRAG Retrievers | `POST /v1/graphrag-query-stream` | `query`; `partition_ids[]` = active tenant's `rag_partition_id`s |

### 4.3 Backend constraints the UI must handle

- **Asynchronous builds:** corpus build and orchestration run in the background; the UI must
  poll and reflect status, not assume immediate completion.
- **Concurrency limits:** only one active corpus build and one orchestration at a time; the
  backend returns **HTTP 409** otherwise. The UI must surface this clearly and disable
  conflicting actions.
- **Strategizer is mandatory:** `orchestrate` depends on `rags` produced by the strategizer.
  Skipping it (as the original PRD implied) will fail.
- **File Manager pre-upload + unique basenames:** every document must be uploaded to File
  Manager before the build (§2.3 #2), with globally unique basenames per database (§2.3 #3).
- **Per-module ingest+build:** import and build one module at a time (§2.3 #4); do not batch
  multiple tenants into one build or only the last survives.
- **Database provisioning:** the target database must exist before any call (§2.3 #1).
- **camelCase responses / Local query type:** parse camelCase response keys (§2.3 #6) and
  default chat to `query_type: 2` (§2.3 #5).
- **Streaming:** chat responses are streamed (chunked); the UI must render incrementally.

### 4.4 Isolation observability (new requirement)

To make the isolation claim auditable, the UI must display, for each chat answer:
- the active tenant/persona,
- the exact `partition_ids` the query was scoped to,
- (optionally) the source documents/chunks cited.

This turns "trust us, it's isolated" into a visible, demonstrable property.

### 4.5 Advanced ABAC mocking (Optional, Phase 2)

To explore traversal-based, attribute-based access control beyond tenant partitioning:

- **Custom retriever tools** are defined server-side in the GraphRAG Retrievers service, each
  with an `aql_config.template` and default `bind_params`.
- The UI can trigger predefined custom tools and pass mock user attributes (role, department)
  to influence the AQL traversal.
- **Known limitation:** the main streaming-query request message does not currently expose a
  per-request `bind_params` field. Passing runtime attributes therefore requires either
  (a) pre-deployed tool definitions with the desired defaults, or (b) a small backend API
  extension on the retriever service. This must be confirmed/scoped before committing Phase 2.

---

## 5. Authentication & Security Model

- **Server-side enforcement:** isolation is enforced by the backend (module scoping at
  ingest, `partition_ids` filtering at query). The prototype must not be presented as the
  thing providing isolation.
- **JWT required:** every backend endpoint (AutoGraph and Retrievers) requires a valid
  `Authorization: Bearer <JWT>` validated against the platform authentication service, which
  also performs ArangoDB-level access checks (returns **403** on failure).
- **Persona vs. identity:** the tenant-persona dropdown is a client-side demo affordance for
  switching the `module`/`partition_ids` context. It is **not** authentication. For the demo,
  a single valid backend token is used; the persona switch changes only the tenant scoping.
- **Negative-path integrity:** the prototype must derive `partition_ids` strictly from the
  active tenant. It must never send Tenant A's partitions while in Tenant B's persona — the
  cross-tenant test (Section 7.4) depends on this being honest.

---

## 6. Non-Functional Requirements

### 6.1 Tech stack — recommendation: React/TypeScript

**Primary recommendation: a React + TypeScript SPA (Vite).** Rationale:

- **Embeddable:** the goal is for the integrating team to lift these components into their
  existing front end. React components are directly reusable; a server-rendered Python app is
  not.
- **Streaming:** first-class handling of chunked/SSE streaming for the chat experience.
- **Stateless & lightweight:** matches the requirement that the UI hold no graph state.

**Alternative (throwaway only): Python + Streamlit.** Faster to prototype and has native chat
widgets, but it is a server-rendered Python app that **cannot be snapped into an existing
React/JS UI**. Recommend Streamlit only if the goal is a one-off internal demo with no reuse.

| Concern | Approach |
| --- | --- |
| Framework | React 18 + TypeScript, built with Vite |
| State | Lightweight store (Context/Zustand) for active tenant + pipeline state |
| Styling | Component library that mirrors the integrating UI (or headless + minimal CSS) |
| API client | Typed fetch wrapper; streaming via `fetch` + `ReadableStream` |
| Config | Backend base URLs (AutoGraph, Retrievers), token, tenant labels via env/config file |

### 6.2 Statelessness

The UI holds no graph state. All graph state, embeddings, and relationship persistence live
entirely in ArangoDB via the backend services. The only client state is ephemeral UI/session
state (active tenant, pipeline progress, chat transcript).

### 6.3 Performance & UX

- Stream chat responses incrementally for low perceived latency.
- Show explicit loading/progress for every async step; never leave the user guessing.
- Handle and surface backend errors (401/403/409/5xx) with actionable messaging.

### 6.4 Cross-origin (CORS)

The browser calls the Go gRPC-Gateway and the Retrievers service directly. CORS must be
configured on those services (or a thin dev proxy used) so the SPA can call them from the
browser. Document the chosen approach.

### 6.5 Configuration

No secrets committed to the (public) repo. Backend URLs and the demo JWT are provided via
local environment variables / a git-ignored config file, with an `.env.example` template.

---

## 7. Acceptance & Success Criteria

The prototype is successful if it executes the following script end to end against running
AutoGraph + Importer + Retrievers services, without backend code changes during the demo:

1. **Isolate ingestion.** For each of **Tenant A**, **Tenant B**, and **Tenant C**, upload that
   tenant's document set and run the full pipeline (build → strategize → orchestrate).
2. **Verify each tenant.** As each tenant in turn, ask *"Summarize my projects."* The answer
   reflects **only** that tenant's documents, and the UI shows the query was scoped to that
   tenant's `partition_ids`.
3. **Verify cross-tenant security (the key test).** While operating as one tenant, explicitly
   ask about a uniquely named project that exists only in **another** tenant's data (e.g. as
   Tenant B, ask about Tenant A's "Project Ironclad"). The agent responds that it has no
   relevant context — proving no cross-tenant leakage.
4. **Verify pairwise isolation.** Repeat step 3 across multiple tenant pairs (A↔B, B↔C, A↔C)
   to show isolation holds in every direction, not just one.

**Pass criteria:** all steps succeed, the partition scoping shown in the UI matches the active
tenant in every case, and every cross-tenant probe returns no content from the other tenant.

---

## 8. Test Data Plan

The prototype is exercised with three tenants' worth of generated, **fictional** documents.
Requirements for the test corpus:

- **Three disjoint document sets** (Tenant A, Tenant B, Tenant C) with **no overlapping entity
  names or topics**, so leakage is unambiguous to detect.
- Each set contains at least one **uniquely named project/entity** that appears in only that
  tenant's documents (used to drive the cross-tenant negative tests in §7).
- Energy-sector-themed but entirely fictional content (e.g., transmission grid planning,
  demand-side coordination, renewable project development). **No real organizations,
  customers, or proprietary data.**
- Plain `.txt` and `.pdf` formats to exercise both ingest paths.

The three tenants and their signature (uniquely scoped) entities:

| Tenant | Persona (fictional) | Domain | Signature entities (appear in this tenant only) |
| --- | --- | --- | --- |
| **Tenant A** | Northwind Grid Authority | Transmission grid operator | Project Ironclad, Mistral Substation, Cascadia North, Aurora Interconnect |
| **Tenant B** | Solara Energy Retail | Energy retailer / demand-side | Project Tidewatch, FlexPeak tariff, Sunbelt Metro, EcoReward |
| **Tenant C** | Verdant Power Developments | Renewable developer | Project Helios Fields, Dunesong, Windward Bluffs, Greenline PPA |

Generated documents live under `test-data/tenant-a/`, `test-data/tenant-b/`, and
`test-data/tenant-c/`. All names are invented; the corpus contains no real names or
confidential material, since the repository is public.

---

## 9. Out of Scope

- Production authentication, user management, or a real ABAC policy engine.
- Multi-user concurrency, scaling, or HA concerns.
- Persisting UI state across sessions.
- Provisioning/deploying the backend services (assumed already running).
- Any feature requiring backend code changes during the demo.

---

## 10. Risks, Assumptions & Open Questions

| # | Item | Type | Notes |
| --- | --- | --- | --- |
| 1 | All three services (AutoGraph, Importer, Retrievers) are deployed and reachable | Assumption | Required for the E2E script |
| 2 | A valid demo JWT with DB access is available | Assumption | Needed for every call |
| 3 | CORS is (or can be) enabled on the gateway + retrievers | Risk | Otherwise needs a dev proxy |
| 4 | Phase 2 `bind_params` per-request passing may need a retriever API change | Open question | Confirm before committing Phase 2 |
| 5 | Strategizer output reliably yields stable `rag_partition_id`s per module | Assumption | Drives the tenant→partition map |
| 6 | One-build/one-orchestration concurrency limit | Constraint | UI must serialize and surface 409s |

---

## 11. Glossary

- **Module** — Layer 1 isolation label set at ingest; the prototype maps one tenant to one module.
- **Corpus graph** — Layer 2 similarity/cluster graph built by AutoGraph.
- **Knowledge graph (KG)** — Layer 3 entity/relation graph built by the Importer, queried by Retrievers.
- **`rag_partition_id` / `partition_id`** — the partition key used to scope Layer 3 data and queries; one module can map to several.
- **Strategizer** — AutoGraph step that analyzes the corpus and produces `rags` records (and their partitions) before orchestration.
