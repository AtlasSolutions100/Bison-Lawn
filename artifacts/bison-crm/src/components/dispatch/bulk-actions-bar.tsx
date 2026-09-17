import { useMemo, useState } from 'react';
import { useBulkJobAction, type Job, type BulkJobActionInput } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { format } from 'date-fns';
import { CalendarDays, ListOrdered, Mail, RotateCcw, Trash2, UserRound, XCircle, SkipForward } from 'lucide-react';
import type { ContractorOption } from './contractors';
import { selectClass } from './job-filters';

const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * What a selection can have done to it, on the board and on the waiting list.
 *
 * "select all, or select some, and see the selection" — this is the bar that
 * appears once anything is ticked. Every button posts the same bulk action and
 * says afterwards how many it touched, so a selection with one completed job in
 * it does not fail silently or fail as a whole.
 */
export function BulkActionsBar({
  selectedIds,
  jobs,
  contractors,
  context,
  defaultDate,
  onClear,
  onEmail,
  onRenumber,
}: {
  selectedIds: number[];
  jobs: Job[];
  contractors: ContractorOption[];
  context: 'board' | 'waiting';
  defaultDate?: string;
  onClear: () => void;
  onEmail: () => void;
  onRenumber?: () => void;
}) {
  const [panel, setPanel] = useState<'move' | 'assign' | 'dispatch' | null>(null);
  const [date, setDate] = useState(defaultDate ?? format(new Date(), 'yyyy-MM-dd'));
  const [contractorId, setContractorId] = useState('');
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const bulk = useBulkJobAction();

  const selected = useMemo(() => jobs.filter((j) => selectedIds.includes(j.id)), [jobs, selectedIds]);
  const totals = useMemo(
    () => ({
      amount: selected.reduce((s, j) => s + (j.amount ?? 0), 0),
      hours: selected.reduce((s, j) => s + (j.budgetedHours ?? 0), 0),
    }),
    [selected],
  );
  const n = selectedIds.length;
  if (n === 0) return null;
  const plural = `${n} job${n === 1 ? '' : 's'}`;

  const run = (input: Omit<BulkJobActionInput, 'jobIds'>, said: string) => {
    bulk.mutate(
      { data: { jobIds: selectedIds, ...input } },
      {
        onSuccess: (result) => {
          queryClient.invalidateQueries({ queryKey: ['/api/jobs'] });
          queryClient.invalidateQueries({ queryKey: ['/api/waiting-list'] });
          const leftAlone = result.skippedIds.length
            ? ` ${result.skippedIds.length} left alone (already completed${input.action === 'skip' || input.action === 'cancel' ? ', skipped or cancelled' : ''}).`
            : '';
          const verdicts = result.skipNotices?.length ? ` ${result.skipNotices.join(' ')}` : '';
          toast({ title: `${said} ${result.updated} job${result.updated === 1 ? '' : 's'}`, description: `${leftAlone}${verdicts}`.trim() || undefined });
          setPanel(null);
          onClear();
        },
        onError: (error) => {
          toast({ title: 'That did not go through', description: error instanceof Error ? error.message : 'Try again.', variant: 'destructive' });
        },
      },
    );
  };

  const cancelSelection = () => {
    const reason = window.prompt(`Cancel ${plural}? Type the reason (optional), or press Cancel to keep them.`, '');
    if (reason === null) return;
    run({ action: 'cancel', reason: reason.trim() || null }, 'Cancelled');
  };
  const skipSelection = () => {
    const reason = window.prompt(`Skip ${plural}? Type the reason (optional), or press Cancel to keep them.`, '');
    if (reason === null) return;
    run({ action: 'skip', reason: reason.trim() || null }, 'Skipped');
  };
  const deleteSelection = () => {
    if (!window.confirm(`Delete ${plural}? This cannot be undone. Completed jobs are kept because they have an invoice.`)) return;
    run({ action: 'delete' }, 'Deleted');
  };

  return (
    <div className="sticky top-0 z-20 rounded-lg border border-amber-300 bg-amber-50 p-3 shadow-sm" data-testid="bulk-actions-bar">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="text-sm">
          <strong>{n} selected</strong>
          <span className="ml-2 text-muted-foreground">
            {money(totals.amount)}
            {totals.hours > 0 ? ` · ${totals.hours.toFixed(1)} hrs` : ''}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant={panel === 'move' ? 'default' : 'outline'} onClick={() => setPanel(panel === 'move' ? null : 'move')} data-testid="bulk-move">
            <CalendarDays className="mr-1 h-3.5 w-3.5" /> Move to date
          </Button>
          <Button size="sm" variant={panel === 'assign' ? 'default' : 'outline'} onClick={() => setPanel(panel === 'assign' ? null : 'assign')} data-testid="bulk-assign">
            <UserRound className="mr-1 h-3.5 w-3.5" /> Assign
          </Button>
          {context === 'waiting' ? (
            <Button size="sm" variant={panel === 'dispatch' ? 'default' : 'outline'} onClick={() => setPanel(panel === 'dispatch' ? null : 'dispatch')} data-testid="bulk-dispatch">
              <CalendarDays className="mr-1 h-3.5 w-3.5" /> Dispatch
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => run({ action: 'waiting_list' }, 'Sent back to the waiting list')} data-testid="bulk-waiting-list">
              <RotateCcw className="mr-1 h-3.5 w-3.5" /> Back to waiting list
            </Button>
          )}
          {onRenumber && (
            <Button size="sm" variant="outline" onClick={onRenumber} data-testid="bulk-renumber">
              <ListOrdered className="mr-1 h-3.5 w-3.5" /> Set route order
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={onEmail} data-testid="bulk-email">
            <Mail className="mr-1 h-3.5 w-3.5" /> Email selected
          </Button>
          {/* Skipping is something the crew does on the day. A waiting-list job
              has no day yet, so nobody drove out to it — skipping one there
              would spend the customer's one free skip of the year on a visit
              that never happened. */}
          {context === 'board' && (
            <Button size="sm" variant="outline" className="text-orange-700" onClick={skipSelection} data-testid="bulk-skip">
              <SkipForward className="mr-1 h-3.5 w-3.5" /> Skip
            </Button>
          )}
          <Button size="sm" variant="outline" className="text-destructive" onClick={cancelSelection} data-testid="bulk-cancel">
            <XCircle className="mr-1 h-3.5 w-3.5" /> Cancel
          </Button>
          <Button size="sm" variant="outline" className="text-destructive" onClick={deleteSelection} data-testid="bulk-delete">
            <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
          </Button>
        </div>
        <button type="button" onClick={onClear} className="ml-auto text-xs text-muted-foreground hover:text-foreground" data-testid="bulk-clear">
          Clear selection
        </button>
      </div>

      {panel === 'move' && (
        <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-amber-200 pt-3">
          <label className="text-xs text-muted-foreground">
            New date
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-9 w-44" data-testid="bulk-move-date" />
          </label>
          <Button size="sm" disabled={bulk.isPending || !date} onClick={() => run({ action: 'move', scheduledDate: date }, `Moved to ${date}:`)} data-testid="bulk-move-apply">
            Move {plural}
          </Button>
        </div>
      )}
      {panel === 'assign' && (
        <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-amber-200 pt-3">
          <label className="text-xs text-muted-foreground">
            Contractor
            <select className={`${selectClass} w-48`} value={contractorId} onChange={(e) => setContractorId(e.target.value)} data-testid="bulk-assign-contractor">
              <option value="">Unassigned</option>
              {contractors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <Button
            size="sm"
            disabled={bulk.isPending}
            onClick={() => run({ action: 'assign', assignedToId: contractorId ? Number(contractorId) : null }, contractorId ? 'Assigned' : 'Unassigned')}
            data-testid="bulk-assign-apply"
          >
            {contractorId ? 'Assign' : 'Unassign'} {plural}
          </Button>
        </div>
      )}
      {panel === 'dispatch' && (
        <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-amber-200 pt-3">
          <label className="text-xs text-muted-foreground">
            Dispatch on
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-9 w-44" data-testid="bulk-dispatch-date" />
          </label>
          <label className="text-xs text-muted-foreground">
            Contractor
            <select className={`${selectClass} w-48`} value={contractorId} onChange={(e) => setContractorId(e.target.value)} data-testid="bulk-dispatch-contractor">
              <option value="">Leave as is / unassigned</option>
              {contractors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <Button
            size="sm"
            disabled={bulk.isPending || !date}
            onClick={() => run({ action: 'dispatch', scheduledDate: date, assignedToId: contractorId ? Number(contractorId) : null }, `Dispatched to ${date}:`)}
            data-testid="bulk-dispatch-apply"
          >
            Dispatch {plural}
          </Button>
        </div>
      )}
    </div>
  );
}
