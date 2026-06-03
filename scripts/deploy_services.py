#!/usr/bin/env python3
"""Deploy the AutoGraph + GraphRAG Retriever services for the multi-tenant demo.

Reads connection details and API keys from the repo-root `.env`, authenticates
against ArangoDB (`/_open/auth`), creates a GenAI project, and installs both
services via the GenAI control plane (`/gen-ai/v1/...`). On success it prints the
resolved service base URLs (and writes them back into `.env`).

No secrets are hardcoded here; everything is read from `.env`. Safe to commit.

Usage:
    python scripts/deploy_services.py            # deploy + write URLs into .env
    python scripts/deploy_services.py --dry-run  # show payloads, deploy nothing
"""

from __future__ import annotations

import argparse
import json
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = REPO_ROOT / ".env"

SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    for line in ENV_PATH.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def request(method: str, url: str, payload: dict | None, token: str | None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, context=SSL_CTX, timeout=60) as r:
            body = r.read().decode()
            return r.status, body
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def authenticate(endpoint: str, username: str, password: str) -> str:
    status, body = request(
        "POST", f"{endpoint}/_open/auth",
        {"username": username, "password": password}, None,
    )
    if status != 200:
        sys.exit(f"Auth failed ({status}): {body}")
    jwt = json.loads(body).get("jwt")
    if not jwt:
        sys.exit(f"Auth response had no jwt: {body}")
    print(f"[ok] authenticated as {username}")
    return jwt


def create_project(endpoint: str, token: str, project: str, db: str) -> None:
    payload = {
        "project_name": project,
        "project_db_name": db,
        "project_type": "graphrag",
        "project_description": "Multi-tenant GraphRAG isolation demo",
    }
    status, body = request("POST", f"{endpoint}/gen-ai/v1/project", payload, token)
    if status == 200:
        print(f"[ok] project '{project}' created in db '{db}'")
    elif status == 400 and "exist" in body.lower():
        print(f"[ok] project '{project}' already exists; continuing")
    else:
        print(f"[warn] project create returned {status}: {body}")


def find_existing_service(endpoint: str, token: str, service_name: str, db: str) -> str | None:
    """Return the serviceId of an already-DEPLOYED service for this db, if any.

    Lets us REUSE pods instead of spinning up duplicates on every run.
    """
    status, body = request("POST", f"{endpoint}/gen-ai/v1/list_services", {}, token)
    if status != 200:
        return None
    for s in json.loads(body).get("services", []):
        sid = s.get("serviceId", "")
        if (
            sid.startswith(f"{service_name}-")
            and s.get("dbName") == db
            and s.get("status") == "DEPLOYED"
        ):
            return sid
    return None


def install_service(endpoint: str, token: str, service_name: str, env: dict) -> str:
    payload = {"service_name": service_name, "env": env}
    status, body = request("POST", f"{endpoint}/gen-ai/v1/service", payload, token)
    if status != 200:
        sys.exit(f"Install {service_name} failed ({status}): {body}")
    info = json.loads(body)
    service_id = info.get("service_id") or info.get("serviceInfo", {}).get("serviceId")
    if not service_id:
        sys.exit(f"Install {service_name} ok but no serviceId: {body}")
    print(f"[ok] installed {service_name} -> serviceId={service_id}")
    return service_id


def ensure_service(
    endpoint: str, token: str, service_name: str, env: dict, db: str, force: bool
) -> str:
    """Reuse an existing DEPLOYED service for this db unless --force is given."""
    if not force:
        existing = find_existing_service(endpoint, token, service_name, db)
        if existing:
            print(f"[reuse] {service_name} already deployed for '{db}' -> {existing}")
            return existing
    return install_service(endpoint, token, service_name, env)


def health(endpoint: str, token: str, base_path: str, attempts: int = 30) -> bool:
    url = f"{endpoint}{base_path}/v1/health"
    for i in range(attempts):
        status, _ = request("GET", url, None, token)
        if status == 200:
            print(f"[ok] healthy: {url}")
            return True
        time.sleep(5)
    print(f"[warn] not healthy yet after {attempts * 5}s: {url} (last status {status})")
    return False


def write_env_url(key: str, value: str) -> None:
    text = ENV_PATH.read_text()
    pattern = rf"(?m)^{re.escape(key)}=.*$"
    if re.search(pattern, text):
        text = re.sub(pattern, f"{key}={value}", text)
    else:
        text += f"\n{key}={value}\n"
    ENV_PATH.write_text(text)
    print(f"[ok] wrote {key} into .env")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Install new service instances even if ones already exist for this db "
        "(use only when you must clear a stuck in-memory lock). Otherwise pods are reused.",
    )
    args = parser.parse_args()

    env = load_env()
    endpoint = env["ARANGO_ENDPOINT"].rstrip("/")
    db = env.get("ARANGO_DATABASE", "multitenant_demo")
    project = env.get("VITE_GENAI_PROJECT_NAME", db)
    openai_key = env.get("OPENAI_API_KEY", "")
    chat_model = env.get("LLM_EXTRACTION_MODEL", "gpt-4o")
    embedding_model = env.get("EMBEDDING_MODEL", "text-embedding-3-small")
    embedding_dim = env.get("EMBEDDING_DIM", "1536")

    if not openai_key:
        sys.exit("OPENAI_API_KEY is not set in .env")

    autograph_env = {
        "genai_project_name": project,
        "db_name": db,
        "chat_api_provider": "openai",
        "chat_model": chat_model,
        "chat_api_key": openai_key,
        "embedding_api_provider": "openai",
        "embedding_api_key": openai_key,
        "embedding_model_name": embedding_model,
    }
    retriever_env = {
        "genai_project_name": project,
        "db_name": db,
        "chat_api_provider": "openai",
        "chat_model": chat_model,
        "chat_api_key": openai_key,
        "chat_api_url": "https://api.openai.com/v1",
        "embedding_api_provider": "openai",
        "embedding_api_key": openai_key,
        "embedding_api_url": "https://api.openai.com/v1",
        "embedding_model": embedding_model,
        "embedding_dim": embedding_dim,
    }

    def redact(d: dict) -> dict:
        return {k: ("***" if "key" in k else v) for k, v in d.items()}

    print(f"endpoint={endpoint} db={db} project={project}")
    print("autograph env:", json.dumps(redact(autograph_env)))
    print("retriever env:", json.dumps(redact(retriever_env)))

    if args.dry_run:
        print("[dry-run] not deploying")
        return

    token = authenticate(endpoint, env.get("ARANGO_USERNAME", "root"),
                         env.get("ARANGO_PASSWORD", ""))
    create_project(endpoint, token, project, db)

    ag_id = ensure_service(endpoint, token, "arangodb-autograph", autograph_env, db, args.force)
    rt_id = ensure_service(
        endpoint, token, "arangodb-graphrag-retriever", retriever_env, db, args.force
    )

    ag_base = f"/autograph/{ag_id[-5:]}"
    rt_base = f"/graphrag/retriever/{rt_id[-5:]}"
    print(f"\nResolved (postfix = last 5 of serviceId):")
    print(f"  AutoGraph : {endpoint}{ag_base}")
    print(f"  Retriever : {endpoint}{rt_base}")

    print("\nWaiting for services to become healthy (this can take a few minutes)...")
    health(endpoint, token, ag_base)
    health(endpoint, token, rt_base)

    write_env_url("VITE_AUTOGRAPH_BASE_URL", f"{endpoint}{ag_base}")
    write_env_url("VITE_RETRIEVERS_BASE_URL", f"{endpoint}{rt_base}")
    print("\nDone.")


if __name__ == "__main__":
    main()
