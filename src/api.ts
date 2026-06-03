import type { Strategy } from "./types";
import { QUERY_TYPE_LOCAL } from "./config";

/**
 * All requests target same-origin /api/* routes. The Vite dev proxy
 * (see vite.config.ts) mints the JWT, injects Authorization, and forwards to
 * AutoGraph (/api/ag), the Retriever (/api/rt), and File Manager (/api/fm).
 * Responses come back camelCase (PRD §2.3 #6).
 */

async function ag<T>(path: string, body?: unknown, method = "POST"): Promise<T> {
  const res = await fetch(`/api/ag/${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? (JSON.parse(text) as T) : ({} as T);
}

/** Prefix the tenant module so basenames are globally unique (PRD §2.3 #3). */
export function scopedName(module: string, fileName: string): string {
  return `${module}_${fileName}`;
}

export async function fileManagerUpload(name: string, file: File): Promise<void> {
  const form = new FormData();
  form.append("name", name);
  form.append("file", new File([file], name, { type: file.type || "text/plain" }));
  const res = await fetch("/api/fm/rag-input", { method: "POST", body: form });
  if (!res.ok && res.status !== 201) {
    throw new Error(`file-manager upload ${name} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

export async function importMultiple(module: string, files: File[]): Promise<void> {
  const encoded = await Promise.all(
    files.map(async (f) => ({
      doc_name: scopedName(module, f.name),
      content: await toBase64(f),
      citable_url: `https://example.test/${module}/${f.name}`,
    })),
  );
  await ag("v1/import-multiple", { files: encoded, module });
}

export async function createBuild(modules: string[]): Promise<string> {
  // incremental:false + single-module list rebuilds only that module (PRD §2.3 #4).
  const r = await ag<{ corpusBuildId?: string; corpus_build_id?: string }>(
    "v1/corpus/builds",
    {
      embedding_strategy: "first_chunk",
      strategy: { top_k: 7, cluster_threshold: 2 },
      incremental: false,
      modules,
    },
  );
  const id = r.corpusBuildId || r.corpus_build_id;
  if (!id) throw new Error("build did not return a corpusBuildId");
  return id;
}

export interface BuildStatus {
  status: string;
  progress?: number;
  message?: string;
  error?: string;
}

export function getBuild(id: string): Promise<BuildStatus> {
  return ag<BuildStatus>(`v1/corpus/builds/${id}`, undefined, "GET");
}

export async function strategize(): Promise<void> {
  await ag("v1/rag-strategizer/analyze", { full_graph_rag_strategy: "very high" });
}

interface StrategyResponse {
  strategies?: Array<Record<string, unknown>>;
}

export async function getStrategies(): Promise<Strategy[]> {
  const r = await ag<StrategyResponse>("v1/rag-strategizer/strategy", undefined, "GET");
  return (r.strategies || []).map((s) => ({
    clusterId: String(s.clusterId ?? s.cluster_id ?? ""),
    strategyType: String(s.strategyType ?? s.strategy_type ?? ""),
    ragPartitionId: String(s.ragPartitionId ?? s.rag_partition_id ?? ""),
    documentCount: Number(s.documentCount ?? s.document_count ?? 0),
  }));
}

export async function orchestrate(partitionIds?: string[]): Promise<void> {
  // chat_api_keys are injected server-side by the dev proxy (vite.config.ts).
  const body: Record<string, unknown> = { replicas: 2, max_retries: 3 };
  if (partitionIds && partitionIds.length) body.partition_ids = partitionIds;
  await ag("v1/orchestrate", body);
}

export interface KgStatus {
  layer3Exists: boolean;
  byPartition: Record<string, { documents: number; entities: number }>;
}

export async function getKgStatus(): Promise<KgStatus> {
  const res = await fetch("/api/admin/kg-status");
  if (!res.ok) return { layer3Exists: false, byPartition: {} };
  return (await res.json()) as KgStatus;
}

export async function resetDatabase(): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch("/api/admin/reset", { method: "POST" });
  const j = (await res.json()) as { ok?: boolean; detail?: string; error?: string };
  if (!res.ok || !j.ok) throw new Error(j.error || j.detail || `reset failed (${res.status})`);
  return { ok: true, detail: j.detail || "" };
}

export async function graphragQuery(
  query: string,
  partitionIds: string[],
): Promise<string> {
  const res = await fetch("/api/rt/v1/graphrag-query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      query_type: QUERY_TYPE_LOCAL,
      partition_ids: partitionIds,
      include_metadata: false,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`query -> ${res.status}: ${text.slice(0, 200)}`);
  try {
    return (JSON.parse(text) as { result?: string }).result ?? text;
  } catch {
    return text;
  }
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
