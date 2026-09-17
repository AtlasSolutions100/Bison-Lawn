import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  useListClientServices,
  getListClientServicesQueryKey,
  useCreateClientService,
  useUpdateClientService,
  useDeleteClientService,
  usePauseClientService,
  useResumeClientService,
  useRenewClientService,
  useListClientServiceJobs,
  usePreviewClientServicePrice,
  useListServices,
  useListPackages,
  useListUsers,
  type ClientService,
  type ClientServicePrice,
  type Job,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import { contractorColor, initialsOf } from '@/lib/contractor-color';
import { format, parseISO } from 'date-fns';
import {
  AlertTriangle,
  Calendar,
  ChevronDown,
  ChevronRight,
  Clock,
  Pause,
  Play,
  Plus,
  RefreshCw,
  StickyNote,
  Timer,
  Trash2,
} from 'lucide-react';

/**
 * The services on a customer's account, the way he works them in his old
 * CRM's "assigned services" screen: click the row to open it (P24), change
 * the contractor, the cadence, the price, the discount, the crew note, pause
 * it, and see what is ahead and what was done — all without leaving the
 * account. Everything here talks to routes/client-services.ts.
 */

type ScheduleType = 'window' | 'recurring' | 'one_time' | 'contract';
type Frequency = 'weekly' | 'biweekly' | 'monthly';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const NTH = ['', '1st', '2nd', '3rd', '4th'];

const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dayLabel = (d: string) => format(parseISO(d), 'MMM d, yyyy');

const selectClass =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** What the server said went wrong, in its words, or the generic one. */
function errText(e: unknown, fallback: string): string {
  const err = e as { data?: { error?: string }; message?: string } | null;
  return err?.data?.error || err?.message || fallback;
}

/** ISO-8601 week parity, the same arithmetic as the server so the label agrees. */
function weekParityOf(isoDate: string): 'odd' | 'even' {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
  return week % 2 === 0 ? 'even' : 'odd';
}

function weekdayOf(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay();
}

function weekOfMonthOf(isoDate: string): number {
  return Math.min(4, Math.ceil(Number(isoDate.slice(8, 10)) / 7));
}

// ---------------------------------------------------------------- form ----

type Draft = {
  scheduleType: ScheduleType;
  assignedToId: string;
  // '' means the row's own "every N weeks" — a cadence the three named ones
  // cannot say. Coercing it to weekly quadrupled a customer's mows.
  frequency: Frequency | '';
  frequencyWeeks: string;
  weekday: string;
  weekParity: 'odd' | 'even';
  monthlyWeek: string;
  firstServiceDate: string;
  seasonEndDate: string;
  startDate: string;
  endDate: string;
  renewDate: string;
  amount: string;
  quantity: string;
  budgetedHours: string;
  discountType: '' | 'amount' | 'percent';
  discountValue: string;
  discountLabel: string;
  contractorNote: string;
  noteStartDate: string;
  noteEndDate: string;
  autoRenew: boolean;
  active: boolean;
  contractMonths: '8' | '12';
  contractTotal: string;
};

const EMPTY_DRAFT: Draft = {
  scheduleType: 'recurring',
  assignedToId: '',
  frequency: 'weekly',
  frequencyWeeks: '1',
  weekday: '',
  weekParity: 'odd',
  monthlyWeek: '1',
  firstServiceDate: '',
  seasonEndDate: '',
  startDate: '',
  endDate: '',
  renewDate: '',
  amount: '',
  quantity: '1',
  budgetedHours: '',
  discountType: '',
  discountValue: '',
  discountLabel: '',
  contractorNote: '',
  noteStartDate: '',
  noteEndDate: '',
  autoRenew: true,
  active: true,
  contractMonths: '12',
  contractTotal: '',
};

function draftFrom(cs: ClientService): Draft {
  return {
    scheduleType: cs.scheduleType as ScheduleType,
    assignedToId: cs.assignedToId != null ? String(cs.assignedToId) : '',
    frequency:
      (cs.frequency as Frequency | null) ??
      (cs.frequencyWeeks == null || cs.frequencyWeeks === 1 ? 'weekly' : cs.frequencyWeeks === 2 ? 'biweekly' : ''),
    frequencyWeeks: String(cs.frequencyWeeks ?? 1),
    weekday: cs.weekday != null ? String(cs.weekday) : cs.firstServiceDate ? String(weekdayOf(cs.firstServiceDate)) : '',
    weekParity: (cs.weekParity as 'odd' | 'even' | null) ?? (cs.firstServiceDate ? weekParityOf(cs.firstServiceDate) : 'odd'),
    monthlyWeek: String(cs.monthlyWeek ?? (cs.firstServiceDate ? weekOfMonthOf(cs.firstServiceDate) : 1)),
    firstServiceDate: cs.firstServiceDate ?? '',
    seasonEndDate: cs.seasonEndDate ?? '',
    startDate: cs.startDate ?? '',
    endDate: cs.endDate ?? '',
    renewDate: cs.renewDate ?? '',
    amount: String(cs.amount),
    quantity: String(cs.quantity),
    budgetedHours: cs.budgetedHours != null ? String(cs.budgetedHours) : '',
    discountType: (cs.discountType as 'amount' | 'percent' | null) ?? '',
    discountValue: cs.discountValue != null ? String(cs.discountValue) : '',
    discountLabel: cs.discountLabel ?? '',
    contractorNote: cs.contractorNote ?? '',
    noteStartDate: cs.noteStartDate ?? '',
    noteEndDate: cs.noteEndDate ?? '',
    autoRenew: cs.autoRenew,
    active: cs.active,
    contractMonths: cs.contractMonths === 8 ? '8' : '12',
    contractTotal: cs.contractTotal != null ? String(cs.contractTotal) : '',
  };
}

const num = (s: string): number | null => (s.trim() === '' ? null : Number.isFinite(Number(s)) ? Number(s) : null);

/** The request body a draft turns into; the same shape for assign and edit. */
function payloadFrom(d: Draft) {
  const recurring = d.scheduleType === 'recurring';
  return {
    scheduleType: d.scheduleType,
    assignedToId: d.assignedToId ? Number(d.assignedToId) : null,
    frequency: recurring && d.frequency ? d.frequency : null,
    // Only sent for the every-N-weeks rows; the server works it out from the
    // named cadence for the others.
    frequencyWeeks: recurring && !d.frequency ? (num(d.frequencyWeeks) ?? 1) : null,
    weekday: recurring && d.frequency && d.weekday !== '' ? Number(d.weekday) : null,
    weekParity: recurring && d.frequency === 'biweekly' ? d.weekParity : null,
    monthlyWeek: recurring && d.frequency === 'monthly' ? Number(d.monthlyWeek) : null,
    firstServiceDate: d.scheduleType === 'window' ? null : d.firstServiceDate || null,
    seasonEndDate: recurring ? d.seasonEndDate || null : null,
    startDate: d.scheduleType === 'window' ? d.startDate || null : null,
    endDate: d.scheduleType === 'window' ? d.endDate || null : null,
    renewDate: d.renewDate || null,
    quantity: num(d.quantity) ?? 1,
    budgetedHours: num(d.budgetedHours),
    discountType: d.discountType || null,
    discountValue: d.discountType ? num(d.discountValue) : null,
    discountLabel: d.discountType ? d.discountLabel.trim() || null : null,
    contractorNote: d.contractorNote.trim() || null,
    noteStartDate: d.contractorNote.trim() ? d.noteStartDate || null : null,
    noteEndDate: d.contractorNote.trim() ? d.noteEndDate || null : null,
    autoRenew: d.autoRenew,
    contractMonths: d.scheduleType === 'contract' ? Number(d.contractMonths) : null,
    contractTotal: d.scheduleType === 'contract' ? num(d.contractTotal) : null,
  };
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <label className="text-sm font-medium mb-1 block">{label}</label>
      {children}
      {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
    </div>
  );
}

/**
 * The fields shared by "assign" and "edit". `billingMode` decides whether the
 * price box is per visit or per hour; `priceNote` is where the number came
 * from (the matrix and which measurement), shown right under it so he never
 * has to wonder whether the rate filled in.
 */
function ServiceForm({
  draft,
  set,
  billingMode,
  priceNote,
  contractors,
  showOnOff,
}: {
  draft: Draft;
  set: (patch: Partial<Draft>) => void;
  billingMode: 'fixed' | 'time';
  priceNote?: React.ReactNode;
  contractors: { id: number; name: string }[];
  showOnOff: boolean;
}) {
  const recurring = draft.scheduleType === 'recurring';
  // The first visit date says which weekday and which week it is; typing it
  // fills the cadence in, and he can still change it by hand after.
  const onFirstDate = (value: string) => {
    const patch: Partial<Draft> = { firstServiceDate: value };
    if (value) {
      patch.weekday = String(weekdayOf(value));
      patch.weekParity = weekParityOf(value);
      patch.monthlyWeek = String(weekOfMonthOf(value));
    }
    set(patch);
  };

  const amt = num(draft.amount) ?? 0;
  const retail = billingMode === 'time' ? amt * (num(draft.budgetedHours) ?? 0) : draft.scheduleType === 'contract' ? (num(draft.contractTotal) ?? 0) / Number(draft.contractMonths) : amt;
  const disc = !draft.discountType ? 0 : draft.discountType === 'percent' ? (retail * (num(draft.discountValue) ?? 0)) / 100 : (num(draft.discountValue) ?? 0);
  const net = Math.max(0, retail - Math.min(disc, retail));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Schedule">
          <select
            className={selectClass}
            value={draft.scheduleType}
            onChange={e => {
              const scheduleType = e.target.value as ScheduleType;
              // A one-time job and a contract finish; they only come back if
              // he switches auto-renew on himself.
              set({ scheduleType, autoRenew: scheduleType !== 'one_time' && scheduleType !== 'contract' });
            }}
          >
            <option value="recurring">Recurring (weekly / bi-weekly / monthly)</option>
            <option value="window">Waiting list (date window)</option>
            <option value="one_time">One time</option>
            <option value="contract">Contract (annual amount, monthly lines)</option>
          </select>
        </Field>
        <Field label="Contractor" hint={recurring ? 'Every visit lands on this person’s board.' : undefined}>
          <select className={selectClass} value={draft.assignedToId} onChange={e => set({ assignedToId: e.target.value })}>
            <option value="">Not assigned yet</option>
            {contractors.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </Field>
      </div>

      {recurring && (
        <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="First visit">
              <Input type="date" value={draft.firstServiceDate} onChange={e => onFirstDate(e.target.value)} required />
            </Field>
            <Field label="How often">
              <select className={selectClass} value={draft.frequency} onChange={e => set({ frequency: e.target.value as Frequency | '' })}>
                <option value="weekly">Weekly</option>
                <option value="biweekly">Every other week</option>
                <option value="monthly">Monthly</option>
                {draft.frequency === '' && <option value="">Every {draft.frequencyWeeks} weeks (as set)</option>}
              </select>
            </Field>
            <Field label="Season end" hint="Blank runs to Dec 31, then auto-renews.">
              <Input type="date" value={draft.seasonEndDate} onChange={e => set({ seasonEndDate: e.target.value })} />
            </Field>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Day of the week">
              <select className={selectClass} value={draft.weekday} onChange={e => set({ weekday: e.target.value })}>
                <option value="">From the first visit</option>
                {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            </Field>
            {draft.frequency === 'biweekly' && (
              <Field label="Which weeks" hint="Odd / even by the week number of the year, like his board shows.">
                <select className={selectClass} value={draft.weekParity} onChange={e => set({ weekParity: e.target.value as 'odd' | 'even' })}>
                  <option value="odd">Odd weeks</option>
                  <option value="even">Even weeks</option>
                </select>
              </Field>
            )}
            {draft.frequency === 'monthly' && (
              <Field label="Week of the month">
                <select className={selectClass} value={draft.monthlyWeek} onChange={e => set({ monthlyWeek: e.target.value })}>
                  {[1, 2, 3, 4].map(n => <option key={n} value={n}>{NTH[n]} week</option>)}
                </select>
              </Field>
            )}
            <div className="sm:col-span-1 flex items-end">
              <p className="text-sm text-muted-foreground pb-2">
                {draft.frequency === ''
                  ? `Every ${draft.frequencyWeeks} weeks from the first visit`
                  : draft.weekday !== '' && (
                      draft.frequency === 'weekly'
                        ? `Every ${WEEKDAYS[Number(draft.weekday)]}`
                        : draft.frequency === 'biweekly'
                          ? `Every other ${WEEKDAYS[Number(draft.weekday)]}, ${draft.weekParity} weeks`
                          : `The ${NTH[Number(draft.monthlyWeek)]} ${WEEKDAYS[Number(draft.weekday)]} each month`
                    )}
              </p>
            </div>
          </div>
        </div>
      )}

      {draft.scheduleType === 'window' && (
        <div className="grid grid-cols-2 gap-4">
          <Field label="Window start">
            <Input type="date" value={draft.startDate} onChange={e => set({ startDate: e.target.value })} required />
          </Field>
          <Field label="Window end" hint="It shows on the waiting list only for days inside the window.">
            <Input type="date" value={draft.endDate} onChange={e => set({ endDate: e.target.value })} required />
          </Field>
        </div>
      )}

      {draft.scheduleType === 'one_time' && (
        <Field label="Service date (blank leaves it undispatched)">
          <Input type="date" value={draft.firstServiceDate} onChange={e => set({ firstServiceDate: e.target.value })} />
        </Field>
      )}

      {draft.scheduleType === 'contract' && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Field label="Annual amount ($)">
            <Input type="number" step="0.01" min="0" value={draft.contractTotal} onChange={e => set({ contractTotal: e.target.value })} required />
          </Field>
          <Field label="Split over">
            <select className={selectClass} value={draft.contractMonths} onChange={e => set({ contractMonths: e.target.value as '8' | '12' })}>
              <option value="12">12 months</option>
              <option value="8">8 months</option>
            </select>
          </Field>
          <Field label="First payment date" hint="One invoice line a month from here; the office completes each to bill it.">
            <Input type="date" value={draft.firstServiceDate} onChange={e => set({ firstServiceDate: e.target.value })} required />
          </Field>
        </div>
      )}

      {draft.scheduleType !== 'contract' && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Field label={billingMode === 'time' ? 'Hourly rate ($)' : 'Price per visit ($)'}>
            <Input type="number" step="0.01" min="0" value={draft.amount} onChange={e => set({ amount: e.target.value })} required />
            {priceNote}
          </Field>
          <Field label="Billable hours" hint={billingMode === 'time' ? 'The estimate; the clock sets the real hours.' : undefined}>
            <Input type="number" step="0.25" min="0" value={draft.budgetedHours} onChange={e => set({ budgetedHours: e.target.value })} />
          </Field>
          <Field label="Quantity">
            <Input type="number" step="1" min="1" value={draft.quantity} onChange={e => set({ quantity: e.target.value })} />
          </Field>
        </div>
      )}

      <div className="rounded-lg border p-3 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="Discount">
            <select className={selectClass} value={draft.discountType} onChange={e => set({ discountType: e.target.value as Draft['discountType'] })}>
              <option value="">None</option>
              <option value="amount">Dollars off each visit</option>
              <option value="percent">Percent off</option>
            </select>
          </Field>
          {draft.discountType && (
            <>
              <Field label={draft.discountType === 'percent' ? 'Percent' : 'Amount ($)'}>
                <Input type="number" step="0.01" min="0" value={draft.discountValue} onChange={e => set({ discountValue: e.target.value })} required />
              </Field>
              <Field label="Shows on the invoice as" hint="Its own line, under the service.">
                <Input value={draft.discountLabel} placeholder="Loyalty discount" onChange={e => set({ discountLabel: e.target.value })} />
              </Field>
            </>
          )}
        </div>
        {(draft.discountType || billingMode === 'time' || draft.scheduleType === 'contract') && (
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <span className="text-muted-foreground">Retail <b className="text-foreground">{money(retail)}</b>{billingMode === 'time' ? ' (rate x hours)' : draft.scheduleType === 'contract' ? ' a month' : ' a visit'}</span>
            {draft.discountType && <span className="text-muted-foreground">Discount <b className="text-foreground">-{money(Math.min(disc, retail))}</b></span>}
            <span className="text-muted-foreground">Customer pays <b className="text-primary">{money(net)}</b></span>
          </div>
        )}
      </div>

      <div className="rounded-lg border p-3 space-y-3">
        <Field label="Note the contractor must read before starting" hint="Start stays locked on their phone until they open it.">
          <Textarea rows={2} value={draft.contractorNote} placeholder="Gate code is 4412. Dog in the back yard — text first." onChange={e => set({ contractorNote: e.target.value })} />
        </Field>
        {draft.contractorNote.trim() && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Note applies from" hint="Blank means every visit.">
              <Input type="date" value={draft.noteStartDate} onChange={e => set({ noteStartDate: e.target.value })} />
            </Field>
            <Field label="Until">
              <Input type="date" value={draft.noteEndDate} onChange={e => set({ noteEndDate: e.target.value })} />
            </Field>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-6">
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={draft.autoRenew} onCheckedChange={v => set({ autoRenew: v })} />
          Auto-renew each year
        </label>
        {showOnOff && (
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={draft.active} onCheckedChange={v => set({ active: v })} />
            {draft.active ? 'On — visits go on the board' : 'Off — no visits are made'}
          </label>
        )}
        <Field label="Renew date (optional)">
          <Input type="date" className="h-8" value={draft.renewDate} onChange={e => set({ renewDate: e.target.value })} />
        </Field>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- assign ----

function AssignDialog({ clientId, contractors, onDone }: { clientId: number; contractors: { id: number; name: string }[]; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const { data: services } = useListServices();
  const { data: packages } = useListPackages();
  const create = useCreateClientService();
  const preview = usePreviewClientServicePrice();
  const { toast } = useToast();

  const [type, setType] = useState<'service' | 'package'>('service');
  const [itemId, setItemId] = useState('');
  const [sqft, setSqft] = useState('');
  const [priced, setPriced] = useState<ClientServicePrice | null>(null);
  const [priceTouched, setPriceTouched] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const set = (patch: Partial<Draft>) => setDraft(d => ({ ...d, ...patch }));
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setType('service'); setItemId(''); setSqft(''); setPriced(null); setPriceTouched(false); setDraft(EMPTY_DRAFT); setError(null);
  };

  const service = type === 'service' ? services?.find(s => String(s.id) === itemId) : undefined;
  const billingMode: 'fixed' | 'time' = service?.billingMode === 'time' ? 'time' : 'fixed';

  // The price fills in the moment a service is picked — from the customer's
  // own Turf Sqft (or zones) through the matrix. His old CRM left this at
  // 0.00 and he had to go look it up; that is the thing this must not do.
  useEffect(() => {
    if (type !== 'service' || !itemId) { setPriced(null); return; }
    const typed = num(sqft);
    preview.mutate(
      { id: clientId, data: { serviceId: Number(itemId), sqft: typed && typed > 0 ? typed : null, quantity: num(draft.quantity) } },
      {
        onSuccess: (p) => {
          setPriced(p);
          setDraft(d => ({
            ...d,
            amount: priceTouched ? d.amount : String(p.amount),
            budgetedHours: d.budgetedHours || (p.budgetedHours != null ? String(p.budgetedHours) : ''),
            // A service's own season window prefills the waiting-list dates
            // (P17), rolled to this year.
            startDate: d.startDate || rollToThisYear(p.defaultStartDate),
            endDate: d.endDate || rollToThisYear(p.defaultEndDate),
            renewDate: d.renewDate || (p.renewDate ?? ''),
          }));
        },
      },
    );
  }, [type, itemId, sqft, draft.quantity]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickPackage = (value: string) => {
    setItemId(value);
    const pkg = packages?.find(p => String(p.id) === value);
    if (!pkg) return;
    setDraft(d => {
      const scheduleType = (pkg.scheduleType as ScheduleType | null) ?? d.scheduleType;
      return {
      ...d,
      scheduleType,
      autoRenew: scheduleType !== 'one_time' && scheduleType !== 'contract',
      startDate: pkg.startDate ?? '',
      endDate: pkg.endDate ?? '',
      firstServiceDate: pkg.startDate ?? '',
      frequency:
        pkg.frequencyWeeks == null || pkg.frequencyWeeks === 1 ? 'weekly' : pkg.frequencyWeeks === 2 ? 'biweekly' : '',
      frequencyWeeks: String(pkg.frequencyWeeks ?? 1),
      seasonEndDate: pkg.seasonEndDate ?? '',
      renewDate: pkg.renewDate ?? '',
      weekday: pkg.startDate ? String(weekdayOf(pkg.startDate)) : '',
      weekParity: pkg.startDate ? weekParityOf(pkg.startDate) : 'odd',
      };
    });
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const body = payloadFrom(draft);
    const amount = num(draft.amount);
    create.mutate(
      {
        id: clientId,
        data: {
          ...body,
          ...(type === 'service' ? { serviceId: Number(itemId) } : { packageId: Number(itemId) }),
          // A package prices each member itself; a single service takes the
          // number in the box (matrix-filled or typed).
          ...(type === 'service' && amount != null && draft.scheduleType !== 'contract' ? { amount } : {}),
          ...(num(sqft) ? { sqft: num(sqft) } : {}),
        },
      },
      {
        onSuccess: (rows) => {
          onDone();
          toast({ title: rows.length > 1 ? `${rows.length} services assigned` : 'Service assigned', description: rows.map(r => `${r.serviceName}: ${r.cadenceLabel}`).join(' · ') });
          setOpen(false);
          reset();
        },
        onError: (err) => setError(errText(err, 'Check the schedule and try again.')),
      },
    );
  };

  const priceNote = priced && type === 'service' ? (
    priced.missingField ? (
      <p className="text-xs text-destructive mt-1 flex items-start gap-1">
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        Priced from {priced.missingField}, and this customer has no {priced.missingField} on file. Add it under Property Details, type it below, or type a price.
      </p>
    ) : priced.pricedFromLabel ? (
      <p className="text-xs text-primary mt-1">
        From the matrix: {priced.pricedFromLabel} {priced.pricedFromValue?.toLocaleString()}
        {priceTouched && ` (matrix said ${money(priced.amount)})`}
      </p>
    ) : (
      <p className="text-xs text-muted-foreground mt-1">{billingMode === 'time' ? 'The service’s hourly rate.' : 'The service’s flat rate.'}</p>
    )
  ) : null;

  return (
    <>
      <Button size="sm" className="h-8" onClick={() => setOpen(true)}>
        <Plus className="w-4 h-4 mr-1" /> Assign service
      </Button>
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Assign a service or package</DialogTitle>
            <DialogDescription>The price fills in from the customer’s own measurements. Change anything before saving.</DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Field label="What">
                <select className={selectClass} value={type} onChange={e => { setType(e.target.value as 'service' | 'package'); setItemId(''); setPriced(null); }}>
                  <option value="service">One service</option>
                  <option value="package">A package</option>
                </select>
              </Field>
              <div className="sm:col-span-2">
                <Field label={type === 'service' ? 'Service' : 'Package'}>
                  <select className={selectClass} value={itemId} onChange={e => (type === 'service' ? setItemId(e.target.value) : pickPackage(e.target.value))} required>
                    <option value="">Select...</option>
                    {type === 'service'
                      ? services?.map(s => <option key={s.id} value={s.id}>{s.name}{s.code ? ` (${s.code})` : ''}{s.billingMode === 'time' ? ' — by the hour' : ''}</option>)
                      : packages?.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </Field>
              </div>
            </div>

            {type === 'service' && itemId && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 rounded-lg border bg-muted/30 p-3">
                <Field label={`${priced?.pricedFromLabel ?? priced?.missingField ?? 'Measurement'} (type to price against a different number)`}>
                  <Input type="number" min="0" value={sqft} placeholder={priced?.pricedFromValue != null ? String(priced.pricedFromValue) : 'On file'} onChange={e => setSqft(e.target.value)} />
                </Field>
                <div>
                  <label className="text-sm font-medium mb-1 block">Matrix price</label>
                  <div className="h-10 flex items-center px-3 font-bold text-lg bg-background border rounded-md text-primary">
                    {preview.isPending ? '…' : priced ? `${money(priced.amount)}${billingMode === 'time' ? '/hr' : ''}` : '--'}
                  </div>
                </div>
              </div>
            )}

            <ServiceForm
              draft={draft}
              set={(patch) => { if ('amount' in patch) setPriceTouched(true); set(patch); }}
              billingMode={billingMode}
              priceNote={priceNote}
              contractors={contractors}
              showOnOff={false}
            />

            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={!itemId || create.isPending}>{create.isPending ? 'Saving…' : 'Assign'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A service's default window is a month-and-day; put it in the current year. */
function rollToThisYear(value: string | null | undefined): string {
  if (!value) return '';
  const year = new Date().getFullYear();
  return `${year}${value.slice(4)}`;
}

// ---------------------------------------------------------------- edit ----

function EditDialog({
  cs,
  contractors,
  onClose,
  onDone,
}: {
  cs: ClientService;
  contractors: { id: number; name: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const update = useUpdateClientService();
  const remove = useDeleteClientService();
  const pause = usePauseClientService();
  const resume = useResumeClientService();
  const renew = useRenewClientService();
  const { toast } = useToast();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(cs));
  const set = (patch: Partial<Draft>) => setDraft(d => ({ ...d, ...patch }));
  const [error, setError] = useState<string | null>(null);
  const [pausing, setPausing] = useState(false);
  const [pauseReason, setPauseReason] = useState('');
  const [pauseUntil, setPauseUntil] = useState('');
  const [resumeWhenPaid, setResumeWhenPaid] = useState(false);
  const [wholePackage, setWholePackage] = useState(false);
  const busy = update.isPending || remove.isPending || pause.isPending || resume.isPending || renew.isPending;

  const fail = (e: unknown) => setError(errText(e, 'Could not save. Check the schedule and try again.'));

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const body = payloadFrom(draft);
    const amount = num(draft.amount);
    update.mutate(
      { id: cs.id, data: { ...body, ...(amount != null && draft.scheduleType !== 'contract' ? { amount } : {}), active: draft.active } },
      {
        onSuccess: (row) => { onDone(); toast({ title: 'Saved', description: `${row.serviceName}: ${row.cadenceLabel}` }); onClose(); },
        onError: fail,
      },
    );
  };

  const doPause = () => {
    setError(null);
    pause.mutate(
      { id: cs.id, data: { reason: pauseReason || null, pauseUntil: pauseUntil || null, resumeWhenPaid, wholePackage } },
      {
        onSuccess: () => { onDone(); toast({ title: 'Paused', description: 'Upcoming visits are off the board until it resumes.' }); onClose(); },
        onError: fail,
      },
    );
  };

  const doResume = () => {
    setError(null);
    resume.mutate({ id: cs.id }, {
      onSuccess: () => { onDone(); toast({ title: 'Resumed', description: 'Visits are back on the board from today.' }); onClose(); },
      onError: fail,
    });
  };

  const doRenew = () => {
    if (!window.confirm('Roll this service into next season now? Dates move one year and next season’s visits go on the board.')) return;
    setError(null);
    renew.mutate({ id: cs.id }, {
      onSuccess: (row) => { onDone(); toast({ title: 'Renewed', description: `Now ${row.firstServiceDate ?? row.startDate ?? ''} onward.` }); onClose(); },
      onError: fail,
    });
  };

  const doRemove = () => {
    if (!window.confirm(`Remove ${cs.serviceName} from this account? Visits not yet done come off the board; history stays.`)) return;
    remove.mutate({ id: cs.id }, {
      onSuccess: () => { onDone(); toast({ title: 'Removed' }); onClose(); },
      onError: fail,
    });
  };

  const billingMode: 'fixed' | 'time' = cs.billingMode === 'time' ? 'time' : 'fixed';
  const priceNote = cs.pricedFromLabel && draft.amount === String(cs.amount)
    ? <p className="text-xs text-primary mt-1">From the matrix: {cs.pricedFromLabel} {cs.pricedFromValue?.toLocaleString()}</p>
    : null;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{cs.label || cs.serviceName}{cs.packageName ? <span className="text-muted-foreground font-normal"> · {cs.packageName}</span> : null}</DialogTitle>
          <DialogDescription>
            {cs.pausedAt
              ? `Paused ${cs.pauseUntil ? `until ${dayLabel(cs.pauseUntil)}` : cs.resumeWhenPaid ? 'until the account is paid' : ''}${cs.pauseReason ? ` — ${cs.pauseReason}` : ''}.`
              : 'Changes reach the visits still ahead; done visits keep what they were billed.'}
          </DialogDescription>
        </DialogHeader>

        {pausing ? (
          <div className="space-y-4">
            <Field label="Why (optional)">
              <Input value={pauseReason} placeholder="Waiting on payment" onChange={e => setPauseReason(e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Resume on" hint="The nightly check puts it back that day.">
                <Input type="date" value={pauseUntil} onChange={e => setPauseUntil(e.target.value)} />
              </Field>
              <div className="space-y-3 pt-6">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={resumeWhenPaid} onCheckedChange={v => setResumeWhenPaid(v === true)} /> Resume when the account is paid
                </label>
                {cs.packageId != null && (
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={wholePackage} onCheckedChange={v => setWholePackage(v === true)} /> Pause the whole {cs.packageName ?? 'package'}
                  </label>
                )}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">With neither set it stays paused until someone presses Resume.</p>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setPausing(false)}>Back</Button>
              <Button type="button" onClick={doPause} disabled={busy}><Pause className="w-4 h-4 mr-1" /> {pause.isPending ? 'Pausing…' : 'Pause'}</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={save} className="space-y-4">
            <ServiceForm draft={draft} set={set} billingMode={billingMode} priceNote={priceNote} contractors={contractors} showOnOff />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex flex-wrap gap-2 border-t pt-4">
              {cs.pausedAt ? (
                <Button type="button" variant="outline" onClick={doResume} disabled={busy}><Play className="w-4 h-4 mr-1" /> Resume</Button>
              ) : (
                <Button type="button" variant="outline" onClick={() => setPausing(true)} disabled={busy}><Pause className="w-4 h-4 mr-1" /> Pause…</Button>
              )}
              <Button type="button" variant="outline" onClick={doRenew} disabled={busy}><RefreshCw className="w-4 h-4 mr-1" /> Renew now</Button>
              <Button type="button" variant="ghost" className="text-destructive hover:text-destructive ml-auto" onClick={doRemove} disabled={busy}><Trash2 className="w-4 h-4 mr-1" /> Remove</Button>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={busy}>{update.isPending ? 'Saving…' : 'Save'}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- visits ----

function VisitRow({ j }: { j: Job }) {
  const day = j.scheduledDate ?? (j.windowStart ? `${j.windowStart} → ${j.windowEnd}` : null);
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <div className="flex items-center gap-2 min-w-0">
        <span className="tabular-nums whitespace-nowrap">{day ? (day.includes('→') ? day : dayLabel(day)) : 'No date'}</span>
        {j.assignedToName && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <span className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold text-white" style={{ background: contractorColor(j.assignedToId) }}>{initialsOf(j.assignedToName)}</span>
            {j.assignedToName}
          </span>
        )}
        {!j.dispatched && <span className="text-xs text-muted-foreground">waiting list</span>}
        {j.status === 'skipped' && <span className="text-xs text-destructive">skipped{j.skipReason ? ` — ${j.skipReason}` : ''}</span>}
        {j.status === 'in_progress' && <span className="text-xs text-accent-foreground">in progress</span>}
      </div>
      <div className="flex items-center gap-3 whitespace-nowrap">
        {j.status === 'completed' && j.billingMode === 'time' && j.clockedMinutes != null && j.clockedMinutes > 0 && (
          <span className="text-xs text-muted-foreground"><Timer className="inline w-3 h-3 mr-0.5" />{(j.clockedMinutes / 60).toFixed(2)} h</span>
        )}
        <span className="tabular-nums font-medium">{money(j.amount)}{j.discountAmount ? <span className="text-xs text-muted-foreground"> −{money(j.discountAmount)}</span> : null}</span>
        {j.invoiceId && <Link href={`/invoices?invoiceId=${j.invoiceId}`} className="text-xs text-primary hover:underline">invoice</Link>}
      </div>
    </div>
  );
}

function Visits({ csId }: { csId: number }) {
  const { data, isLoading } = useListClientServiceJobs(csId);
  if (isLoading) return <p className="text-sm text-muted-foreground animate-pulse px-4 pb-3">Loading visits…</p>;
  const upcoming = data?.upcoming ?? [];
  const history = data?.history ?? [];
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 px-4 pb-4">
      <div>
        <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Upcoming ({upcoming.length})</div>
        {upcoming.length === 0 ? <p className="text-sm text-muted-foreground">Nothing ahead.</p> : (
          <div className="divide-y max-h-64 overflow-y-auto">{upcoming.map(j => <VisitRow key={j.id} j={j} />)}</div>
        )}
      </div>
      <div>
        <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1">History ({history.length})</div>
        {history.length === 0 ? <p className="text-sm text-muted-foreground">No visits done yet.</p> : (
          <div className="divide-y max-h-64 overflow-y-auto">{history.map(j => <VisitRow key={j.id} j={j} />)}</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- rows ----

function Tag({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'warn' | 'good' | 'off' }) {
  const cls = {
    muted: 'bg-muted text-muted-foreground border-border',
    warn: 'bg-orange-50 text-orange-800 border-orange-200',
    good: 'bg-primary/10 text-primary border-primary/20',
    off: 'bg-destructive/10 text-destructive border-destructive/20',
  }[tone];
  return <span className={`inline-block whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-semibold ${cls}`}>{children}</span>;
}

function ServiceRow({ cs, expanded, onToggle, onOpen, onSwitch }: {
  cs: ClientService;
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onSwitch: (on: boolean) => void;
}) {
  const dim = !cs.active || cs.pausedAt;
  const renewedYear = cs.lastRenewedAt ? new Date(cs.lastRenewedAt).getFullYear() : null;
  return (
    <div className={dim ? 'opacity-70' : ''}>
      <div className="flex items-start gap-3 p-4 hover:bg-muted/30 transition-colors cursor-pointer" onClick={onOpen} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') onOpen(); }}>
        <button type="button" className="mt-0.5 text-muted-foreground hover:text-foreground" onClick={e => { e.stopPropagation(); onToggle(); }} aria-label="Show visits">
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="font-bold text-foreground">{cs.label || cs.serviceName}</h4>
            {cs.serviceCode && <span className="text-xs font-mono text-muted-foreground">{cs.serviceCode}</span>}
            {cs.billingMode === 'time' && <Tag><Timer className="inline w-3 h-3 mr-0.5" />by the hour</Tag>}
            {!cs.active && <Tag tone="off">Off</Tag>}
            {cs.pausedAt && <Tag tone="warn">Paused{cs.pauseUntil ? ` until ${format(parseISO(cs.pauseUntil), 'MMM d')}` : cs.resumeWhenPaid ? ' until paid' : ''}</Tag>}
            {cs.contractorNote && <Tag tone={cs.noteActiveToday ? 'good' : 'muted'}><StickyNote className="inline w-3 h-3 mr-0.5" />crew note</Tag>}
            {!cs.autoRenew && <Tag>no auto-renew</Tag>}
            {renewedYear != null && <Tag tone="good">renewed {renewedYear}</Tag>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5" /> {cs.cadenceLabel}{cs.scheduleType === 'window' && cs.startDate ? `: ${format(parseISO(cs.startDate), 'MMM d')} – ${cs.endDate ? format(parseISO(cs.endDate), 'MMM d') : ''}` : ''}</span>
            <span className="flex items-center gap-1">
              <span className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold text-white" style={{ background: contractorColor(cs.assignedToId) }}>{cs.assignedToName ? initialsOf(cs.assignedToName) : '?'}</span>
              {cs.assignedToName ?? 'Not assigned'}
            </span>
            {cs.nextDate && <span className="flex items-center gap-1"><Calendar className="w-3.5 h-3.5" /> next {dayLabel(cs.nextDate)}</span>}
            <span>{cs.upcomingCount} ahead · {cs.completedCount} done</span>
          </div>
          {cs.pauseReason && cs.pausedAt && <p className="mt-1 text-xs text-orange-800">{cs.pauseReason}</p>}
        </div>
        <div className="text-right shrink-0" onClick={e => e.stopPropagation()}>
          <div className="font-bold tabular-nums">
            {cs.discountAmount > 0 ? (
              <>
                <span className="text-muted-foreground line-through text-sm font-normal mr-1">{money(cs.retailAmount)}</span>
                {money(cs.netAmount)}
              </>
            ) : money(cs.retailAmount)}
            <span className="text-xs text-muted-foreground font-normal">{cs.scheduleType === 'contract' ? '/mo' : cs.billingMode === 'time' ? ' est.' : '/visit'}</span>
          </div>
          {cs.discountAmount > 0 && <div className="text-xs text-muted-foreground">−{money(cs.discountAmount)} {cs.discountLabel ?? 'discount'}</div>}
          {cs.billingMode === 'time' && <div className="text-xs text-muted-foreground">{money(cs.amount)}/hr × {cs.budgetedHours ?? 0} h</div>}
          {cs.pricedFromLabel && <div className="text-[11px] text-primary">from {cs.pricedFromLabel} {cs.pricedFromValue?.toLocaleString()}</div>}
          <div className="mt-1 flex items-center justify-end gap-2 text-xs text-muted-foreground">
            <span>{cs.active ? 'On' : 'Off'}</span>
            <Switch checked={cs.active} onCheckedChange={onSwitch} aria-label="On or off" />
          </div>
        </div>
      </div>
      {expanded && <Visits csId={cs.id} />}
    </div>
  );
}

// ---------------------------------------------------------------- panel ----

export default function AssignedServicesPanel({ clientId }: { clientId: number }) {
  const { data: rows, isLoading } = useListClientServices(clientId);
  const { data: users } = useListUsers();
  const update = useUpdateClientService();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState<ClientService | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Contractors first, then anyone else who can be sent out (the owner mows too).
  const contractors = useMemo(() => {
    const list = (users ?? []).filter(u => u.active !== false);
    const label = (u: { name: string; displayName?: string | null }) => u.displayName?.trim() || u.name;
    return [...list.filter(u => u.role === 'contractor'), ...list.filter(u => u.role !== 'contractor')].map(u => ({ id: u.id, name: label(u) }));
  }, [users]);

  // The account's services, its jobs, the board and the waiting list all
  // change together, so one refresh reaches every list that shows a visit.
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getListClientServicesQueryKey(clientId) });
    queryClient.invalidateQueries({
      predicate: (q) => {
        const k = String(q.queryKey[0] ?? '');
        return k.startsWith(`/api/clients/${clientId}`) || k.startsWith('/api/client-services') || k.startsWith('/api/jobs') || k.startsWith('/api/waiting-list') || k.startsWith('/api/my/jobs');
      },
    });
  };

  const toggle = (id: number) => setExpanded(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });

  const switchRow = (cs: ClientService, on: boolean) => {
    update.mutate({ id: cs.id, data: { active: on } }, {
      onSuccess: () => { refresh(); toast({ title: on ? `${cs.serviceName} switched on` : `${cs.serviceName} switched off`, description: on ? 'Visits are back on the board.' : 'Upcoming visits came off the board.' }); },
      onError: (e) => toast({ title: 'Could not change it', description: errText(e, ''), variant: 'destructive' }),
    });
  };

  // Rows grouped by package, single services after.
  const groups = useMemo(() => {
    const byPkg = new Map<number | null, ClientService[]>();
    for (const r of rows ?? []) {
      const key = r.packageId ?? null;
      byPkg.set(key, [...(byPkg.get(key) ?? []), r]);
    }
    const packaged = [...byPkg.entries()].filter(([k]) => k != null);
    const single = byPkg.get(null) ?? [];
    return { packaged, single };
  }, [rows]);

  const live = (rows ?? []).filter(r => r.active && !r.pausedAt);
  const totals = {
    retail: live.reduce((s, r) => s + r.retailAmount, 0),
    discount: live.reduce((s, r) => s + r.discountAmount, 0),
    net: live.reduce((s, r) => s + r.netAmount, 0),
    ahead: live.reduce((s, r) => s + r.upcomingCount, 0),
    aheadTotal: live.reduce((s, r) => s + r.upcomingTotal, 0),
  };

  return (
    <Card className="shadow-sm border-border">
      <CardHeader className="pb-3 border-b bg-card/50">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-lg font-bold flex items-center gap-2">
            <Calendar className="w-5 h-5 text-muted-foreground" /> Assigned services
          </CardTitle>
          <AssignDialog clientId={clientId} contractors={contractors} onDone={refresh} />
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="p-6 text-center text-muted-foreground animate-pulse">Loading…</div>
        ) : !rows?.length ? (
          <div className="p-6 text-center text-muted-foreground">Nothing assigned yet. Assign a service to put visits on the board.</div>
        ) : (
          <>
            <div className="divide-y">
              {groups.packaged.map(([pkgId, list]) => (
                <div key={pkgId}>
                  <div className="px-4 pt-3 pb-1 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Package · {list[0].packageName ?? `#${pkgId}`}</div>
                  <div className="divide-y">
                    {list.map(cs => <ServiceRow key={cs.id} cs={cs} expanded={expanded.has(cs.id)} onToggle={() => toggle(cs.id)} onOpen={() => setEditing(cs)} onSwitch={on => switchRow(cs, on)} />)}
                  </div>
                </div>
              ))}
              {groups.single.map(cs => <ServiceRow key={cs.id} cs={cs} expanded={expanded.has(cs.id)} onToggle={() => toggle(cs.id)} onOpen={() => setEditing(cs)} onSwitch={on => switchRow(cs, on)} />)}
            </div>
            <div className="border-t bg-muted/30 px-4 py-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span className="text-muted-foreground">Per visit, all live services: retail <b className="text-foreground">{money(totals.retail)}</b></span>
              {totals.discount > 0 && <span className="text-muted-foreground">discounts <b className="text-foreground">−{money(totals.discount)}</b></span>}
              <span className="text-muted-foreground">customer pays <b className="text-primary">{money(totals.net)}</b></span>
              <span className="text-muted-foreground ml-auto">Ahead on the board: <b className="text-foreground">{totals.ahead} visits · {money(totals.aheadTotal)}</b></span>
            </div>
          </>
        )}
      </CardContent>
      {editing && (
        <EditDialog
          key={editing.id}
          cs={rows?.find(r => r.id === editing.id) ?? editing}
          contractors={contractors}
          onClose={() => setEditing(null)}
          onDone={refresh}
        />
      )}
    </Card>
  );
}
