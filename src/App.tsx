import { useEffect, useMemo, useState } from "react";
import { TENANTS } from "./config";
import type { ChatMessage, Strategy, TenantPipelineState } from "./types";
import { TenantSelector } from "./components/TenantSelector";
import { PipelinePanel } from "./components/PipelinePanel";
import { Chat } from "./components/Chat";
import { sampleFiles, hasSamples } from "./samples";
import {
  createBuild,
  fileManagerUpload,
  getBuild,
  getKgStatus,
  getStrategies,
  graphragQuery,
  importMultiple,
  orchestrate,
  resetDatabase,
  scopedName,
  strategize,
  type KgStatus,
} from "./api";

const emptyPipeline = (): TenantPipelineState => ({
  files: [],
  fileNames: [],
  fileManager: "idle",
  ingest: "idle",
  build: "idle",
  strategize: "idle",
  orchestrate: "idle",
  detail: "",
  log: [],
});

const STORAGE_KEY = "mt-graphrag-pipelines";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loadPersisted(): Record<string, TenantPipelineState> {
  const base = Object.fromEntries(TENANTS.map((t) => [t.id, emptyPipeline()]));
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    for (const t of TENANTS) {
      if (saved[t.id]) base[t.id] = { ...emptyPipeline(), ...saved[t.id], files: [] };
    }
  } catch {
    /* ignore */
  }
  return base;
}

export default function App() {
  const [activeId, setActiveId] = useState(TENANTS[0].id);
  const [pipelines, setPipelines] = useState<Record<string, TenantPipelineState>>(loadPersisted);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({});
  const [busy, setBusy] = useState(false);
  const [awaiting, setAwaiting] = useState(false);
  const [kg, setKg] = useState<KgStatus>({ layer3Exists: false, byPartition: {} });

  const tenant = TENANTS.find((t) => t.id === activeId)!;
  const pipeline = pipelines[activeId];

  useEffect(() => {
    getStrategies()
      .then((s) => s.length && setStrategies(s))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const serializable = Object.fromEntries(
      Object.entries(pipelines).map(([id, p]) => [id, { ...p, files: [] }]),
    );
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
  }, [pipelines]);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      getKgStatus()
        .then((s) => alive && setKg(s))
        .catch(() => {});
    tick();
    const id = setInterval(tick, 6000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const partitionIds = useMemo(
    () =>
      strategies
        .filter((s) => s.clusterId.includes(tenant.module))
        .map((s) => s.ragPartitionId),
    [strategies, tenant.module],
  );

  const kgForTenant = useMemo(
    () =>
      partitionIds.reduce(
        (acc, p) => {
          const c = kg.byPartition[p];
          if (c) {
            acc.documents += c.documents;
            acc.entities += c.entities;
          }
          return acc;
        },
        { documents: 0, entities: 0 },
      ),
    [kg, partitionIds],
  );

  function patch(id: string, p: Partial<TenantPipelineState>) {
    setPipelines((prev) => ({ ...prev, [id]: { ...prev[id], ...p } }));
  }

  function setFiles(id: string, files: File[]) {
    patch(id, {
      files,
      fileNames: files.map((f) => f.name),
      fileManager: "idle",
      ingest: "idle",
      build: "idle",
      strategize: "idle",
      orchestrate: "idle",
      detail: "",
      buildId: undefined,
    });
  }
  function logLine(id: string, line: string) {
    const stamp = new Date().toLocaleTimeString();
    setPipelines((prev) => ({
      ...prev,
      [id]: { ...prev[id], log: [...prev[id].log, `${stamp}  ${line}`] },
    }));
  }

  /** Full per-tenant pipeline: FM upload -> import -> build -> strategize -> orchestrate (scoped). */
  async function runActivate() {
    const id = activeId;
    const { module, label } = tenant;
    const files = pipelines[id].files;
    if (!files.length) return;

    const t0 = Date.now();
    const el = () => Math.round((Date.now() - t0) / 1000);
    const detail = (d: string) => patch(id, { detail: d });

    setBusy(true);
    patch(id, {
      fileManager: "running",
      ingest: "idle",
      build: "idle",
      strategize: "idle",
      orchestrate: "idle",
    });
    try {
      // 1. File Manager
      detail("Uploading documents to File Manager…");
      for (const f of files) {
        await fileManagerUpload(scopedName(module, f.name), f);
        logLine(id, `file-manager: uploaded ${scopedName(module, f.name)}`);
      }
      patch(id, { fileManager: "done", ingest: "running" });

      // 2. Import
      detail("Importing documents into AutoGraph…");
      await importMultiple(module, files);
      logLine(id, `import: ${files.length} files into module '${module}'`);
      patch(id, { ingest: "done", build: "running" });

      // 3. Corpus build (poll progress)
      const buildId = await createBuild([module]);
      patch(id, { buildId });
      logLine(id, `corpus build: ${buildId}`);
      let built = false;
      for (let i = 0; i < 200; i++) {
        const st = await getBuild(buildId);
        detail(`Building corpus graph… ${st.progress ?? 0}% — ${st.message ?? ""} (${el()}s)`);
        if (st.status === "completed") {
          built = true;
          break;
        }
        if (st.status === "failed") {
          logLine(id, `corpus build FAILED: ${st.error || st.message}`);
          patch(id, { build: "error", detail: "Corpus build failed." });
          setBusy(false);
          return;
        }
        await sleep(3000);
      }
      if (!built) {
        patch(id, { build: "error", detail: "Corpus build timed out." });
        setBusy(false);
        return;
      }
      logLine(id, "corpus build: completed");
      patch(id, { build: "done", strategize: "running" });

      // 4. Strategize (corpus-wide but incremental; wait for THIS tenant's partitions)
      detail("Strategizing: LLM is generating per-cluster ontology & RAG strategy…");
      await strategize();
      let parts: string[] = [];
      for (let i = 0; i < 120; i++) {
        await sleep(4000);
        const strat = await getStrategies();
        parts = strat.filter((s) => s.clusterId.includes(module)).map((s) => s.ragPartitionId);
        detail(`Strategizing… ${el()}s elapsed — found ${parts.length} partition(s) for ${label}`);
        if (parts.length) {
          setStrategies(strat);
          break;
        }
      }
      if (!parts.length) {
        logLine(id, "strategizer: no partitions produced");
        patch(id, { strategize: "error", detail: "Strategizer produced no partitions." });
        setBusy(false);
        return;
      }
      logLine(id, `strategizer: partitions ${parts.join(", ")}`);
      patch(id, { strategize: "done", orchestrate: "running" });

      // 5. Orchestrate — scoped to THIS tenant's partitions only
      detail("Orchestrating: spawning importer to build the knowledge graph…");
      await orchestrate(parts);
      logLine(id, `orchestrate: started for ${parts.join(", ")}`);
      let ready = false;
      for (let i = 0; i < 240; i++) {
        await sleep(5000);
        const ks = await getKgStatus();
        setKg(ks);
        const ent = parts.reduce((a, p) => a + (ks.byPartition[p]?.entities || 0), 0);
        const docs = parts.reduce((a, p) => a + (ks.byPartition[p]?.documents || 0), 0);
        detail(`Building knowledge graph… ${el()}s elapsed — ${ent} entities, ${docs} docs`);
        if (ent > 0) {
          ready = true;
          break;
        }
      }
      if (ready) {
        logLine(id, "knowledge graph: ready");
        patch(id, { orchestrate: "done", detail: `${label} is ready — chat now.` });
      } else {
        logLine(id, "knowledge graph: still building after timeout");
        patch(id, {
          orchestrate: "error",
          detail: "Knowledge graph did not finish in time (orchestration may be slow/stuck).",
        });
      }
    } catch (e) {
      logLine(id, `ERROR: ${String(e)}`);
      patch(id, { detail: `Error: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  }

  async function handleReset() {
    if (
      !window.confirm(
        "Reset the demo database? This drops ALL ingested data and built graphs for every tenant.",
      )
    )
      return;
    setBusy(true);
    try {
      await resetDatabase();
      localStorage.removeItem(STORAGE_KEY);
      setPipelines(Object.fromEntries(TENANTS.map((t) => [t.id, emptyPipeline()])));
      setStrategies([]);
      setKg({ layer3Exists: false, byPartition: {} });
      setMessages({});
    } catch (e) {
      patch(activeId, { detail: `reset error: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  }

  async function sendChat(text: string) {
    const id = activeId;
    const ids = partitionIds;
    setMessages((m) => ({ ...m, [id]: [...(m[id] || []), { role: "user", text }] }));
    setBusy(true);
    setAwaiting(true);
    try {
      const answer = await graphragQuery(text, ids);
      setMessages((m) => ({
        ...m,
        [id]: [...(m[id] || []), { role: "assistant", text: answer, partitionIds: ids }],
      }));
    } catch (e) {
      setMessages((m) => ({
        ...m,
        [id]: [
          ...(m[id] || []),
          { role: "assistant", text: `Error: ${String(e)}`, partitionIds: ids },
        ],
      }));
    } finally {
      setBusy(false);
      setAwaiting(false);
    }
  }

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <h1>Multi-Tenant GraphRAG Isolation Prototype</h1>
          <p className="subtitle">
            Prove that documents ingested by different tenants stay isolated in a shared
            knowledge graph.
          </p>
        </div>
        <div className="header__right">
          <TenantSelector tenants={TENANTS} activeId={activeId} onChange={setActiveId} />
          <button className="reset-btn" onClick={handleReset} disabled={busy}>
            Reset database
          </button>
        </div>
      </header>

      <main className="app__grid">
        <PipelinePanel
          tenant={tenant}
          state={pipeline}
          busy={busy}
          onFiles={(files) => setFiles(activeId, files)}
          onLoadSamples={() => setFiles(activeId, sampleFiles(activeId))}
          hasSamples={hasSamples(activeId)}
          onActivate={runActivate}
        />
        <Chat
          tenant={tenant}
          partitionIds={partitionIds}
          messages={messages[activeId] || []}
          busy={busy}
          onSend={sendChat}
          kg={kgForTenant}
          orchestrating={pipeline.orchestrate === "running"}
          awaiting={awaiting}
        />
      </main>
    </div>
  );
}
