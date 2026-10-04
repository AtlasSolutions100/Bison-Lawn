import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useGetBillingSettings, useListUsers, useUpdateBillingSettings } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { Wallet } from 'lucide-react';
import { errorText } from './shared';

/**
 * Who, besides the office, may take money at the door.
 *
 * The field payment screen refuses anybody who is not on this list, and tells
 * them to ask him to tick them here — so the list has to live where that
 * message sends them, on the Invoices screen. Office people with Invoices
 * access already can, and they are shown as such rather than needing a tick
 * that would do nothing.
 */
export default function FieldMoneyAccessDialog() {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const { data: settings } = useGetBillingSettings({ query: { enabled: open, queryKey: ['/api/billing-settings'] } });
  const { data: users } = useListUsers(undefined, { query: { enabled: open, queryKey: ['/api/users'] } });
  const save = useUpdateBillingSettings();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  useEffect(() => {
    if (open && settings) setPicked(new Set(settings.fieldPaymentUserIds ?? []));
  }, [open, settings]);

  // Only people who are actually on the team and still switched on. Somebody
  // who left should not be sitting on a list that lets them take cash.
  const team = (users ?? []).filter((u) => u.active !== false);
  const alreadyAllowed = (areas: string[] | undefined, role: string) => role === 'admin' || (areas ?? []).includes('invoices');

  const toggle = (id: number) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const go = () =>
    save.mutate(
      { data: { fieldPaymentUserIds: [...picked] } },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: ['/api/billing-settings'] });
          toast({
            title: picked.size ? `${picked.size} can take payments in the field` : 'Nobody outside the office can take payments',
          });
          setOpen(false);
        },
        onError: (error) => toast({ title: 'Could not save that', description: errorText(error), variant: 'destructive' }),
      },
    );

  return (
    <>
      <Button variant="outline" className="h-10" onClick={() => setOpen(true)}>
        <Wallet className="w-4 h-4 mr-2" /> Who can take payments
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Who can take payments in the field</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2 max-h-[55vh] overflow-y-auto">
            <p className="text-sm text-muted-foreground">
              Tick the subs you trust with a cheque or a card at the door. They can only take one for their own job, and the card
              fee is shown to the customer before it is charged.
            </p>
            {team.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nobody on the team yet.</p>
            ) : (
              team.map((u) => {
                const free = alreadyAllowed(u.areas as unknown as string[] | undefined, u.role);
                return (
                  <label key={u.id} className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm">
                    <Checkbox checked={free || picked.has(u.id)} disabled={free} onCheckedChange={() => toggle(u.id)} />
                    <span className="flex-1">
                      <span className="font-medium">{u.displayName?.trim() || u.name}</span>
                      <span className="text-xs text-muted-foreground block">
                        {free ? 'Office access to Invoices — already can' : u.accessLevel === 'mobile' ? 'Phone only' : u.accessLevel}
                      </span>
                    </span>
                  </label>
                );
              })
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={go} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
