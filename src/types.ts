export interface TenantDef {
  id: string;
  label: string;
  module: string;
  /** Questions about this tenant's own documents (should return rich answers). */
  ownQuestions: string[];
  /** Cross-tenant probes about OTHER tenants (should return "no relevant data"). */
  isolationProbes: string[];
}

export type StageStatus = "idle" | "running" | "done" | "error";

export interface TenantPipelineState {
  files: File[];
  fileNames: string[];
  fileManager: StageStatus;
  ingest: StageStatus;
  build: StageStatus;
  strategize: StageStatus;
  orchestrate: StageStatus;
  buildId?: string;
  detail: string;
  log: string[];
}

export interface Strategy {
  clusterId: string;
  strategyType: string;
  ragPartitionId: string;
  documentCount: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  partitionIds?: string[];
}
