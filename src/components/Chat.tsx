import { useState } from "react";
import type { ChatMessage, TenantDef } from "../types";

interface Props {
  tenant: TenantDef;
  partitionIds: string[];
  messages: ChatMessage[];
  busy: boolean;
  onSend: (text: string) => void;
  kg: { documents: number; entities: number; communities: number };
  orchestrating: boolean;
  awaiting: boolean;
}

export function Chat({
  tenant,
  partitionIds,
  messages,
  busy,
  onSend,
  kg,
  orchestrating,
  awaiting,
}: Props) {
  const [text, setText] = useState("");
  const hasPartitions = partitionIds.length > 0;
  // Query-ready only once communities exist (entity embeddings/index are done by then).
  const kgReady = kg.communities > 0;
  const ready = hasPartitions && kgReady;

  let kgState: { cls: string; text: string };
  if (!hasPartitions) {
    kgState = { cls: "idle", text: "not built yet — onboard this tenant first" };
  } else if (kgReady) {
    kgState = {
      cls: "ready",
      text: `ready · ${kg.entities} entities, ${kg.communities} communities, ${kg.documents} docs`,
    };
  } else if (kg.entities > 0) {
    kgState = {
      cls: "running",
      text: `finalizing — building embeddings & communities… (${kg.entities} entities, not queryable yet)`,
    };
  } else if (orchestrating) {
    kgState = { cls: "running", text: "building knowledge graph…" };
  } else {
    kgState = { cls: "idle", text: "not built yet — onboard this tenant first" };
  }

  return (
    <section className="panel chat">
      <h2 className="panel__title">Chat — {tenant.label}</h2>
      <div className="kg-status">
        <span className={`kg-dot kg-dot--${kgState.cls}`} />
        <span className="kg-status__label">Knowledge graph:</span>
        <span className="kg-status__text">{kgState.text}</span>
      </div>
      <div className="chat__scope">
        scoped to partitions:{" "}
        {hasPartitions ? (
          partitionIds.map((p) => (
            <code key={p} className="chip">
              {p}
            </code>
          ))
        ) : (
          <em>none yet — onboard this tenant first</em>
        )}
      </div>

      {ready && (
        <div className="suggestions">
          <div className="suggestions__group">
            <span className="suggestions__label">Try ({tenant.label}'s data)</span>
            <div className="suggestions__chips">
              {tenant.ownQuestions.map((q) => (
                <button
                  key={q}
                  className="suggestion"
                  disabled={busy}
                  onClick={() => onSend(q)}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
          <div className="suggestions__group">
            <span className="suggestions__label suggestions__label--probe">
              Isolation probes (should return nothing)
            </span>
            <div className="suggestions__chips">
              {tenant.isolationProbes.map((q) => (
                <button
                  key={q}
                  className="suggestion suggestion--probe"
                  disabled={busy}
                  onClick={() => onSend(q)}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="chat__log">
        {messages.length === 0 && (
          <p className="muted">
            Ask about this tenant's projects, or click a suggestion above. The{" "}
            <strong>isolation probes</strong> ask {tenant.label} about other tenants' projects —
            they should return "no relevant data".
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`bubble bubble--${m.role}`}>
            <div className="bubble__text">{m.text}</div>
            {m.partitionIds && (
              <div className="bubble__scope">scoped: {m.partitionIds.join(", ") || "(all)"}</div>
            )}
          </div>
        ))}
        {awaiting && (
          <div className="bubble bubble--assistant bubble--thinking">
            <span className="dots">
              <span />
              <span />
              <span />
            </span>
            <span className="thinking-text">Searching the knowledge graph… (can take ~30s)</span>
          </div>
        )}
      </div>

      <form
        className="chat__input"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim() && ready && !busy) {
            onSend(text.trim());
            setText("");
          }
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={ready ? "Ask a question…" : "Pipeline not ready"}
          disabled={!ready || busy}
        />
        <button type="submit" disabled={!ready || busy || !text.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}
