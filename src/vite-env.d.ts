/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TENANT_A_LABEL?: string;
  readonly VITE_TENANT_B_LABEL?: string;
  readonly VITE_TENANT_C_LABEL?: string;
  readonly VITE_TENANT_A_MODULE?: string;
  readonly VITE_TENANT_B_MODULE?: string;
  readonly VITE_TENANT_C_MODULE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
