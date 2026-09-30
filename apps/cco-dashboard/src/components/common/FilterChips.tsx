interface FilterChipsProps<K extends string> {
  label: string;
  options: ReadonlyArray<{ key: K; label: string; count?: number }>;
  value: K;
  onChange: (key: K) => void;
}

export function FilterChips<K extends string>({ label, options, value, onChange }: FilterChipsProps<K>) {
  return (
    <div className="filter-chips" role="group" aria-label={label}>
      {options.map((o) => (
        <button type="button" key={o.key} className="filter-chip" aria-pressed={value === o.key} onClick={() => onChange(o.key)}>
          {o.label}
          {o.count !== undefined && <span className="filter-count mono">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}
