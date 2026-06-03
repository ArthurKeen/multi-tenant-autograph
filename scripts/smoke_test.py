#!/usr/bin/env python3
"""End-to-end smoke test for the multi-tenant GraphRAG isolation demo.

Runs the real pipeline against the deployed services (URLs + creds from .env):

  ingest (Tenant A + B) -> corpus build -> strategizer -> orchestrate -> query

and finishes with isolation checks (a query scoped to Tenant B must not surface
Tenant A's "Project Ironclad").

Stages can be limited with --stop-after {ingest,build,strategize,orchestrate,query}.
"""

from __future__ import annotations

import argparse
import base64
import json
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = REPO_ROOT / ".env"
TEST_DATA = REPO_ROOT / "test-data"

SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE

STAGES = ["ingest", "build", "strategize", "orchestrate", "query"]


def g(d, *keys):
    """Get the first present key (REST responses are camelCase, proto is snake)."""
    for k in keys:
        if k in d:
            return d[k]
    return None


def load_env() -> dict[str, str]:
    env = {}
    for line in ENV_PATH.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def req(method, url, payload, token, timeout=120):
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(r, context=SSL_CTX, timeout=timeout) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except Exception as e:  # noqa: BLE001
        return 0, repr(e)


def fm_upload(endpoint, token, db, name, content: bytes):
    """Upload one RAG input to the platform File Manager (multipart)."""
    boundary = "----smoke" + str(int(time.time() * 1000))
    parts = []
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"name\"\r\n\r\n{name}\r\n")
    parts.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
        f"filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
    )
    body = b"".join(p.encode() for p in parts) + content + f"\r\n--{boundary}--\r\n".encode()
    url = f"{endpoint.rstrip('/')}/_platform/filemanager/_db/{db}/rag-input"
    r = urllib.request.Request(url, data=body, method="POST")
    r.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    r.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(r, context=SSL_CTX, timeout=120) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def upload_to_file_manager(endpoint, token, db, module, folder):
    n = 0
    for p in sorted((TEST_DATA / folder).glob("*.txt")):
        name = f"{module}_{p.name}"  # globally unique basename -> no cross-tenant collision
        s, b = fm_upload(endpoint, token, db, name, p.read_bytes())
        if s not in (200, 201):
            sys.exit(f"file-manager upload failed for {name}: {s} {b[:200]}")
        n += 1
    print(f"[file-manager:{module}] uploaded {n} RAG inputs to db '{db}'")


def auth(env) -> str:
    s, b = req("POST", f"{env['ARANGO_ENDPOINT'].rstrip('/')}/_open/auth",
               {"username": env.get("ARANGO_USERNAME", "root"),
                "password": env.get("ARANGO_PASSWORD", "")}, None)
    if s != 200:
        sys.exit(f"auth failed {s}: {b}")
    print("[ok] authenticated")
    return json.loads(b)["jwt"]


def ingest(ag, token, module, folder):
    files = []
    for p in sorted((TEST_DATA / folder).glob("*.txt")):
        name = f"{module}_{p.name}"  # must match the File Manager basename
        files.append({
            "doc_name": name,
            "content": base64.b64encode(p.read_bytes()).decode(),
            "citable_url": f"https://example.test/{folder}/{p.name}",
        })
    s, b = req("POST", f"{ag}/v1/import-multiple", {"files": files, "module": module}, token)
    print(f"[ingest:{module}] {s} {b[:200]}  ({len(files)} files)")
    if s != 200:
        sys.exit(f"ingest failed for {module}")


def build(ag, token, modules=None):
    # incremental=False with an explicit single-module `modules` list cleans+rebuilds
    # only that module; modules not listed are preserved. This is the multi-module
    # pattern: import+build each module separately (a fresh import wipes disk staging,
    # but each module is already committed to the corpus DB by its own build).
    body = {"embedding_strategy": "first_chunk",
            "strategy": {"top_k": 7, "cluster_threshold": 2},
            "incremental": False}
    if modules:
        body["modules"] = modules
    s, b = req("POST", f"{ag}/v1/corpus/builds", body, token)
    print(f"[build:create modules={modules}] {s} {b[:300]}")
    if s != 200:
        sys.exit("corpus build creation failed")
    bid = g(json.loads(b), "corpusBuildId", "corpus_build_id")
    for _ in range(120):
        s, b = req("GET", f"{ag}/v1/corpus/builds/{bid}", None, token)
        try:
            j = json.loads(b)
        except Exception:  # noqa: BLE001
            j = {}
        status = j.get("status", "?")
        print(f"[build:{bid}] {status} {j.get('progress','')}% {j.get('message','')}")
        if status == "completed":
            return
        if status == "failed":
            sys.exit(f"build failed: {j.get('error') or b}")
        time.sleep(8)
    sys.exit("build did not complete in time")


def strategize(ag, token):
    s, b = req("POST", f"{ag}/v1/rag-strategizer/analyze",
               {"full_graph_rag_strategy": "very high"}, token)
    print(f"[strategize:start] {s} {b[:200]}")
    if s != 200:
        sys.exit("strategizer failed to start")
    for _ in range(120):
        time.sleep(8)
        s, b = req("GET", f"{ag}/v1/rag-strategizer/strategy", None, token)
        try:
            j = json.loads(b)
        except Exception:  # noqa: BLE001
            continue
        strategies = j.get("strategies", [])
        if strategies:
            print(f"[strategize] {len(strategies)} strategies:")
            for st in strategies:
                print(f"    cluster={g(st,'clusterId','cluster_id')} "
                      f"type={g(st,'strategyType','strategy_type')} "
                      f"partition={g(st,'ragPartitionId','rag_partition_id')} "
                      f"docs={g(st,'documentCount','document_count')}")
            return strategies
    sys.exit("no strategies produced in time")


def partitions_for(strategies, module):
    out = []
    for st in strategies:
        cid = g(st, "clusterId", "cluster_id") or ""
        pid = g(st, "ragPartitionId", "rag_partition_id")
        if module in cid and pid:
            out.append(pid)
    return out


def orchestrate(ag, token, openai_key):
    s, b = req("POST", f"{ag}/v1/orchestrate",
               {"replicas": 2, "max_retries": 3, "chat_api_keys": [openai_key]}, token)
    print(f"[orchestrate] {s} {b[:300]}")
    if s != 200:
        sys.exit("orchestration failed to start")


def query(rt, token, q, partition_ids, qtype=2):  # 2=Local search (entity-level, supports partition filter + citations)
    body = {"query": q, "query_type": qtype, "include_metadata": False}
    if partition_ids:
        body["partition_ids"] = partition_ids
    return req("POST", f"{rt}/v1/graphrag-query", body, token, timeout=180)


def wait_and_query(rt, token, partitions_a, partitions_b, max_wait_s=600):
    """Poll until the KG is queryable, then run isolation checks."""
    print(f"\n[query] tenant_a partitions={partitions_a}  tenant_b partitions={partitions_b}")
    if not partitions_a or not partitions_b:
        print("[query] ERROR: missing partitions for a tenant; both modules must build. Aborting.")
        return
    deadline = time.time() + max_wait_s
    ironclad = "What is Project Ironclad? Answer briefly."
    while time.time() < deadline:
        s, b = query(rt, token, ironclad, partitions_a)
        snippet = b[:240].replace("\n", " ")
        print(f"[query:A/ironclad] {s} {snippet}")
        if s == 200 and "ironclad" in b.lower():
            break
        time.sleep(20)
    else:
        print("[query] WARNING: Tenant A never returned Ironclad content; KG may still be building.")
        return

    print("\n=== ISOLATION CHECKS ===")
    s, b = query(rt, token, ironclad, partitions_b)
    a_leak = "ironclad" in b.lower() or "mistral" in b.lower()
    print(f"[A->B isolation] status={s} leak={a_leak}\n    {b[:300]}")

    s, b = query(rt, token, "What is Project Tidewatch? Answer briefly.", partitions_b)
    b_ok = "tidewatch" in b.lower() or "flexpeak" in b.lower()
    print(f"[B positive] status={s} found_tidewatch={b_ok}\n    {b[:300]}")

    print("\n=== RESULT ===")
    print("PASS" if (not a_leak and b_ok) else "REVIEW NEEDED",
          "| A->B leak:", a_leak, "| B positive:", b_ok)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stop-after", choices=STAGES, default="query")
    ap.add_argument("--query-only", action="store_true",
                    help="Skip ingest/build/orchestrate; query the already-built KG.")
    args = ap.parse_args()

    env = load_env()
    ag = env["VITE_AUTOGRAPH_BASE_URL"].rstrip("/")
    rt = env["VITE_RETRIEVERS_BASE_URL"].rstrip("/")
    openai_key = env.get("OPENAI_API_KEY", "")
    if not ag or not rt:
        sys.exit("VITE_AUTOGRAPH_BASE_URL / VITE_RETRIEVERS_BASE_URL not set in .env")

    token = auth(env)
    endpoint = env["ARANGO_ENDPOINT"]
    db = env.get("ARANGO_DATABASE", "multitenant_demo")
    mod_a = env.get("VITE_TENANT_A_MODULE", "tenant_a")
    mod_b = env.get("VITE_TENANT_B_MODULE", "tenant_b")
    print(f"autograph={ag}\nretriever={rt}")

    if args.query_only:
        s, b = req("GET", f"{ag}/v1/rag-strategizer/strategy", None, token)
        strategies = json.loads(b).get("strategies", [])
        pa = partitions_for(strategies, mod_a)
        pb = partitions_for(strategies, mod_b)
        wait_and_query(rt, token, pa, pb, max_wait_s=60)
        return

    upload_to_file_manager(endpoint, token, db, mod_a, "tenant-a")
    upload_to_file_manager(endpoint, token, db, mod_b, "tenant-b")
    # Import + build each module separately so both survive (see build() docstring).
    ingest(ag, token, mod_a, "tenant-a")
    if args.stop_after == "ingest":
        ingest(ag, token, mod_b, "tenant-b")
        return
    build(ag, token, modules=[mod_a])
    ingest(ag, token, mod_b, "tenant-b")
    build(ag, token, modules=[mod_b])
    if args.stop_after == "build":
        return

    strategies = strategize(ag, token)
    pa = partitions_for(strategies, env.get("VITE_TENANT_A_MODULE", "tenant_a"))
    pb = partitions_for(strategies, env.get("VITE_TENANT_B_MODULE", "tenant_b"))
    if args.stop_after == "strategize":
        return

    orchestrate(ag, token, openai_key)
    if args.stop_after == "orchestrate":
        return

    wait_and_query(rt, token, pa, pb)


if __name__ == "__main__":
    main()
