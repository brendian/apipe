import { FILTER_KEYS, FILTERS, type FilterKey } from '@advpipe/contracts';

/** The run list's filters, with counts. Toggle buttons: one is pressed. */
export function FilterTabs({
  value,
  counts,
  onChange,
}: {
  value: FilterKey;
  counts: Record<FilterKey, number>;
  onChange: (key: FilterKey) => void;
}) {
  return (
    <div className="filters" role="group" aria-label="Show runs">
      {FILTER_KEYS.map((key) => (
        <button key={key} type="button" aria-pressed={value === key} onClick={() => onChange(key)}>
          {FILTERS[key].label} {counts[key]}
        </button>
      ))}
    </div>
  );
}
