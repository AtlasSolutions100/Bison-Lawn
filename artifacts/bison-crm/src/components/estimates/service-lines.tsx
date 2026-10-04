import { Fragment } from 'react';
import type { EstimateField, Service, ServicePackage } from '@workspace/api-client-react';
import { AlertCircle, Package, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  defaultVisits,
  hasMatrix,
  pricingFieldFor,
  serviceLineMath,
  type MeasureSources,
  type ServiceLineDraft,
} from './service-pricing';

/**
 * The services on an estimate, the way he prices them (2026-09-15
 * walkthrough, B2 and feedback 46/48): the band rate the matrix gives for
 * this property, times the quantity, times the visits — "I type 28 mows and
 * the customer sees the quantity so they can divide the total by the visits".
 * A package drops all of its services in at once, repeats included, and they
 * stay together so the customer can accept the package as one line.
 */

// The maths that has to agree with the server lives in service-pricing.ts so a
// test can run it against the real save route; it is re-exported from here
// because this is the screen that uses it.
export {
  calculableNeedsNumber,
  defaultVisits,
  fieldLinePrice,
  hasMatrix,
  lineCount,
  measurementForLine,
  measurementOf,
  prefillFieldValue,
  pricingFieldFor,
  serviceLineMath,
  serviceUnitPrice,
} from './service-pricing';
export type { MeasureSource, MeasureSources, ServiceLineDraft } from './service-pricing';

let lineKeySeq = 0;
const nextLineKey = () => ++lineKeySeq;
export const withLineKey = <T extends object>(line: T): T & { key: number } => ({ key: nextLineKey(), ...line });

export const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
  fieldValues,
  propertyData,
}: {
  services: Service[] | undefined;
  packages: ServicePackage[] | undefined;
  fields: EstimateField[] | undefined;
  lines: ServiceLineDraft[];
  onChange: (next: ServiceLineDraft[]) => void;
  /** The measurement to start a new line with, from the estimate's own fields or the customer's file. */
  valueFor: (service: Service) => string;
  /** The property details ticked on this estimate, so a line reads the sqft typed beside it. */
  fieldValues?: Record<number, { selected: boolean; value: string }> | null;
  /** What the customer's file holds, so a line reads the account the way the save does. */
  propertyData?: Record<string, string> | null;
}) {
  const serviceById = new Map((services ?? []).map(s => [s.id, s]));
  // The same three places the save reads a measurement from. Leaving the
  // account out of this is how the screen said $1,260 and the saved quote said
  // $2,660 for the same 28 mows.
  const sources: MeasureSources = { fields, fieldValues, propertyData };
  const update = (key: number, patch: Partial<ServiceLineDraft>) =>
    onChange(lines.map(line => (line.key === key ? { ...line, ...patch } : line)));
  const remove = (key: number) => onChange(lines.filter(line => line.key !== key));
  const removePackage = (packageKey: string) => onChange(lines.filter(line => line.packageKey !== packageKey));

  const packageSubtotal = (packageKey: string) =>
    lines
      .filter(line => line.packageKey === packageKey)
      .reduce((sum, line) => {
        const service = serviceById.get(line.serviceId);
        return sum + (service ? serviceLineMath(service, line, sources).total ?? 0 : 0);
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
            const math = serviceLineMath(service, line, sources);
            const missingMeasure = hasMatrix(service) && !math.fromMatrix;
            // The box is empty but the save will still price off a number: say
            // which one and where it came from, because the saved quote is what
            // the customer reads and he never sees it otherwise.
            const borrowed = math.fromMatrix && math.measuredFrom !== null && math.measuredFrom !== 'line';
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
                          placeholder={borrowed ? String(math.measurement) : (field?.label ?? 'Sqft')}
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
                      No {field?.label ?? 'Turf Sqft'} anywhere — not on this estimate and not on the account — so this is the flat rate ({money(service.rate)}). Type the {field?.label ?? 'Turf Sqft'} to get the matrix price.
                    </p>
                  )}
                  {borrowed && (
                    <p className="text-xs text-muted-foreground">
                      Priced off {math.measurement?.toLocaleString()} {field?.label ?? 'Turf Sqft'}{' '}
                      {math.measuredFrom === 'estimate' ? 'measured on this estimate' : "on the customer's account"}. Type a
                      different {field?.label ?? 'Turf Sqft'} here to price off that instead.
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
