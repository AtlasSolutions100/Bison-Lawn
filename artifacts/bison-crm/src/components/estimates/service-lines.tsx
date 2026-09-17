import { Fragment } from 'react';
import type { EstimateField, Service, ServicePackage } from '@workspace/api-client-react';
import { AlertCircle, Package, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * The services on an estimate, the way he prices them (2026-09-15
 * walkthrough, B2 and feedback 46/48): the band rate the matrix gives for
 * this property, times the quantity, times the visits — "I type 28 mows and
 * the customer sees the quantity so they can divide the total by the visits".
 * A package drops all of its services in at once, repeats included, and they
 * stay together so the customer can accept the package as one line.
 */

export type ServiceLineDraft = {
  /** Local identity only; never sent. */
  key: number;
  serviceId: number;
  label: string;
  /** The property measurement the matrix prices from (Turf Sqft, zones). */
  value: string;
  /** Blank means the service's own default. */
  quantity: string;
  /** Blank means the service's visits per season, or one. */
  visits: string;
  packageId: number | null;
  packageKey: string | null;
  packageName: string | null;
};

let lineKeySeq = 0;
const nextLineKey = () => ++lineKeySeq;
export const withLineKey = <T extends object>(line: T): T & { key: number } => ({ key: nextLineKey(), ...line });

export const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Which property detail a service prices from. Null pricingFieldId means turf
 * square footage — what every matrix meant before that column existed — so the
 * turf field is found by its label, the same way the server does it.
 */
export function pricingFieldFor(service: Service, fields: EstimateField[] | undefined): EstimateField | null {
  if (!fields) return null;
  if (service.pricingFieldId != null) return fields.find(f => f.id === service.pricingFieldId) ?? null;
  return (
    fields.find(f => /turf/i.test(f.label) && /sq/i.test(f.label)) ??
    fields.find(f => /sq\s?ft|sqft|square/i.test(f.label) && f.fieldType === 'calculable') ??
    null
  );
}

export const hasMatrix = (service: Service) => (service.pricingEquations ?? []).length > 0;

/** Mirrors calculatePrice on the server: the band for `value`, base plus increments. */
export function serviceUnitPrice(service: Service, value: string): { rate: number; fromMatrix: boolean } {
  // Work billed by the hour is quoted at the hours it is budgeted for times the
  // hourly rate, the way the server prices it — the bare $65/hr is not what a
  // three-hour clean-up costs.
  if (service.billingMode === 'time') {
    return { rate: Math.round(service.rate * (service.billableHours ?? 1) * 100) / 100, fromMatrix: false };
  }
  const numeric = Number(value.replace(/,/g, ''));
  const eqs = service.pricingEquations ?? [];
  if (eqs.length > 0 && value.trim() !== '' && Number.isFinite(numeric)) {
    let idx = eqs.findIndex(e => e.upToSqft != null && numeric <= e.upToSqft);
    if (idx === -1) {
      idx = eqs.findIndex(e => e.upToSqft == null);
      if (idx === -1) idx = eqs.length - 1;
    }
    const eq = eqs[idx];
    let price = eq.basePrice;
    if (numeric > eq.baseSqft && eq.incrementSqft > 0) {
      price += Math.ceil((numeric - eq.baseSqft) / eq.incrementSqft) * eq.incrementPrice;
    }
    return { rate: Math.round(price * 100) / 100, fromMatrix: true };
  }
  return { rate: Math.round(service.rate * 100) / 100, fromMatrix: false };
}

/** A typed count, or the fallback when the box is blank. Null when it is not a number. */
export function lineCount(raw: string, fallback: number): number | null {
  if (raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function defaultVisits(service: Service) {
  return service.visitsPerSeason ?? 1;
}

export function serviceLineMath(service: Service, line: ServiceLineDraft) {
  const unit = serviceUnitPrice(service, line.value);
  const quantity = lineCount(line.quantity, service.quantity ?? 1);
  const visits = lineCount(line.visits, defaultVisits(service));
  const valid = quantity != null && visits != null;
  const total = valid ? Math.round(unit.rate * quantity * visits * 100) / 100 : null;
  return { ...unit, quantity, visits, valid, total };
}

export function newServiceLine(
  service: Service,
  value: string,
  pkg?: { id: number; key: string; name: string; label?: string | null },
): ServiceLineDraft {
  return withLineKey({
    serviceId: service.id,
    label: pkg?.label?.trim() || service.name,
    value,
    quantity: '',
    visits: '',
    packageId: pkg?.id ?? null,
    packageKey: pkg?.key ?? null,
    packageName: pkg?.name ?? null,
  });
}

/**
 * Every entry of a package as its own line, in the package's order and with
 * its repeats ("Sprinkler timer adjustment" four times) — the label on the
 * entry is what tells them apart. One key ties them together.
 */
export function packageLines(pkg: ServicePackage, services: Service[], valueFor: (service: Service) => string): ServiceLineDraft[] {
  const key = `pkg-${pkg.id}-${Date.now().toString(36)}-${nextLineKey()}`;
  const entries = pkg.items?.length ? pkg.items : pkg.serviceIds.map(serviceId => ({ serviceId, label: null }));
  return entries.flatMap((entry, i) => {
    const service = pkg.services?.[i]?.id === entry.serviceId ? pkg.services[i] : services.find(s => s.id === entry.serviceId);
    if (!service) return [];
    return [newServiceLine(service, valueFor(service), { id: pkg.id, key, name: pkg.name, label: entry.label })];
  });
}

export default function ServiceLinesEditor({
  services,
  packages,
  fields,
  lines,
  onChange,
  valueFor,
}: {
  services: Service[] | undefined;
  packages: ServicePackage[] | undefined;
  fields: EstimateField[] | undefined;
  lines: ServiceLineDraft[];
  onChange: (next: ServiceLineDraft[]) => void;
  /** The measurement to start a new line with, from the estimate's own fields or the customer's file. */
  valueFor: (service: Service) => string;
}) {
  const serviceById = new Map((services ?? []).map(s => [s.id, s]));
  const update = (key: number, patch: Partial<ServiceLineDraft>) =>
    onChange(lines.map(line => (line.key === key ? { ...line, ...patch } : line)));
  const remove = (key: number) => onChange(lines.filter(line => line.key !== key));
  const removePackage = (packageKey: string) => onChange(lines.filter(line => line.packageKey !== packageKey));

  const packageSubtotal = (packageKey: string) =>
    lines
      .filter(line => line.packageKey === packageKey)
      .reduce((sum, line) => {
        const service = serviceById.get(line.serviceId);
        return sum + (service ? serviceLineMath(service, line).total ?? 0 : 0);
      }, 0);

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <select
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          value=""
          disabled={!services?.length}
          onChange={event => {
            const service = serviceById.get(Number(event.target.value));
            if (service) onChange([...lines, newServiceLine(service, valueFor(service))]);
          }}
        >
          <option value="">{services?.length ? '+ Add a service…' : 'No services set up yet'}</option>
          {(services ?? []).map(s => (
            <option key={s.id} value={s.id}>
              {s.code ? `${s.code} — ` : ''}{s.name}{s.visitsPerSeason && s.visitsPerSeason > 1 ? ` (${s.visitsPerSeason} visits)` : ''}
            </option>
          ))}
        </select>
        <select
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          value=""
          disabled={!packages?.length}
          onChange={event => {
            const pkg = packages?.find(p => p.id === Number(event.target.value));
            if (pkg) onChange([...lines, ...packageLines(pkg, services ?? [], valueFor)]);
          }}
        >
          <option value="">{packages?.length ? '+ Add a whole package…' : 'No packages set up yet'}</option>
          {(packages ?? []).map(p => (
            <option key={p.id} value={p.id}>{p.name} ({(p.items?.length || p.serviceIds.length)} services)</option>
          ))}
        </select>
      </div>

      {lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">No services on this estimate yet. Add one, or a whole package.</p>
      ) : (
        <div className="rounded-md border divide-y">
          {lines.map((line, index) => {
            const service = serviceById.get(line.serviceId);
            const startsPackage = line.packageKey != null && (index === 0 || lines[index - 1].packageKey !== line.packageKey);
            if (!service) {
              return (
                <div key={line.key} className="flex items-center gap-3 p-3 text-sm text-muted-foreground">
                  <AlertCircle className="w-4 h-4 text-destructive" />
                  <span className="flex-1">“{line.label}” refers to a service that no longer exists.</span>
                  <Button size="icon" variant="ghost" onClick={() => remove(line.key)}><Trash2 className="w-4 h-4" /></Button>
                </div>
              );
            }
            const field = pricingFieldFor(service, fields);
            const math = serviceLineMath(service, line);
            const missingMeasure = hasMatrix(service) && !math.fromMatrix;
            return (
              <Fragment key={line.key}>
                {startsPackage && line.packageKey && (
                  <div className="flex items-center gap-2 bg-muted/50 px-3 py-2 text-sm">
                    <Package className="w-4 h-4 text-primary" />
                    <span className="font-semibold">{line.packageName ?? 'Package'}</span>
                    <span className="text-xs text-muted-foreground">the customer accepts this as one item</span>
                    <span className="ml-auto font-semibold tabular-nums">{money(packageSubtotal(line.packageKey))}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-muted-foreground hover:text-destructive"
                      onClick={() => removePackage(line.packageKey!)}
                    >
                      Remove package
                    </Button>
                  </div>
                )}
                <div className={cn('p-3 space-y-2', line.packageKey && 'pl-6')}>
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="min-w-40 flex-1">
                      <div className="text-sm font-medium">{line.label}</div>
                      <div className="text-xs text-muted-foreground">
                        {line.label !== service.name && `${service.name} · `}
                        {hasMatrix(service) ? `Rate from the ${field?.label ?? 'Turf Sqft'} matrix` : 'Flat rate'}
                        {service.billingMode === 'time' &&
                          ` · billed by the hour, quoted at ${service.billableHours ?? 1} hr @ ${money(service.rate)}/hr`}
                      </div>
                    </div>
                    {hasMatrix(service) && (
                      <label className="text-xs text-muted-foreground">
                        {field?.label ?? 'Sqft'}
                        <Input
                          type="number"
                          className={cn('mt-1 w-28 h-9', missingMeasure && 'border-amber-500')}
                          value={line.value}
                          onChange={e => update(line.key, { value: e.target.value })}
                          placeholder={field?.label ?? 'Sqft'}
                        />
                      </label>
                    )}
                    <label className="text-xs text-muted-foreground">
                      Qty
                      <Input
                        type="number"
                        min="0"
                        step="any"
                        className={cn('mt-1 w-20 h-9', math.quantity == null && 'border-destructive')}
                        value={line.quantity}
                        onChange={e => update(line.key, { quantity: e.target.value })}
                        placeholder={String(service.quantity ?? 1)}
                      />
                    </label>
                    <label className="text-xs text-muted-foreground">
                      Visits
                      <Input
                        type="number"
                        min="0"
                        step="1"
                        className={cn('mt-1 w-20 h-9', math.visits == null && 'border-destructive')}
                        value={line.visits}
                        onChange={e => update(line.key, { visits: e.target.value })}
                        placeholder={String(defaultVisits(service))}
                      />
                    </label>
                    <div className="text-right min-w-32">
                      <div className="text-xs text-muted-foreground tabular-nums">
                        {money(math.rate)} × {math.quantity ?? '?'} × {math.visits ?? '?'} visit{math.visits === 1 ? '' : 's'}
                      </div>
                      <div className="text-sm font-semibold tabular-nums">{math.total == null ? '—' : money(math.total)}</div>
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      title="Remove this service"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => remove(line.key)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                  {missingMeasure && (
                    <p className="text-xs text-amber-700">
                      No {field?.label ?? 'Turf Sqft'} to price from, so this is the flat rate ({money(service.rate)}). Type the {field?.label ?? 'Turf Sqft'} to get the matrix price.
                    </p>
                  )}
                </div>
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
