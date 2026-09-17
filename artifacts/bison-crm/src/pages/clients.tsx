import { useEffect, useMemo, useState } from 'react';
import {
  useListClients,
  useCreateClient,
  useBulkUpdateClients,
  useBulkDeleteClients,
  getExportClientsUrl,
  Client,
  BulkClientUpdateInput,
  BulkClientDeleteResult,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Search, Plus, MapPin, Phone, Mail, ChevronRight, ChevronDown, Droplets, Filter, X, Download, Trash2, Pencil, UserCheck,
} from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { useToast } from '@/hooks/use-toast';
import { MapCodeBadge, WaterProviderLookupLink } from '@/components/map-code';

const clientSchema = z.object({
  name: z.string().min(2, "Name is required"),
  email: z.string().email().optional().or(z.literal('')),
  phone: z.string().optional(),
  billingAddress: z.string().optional(),
  billingCity: z.string().optional(),
  billingState: z.string().optional(),
  billingZip: z.string().optional(),
  serviceAddress: z.string().min(5, "Service Address is required"),
  city: z.string().min(2, "Service City is required"),
  mapCode: z.string().max(16, "Map codes are a short shorthand, e.g. PF").optional(),
  waterDistrict: z.string().optional(),
  status: z.enum(['lead', 'client', 'former_client']),
  accountBalance: z.coerce.number().default(0),
});

// ---------------------------------------------------------------------------
// Filter builder
//
// His old system's client list had a "Filters" bar: pick a field, pick
// "Contains / Starts With / Equal To", type a value, "Add Filter" to stack
// another. That is what he asked for back, so the shape is kept on purpose —
// same words, same order — with the operators he was missing (is empty,
// greater/less than for balance and dates) added to the same dropdown.
//
// It runs over the list already in memory. The whole customer file is ~700
// rows and is fetched whole anyway, so the server needs to know nothing about
// it, and a filter changes the screen the instant he picks it.
// ---------------------------------------------------------------------------

type FilterOp = 'contains' | 'starts_with' | 'equals' | 'not_equals' | 'is_empty' | 'is_not_empty' | 'gt' | 'lt';
type FilterKind = 'text' | 'number' | 'date' | 'tags';
type ClientFilter = { field: string; op: FilterOp; value: string };
type FieldDef = {
  key: string;
  label: string;
  kind: FilterKind;
  get: (client: Client) => string | number | string[] | null | undefined;
};

const STATUS_WORD: Record<string, string> = { lead: 'lead', client: 'active', former_client: 'former' };

const STATIC_FIELDS: FieldDef[] = [
  { key: 'name', label: 'Name', kind: 'text', get: (c) => c.name },
  { key: 'status', label: 'Status (lead / active / former)', kind: 'text', get: (c) => STATUS_WORD[c.status] ?? c.status },
  { key: 'accountType', label: 'Account type', kind: 'text', get: (c) => c.accountType },
  { key: 'accountNumber', label: 'Account number', kind: 'text', get: (c) => c.accountNumber },
  { key: 'accountBalance', label: 'Balance', kind: 'number', get: (c) => c.accountBalance },
  { key: 'state', label: 'Branch / state', kind: 'text', get: (c) => c.state },
  { key: 'city', label: 'City', kind: 'text', get: (c) => c.city },
  { key: 'postalCode', label: 'Zip', kind: 'text', get: (c) => c.postalCode },
  { key: 'serviceAddress', label: 'Service address', kind: 'text', get: (c) => c.serviceAddress },
  { key: 'mapCode', label: 'Map code', kind: 'text', get: (c) => c.mapCode },
  { key: 'waterDistrict', label: 'Water district', kind: 'text', get: (c) => c.waterDistrict },
  { key: 'tags', label: 'Tags', kind: 'tags', get: (c) => c.tags ?? [] },
  { key: 'email', label: 'Email', kind: 'text', get: (c) => c.email },
  { key: 'phone', label: 'Phone', kind: 'text', get: (c) => c.phone },
  { key: 'doNotEmail', label: 'Do not email (yes / no)', kind: 'text', get: (c) => (c.doNotEmail ? 'yes' : 'no') },
  { key: 'source', label: 'Source', kind: 'text', get: (c) => c.source },
  { key: 'billingTerms', label: 'Terms', kind: 'text', get: (c) => c.billingTerms },
  { key: 'invoiceFrequency', label: 'Invoice frequency', kind: 'text', get: (c) => c.invoiceFrequency },
  { key: 'invoiceDelivery', label: 'Invoice delivery', kind: 'text', get: (c) => c.invoiceDelivery },
  { key: 'billingEmail', label: 'Billing email', kind: 'text', get: (c) => c.billingEmail },
  { key: 'nameOnInvoice', label: 'Name on invoice', kind: 'text', get: (c) => c.nameOnInvoice },
  { key: 'billingCity', label: 'Billing city', kind: 'text', get: (c) => c.billingCity },
  { key: 'officeNote', label: 'Office note', kind: 'text', get: (c) => c.officeNote },
  { key: 'createdAt', label: 'Added (date)', kind: 'date', get: (c) => c.createdAt },
  { key: 'lastServiceDate', label: 'Last service (date)', kind: 'date', get: (c) => c.lastServiceDate },
];

const OPS: Record<FilterKind, { value: FilterOp; label: string }[]> = {
  text: [
    { value: 'contains', label: 'contains' },
    { value: 'starts_with', label: 'starts with' },
    { value: 'equals', label: 'equals' },
    { value: 'not_equals', label: 'does not equal' },
    { value: 'is_empty', label: 'is empty' },
    { value: 'is_not_empty', label: 'is not empty' },
  ],
  tags: [
    { value: 'contains', label: 'has a tag containing' },
    { value: 'equals', label: 'has tag' },
    { value: 'not_equals', label: 'does not have tag' },
    { value: 'is_empty', label: 'has no tags' },
    { value: 'is_not_empty', label: 'has any tag' },
  ],
  number: [
    { value: 'equals', label: 'equals' },
    { value: 'not_equals', label: 'does not equal' },
    { value: 'gt', label: 'greater than' },
    { value: 'lt', label: 'less than' },
    // "Who still needs measuring" is a question he actually asks, and without
    // these two the only way to ask it was "less than 5000", which answered
    // with everybody.
    { value: 'is_empty', label: 'is blank' },
    { value: 'is_not_empty', label: 'has a number' },
  ],
  date: [
    { value: 'equals', label: 'on' },
    { value: 'gt', label: 'after' },
    { value: 'lt', label: 'before' },
    { value: 'is_empty', label: 'is empty' },
    { value: 'is_not_empty', label: 'is not empty' },
  ],
};

const opLabel = (kind: FilterKind, op: FilterOp) => OPS[kind].find((o) => o.value === op)?.label ?? op;
const opNeedsValue = (op: FilterOp) => op !== 'is_empty' && op !== 'is_not_empty';

/**
 * A calendar day for comparing. Dates already stored as yyyy-mm-dd stay as
 * they are; a timestamp becomes the local day, so "added after Sept 1" means
 * his September 1st and not UTC's.
 */
function toDay(raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const d = new Date(String(raw));
  if (Number.isNaN(d.getTime())) return null;
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function matchesFilter(client: Client, filter: ClientFilter, def: FieldDef): boolean {
  const raw = def.get(client);
  const empty = raw == null || raw === '' || (Array.isArray(raw) && raw.length === 0);
  if (filter.op === 'is_empty') return empty;
  if (filter.op === 'is_not_empty') return !empty;

  const needle = filter.value.trim().toLowerCase();
  // A filter with nothing typed in it yet hides nothing; it is being built.
  if (!needle) return true;

  if (def.kind === 'tags') {
    const tags = (Array.isArray(raw) ? raw : []).map((t) => String(t).toLowerCase());
    switch (filter.op) {
      case 'contains': return tags.some((t) => t.includes(needle));
      case 'starts_with': return tags.some((t) => t.startsWith(needle));
      case 'equals': return tags.includes(needle);
      case 'not_equals': return !tags.includes(needle);
      default: return true;
    }
  }

  if (def.kind === 'number') {
    const wanted = Number(filter.value);
    if (Number.isNaN(wanted)) return true;
    // Most customers have no "Turf sqft" on them at all. Counting that as zero
    // square feet made "less than 5000" list everyone he has never measured,
    // which is a wrong answer, not a short one.
    const have = empty ? NaN : Number(raw);
    if (Number.isNaN(have)) return filter.op === 'not_equals';
    switch (filter.op) {
      case 'equals': return have === wanted;
      case 'not_equals': return have !== wanted;
      case 'gt': return have > wanted;
      case 'lt': return have < wanted;
      default: return true;
    }
  }

  if (def.kind === 'date') {
    const day = toDay(raw);
    if (!day) return false;
    switch (filter.op) {
      case 'equals': return day === filter.value;
      case 'gt': return day > filter.value;
      case 'lt': return day < filter.value;
      default: return true;
    }
  }

  const hay = String(raw ?? '').toLowerCase();
  switch (filter.op) {
    case 'contains': return hay.includes(needle);
    case 'starts_with': return hay.startsWith(needle);
    case 'equals': return hay === needle;
    case 'not_equals': return hay !== needle;
    default: return true;
  }
}

// Remembered per browser so the list he set up this morning is still set up
// after lunch. A convenience only: the page works the same with it missing.
const FILTERS_KEY = 'bison.clients.filters';
function loadFilters(): ClientFilter[] {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((f) => f && typeof f.field === 'string' && typeof f.op === 'string') : [];
  } catch {
    return [];
  }
}

const selectClass = 'h-9 rounded-md border border-input bg-background px-2 text-sm outline-none';

export default function Clients() {
  const [statusFilter, setStatusFilter] = useState<'lead'|'client'|'former_client'|'all'>('all');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<ClientFilter[]>(loadFilters);
  /*
    Sorting is a mode rather than a flag now. "Can leads be organized
    alphabetically but also looked up based on input date" — alphabetical is the
    default and always was; what was missing is being able to ask "who came in
    most recently", which for a lead list is the question you actually have.
  */
  const [sort, setSort] = useState<'name' | 'mapCode' | 'added'>('name');
  const [selectedIds, setSelectedIds] = useState<number[]>([]);

  useEffect(() => {
    try { localStorage.setItem(FILTERS_KEY, JSON.stringify(filters)); } catch { /* per-browser nicety only */ }
  }, [filters]);

  const queryParams = {
    ...(statusFilter !== 'all' && { status: statusFilter }),
    ...(search && { search })
  };

  const { data: clients, isLoading } = useListClients(queryParams);

  // His custom fields ("Turf sqft", "Gate code") are free text per customer and
  // the import left the same field spelled two ways on different customers, so
  // the list is folded case-insensitively. A field whose every value is a
  // number gets greater/less than, so "Turf sqft greater than 10000" works.
  const fields = useMemo<FieldDef[]>(() => {
    const seen = new Map<string, { label: string; numeric: boolean }>();
    for (const client of clients ?? []) {
      for (const [key, value] of Object.entries(client.propertyData ?? {})) {
        const folded = key.trim().toLowerCase();
        if (!folded) continue;
        const entry = seen.get(folded) ?? { label: key.trim(), numeric: true };
        const text = String(value ?? '').trim();
        if (text && Number.isNaN(Number(text.replace(/[,$\s]/g, '')))) entry.numeric = false;
        seen.set(folded, entry);
      }
    }
    const custom: FieldDef[] = [...seen.entries()]
      .sort((a, b) => a[1].label.localeCompare(b[1].label))
      .map(([folded, { label, numeric }]) => ({
        key: `prop:${folded}`,
        label: `${label} (custom field)`,
        kind: numeric ? 'number' : 'text',
        get: (c) => {
          const hit = Object.entries(c.propertyData ?? {}).find(([k]) => k.trim().toLowerCase() === folded);
          if (!hit) return null;
          if (!numeric) return hit[1];
          // A field left blank on a customer means nobody measured it yet, and
          // that is not the same as a measurement of zero.
          const digits = String(hit[1]).replace(/[,$\s]/g, '');
          return digits ? Number(digits) : null;
        },
      }));
    return [...STATIC_FIELDS, ...custom];
  }, [clients]);
  const fieldByKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);

  // Zones come from the clients themselves rather than a settings list: he
  // invents a map code the moment he takes on a new corner of town, and having
  // to register it somewhere first is how records end up with no zone at all.
  const distinctValues = useMemo(() => {
    const byField = new Map<string, Set<string>>();
    const add = (key: string, value: unknown) => {
      const text = String(value ?? '').trim();
      if (!text) return;
      const set = byField.get(key) ?? new Set<string>();
      set.add(key === 'mapCode' ? text.toUpperCase() : text);
      byField.set(key, set);
    };
    for (const client of clients ?? []) {
      add('mapCode', client.mapCode);
      add('state', client.state);
      add('city', client.city);
      add('waterDistrict', client.waterDistrict);
      add('billingTerms', client.billingTerms);
      add('invoiceFrequency', client.invoiceFrequency);
      add('invoiceDelivery', client.invoiceDelivery);
      add('accountType', client.accountType);
      add('source', client.source);
      add('status', STATUS_WORD[client.status] ?? client.status);
      for (const tag of client.tags ?? []) add('tags', tag);
    }
    const out: Record<string, string[]> = {};
    for (const [key, set] of byField) out[key] = [...set].sort((a, b) => a.localeCompare(b));
    return out;
  }, [clients]);

  const visibleClients = useMemo(() => {
    const active = filters.filter((f) => fieldByKey.has(f.field));
    const rows = (clients ?? []).filter((client) =>
      active.every((f) => matchesFilter(client, f, fieldByKey.get(f.field)!)),
    );
    if (sort === 'name') return rows;

    if (sort === 'added') {
      return [...rows].sort((a, b) => {
        // Newest first: a lead list is read to find the enquiry that just came
        // in, not the oldest one. Customers with no recorded date sort last
        // rather than pretending to be the oldest.
        const aAt = a.createdAt ? new Date(a.createdAt).getTime() : null;
        const bAt = b.createdAt ? new Date(b.createdAt).getTime() : null;
        if (aAt == null && bAt == null) return a.name.localeCompare(b.name);
        if (aAt == null) return 1;
        if (bAt == null) return -1;
        return bAt - aAt || a.name.localeCompare(b.name);
      });
    }

    return [...rows].sort((a, b) => {
      const aCode = a.mapCode?.trim().toUpperCase() ?? '';
      const bCode = b.mapCode?.trim().toUpperCase() ?? '';
      // Unzoned clients sort last, not first: they are the ones still needing a
      // route decision, and mixed in alphabetically they never get made.
      if (aCode !== bCode) {
        if (!aCode) return 1;
        if (!bCode) return -1;
        return aCode.localeCompare(bCode);
      }
      return a.name.localeCompare(b.name);
    });
  }, [clients, filters, fieldByKey, sort]);

  // Selection survives across filter changes but only ever acts on rows the
  // office can currently see — applying a map code to a client scrolled out of
  // view by a filter change is a silent edit nobody asked for.
  const visibleIds = visibleClients.map((client) => client.id);
  const selectedVisibleIds = selectedIds.filter((id) => visibleIds.includes(id));
  const allVisibleSelected = visibleIds.length > 0 && selectedVisibleIds.length === visibleIds.length;

  const toggleClient = (id: number, checked: boolean) =>
    setSelectedIds((prev) => (checked ? [...new Set([...prev, id])] : prev.filter((existing) => existing !== id)));

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6 flex flex-col h-[calc(100vh-2rem)]">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Clients &amp; Leads</h1>
          {/* "Manage your customer database and properties" told the office
              nothing it did not already know from the page it had just clicked.
              How many customers there are, and how many the current filter is
              hiding, is the thing actually worth a line here. */}
          <p className="text-muted-foreground mt-1" data-testid="client-count">
            {clients == null
              ? 'Loading…'
              : visibleClients.length === clients.length
                ? `${clients.length} ${clients.length === 1 ? 'customer' : 'customers'}`
                : `${visibleClients.length} of ${clients.length} shown`}
          </p>
        </div>
        <NewClientDialog />
      </div>

      <div className="bg-card rounded-lg border shadow-sm">
        <div className="flex flex-col sm:flex-row justify-between items-center gap-4 p-2">
          <Tabs value={statusFilter} onValueChange={(v: any) => setStatusFilter(v)} className="w-full sm:w-auto">
            <TabsList className="grid w-full sm:w-[400px] grid-cols-4">
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="lead">Leads</TabsTrigger>
              <TabsTrigger value="client">Active</TabsTrigger>
              <TabsTrigger value="former_client">Former</TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="relative w-full sm:w-72">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search name, city, map code..."
              className="pl-9 bg-background"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        <FilterBuilder
          fields={fields}
          fieldByKey={fieldByKey}
          distinctValues={distinctValues}
          filters={filters}
          onChange={setFilters}
        />
      </div>

      {selectedVisibleIds.length > 0 && (
        <BulkActionsBar
          ids={selectedVisibleIds}
          shownIds={visibleIds}
          distinctValues={distinctValues}
          onDone={() => setSelectedIds([])}
        />
      )}

      <div className="bg-card border rounded-lg shadow-sm flex-1 overflow-hidden flex flex-col">
        <div className="overflow-auto flex-1">
          {/*
            table-fixed, because without it the column widths above are only a
            hint: the browser still grows a column to fit its longest cell, and
            with 709 real customers that pushed the table to 1984px inside an
            1141px container and put the horizontal scrollbar straight back.
            Fixed layout is also what makes `truncate` do anything at all here.
          */}
          <Table className="table-fixed">
            <TableHeader className="bg-muted/50 sticky top-0 z-10 backdrop-blur-sm">
              <TableRow>
                <TableHead className="w-10">
                  <input
                    type="checkbox"
                    className="h-4 w-4 cursor-pointer align-middle accent-primary"
                    aria-label="Select all shown clients"
                    data-testid="select-all-clients"
                    checked={allVisibleSelected}
                    onChange={(e) => setSelectedIds(e.target.checked ? visibleIds : [])}
                  />
                </TableHead>
                {/*
                  Explicit widths, because auto table layout allocates by
                  content length: email addresses are the longest strings in the
                  row, so Contact took roughly half the table while the service
                  address wrapped onto three lines and Added, Status and Balance
                  were pushed off the right edge entirely. Width now follows how
                  often a column is read, not how long its text happens to be.
                */}
                <TableHead className="w-[22%]">Client</TableHead>
                <TableHead className="w-[22%]">Contact</TableHead>
                <TableHead className="w-[24%]">Service Location</TableHead>
                {/* "Zone", not "Map Code / Water": the old label was long enough
                    to wrap onto three lines in its own header while the water
                    district it named is filled in for 8 customers out of 709.
                    The chip is what the office scans for; the district is a
                    detail underneath it, on one line. */}
                <TableHead className="w-28">
                  <button
                    type="button"
                    className="font-medium hover:text-primary transition-colors whitespace-nowrap"
                    onClick={() => setSort(sort === 'mapCode' ? 'name' : 'mapCode')}
                    title="Group the list by route zone"
                  >
                    Zone {sort === 'mapCode' ? '▲' : ''}
                  </button>
                </TableHead>
                <TableHead className="w-28">
                  <button
                    type="button"
                    className="font-medium hover:text-primary transition-colors whitespace-nowrap"
                    onClick={() => setSort(sort === 'added' ? 'name' : 'added')}
                    title="Sort by when they were added, newest first"
                    data-testid="sort-by-added"
                  >
                    Added {sort === 'added' ? '▼' : ''}
                  </button>
                </TableHead>
                <TableHead className="w-24">Status</TableHead>
                <TableHead className="w-28 text-right">Balance</TableHead>
                <TableHead className="w-12"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-10 text-muted-foreground animate-pulse">
                    Loading clients...
                  </TableCell>
                </TableRow>
              ) : !visibleClients.length ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-10 text-muted-foreground">
                    {filters.length ? 'No clients match these filters.' : 'No clients found.'}
                  </TableCell>
                </TableRow>
              ) : (
                visibleClients.map((client) => (
                  <ClientRow
                    key={client.id}
                    client={client}
                    selected={selectedIds.includes(client.id)}
                    onSelectedChange={(checked) => toggleClient(client.id, checked)}
                  />
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

function FilterBuilder({ fields, fieldByKey, distinctValues, filters, onChange }: {
  fields: FieldDef[];
  fieldByKey: Map<string, FieldDef>;
  distinctValues: Record<string, string[]>;
  filters: ClientFilter[];
  onChange: (next: ClientFilter[]) => void;
}) {
  const [field, setField] = useState('name');
  const [op, setOp] = useState<FilterOp>('contains');
  const [value, setValue] = useState('');
  const def = fieldByKey.get(field) ?? fields[0];
  const ops = OPS[def.kind];
  const suggestions = distinctValues[def.key] ?? [];

  const pickField = (key: string) => {
    setField(key);
    const next = fieldByKey.get(key);
    // Keep the operator when the new field still offers it, otherwise the
    // first one that makes sense — "contains" on a balance is not a thing.
    if (next && !OPS[next.kind].some((o) => o.value === op)) setOp(OPS[next.kind][0].value);
    setValue('');
  };

  const add = () => {
    if (opNeedsValue(op) && !value.trim()) return;
    onChange([...filters, { field, op, value: value.trim() }]);
    setValue('');
  };

  return (
    <div className="border-t px-2 py-2 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Filter className="h-4 w-4 text-muted-foreground shrink-0" />
        <select
          className={selectClass}
          value={field}
          onChange={(e) => pickField(e.target.value)}
          aria-label="Filter field"
          data-testid="filter-field"
        >
          {fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
        <select
          className={selectClass}
          value={op}
          onChange={(e) => setOp(e.target.value as FilterOp)}
          aria-label="Filter operator"
          data-testid="filter-op"
        >
          {ops.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {opNeedsValue(op) && (
          <>
            <Input
              className="h-9 w-48 bg-background"
              type={def.kind === 'date' ? 'date' : def.kind === 'number' ? 'number' : 'text'}
              placeholder={def.kind === 'number' ? '0' : 'Value'}
              list={suggestions.length ? `filter-values-${def.key}` : undefined}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
              aria-label="Filter value"
              data-testid="filter-value"
            />
            {suggestions.length > 0 && (
              <datalist id={`filter-values-${def.key}`}>
                {suggestions.slice(0, 300).map((s) => <option key={s} value={s} />)}
              </datalist>
            )}
          </>
        )}
        <Button size="sm" variant="secondary" className="h-9" onClick={add} data-testid="add-filter">
          <Plus className="h-4 w-4 mr-1" /> Add filter
        </Button>
        {filters.length > 0 && (
          <Button size="sm" variant="ghost" className="h-9 text-muted-foreground" onClick={() => onChange([])} data-testid="clear-filters">
            Clear all
          </Button>
        )}
      </div>
      {filters.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="active-filters">
          {filters.map((f, i) => {
            const d = fieldByKey.get(f.field);
            const label = d
              ? `${d.label.replace(/ \(.*\)$/, '')} ${opLabel(d.kind, f.op)}${opNeedsValue(f.op) ? ` "${f.value}"` : ''}`
              : `${f.field} ${f.op} ${f.value}`;
            return (
              <span
                key={`${f.field}-${f.op}-${f.value}-${i}`}
                className="inline-flex items-center gap-1 rounded-full border bg-primary/5 border-primary/20 px-2.5 py-0.5 text-xs font-medium"
              >
                {label}
                <button
                  type="button"
                  className="rounded-full hover:bg-primary/10 p-0.5"
                  aria-label={`Remove filter ${label}`}
                  onClick={() => onChange(filters.filter((_, j) => j !== i))}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bulk actions — his old Actions menu: Delete Clients, Activate Clients,
// Cancel Clients, Export Clients, Bulk Edit, Add/Remove Tags.
// ---------------------------------------------------------------------------

/**
 * Downloads go through a hidden link with `download` set. The server names the
 * file and sends it as an attachment; the unsaved-changes guard leaves links
 * marked download alone, and no popup gets left behind the way window.open does.
 */
function downloadCsv(ids: number[]) {
  const a = document.createElement('a');
  a.href = getExportClientsUrl({ ids: ids.join(',') });
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function BulkActionsBar({ ids, shownIds, distinctValues, onDone }: {
  ids: number[];
  shownIds: number[];
  distinctValues: Record<string, string[]>;
  onDone: () => void;
}) {
  const bulkUpdate = useBulkUpdateClients();
  const bulkDelete = useBulkDeleteClients();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editOpen, setEditOpen] = useState(false);
  const [deletePreview, setDeletePreview] = useState<BulkClientDeleteResult | null>(null);

  const busy = bulkUpdate.isPending || bulkDelete.isPending;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['/api/clients'] });

  const failed = (title: string, error: unknown) =>
    toast({
      title,
      description: error instanceof Error ? error.message : 'Please try again.',
      variant: 'destructive',
    });

  const setStatus = async (status: 'client' | 'former_client' | 'lead') => {
    try {
      const res = await bulkUpdate.mutateAsync({ data: { clientIds: ids, status } });
      toast({ title: `${plural(res.updated, 'client')} set to ${status === 'client' ? 'active' : status === 'lead' ? 'lead' : 'former'}` });
      refresh();
      onDone();
    } catch (error) {
      failed('Status could not be changed', error);
    }
  };

  const applyEdit = async (data: Omit<BulkClientUpdateInput, 'clientIds'>) => {
    try {
      const res = await bulkUpdate.mutateAsync({ data: { ...data, clientIds: ids } });
      toast({ title: `${plural(res.updated, 'client')} updated` });
      setEditOpen(false);
      refresh();
      onDone();
    } catch (error) {
      failed('Bulk edit could not be applied', error);
    }
  };

  const askDelete = async () => {
    try {
      const preview = await bulkDelete.mutateAsync({ data: { clientIds: ids, preview: true } });
      setDeletePreview(preview);
    } catch (error) {
      failed('Could not check what would be deleted', error);
    }
  };

  const confirmDelete = async () => {
    try {
      const res = await bulkDelete.mutateAsync({ data: { clientIds: ids } });
      toast({
        title: `${plural(res.clients, 'client')} deleted`,
        description: `${plural(res.invoices, 'invoice')}, ${plural(res.payments, 'payment')} and ${plural(res.jobs, 'job')} went with them.`,
      });
      setDeletePreview(null);
      refresh();
      onDone();
    } catch (error) {
      failed('Delete failed', error);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 bg-primary/5 border border-primary/20 rounded-lg px-3 py-2" data-testid="bulk-bar">
      <span className="text-sm font-semibold mr-1">{ids.length} selected</span>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" className="h-8" disabled={busy} data-testid="bulk-status">
            <UserCheck className="h-4 w-4 mr-1" /> Set status <ChevronDown className="h-3 w-3 ml-1" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => setStatus('client')}>Active client</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setStatus('former_client')}>Former client</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setStatus('lead')}>Lead</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => setEditOpen(true)} data-testid="bulk-edit">
        <Pencil className="h-4 w-4 mr-1" /> Bulk edit
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" className="h-8" disabled={busy} data-testid="bulk-export">
            <Download className="h-4 w-4 mr-1" /> Export CSV <ChevronDown className="h-3 w-3 ml-1" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => downloadCsv(ids)}>Selected ({ids.length})</DropdownMenuItem>
          <DropdownMenuItem onClick={() => downloadCsv(shownIds)}>Everyone shown ({shownIds.length})</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button size="sm" variant="outline" className="h-8 text-destructive hover:text-destructive" disabled={busy} onClick={askDelete} data-testid="bulk-delete">
        <Trash2 className="h-4 w-4 mr-1" /> Delete
      </Button>

      <Button size="sm" variant="ghost" className="h-8 ml-auto" onClick={onDone} disabled={busy}>Clear selection</Button>

      <BulkEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        count={ids.length}
        distinctValues={distinctValues}
        saving={bulkUpdate.isPending}
        onApply={applyEdit}
      />

      <AlertDialog open={deletePreview != null} onOpenChange={(open) => { if (!open) setDeletePreview(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {plural(deletePreview?.clients ?? ids.length, 'client')}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  Everything on their accounts goes with them:{' '}
                  <strong>{plural(deletePreview?.invoices ?? 0, 'invoice')}</strong>,{' '}
                  <strong>{plural(deletePreview?.payments ?? 0, 'payment')}</strong> and{' '}
                  <strong>{plural(deletePreview?.jobs ?? 0, 'job')}</strong>, plus their notes, photos and history.
                  There is no undo.
                </p>
                <p>
                  If you only want them off the active list, use <em>Set status → Former client</em> instead. That
                  keeps the account and the money history.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkDelete.isPending}>Keep them</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={bulkDelete.isPending}
              onClick={(e) => { e.preventDefault(); confirmDelete(); }}
              data-testid="confirm-bulk-delete"
            >
              {bulkDelete.isPending ? 'Deleting…' : `Delete ${plural(deletePreview?.clients ?? ids.length, 'client')}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type EditKey = 'mapCode' | 'waterDistrict' | 'state' | 'accountType' | 'billingTerms' | 'invoiceFrequency' | 'invoiceDelivery' | 'doNotEmail' | 'addTags' | 'removeTags';

const EDIT_FIELDS: { key: EditKey; label: string; hint?: string; suggest?: string; choices?: { value: string; label: string }[] }[] = [
  { key: 'mapCode', label: 'Map code', hint: 'Blank clears it', suggest: 'mapCode' },
  { key: 'state', label: 'Branch / state', hint: 'ID or WA', suggest: 'state' },
  { key: 'waterDistrict', label: 'Water district', suggest: 'waterDistrict' },
  { key: 'accountType', label: 'Account type', choices: [{ value: '', label: '— clear —' }, { value: 'residential', label: 'Residential' }, { value: 'commercial', label: 'Commercial' }] },
  { key: 'billingTerms', label: 'Terms', hint: 'e.g. Net 15', suggest: 'billingTerms' },
  { key: 'invoiceFrequency', label: 'Invoice frequency', hint: 'e.g. Monthly', suggest: 'invoiceFrequency' },
  { key: 'invoiceDelivery', label: 'Invoice delivery', choices: [{ value: '', label: '— clear —' }, { value: 'email', label: 'Email' }, { value: 'print', label: 'Print' }, { value: 'both', label: 'Both' }] },
  { key: 'doNotEmail', label: 'Do not email', choices: [{ value: 'true', label: 'On — skip them in bulk emails' }, { value: 'false', label: 'Off' }] },
  { key: 'addTags', label: 'Add tags', hint: 'Comma-separated', suggest: 'tags' },
  { key: 'removeTags', label: 'Remove tags', hint: 'Comma-separated', suggest: 'tags' },
];

/**
 * Each row has its own "change this" box. Only ticked rows are sent, so a
 * bulk edit that only meant to set the terms cannot blank forty map codes:
 * the server treats an absent field as "leave alone" and a blank as "clear".
 */
function BulkEditDialog({ open, onOpenChange, count, distinctValues, saving, onApply }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  count: number;
  distinctValues: Record<string, string[]>;
  saving: boolean;
  onApply: (data: Omit<BulkClientUpdateInput, 'clientIds'>) => void;
}) {
  const [on, setOn] = useState<Partial<Record<EditKey, boolean>>>({});
  const [values, setValues] = useState<Partial<Record<EditKey, string>>>({});

  useEffect(() => {
    if (open) { setOn({}); setValues({}); }
  }, [open]);

  const anyOn = Object.values(on).some(Boolean);
  const splitTags = (text: string) => text.split(',').map((t) => t.trim()).filter(Boolean);

  const submit = () => {
    const data: Omit<BulkClientUpdateInput, 'clientIds'> = {};
    // A dropdown he never touched is still showing its first choice, so that is
    // what Apply has to send. Reading it as blank is how ticking "Do not email"
    // and leaving it on the "On" it shows turned do-not-email OFF for everyone
    // selected — the opposite of what the dialog said.
    const text = (key: EditKey) => {
      const shown = values[key] ?? EDIT_FIELDS.find((f) => f.key === key)?.choices?.[0]?.value ?? '';
      return shown.trim();
    };
    if (on.mapCode) data.mapCode = text('mapCode').toUpperCase() || null;
    if (on.state) data.state = text('state') || null;
    if (on.waterDistrict) data.waterDistrict = text('waterDistrict') || null;
    if (on.accountType) data.accountType = (text('accountType') || null) as BulkClientUpdateInput['accountType'];
    if (on.billingTerms) data.billingTerms = text('billingTerms') || null;
    if (on.invoiceFrequency) data.invoiceFrequency = text('invoiceFrequency') || null;
    if (on.invoiceDelivery) data.invoiceDelivery = (text('invoiceDelivery') || null) as BulkClientUpdateInput['invoiceDelivery'];
    if (on.doNotEmail) data.doNotEmail = text('doNotEmail') === 'true';
    if (on.addTags && splitTags(text('addTags')).length) data.addTags = splitTags(text('addTags'));
    if (on.removeTags && splitTags(text('removeTags')).length) data.removeTags = splitTags(text('removeTags'));
    if (Object.keys(data).length === 0) return;
    onApply(data);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Bulk edit {plural(count, 'client')}</DialogTitle>
          <DialogDescription>
            Tick the fields to change. Anything left unticked stays as it is on every client.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {EDIT_FIELDS.map((f) => {
            const enabled = !!on[f.key];
            const suggestions = f.suggest ? distinctValues[f.suggest] ?? [] : [];
            return (
              <div key={f.key} className="grid grid-cols-[auto_150px_1fr] items-center gap-3">
                <input
                  type="checkbox"
                  className="h-4 w-4 cursor-pointer accent-primary"
                  checked={enabled}
                  onChange={(e) => setOn((prev) => ({ ...prev, [f.key]: e.target.checked }))}
                  aria-label={`Change ${f.label}`}
                  data-testid={`bulk-edit-on-${f.key}`}
                />
                <label className={`text-sm ${enabled ? 'font-medium' : 'text-muted-foreground'}`}>{f.label}</label>
                {f.choices ? (
                  <select
                    className={`${selectClass} w-full`}
                    disabled={!enabled}
                    value={values[f.key] ?? f.choices[0].value}
                    onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
                    data-testid={`bulk-edit-${f.key}`}
                  >
                    {f.choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                ) : (
                  <>
                    <Input
                      className={`h-9 bg-background ${f.key === 'mapCode' ? 'uppercase' : ''}`}
                      disabled={!enabled}
                      placeholder={f.hint}
                      list={suggestions.length ? `bulk-edit-values-${f.key}` : undefined}
                      value={values[f.key] ?? ''}
                      onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
                      data-testid={`bulk-edit-${f.key}`}
                    />
                    {suggestions.length > 0 && (
                      <datalist id={`bulk-edit-values-${f.key}`}>
                        {suggestions.slice(0, 300).map((s) => <option key={s} value={s} />)}
                      </datalist>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
        <DialogFooter className="pt-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button type="button" onClick={submit} disabled={saving || !anyOn} data-testid="bulk-edit-apply">
            {saving ? 'Applying…' : `Apply to ${plural(count, 'client')}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ClientRow({ client, selected, onSelectedChange }: {
  client: Client;
  selected: boolean;
  onSelectedChange: (checked: boolean) => void;
}) {
  const [, setLocation] = useLocation();

  const statusColors = {
    lead: "bg-accent/20 text-accent-foreground border-accent/30",
    client: "bg-primary/10 text-primary border-primary/20",
    former_client: "bg-muted text-muted-foreground border-border",
  };

  return (
    <TableRow
      className="cursor-pointer hover:bg-muted/50 transition-colors group"
      onClick={() => setLocation(`/clients/${client.id}`)}
    >
      <TableCell onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          className="h-4 w-4 cursor-pointer align-middle accent-primary"
          aria-label={`Select ${client.name}`}
          checked={selected}
          onChange={(e) => onSelectedChange(e.target.checked)}
        />
      </TableCell>
      <TableCell className="font-semibold text-foreground">
        <span className="block truncate" title={client.name}>{client.name}</span>
      </TableCell>
      <TableCell>
        {/* An absent value is shown as a dash, not as a sentence. "No contact
            info" in italics on hundreds of rows reads as an error state and
            costs a line of height on every one of them. */}
        <div className="flex flex-col gap-0.5 text-sm min-w-0">
          {client.phone && (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Phone className="w-3 h-3 shrink-0"/>
              <span className="truncate">{client.phone}</span>
            </span>
          )}
          {client.email && (
            <span className="flex items-center gap-1.5 text-muted-foreground" title={client.email}>
              <Mail className="w-3 h-3 shrink-0"/>
              <span className="truncate">{client.email}</span>
            </span>
          )}
          {!client.phone && !client.email && <span className="text-muted-foreground/40">—</span>}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-col gap-0.5 text-sm min-w-0">
          <span
            className="flex items-center gap-1.5 font-medium text-foreground"
            title={[client.serviceAddress, client.city].filter(Boolean).join(', ')}
          >
            <MapPin className="w-3.5 h-3.5 shrink-0 text-muted-foreground"/>
            <span className="truncate">{client.serviceAddress || '—'}</span>
          </span>
          {client.city && <span className="ml-5 truncate text-muted-foreground">{client.city}</span>}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-col items-start gap-1 text-sm">
          {client.mapCode?.trim()
            ? <MapCodeBadge code={client.mapCode} />
            : <span className="text-muted-foreground/40 text-xs">—</span>}
          {client.waterDistrict && (
            <span
              className="flex w-full items-center gap-1 text-xs text-muted-foreground"
              title={client.waterDistrict}
            >
              <Droplets className="w-3 h-3 shrink-0" />
              <span className="truncate">{client.waterDistrict}</span>
            </span>
          )}
        </div>
      </TableCell>
      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
        {client.createdAt
          ? new Date(client.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
          : <span className="text-muted-foreground/50 italic text-xs">—</span>}
      </TableCell>
      <TableCell>
        <span className={`px-2.5 py-1 text-xs font-semibold rounded-full border ${statusColors[client.status as keyof typeof statusColors]}`}>
          {client.status === 'former_client' ? 'FORMER' : client.status.toUpperCase()}
        </span>
      </TableCell>
      <TableCell className="text-right">
        <span className={`font-semibold ${client.accountBalance > 0 ? 'text-destructive' : client.accountBalance < 0 ? 'text-primary' : 'text-muted-foreground'}`}>
          ${client.accountBalance.toLocaleString(undefined, {minimumFractionDigits:2})}
        </span>
      </TableCell>
      <TableCell>
        <ChevronRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors" />
      </TableCell>
    </TableRow>
  );
}

function NewClientDialog() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const createClient = useCreateClient();

  const form = useForm<z.infer<typeof clientSchema>>({
    resolver: zodResolver(clientSchema),
    defaultValues: {
      name: '', email: '', phone: '', serviceAddress: '', city: '',
      mapCode: '', waterDistrict: '', status: 'lead', accountBalance: 0
    }
  });

  const onSubmit = (values: z.infer<typeof clientSchema>) => {
    // Blank means "not known yet", which is not the same as an empty map code
    // sitting in the column and reading as a real zone in the filter list.
    const data = {
      ...values,
      mapCode: values.mapCode?.trim().toUpperCase() || undefined,
      waterDistrict: values.waterDistrict?.trim() || undefined,
    };
    createClient.mutate({ data }, {
      onSuccess: (res) => {
        queryClient.invalidateQueries({ queryKey: ['/api/clients'] });
        setOpen(false);
        setLocation(`/clients/${res.id}`);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="bg-primary text-primary-foreground hover:bg-primary/90 font-semibold shadow-sm">
          <Plus className="w-4 h-4 mr-2" /> New Client
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Create New Client</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem className="col-span-2"><FormLabel>Full Name / Company</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage/></FormItem>
              )} />
              <FormField control={form.control} name="phone" render={({ field }) => (
                <FormItem><FormLabel>Phone</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage/></FormItem>
              )} />
              <FormField control={form.control} name="email" render={({ field }) => (
                <FormItem><FormLabel>Email</FormLabel><FormControl><Input {...field} type="email" /></FormControl><FormMessage/></FormItem>
              )} />
              <div className="col-span-2 pt-2 pb-1 border-b">
                <h4 className="font-semibold text-sm">Service Location</h4>
              </div>
              <FormField control={form.control} name="serviceAddress" render={({ field }) => (
                <FormItem className="col-span-2"><FormLabel>Address</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage/></FormItem>
              )} />
              <FormField control={form.control} name="city" render={({ field }) => (
                <FormItem><FormLabel>City</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage/></FormItem>
              )} />
              <FormField control={form.control} name="mapCode" render={({ field }) => (
                <FormItem>
                  <FormLabel>Map Code</FormLabel>
                  <FormControl><Input {...field} className="uppercase" placeholder="e.g. PF" maxLength={16} /></FormControl>
                  <FormMessage/>
                </FormItem>
              )} />
              <FormField control={form.control} name="waterDistrict" render={({ field }) => (
                <FormItem className="col-span-2">
                  <div className="flex items-center justify-between">
                    <FormLabel>Water District</FormLabel>
                    <WaterProviderLookupLink />
                  </div>
                  <FormControl><Input {...field} placeholder="e.g. Whitworth Water District No. 2" /></FormControl>
                  <FormMessage/>
                </FormItem>
              )} />
              <FormField control={form.control} name="status" render={({ field }) => (
                <FormItem><FormLabel>Status</FormLabel>
                  <select
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    {...field}
                  >
                    <option value="lead">Lead</option>
                    <option value="client">Active Client</option>
                  </select>
                <FormMessage/></FormItem>
              )} />
            </div>
            <DialogFooter className="pt-4">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={createClient.isPending}>
                {createClient.isPending ? "Creating..." : "Save Client"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
