#!/usr/bin/env python3
"""Delete orphaned GenAI services for this demo, keeping only the ones in use.

"In use" = the AutoGraph + Retriever instances whose postfix appears in the
current .env (VITE_*_BASE_URL). Everything else scoped to this demo's database /
GenAI project (superseded autograph/retriever instances and leftover importer
pods) is uninstalled so we don't leave spurious pods running on the cluster.

Scope is limited to dbName == ARANGO_DATABASE or genaiProjectName ==
VITE_GENAI_PROJECT_NAME, so it never touches unrelated services.

Usage:
    python scripts/cleanup_services.py          # show what would be deleted
    python scripts/cleanup_services.py --yes     # actually delete orphans
"""

from __future__ import annotations

import argparse
import json
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path

ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE


def load_env() -> dict[str, str]:
    env = {}
    for line in ENV_PATH.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def call(url: str, method: str, payload, token):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, context=SSL_CTX, timeout=30) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--yes", action="store_true", help="actually delete (default: dry run)")
    args = ap.parse_args()

    env = load_env()
    ep = env["ARANGO_ENDPOINT"].rstrip("/")
    db = env.get("ARANGO_DATABASE", "")
    project = env.get("VITE_GENAI_PROJECT_NAME", "")

    keep_postfixes = set()
    for key in ("VITE_AUTOGRAPH_BASE_URL", "VITE_RETRIEVERS_BASE_URL"):
        url = env.get(key, "").rstrip("/")
        if url:
            keep_postfixes.add(url.rsplit("/", 1)[-1])

    _, body = call(ep + "/_open/auth", "POST",
                   {"username": env.get("ARANGO_USERNAME", "root"),
                    "password": env.get("ARANGO_PASSWORD", "")}, None)
    token = json.loads(body)["jwt"]

    status, body = call(ep + "/gen-ai/v1/list_services", "POST", {}, token)
    if status != 200:
        sys.exit(f"list_services failed: {status} {body}")

    keep, delete = [], []
    for s in json.loads(body).get("services", []):
        sid = s.get("serviceId", "")
        if s.get("dbName") == db or s.get("genaiProjectName") == project:
            if any(sid.endswith(pf) for pf in keep_postfixes):
                keep.append(sid)
            else:
                delete.append(sid)

    print(f"db={db} project={project} keep_postfixes={sorted(keep_postfixes)}")
    print(f"KEEP ({len(keep)}): {keep}")
    print(f"DELETE ({len(delete)}): {delete}")

    if not delete:
        print("Nothing to clean up.")
        return
    if not args.yes:
        print("\n(dry run) re-run with --yes to delete the above.")
        return
    for sid in delete:
        s, b = call(f"{ep}/gen-ai/v1/service/{sid}", "DELETE", None, token)
        print(f"DELETE {sid}: {s} {b[:80]}")


if __name__ == "__main__":
    main()
