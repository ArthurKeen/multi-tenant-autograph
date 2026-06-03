import { useRef } from "react";
import type { StageStatus, TenantDef, TenantPipelineState } from "../types";

interface Props {
  tenant: TenantDef;
  state: TenantPipelineState;
  onFiles: (files: File[]) => void;
  onLoadSamples: () => void;
  hasSamples: boolean;
  onActivate: () => void;
  busy: boolean;
}

function Badge({ status }: { status: StageStatus }) {
  const labels: Record<StageStatus, string> = {
    idle: "—",
    running: "running…",
    done: "done",
    error: "error",
  };
  return <span className={`badge badge--${status}`}>{labels[status]}</span>;
}

export function PipelinePanel({
  tenant,
  state,
  onFiles,
  onLoadSamples,
  hasSamples,
  onActivate,
  busy,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const activated = state.orchestrate === "done";

  return (
    <section className="panel">
      <h2 className="panel__title">Onboard tenant — {tenant.label}</h2>
      <p className="panel__hint">
        Add this tenant's documents and click <strong>Ingest &amp; activate</strong>. That runs
        the full pipeline for <em>this tenant only</em>: upload → import → build → strategize →
        build knowledge graph. Repeat per tenant, then chat.
      </p>

      {hasSamples && (
        <div className="sample-row">
          <button className="secondary" disabled={busy} onClick={onLoadSamples}>
            Load sample docs ({tenant.label})
          </button>
          <span className="sample-row__hint">bundled from test-data/ — no file picking needed</span>
        </div>
      )}

      <div
        className="dropzone"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          onFiles(Array.from(e.dataTransfer.files));
        }}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".txt,.pdf"
          hidden
          onChange={(e) => onFiles(Array.from(e.target.files ?? []))}
        />
        {state.files.length > 0 ? (
          <ul className="filelist">
            {state.files.map((f) => (
              <li key={f.name}>
                {tenant.module}_{f.name}
              </li>
            ))}
          </ul>
        ) : state.fileNames.length > 0 ? (
          <ul className="filelist filelist--muted">
            {state.fileNames.map((n) => (
              <li key={n}>
                {tenant.module}_{n} <span className="muted-tag">(re-select to re-run)</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>Drop .txt / .pdf files here, or click to choose</p>
        )}
      </div>

      <ol className="steps">
        <li>
          File Manager upload <Badge status={state.fileManager} />
        </li>
        <li>
          AutoGraph import <Badge status={state.ingest} />
        </li>
        <li>
          Corpus build {state.buildId ? `(${state.buildId})` : ""} <Badge status={state.build} />
        </li>
        <li>
          RAG strategizer <Badge status={state.strategize} />
        </li>
        <li>
          Knowledge graph (orchestrate) <Badge status={state.orchestrate} />
        </li>
      </ol>

      <div className="actions">
        <button disabled={busy || state.files.length === 0 || activated} onClick={onActivate}>
          {activated
            ? `${tenant.label} activated \u2713`
            : busy
              ? "Working\u2026"
              : `Ingest & activate ${tenant.label}`}
        </button>
      </div>

      {state.detail && (
        <div className={`activity ${busy ? "activity--live" : ""}`}>
          {busy && <span className="spinner" />}
          <span>{state.detail}</span>
        </div>
      )}

      {state.log.length > 0 && <pre className="log">{state.log.join("\n")}</pre>}
    </section>
  );
}
