import { useMemo } from 'react';
import { useListClients, useListServices, useListCustomerFields, useListEstimateFields, type ListJobsParams } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Filter } from 'lucide-react';
import type { ContractorOption } from './contractors';

/**
 * The filters the dispatch board and the waiting list share.
 *
 * His list from the walkthrough: branch, resource (the contractor), service,
 * map code, address/city, tags, notes-present. They are one popover rather than
 * a row of boxes because the row already holds the dates and the contractor,
 * and seven more boxes would push the Add Job button off a laptop screen.
 */
export type JobFilters = {
  contractorId: string;
  status: string;
  serviceId: string;
  mapCode: string;
  city: string;
  branch: string;
  tag: string;
  hasNotes: boolean;
  search: string;
  /**
   * "Dispatch board — columns search using custom fields." One filter wearing
   * four boxes: which of his custom customer fields (Turf Sqft, Gate Code,
   * Sprinkler Zones), and then what to match on it. The label on its own means
   * "only the ones who have this filled in", which is how he finds the lawns
   * nobody has measured yet.
   */
  fieldLabel: string;
  fieldValue: string;
  fieldMin: string;
  fieldMax: string;
};

export const EMPTY_JOB_FILTERS: JobFilters = {
  contractorId: '',
  status: '',
  serviceId: '',
  mapCode: '',
  city: '',
  branch: '',
  tag: '',
  hasNotes: false,
  search: '',
  fieldLabel: '',
  fieldValue: '',
  fieldMin: '',
  fieldMax: '',
};

export function countActiveFilters(f: JobFilters): number {
  // The three custom-field boxes do not count on their own: they are what to
  // match on the field he picked, so a label and a minimum is one filter. Left
  // in, the button read "Filters (3)" for the one thing he chose.
  return (Object.keys(f) as (keyof JobFilters)[])
    .filter((k) => k !== 'fieldValue' && k !== 'fieldMin' && k !== 'fieldMax')
    .filter((k) => (k === 'hasNotes' ? f.hasNotes : f[k] !== '')).length;
}

/** What the server understands; empty boxes are left out so the query key stays tidy. */
export function jobFilterParams(f: JobFilters) {
  return {
    ...(f.contractorId && { assignedTo: Number(f.contractorId) }),
    ...(f.status && { status: f.status as NonNullable<ListJobsParams['status']> }),
    ...(f.serviceId && { serviceId: Number(f.serviceId) }),
    ...(f.mapCode && { mapCode: f.mapCode }),
    ...(f.city && { city: f.city }),
    ...(f.branch && { branch: f.branch }),
    ...(f.tag && { tag: f.tag }),
    ...(f.hasNotes && { hasNotes: true }),
    ...(f.search && { search: f.search }),
    // Nothing goes without a label: a value with no field to look it up on
    // would be a filter the server cannot answer.
    ...(f.fieldLabel && { fieldLabel: f.fieldLabel }),
    ...(f.fieldLabel && f.fieldValue && { fieldValue: f.fieldValue }),
    ...(f.fieldLabel && f.fieldMin !== '' && Number.isFinite(Number(f.fieldMin)) && { fieldMin: Number(f.fieldMin) }),
    ...(f.fieldLabel && f.fieldMax !== '' && Number.isFinite(Number(f.fieldMax)) && { fieldMax: Number(f.fieldMax) }),
  };
}

/**
 * His custom customer fields, by label, in the order he put them in Settings.
 *
 * The same list the board offers as extra columns and as a filter — "columns
 * search using custom fields" is one request about both. `calculable` and
 * `number` fields are the ones worth a min/max; the rest are matched as text.
 */
export function useCustomFields() {
  const { data } = useListCustomerFields();
  /**
   * The same fields, read a second way, because the first way needs Settings.
   *
   * /customer-fields is the fuller answer — it also knows the stray labels that
   * only ever got typed on one customer's card — but it is a Settings screen's
   * endpoint, and the second office person has the dispatch board without
   * Settings. For her it comes back refused, and the board used to drop the
   * Custom field filter and every custom column with no word about why. The
   * plain field list is readable by anyone who can open the board, so the
   * fields he set up still show for her; only the strays are missing, and
   * nothing goes quiet.
   */
  const { data: onTheListOnly } = useListEstimateFields();
  return useMemo(() => {
    const toField = (f: { label: string; fieldType: string }) => ({
      label: f.label.trim(),
      numeric: f.fieldType === 'calculable' || f.fieldType === 'number',
    });
    const fromSettings = (data?.managed ?? []).filter((f) => f.label?.trim()).map(toField);
    const fromBoard = (onTheListOnly ?? []).filter((f) => f.label?.trim()).map(toField);
    const managed = data?.managed ? fromSettings : fromBoard;
    // Labels typed on one customer's card and never added to the list. Most of
    // the 709 came over from Service Autopilot carrying these, so leaving them
    // out would hide the gate codes he actually has. No type was ever set on
    // one, so it is matched as text — a min/max on a stray would be a guess.
    const stray = (data?.unmanaged ?? [])
      .filter((f) => f.label?.trim())
      .map((f) => ({ label: f.label.trim(), numeric: false }));
    const seen = new Set(managed.map((f) => f.label.toLowerCase()));
    return [...managed, ...stray.filter((f) => !seen.has(f.label.toLowerCase()))];
  }, [data, onTheListOnly]);
}

/**
 * Distinct values off the customer list for the dropdowns. Seven hundred
 * customers is a small list to scan once; the alternative is four endpoints
 * that each answer "what values exist", which is more to keep in step.
 */
export function useClientFilterOptions() {
  const { data: clients } = useListClients();
  return useMemo(() => {
    const mapCodes = new Set<string>();
    const cities = new Set<string>();
    const branches = new Set<string>();
    const tags = new Set<string>();
    for (const c of clients ?? []) {
      if (c.mapCode?.trim()) mapCodes.add(c.mapCode.trim().toUpperCase());
      if (c.city?.trim()) cities.add(c.city.trim());
      if (c.state?.trim()) branches.add(c.state.trim().toUpperCase());
      for (const t of c.tags ?? []) if (t.trim()) tags.add(t.trim().toLowerCase());
    }
    const sorted = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b));
    return { mapCodes: sorted(mapCodes), cities: sorted(cities), branches: sorted(branches), tags: sorted(tags) };
  }, [clients]);
}

export const selectClass = 'flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm';

export function JobFiltersPopover({
  value,
  onChange,
  contractors,
  withStatus = true,
  withSearch = true,
}: {
  value: JobFilters;
  onChange: (next: JobFilters) => void;
  contractors: ContractorOption[];
  withStatus?: boolean;
  withSearch?: boolean;
}) {
  const { data: services } = useListServices();
  const { mapCodes, cities, branches, tags } = useClientFilterOptions();
  const customFields = useCustomFields();
  const pickedField = customFields.find((f) => f.label === value.fieldLabel) ?? null;
  const active = countActiveFilters(value);
  const set = <K extends keyof JobFilters>(key: K, v: JobFilters[K]) => onChange({ ...value, [key]: v });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant={active ? 'default' : 'outline'} data-testid="job-filters">
          <Filter className="mr-1 h-4 w-4" /> Filters{active ? ` (${active})` : ''}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3 p-3">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-muted-foreground">
            Branch
            <select className={selectClass} value={value.branch} onChange={(e) => set('branch', e.target.value)} data-testid="filter-branch">
              <option value="">All</option>
              {branches.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </label>
          <label className="text-xs text-muted-foreground">
            Contractor
            <select className={selectClass} value={value.contractorId} onChange={(e) => set('contractorId', e.target.value)} data-testid="filter-contractor">
              <option value="">All</option>
              {contractors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="col-span-2 text-xs text-muted-foreground">
            Service
            <select className={selectClass} value={value.serviceId} onChange={(e) => set('serviceId', e.target.value)} data-testid="filter-service">
              <option value="">All services</option>
              {(services ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {(s as { code?: string | null }).code ? `${(s as { code?: string | null }).code} · ` : ''}{s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-muted-foreground">
            Map code
            <select className={selectClass} value={value.mapCode} onChange={(e) => set('mapCode', e.target.value)} data-testid="filter-map-code">
              <option value="">All</option>
              {mapCodes.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label className="text-xs text-muted-foreground">
            City
            <select className={selectClass} value={value.city} onChange={(e) => set('city', e.target.value)} data-testid="filter-city">
              <option value="">All</option>
              {cities.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="text-xs text-muted-foreground">
            Tag
            <select className={selectClass} value={value.tag} onChange={(e) => set('tag', e.target.value)} data-testid="filter-tag">
              <option value="">Any</option>
              {tags.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          {withStatus && (
            <label className="text-xs text-muted-foreground">
              Status
              <select className={selectClass} value={value.status} onChange={(e) => set('status', e.target.value)} data-testid="filter-status">
                <option value="">All statuses</option>
                <option value="scheduled">Scheduled</option>
                <option value="on_the_way">On the way</option>
                <option value="in_progress">In progress</option>
                <option value="completed">Completed</option>
                <option value="skipped">Skipped</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>
          )}
        </div>
        {customFields.length > 0 && (
          <div className="space-y-2 rounded-md border bg-muted/30 p-2">
            <label className="block text-xs text-muted-foreground">
              Custom field
              <select
                className={selectClass}
                value={value.fieldLabel}
                // Changing which field is being looked at clears what was
                // typed against the old one: "over 8" made sense for sprinkler
                // zones and means nothing left on a gate code.
                onChange={(e) => onChange({ ...value, fieldLabel: e.target.value, fieldValue: '', fieldMin: '', fieldMax: '' })}
                data-testid="filter-field-label"
              >
                <option value="">Any</option>
                {customFields.map((f) => <option key={f.label} value={f.label}>{f.label}</option>)}
              </select>
            </label>
            {value.fieldLabel && (
              <>
                <p className="text-[11px] leading-tight text-muted-foreground">
                  Leave the boxes empty to see everyone who has a {value.fieldLabel} on file.
                </p>
                <Input
                  placeholder={`${value.fieldLabel} contains…`}
                  value={value.fieldValue}
                  onChange={(e) => set('fieldValue', e.target.value)}
                  className="h-9"
                  data-testid="filter-field-value"
                />
                {pickedField?.numeric && (
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      placeholder="At least"
                      value={value.fieldMin}
                      onChange={(e) => set('fieldMin', e.target.value)}
                      className="h-9"
                      data-testid="filter-field-min"
                    />
                    <span className="text-xs text-muted-foreground">to</span>
                    <Input
                      type="number"
                      placeholder="At most"
                      value={value.fieldMax}
                      onChange={(e) => set('fieldMax', e.target.value)}
                      className="h-9"
                      data-testid="filter-field-max"
                    />
                  </div>
                )}
              </>
            )}
          </div>
        )}
        {withSearch && (
          <Input
            placeholder="Name or address contains…"
            value={value.search}
            onChange={(e) => set('search', e.target.value)}
            className="h-9"
            data-testid="filter-search"
          />
        )}
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-primary" checked={value.hasNotes} onChange={(e) => set('hasNotes', e.target.checked)} data-testid="filter-has-notes" />
          Only jobs with notes
        </label>
        {active > 0 && (
          <Button variant="outline" size="sm" className="w-full" onClick={() => onChange(EMPTY_JOB_FILTERS)} data-testid="clear-job-filters">
            Clear filters
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
