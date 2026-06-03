# Multi-Tenant Test Document Sets

Fictional, energy-sector-themed document sets used to exercise tenant data isolation in the
GraphRAG prototype. **Everything here is invented.** There are no real organizations,
people, customers, or proprietary data — the repository is public.

Each tenant maps to a `module` at ingest time (see the project `.env`). The three sets are
**disjoint**: no shared project names, sites, people, or topics. That makes cross-tenant
leakage trivial to detect — if a query issued as one tenant ever surfaces another tenant's
signature entity, isolation has failed.

## Tenants

| Folder | Persona (fictional) | Domain | Signature entities (this tenant only) |
| --- | --- | --- | --- |
| `tenant-a/` | Northwind Grid Authority | Transmission grid operator | Project Ironclad, Mistral Substation, Cascadia North, Aurora Interconnect, Dana Holloway |
| `tenant-b/` | Solara Energy Retail | Energy retailer / demand-side | Project Tidewatch, FlexPeak tariff, Sunbelt Metro, EcoReward, Marcus Okafor |
| `tenant-c/` | Verdant Power Developments | Renewable developer | Project Helios Fields, Dunesong, Windward Bluffs, Greenline PPA, Priya Raman |

Each folder contains:
1. `01-organization-overview.txt` — who the tenant is and its key assets/programs.
2. `02-project-*.txt` — a deep dive on the tenant's flagship project.
3. `03-*.txt` — a quarterly report / brief reinforcing the same entities.

## How to use in the demo

For each tenant, ingest its folder with the matching `module` value, then run the pipeline
(build → strategize → orchestrate) before chatting. See the project `PRD.md` (Sections 2 and
7) for the full workflow and acceptance script.

## Isolation probes (the key test)

After ingesting all three tenants, switch personas and confirm each probe returns **no**
content from the other tenant:

- As **Tenant B**, ask about **Project Ironclad** → expect "no relevant context".
- As **Tenant C**, ask about the **FlexPeak tariff** → expect "no relevant context".
- As **Tenant A**, ask about **Project Helios Fields** → expect "no relevant context".

Positive control — as the owning tenant, the same question should return a rich answer.

## Generating PDFs (optional)

The source documents are `.txt`. To also exercise the PDF ingest path, generate PDFs from
the text files:

```bash
python test-data/generate_pdfs.py
```

This writes a `.pdf` next to each `.txt`. Generated PDFs are gitignored (regenerate as
needed). The script requires `reportlab` (`pip install reportlab`).
