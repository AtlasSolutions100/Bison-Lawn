import { useMemo } from 'react';
import { useListClients, useListServices, type ListJobsParams } from '@workspace/api-client-react';
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
};

export function countActiveFilters(f: JobFilters): number {
  return (Object.keys(f) as (keyof JobFilters)[]).filter((k) => (k === 'hasNotes' ? f.hasNotes : f[k] !== '')).length;
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
  };
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
