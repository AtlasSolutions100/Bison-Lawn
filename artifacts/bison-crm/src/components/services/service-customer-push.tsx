import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useGetServiceAssignedImpact,
  usePushServiceToAssigned,
  useSetServiceSeasonEnd,
  type Service,
  type ServiceSeasonEndResult,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { AlertTriangle, Users } from 'lucide-react';

/**
 * "Making changes to service info. Ask if want to push on to current assigned
 * jobs/customers."
 *
 * A price on an account is a copy taken the day the service was assigned, so
 * putting mowing up $5 changed nothing for the 300 customers already mowing.
 * This is the question that was missing: it opens as soon as a service is
 * saved, says how many customers have it before he answers anything, shows
 * every from → to, and pushes nothing unless he presses the button. The same
 * dialog carries "Season End date will be the same for all mowing clients",
 * because that is the same job — one date on the service, pushed onto
 * everybody, with the visits past it called off.
 */

const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** What the server said went wrong, in its words. */
function errText(e: unknown, fallback: string): string {
  const err = e as { data?: { error?: string }; message?: string } | null;
  return err?.data?.error || err?.message || fallback;
}

/** Which of a service's fields are worth asking about, by comparing before and after. */
export function pushableChanges(before: Service | undefined, after: Partial<Service>): string[] {
  if (!before) return [];
  const changed: string[] = [];
  const num = (v: unknown) => (v == null || v === '' ? null : Number(v));
  if (num(after.rate) !== num(before.rate)) changed.push('price');
  if (JSON.stringify(after.pricingEquations ?? []) !== JSON.stringify(before.pricingEquations ?? [])) {
    if (!changed.includes('price')) changed.push('price');
  }
  if (num(after.billableHours) !== num(before.billableHours)) changed.push('hours');
  if ((after.invoiceDescription ?? '') !== (before.invoiceDescription ?? '')) changed.push('description');
  if ((after.description ?? '') !== (before.description ?? '')) changed.push('description');
  return [...new Set(changed)];
}

/** "Mowing is $5 dearer" in the words he used when he typed it. */
function whatChangedLine(changed: string[]): string | null {
  const words = changed.map(c => (c === 'price' ? 'the price' : c === 'hours' ? 'the billable hours' : 'the description'));
  if (words.length === 0) return null;
  if (words.length === 1) return `You changed ${words[0]}.`;
  return `You changed ${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}.`;
}

export default function ServiceCustomerPush({
  service,
  changed,
  fromRate,
  onClose,
}: {
  service: Service;
  /** Which fields he just changed, so the dialog opens on the right question. */
  changed: string[];
  /**
   * The rate the service had before this save. A service with no matrix keeps
   * no record of where a price on an account came from, so this is the only
   * thing that tells "we agreed $180 with them" apart from "they are still on
   * the old $220" — without it, a negotiated price gets walked over.
   */
  fromRate?: number | null;
  onClose: () => void;
}) {
  const { data: impact, isLoading } = useGetServiceAssignedImpact(
    service.id,
    fromRate == null ? undefined : { fromRate },
  );
  const push = usePushServiceToAssigned();
  const seasonEndPush = useSetServiceSeasonEnd();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [pushPrice, setPushPrice] = useState(changed.includes('price'));
  const [pushHours, setPushHours] = useState(changed.includes('hours'));
  const [includeTyped, setIncludeTyped] = useState(false);
  const [seasonEndDate, setSeasonEndDate] = useState(service.seasonEndDate ?? '');
  const [keepEarlier, setKeepEarlier] = useState(true);
  const [seasonPreview, setSeasonPreview] = useState<ServiceSeasonEndResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['/api/services'] });
    queryClient.invalidateQueries({
      predicate: q => {
        const k = String(q.queryKey[0] ?? '');
        return k.startsWith('/api/clients') || k.startsWith('/api/client-services') || k.startsWith('/api/jobs') || k.startsWith('/api/services');
      },
    });
  };

  // The rows that would actually move, worked out from the same numbers the
  // server will use, so the count on the button is the count he gets.
  const moving = useMemo(() => {
    const rows = impact?.rows ?? [];
    return rows.filter(r => {
      if (r.handTyped && !includeTyped) return false;
      if (r.missingField && pushPrice) return false;
      const priceMoves = pushPrice && r.toAmount !== r.fromAmount;
      const hoursMove = pushHours && (r.toHours ?? null) !== (r.fromHours ?? null);
      return priceMoves || hoursMove;
    });
  }, [impact, pushPrice, pushHours, includeTyped]);

  const movingClients = new Set(moving.map(r => r.clientId)).size;
  const movingVisits = moving.reduce((sum, r) => sum + r.upcomingVisits, 0);
  const busy = push.isPending || seasonEndPush.isPending;

  const doPush = () => {
    setError(null);
    const fields = [...(pushPrice ? ['price' as const] : []), ...(pushHours ? ['hours' as const] : [])];
    push.mutate(
      { id: service.id, data: { fields, includeCustomPrices: includeTyped, fromRate, apply: true } },
      {
        onSuccess: (result) => {
          refresh();
          toast({
            title: `${result.clientCount} customer${result.clientCount === 1 ? '' : 's'} updated`,
            description: `${result.visitsUpdated} upcoming visit(s) re-priced${result.skipped.length ? `, ${result.skipped.length} left alone` : ''}.`,
          });
          onClose();
        },
        onError: (e) => setError(errText(e, 'Could not push the change. Nothing was written.')),
      },
    );
  };

  const doSeasonEnd = (apply: boolean) => {
    setError(null);
    seasonEndPush.mutate(
      { id: service.id, data: { seasonEndDate, keepEarlierFinishes: keepEarlier, apply } },
      {
        onSuccess: (result) => {
          setSeasonPreview(result);
          if (!apply) return;
          refresh();
          toast({
            title: `Season ends ${result.seasonEndDate}`,
            description: `${result.customersChanged} customer(s) moved, ${result.visitsCancelled} visit(s) after it cancelled.`,
          });
        },
        onError: (e) => setError(errText(e, 'Could not set the season end.')),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="w-5 h-5 text-muted-foreground" />
            Push “{service.name}” onto the customers who have it?
          </DialogTitle>
          <DialogDescription>
            {whatChangedLine(changed) ?? 'Nothing new was typed, so this only changes what you tick below.'}{' '}
            Prices on an account are a copy taken when the service was assigned, so nothing moves until you say so here.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <p className="text-sm text-muted-foreground animate-pulse">Counting the customers who have it…</p>
        ) : !impact ? (
          <p className="text-sm text-destructive">Could not read who has this service.</p>
        ) : impact.rowCount === 0 ? (
          <p className="text-sm text-muted-foreground">Nobody has this service on their account yet, so there is nothing to push.</p>
        ) : (
          <div className="space-y-4">
            <div className="rounded-lg border bg-muted/30 p-3 text-sm">
              <b>{impact.clientCount}</b> customer{impact.clientCount === 1 ? '' : 's'} ha{impact.clientCount === 1 ? 's' : 've'} this service
              {impact.rowCount !== impact.clientCount && <> ({impact.rowCount} assigned rows)</>}, with <b>{impact.upcomingVisits}</b> visit
              {impact.upcomingVisits === 1 ? '' : 's'} still ahead on the board.
              {impact.priceDiffers > 0 && <> Pushing the price would move <b>{impact.priceDiffers}</b> of them.</>}
              {impact.matrixPriced && (
                <p className="mt-1 text-xs text-muted-foreground">
                  This service prices from the matrix, so each customer gets the band for their own measurement — not one flat number.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <label className="flex items-start gap-2 text-sm">
                <Checkbox checked={pushPrice} onCheckedChange={v => setPushPrice(v === true)} />
                <span>
                  Push the price <span className="text-muted-foreground">({impact.priceDiffers} account{impact.priceDiffers === 1 ? '' : 's'} would change)</span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox checked={pushHours} onCheckedChange={v => setPushHours(v === true)} />
                <span>
                  Push the billable hours <span className="text-muted-foreground">({impact.hoursDiffers} account{impact.hoursDiffers === 1 ? '' : 's'} would change)</span>
                </span>
              </label>
              {impact.handTypedCount > 0 && (
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox checked={includeTyped} onCheckedChange={v => setIncludeTyped(v === true)} />
                  <span>
                    Include the {impact.handTypedCount} account{impact.handTypedCount === 1 ? '' : 's'} with a price somebody typed by hand
                    <span className="block text-xs text-muted-foreground">Left out by default — somebody set that number on purpose.</span>
                  </span>
                </label>
              )}
              {changed.includes('description') && (
                <p className="text-xs text-muted-foreground">
                  The description and the invoice wording are read off the service when a bill is raised, so the new words are already on every invoice from here on. Invoices already sent keep what they said.
                </p>
              )}
              {impact.missingFieldCount > 0 && pushPrice && (
                <p className="text-xs text-destructive flex items-start gap-1">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  {impact.missingFieldCount} customer{impact.missingFieldCount === 1 ? ' has' : 's have'} no measurement on file, so the matrix cannot price them. They are left alone — add the measurement under Property Details.
                </p>
              )}
            </div>

            {moving.length > 0 && (
              <div className="rounded-lg border">
                <div className="border-b bg-muted/50 px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                  What changes ({movingClients} customer{movingClients === 1 ? '' : 's'}, {movingVisits} visit{movingVisits === 1 ? '' : 's'})
                </div>
                <div className="max-h-56 divide-y overflow-y-auto text-sm">
                  {moving.slice(0, 40).map(r => (
                    <div key={r.clientServiceId} className="flex items-center justify-between gap-3 px-3 py-1.5">
                      <span className="min-w-0 truncate">
                        {r.clientName}
                        {r.label && <span className="text-muted-foreground"> · {r.label}</span>}
                        <span className="text-xs text-muted-foreground"> · {r.cadence}</span>
                      </span>
                      <span className="whitespace-nowrap tabular-nums">
                        {pushPrice && r.toAmount !== r.fromAmount && (
                          <>
                            {money(r.fromAmount)} → <b>{money(r.toAmount)}</b>
                          </>
                        )}
                        {pushHours && (r.toHours ?? null) !== (r.fromHours ?? null) && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {r.fromHours ?? '—'} → {r.toHours ?? '—'} h
                          </span>
                        )}
                        <span className="ml-2 text-xs text-muted-foreground">{r.upcomingVisits} ahead</span>
                      </span>
                    </div>
                  ))}
                  {moving.length > 40 && (
                    <div className="px-3 py-1.5 text-xs text-muted-foreground">…and {moving.length - 40} more</div>
                  )}
                </div>
              </div>
            )}

            {/*
              "Season End date will be the same for all mowing clients. If some
              decide to end earlier having the ability to cancel upcoming or
              future jobs." The year is not needed — it is the same day every
              year — so a bare 10-15 is accepted and each account gets it in
              the year its own season runs in.
            */}
            <div className="space-y-3 rounded-lg border p-3">
              <div>
                <h4 className="font-semibold text-sm">Season ends on</h4>
                <p className="text-xs text-muted-foreground">
                  One date for everybody on this service. Type 10-15 for the 15th of October every year, or a full date for one year only.
                  Visits after it are cancelled, not deleted, so you can still see they were called off.
                </p>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="text-xs font-medium mb-1 block">Last day of the season</label>
                  <Input
                    className="h-9 w-40"
                    value={seasonEndDate}
                    placeholder="10-15"
                    onChange={e => { setSeasonEndDate(e.target.value); setSeasonPreview(null); }}
                  />
                </div>
                <label className="flex items-center gap-2 text-sm pb-2">
                  <Checkbox checked={keepEarlier} onCheckedChange={v => setKeepEarlier(v === true)} />
                  Leave customers who already finish earlier where they are
                </label>
                <Button type="button" variant="outline" size="sm" disabled={!seasonEndDate || busy} onClick={() => doSeasonEnd(false)}>
                  {seasonEndPush.isPending && !seasonPreview ? 'Checking…' : 'Check it first'}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={!seasonEndDate || busy || !seasonPreview}
                  onClick={() => doSeasonEnd(true)}
                  title={seasonPreview ? undefined : 'Check it first so you can see what it cancels'}
                >
                  Set the season end
                </Button>
              </div>
              {seasonPreview && (
                <p className={`text-sm ${seasonPreview.applied ? 'text-primary' : 'text-muted-foreground'}`}>
                  {seasonPreview.applied ? 'Done: ' : 'Would change '}
                  <b>{seasonPreview.customersChanged}</b> customer{seasonPreview.customersChanged === 1 ? '' : 's'} and cancel{seasonPreview.applied ? 'led' : ''}{' '}
                  <b>{seasonPreview.visitsCancelled}</b> visit{seasonPreview.visitsCancelled === 1 ? '' : 's'} after {seasonPreview.seasonEndDate}
                  {seasonPreview.rows.some(r => r.leftAlone) && `; ${seasonPreview.rows.filter(r => r.leftAlone).length} finishing earlier left alone`}.
                </p>
              )}
            </div>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Not now</Button>
          <Button type="button" onClick={doPush} disabled={busy || moving.length === 0 || (!pushPrice && !pushHours)}>
            {push.isPending
              ? 'Pushing…'
              : `Push to ${movingClients} customer${movingClients === 1 ? '' : 's'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
