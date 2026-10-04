import { Input } from '@/components/ui/input';

/**
 * A date that may have no year.
 *
 * "When Creating packages does not need year as they will be renewed every
 * year and have the same date window of service." A date picker cannot say
 * "the first of October, every year", so this is a typed box that takes either
 * shape: 10-01 for the same day every year, or 2026-10-01 for one year only.
 * Assigning the package puts a year-free date into the season it belongs to.
 */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "10/1", "oct 1", "2026-10-01" → "10-01" / "2026-10-01". Anything else is left alone. */
export function normalizeSeasonDate(raw: string): string {
  const text = raw.trim().toLowerCase();
  if (text === '') return '';
  const full = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (full) return `${full[1]}-${full[2].padStart(2, '0')}-${full[3].padStart(2, '0')}`;
  const md = text.match(/^(\d{1,2})[-/](\d{1,2})$/);
  if (md) return `${md[1].padStart(2, '0')}-${md[2].padStart(2, '0')}`;
  const named = text.match(/^([a-z]{3,})\.?\s+(\d{1,2})$/);
  if (named) {
    const month = MONTHS.findIndex(m => named[1].startsWith(m));
    if (month >= 0) return `${String(month + 1).padStart(2, '0')}-${named[2].padStart(2, '0')}`;
  }
  return raw.trim();
}

/** The date in words, so a bare 10-01 does not read like a typo. */
export function seasonDateLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const md = value.match(/^(\d{2})-(\d{2})$/);
  if (md) {
    const month = MONTHS[Number(md[1]) - 1];
    if (!month) return null;
    return `${month[0].toUpperCase()}${month.slice(1)} ${Number(md[2])}, every year`;
  }
  return null;
}

export default function SeasonDateInput({
  value,
  onChange,
  className,
  title,
  placeholder = 'mm-dd or yyyy-mm-dd',
  'data-testid': testId,
}: {
  value: string | null | undefined;
  onChange: (next: string) => void;
  className?: string;
  title?: string;
  placeholder?: string;
  'data-testid'?: string;
}) {
  const label = seasonDateLabel(value);
  return (
    <div>
      <Input
        className={className}
        title={title}
        placeholder={placeholder}
        value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        onBlur={e => onChange(normalizeSeasonDate(e.target.value))}
        data-testid={testId}
      />
      {label && <p className="text-[11px] text-muted-foreground mt-0.5">{label}</p>}
    </div>
  );
}
