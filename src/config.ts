import type { TenantDef } from "./types";

const env = import.meta.env;

export const TENANTS: TenantDef[] = [
  {
    id: "a",
    label: env.VITE_TENANT_A_LABEL || "Tenant A",
    module: env.VITE_TENANT_A_MODULE || "tenant_a",
    ownQuestions: [
      "Summarize my projects.",
      "What is Project Ironclad?",
      "Tell me about Mistral Substation and the Aurora Interconnect.",
      "What is the Cascadia North region?",
    ],
    isolationProbes: [
      "What is Project Tidewatch?",
      "What is Project Helios Fields?",
    ],
  },
  {
    id: "b",
    label: env.VITE_TENANT_B_LABEL || "Tenant B",
    module: env.VITE_TENANT_B_MODULE || "tenant_b",
    ownQuestions: [
      "Summarize my projects.",
      "What is Project Tidewatch?",
      "Explain the FlexPeak tariff and the EcoReward program.",
      "Who are the customers in the Sunbelt Metro territory?",
    ],
    isolationProbes: [
      "What is Project Ironclad?",
      "What is Project Helios Fields?",
    ],
  },
  {
    id: "c",
    label: env.VITE_TENANT_C_LABEL || "Tenant C",
    module: env.VITE_TENANT_C_MODULE || "tenant_c",
    ownQuestions: [
      "Summarize my projects.",
      "What is Project Helios Fields?",
      "Tell me about the Dunesong site and Windward Bluffs.",
      "How does the Greenline PPA framework work?",
    ],
    isolationProbes: [
      "What is Project Ironclad?",
      "What is Project Tidewatch?",
    ],
  },
];

// Local search (entity-level): supports partition_ids + citations. See PRD §2.3 #5.
export const QUERY_TYPE_LOCAL = 2;
