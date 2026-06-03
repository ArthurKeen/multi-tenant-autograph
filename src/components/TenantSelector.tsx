import type { TenantDef } from "../types";

interface Props {
  tenants: TenantDef[];
  activeId: string;
  onChange: (id: string) => void;
}

export function TenantSelector({ tenants, activeId, onChange }: Props) {
  const active = tenants.find((t) => t.id === activeId);
  return (
    <label className="tenant-selector">
      <span className="tenant-selector__label">Acting as</span>
      <div className="tenant-selector__control">
        <select
          className="tenant-selector__select"
          value={activeId}
          onChange={(e) => onChange(e.target.value)}
        >
          {tenants.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}  ({t.module})
            </option>
          ))}
        </select>
        {active && <span className="tenant-selector__module">module: {active.module}</span>}
      </div>
    </label>
  );
}
