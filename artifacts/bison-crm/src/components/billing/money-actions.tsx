import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUnlockInvoice, useWriteOffInvoice, type Invoice, type WriteOffInvoiceInputHow } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { KeyRound, Ban, Undo2 } from 'lucide-react';
import { dayLabel, errorText, invalidateBilling, momentLabel, money } from './shared';

/**
 * The two ways out of a bill that has already gone out, in one place.
 *
 * "Ability to unlock invoice after being sent out to make changes and edit
 * invoice" and "Jackie Wagner — beagle to get rid of balance, via written off
 * and turned into collections". Both are things he does to a bill somebody has
 * already seen, so both say out loud what they mean before he presses the
 * button: unlocking does not change the copy in the customer's inbox, and
 * writing off does not make the bill or the work disappear.
 */

/** The one explanation box both of these ask for, worded for what it is for. */
function Reason({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div>
      <label className="text-sm font-medium mb-1 block">Why (optional)</label>
      <Textarea rows={2} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
      <p className="text-xs text-muted-foreground mt-1">
        Goes on the bill's history with your name and the date, so anybody looking later knows who and why.
      </p>
    </div>
  );
}

export function UnlockInvoiceButton({ invoice, onDone }: { invoice: Invoice; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const unlock = useUnlockInvoice();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Only a bill that is actually finished can be unlocked. One still in Needs
  // verification is already editable, and offering Unlock on it is a button
  // that does nothing but confuse.
  if (invoice.needsVerification || invoice.status === 'void' || invoice.status === 'written_off' || invoice.status === 'collections') {
    return null;
  }

  const handedOverOn = invoice.sentAt ?? invoice.printedAt ?? invoice.previouslySentAt ?? null;
  const how = invoice.sentAt ? 'emailed' : invoice.printedAt ? 'printed' : 'sent out';

  const go = () => {
    unlock.mutate(
      { id: invoice.id, data: { reason: reason.trim() || null } },
      {
        onSuccess: (inv) => {
          invalidateBilling(queryClient, invoice.clientId, invoice.id);
          toast({
            title: `Invoice #${inv.number} is unlocked`,
            description: 'It is back in Needs verification. Change it, verify it, then send it again.',
          });
          setOpen(false);
          setReason('');
          onDone?.();
        },
        onError: (error) => toast({ title: 'Could not unlock the invoice', description: errorText(error), variant: 'destructive' }),
      },
    );
  };

  return (
    <>
      <Button size="sm" variant="ghost" className="h-9 text-muted-foreground" onClick={() => setOpen(true)} disabled={unlock.isPending}>
        <KeyRound className="w-3.5 h-3.5 mr-1.5" /> Unlock
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Unlock invoice #{invoice.number} to change it</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2 text-sm">
            <ul className="space-y-1.5 list-disc pl-5 text-muted-foreground">
              <li>
                <span className="text-foreground font-medium">The customer keeps the copy they already have.</span>{' '}
                {handedOverOn ? `It was ${how} ${dayLabel(handedOverOn)} and it does not change.` : 'It does not change.'}
              </li>
              <li>This bill goes back to <span className="text-foreground font-medium">Needs verification</span>.</li>
              <li>You have to check it and send it again before the customer has the new one.</li>
              <li>Nothing already paid on it moves.</li>
            </ul>
            <Reason value={reason} onChange={setReason} placeholder="Wrong price on the aeration line" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={go} disabled={unlock.isPending}>
              {unlock.isPending ? 'Unlocking…' : 'Unlock it'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

const HOW_TEXT: Record<'written_off' | 'collections', { title: string; blurb: string; button: string }> = {
  written_off: {
    title: 'Write this balance off',
    blurb: 'You are not going to see this money and you are not going to chase it any more.',
    button: 'Write it off',
  },
  collections: {
    title: 'Send this balance to collections',
    blurb: 'Somebody else is chasing it now, so it comes off your past-due list.',
    button: 'Send to collections',
  },
};

export function WriteOffInvoiceButton({ invoice, onDone }: { invoice: Invoice; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [how, setHow] = useState<'written_off' | 'collections'>('written_off');
  const [reason, setReason] = useState('');
  const writeOff = useWriteOffInvoice();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const alreadyGone = invoice.status === 'written_off' || invoice.status === 'collections';

  const run = (which: WriteOffInvoiceInputHow) =>
    writeOff.mutate(
      { id: invoice.id, data: { how: which, reason: reason.trim() || null } },
      {
        onSuccess: (inv) => {
          invalidateBilling(queryClient, invoice.clientId, invoice.id);
          toast({
            title:
              which === 'restore'
                ? `Invoice #${inv.number} is owed again`
                : which === 'collections'
                  ? `Invoice #${inv.number} is with collections`
                  : `Invoice #${inv.number} is written off`,
            description:
              which === 'restore'
                ? `${money(inv.balance)} is back on what they owe.`
                : 'It stopped counting toward what they owe. The bill and its history stay.',
          });
          setOpen(false);
          setReason('');
          onDone?.();
        },
        onError: (error) => toast({ title: 'Could not change the balance', description: errorText(error), variant: 'destructive' }),
      },
    );

  // Putting it back is one button, not a conversation: a write-off on the
  // wrong account is somebody's balance and he should not have to pick a
  // reason out of a list to fix it.
  if (alreadyGone) {
    return (
      <Button size="sm" variant="ghost" className="h-9 text-muted-foreground" disabled={writeOff.isPending} onClick={() => run('restore')}>
        <Undo2 className="w-3.5 h-3.5 mr-1.5" /> {writeOff.isPending ? 'Putting it back…' : 'Put the balance back'}
      </Button>
    );
  }

  if (invoice.status === 'void' || invoice.balance <= 0) return null;

  const text = HOW_TEXT[how];
  return (
    <>
      <Button size="sm" variant="ghost" className="h-9 text-muted-foreground" onClick={() => setOpen(true)}>
        <Ban className="w-3.5 h-3.5 mr-1.5" /> Write off
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{text.title}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2 text-sm">
            <div className="rounded-md border bg-muted/40 p-3">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Still owed on invoice #{invoice.number}</span>
                <span className="font-bold tabular-nums">{money(invoice.balance)}</span>
              </div>
              {invoice.amountPaid > 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  The {money(invoice.amountPaid)} already paid stays on the bill. Only the {money(invoice.balance)} comes off.
                </p>
              )}
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block">Which is it?</label>
              <div className="grid grid-cols-1 gap-2">
                {(['written_off', 'collections'] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setHow(key)}
                    className={`text-left rounded-md border p-3 transition-colors ${
                      how === key ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
                    }`}
                  >
                    <div className="font-medium">{key === 'written_off' ? 'Written off' : 'Turned into collections'}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{HOW_TEXT[key].blurb}</div>
                  </button>
                ))}
              </div>
            </div>

            <ul className="space-y-1 list-disc pl-5 text-muted-foreground text-xs">
              <li>The invoice, its lines and its history all stay — nothing is deleted.</li>
              <li>The balance stops counting toward what this customer owes.</li>
              <li>Their account says which one it was, how much, and why.</li>
              <li>You can put it back to owed at any time.</li>
            </ul>

            <Reason value={reason} onChange={setReason} placeholder="House sold, no forwarding address" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => run(how)} disabled={writeOff.isPending}>
              {writeOff.isPending ? 'Saving…' : text.button}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The two facts a bill carries after one of the above: that the customer is
 * holding a different copy, and that this balance is not being chased. Both
 * belong at the top of the bill where somebody opening it cannot miss them.
 */
export function InvoiceMoneyNotices({ invoice }: { invoice: Invoice }) {
  const unlockedCopyOut = Boolean(invoice.previouslySentAt) && invoice.needsVerification;
  const wroteOff = invoice.status === 'written_off' || invoice.status === 'collections';
  if (!unlockedCopyOut && !wroteOff) return null;
  return (
    <div className="space-y-2">
      {unlockedCopyOut && (
        <div className="rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-sm">
          <span className="font-semibold">The customer has an older copy of this bill</span> from{' '}
          {dayLabel(invoice.previouslySentAt)}. It was unlocked
          {invoice.unlockedByName ? ` by ${invoice.unlockedByName}` : ''}
          {invoice.unlockedAt ? ` on ${dayLabel(invoice.unlockedAt)}` : ''}. Verify it and send it again so they get the new one.
        </div>
      )}
      {wroteOff && (
        <div className="rounded-md border bg-muted/50 px-3 py-2 text-sm">
          <span className="font-semibold">{invoice.writeOffLabel ?? 'Written off'}</span>
          {invoice.writtenOffAmount != null && <> — {money(invoice.writtenOffAmount)} is not counted against them</>}
          {invoice.writtenOffByName ? `, by ${invoice.writtenOffByName}` : ''}
          {invoice.writtenOffAt ? ` on ${momentLabel(invoice.writtenOffAt)}` : ''}.
          {invoice.writeOffReason ? <div className="text-muted-foreground mt-0.5">{invoice.writeOffReason}</div> : null}
        </div>
      )}
    </div>
  );
}
