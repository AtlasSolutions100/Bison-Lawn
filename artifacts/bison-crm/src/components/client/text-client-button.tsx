import { useMemo, useState } from 'react';
import {
  useGetSmsStatus,
  useListClientSms,
  useSendClientSms,
  useListUsers,
  getListClientSmsQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { MessageSquare, Phone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { useCan } from '@/lib/access';

/**
 * The Text button on a customer's page.
 *
 * With a texting provider switched on it opens a thread and sends from the
 * office number, or from a contractor's masked number so the reply lands
 * with that person. With texting off it does not pretend: it hands the number
 * to the phone's own Messages app and says plainly that the customer will see
 * the sender's real number.
 */

export function smsHref(phone: string | null | undefined, body?: string): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  const e164 = digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith('1') ? `+${digits}` : null;
  if (!e164) return null;
  return `sms:${e164}${body ? `?&body=${encodeURIComponent(body)}` : ''}`;
}

export function telHref(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? `tel:${digits.length === 10 ? '+1' : '+'}${digits}` : null;
}

/** Same arithmetic as the server: plain text fits 160, anything fancier 70, and each extra segment is another text. */
export function segmentsOf(body: string): number {
  if (!body) return 0;
  // eslint-disable-next-line no-control-regex
  const gsm = /^[\x00-\x7F€]*$/.test(body);
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  return body.length <= single ? 1 : Math.ceil(body.length / multi);
}

function fmt(n: string) {
  const d = n.replace(/\D/g, '').slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : n;
}

export default function TextClientButton({ clientId, phone }: { clientId: number; phone: string | null }) {
  const { data: status } = useGetSmsStatus();
  // The send dialog talks to the office endpoints. On a contractor's job card
  // (where this is also mounted) that would only earn a 403, so they get the
  // phone links here and the masked-number send from their own job button.
  const office = useCan('clients');
  const canSendFromHere = Boolean(status?.configured) && office;
  const [open, setOpen] = useState(false);
  const sms = smsHref(phone);
  const tel = telHref(phone);

  if (!phone || (!sms && !tel)) {
    return (
      <Button variant="outline" size="sm" disabled title="No mobile number on file" data-testid="text-client-none">
        <MessageSquare className="w-4 h-4 mr-1" /> Text
      </Button>
    );
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="text-client-open">
        <MessageSquare className="w-4 h-4 mr-1" /> Text
      </Button>
      {open && canSendFromHere && (
        <SendTextDialog clientId={clientId} phone={phone} onClose={() => setOpen(false)} />
      )}
      {open && !canSendFromHere && (
        <Dialog open onOpenChange={(o) => { if (!o) setOpen(false); }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Text {fmt(phone)}</DialogTitle>
              <DialogDescription>
                Texting from the CRM is switched off, so this opens your own phone's Messages app instead.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap gap-2">
                {sms && (
                  <Button asChild data-testid="text-client-sms-link">
                    <a href={sms}><MessageSquare className="w-4 h-4 mr-1" /> Open Messages</a>
                  </Button>
                )}
                {tel && (
                  <Button asChild variant="outline">
                    <a href={tel}><Phone className="w-4 h-4 mr-1" /> Call</a>
                  </Button>
                )}
              </div>
              {/* Nobody should assume the masking is on when it is not. */}
              <p className="text-muted-foreground">
                The customer will see your real phone number, and their reply comes to your phone, not to this page.
                Masked company numbers need a texting provider — Settings › Texting says what it costs and how to turn it on.
              </p>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function SendTextDialog({ clientId, phone, onClose }: { clientId: number; phone: string; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: status } = useGetSmsStatus();
  const { data: users } = useListUsers();
  const { data: thread, isLoading } = useListClientSms(clientId);
  const send = useSendClientSms();
  const [body, setBody] = useState('');
  const [fromUserId, setFromUserId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  // Only people who have a masked number can be the sender; the office number
  // is always there as the default.
  const senders = useMemo(() => (users ?? []).filter((u) => u.smsProxyNumber), [users]);
  const segments = segmentsOf(body);

  const handleSend = () => {
    setError(null);
    send.mutate(
      { id: clientId, data: { body: body.trim(), fromUserId: fromUserId ? Number(fromUserId) : null } },
      {
        onSuccess: (result) => {
          queryClient.invalidateQueries({ queryKey: getListClientSmsQueryKey(clientId) });
          if (result.sent) {
            toast({ title: 'Text sent', description: `To ${fmt(result.to)} from ${fmt(result.from)}.` });
            setBody('');
          } else {
            setError(result.error || 'The text did not go through.');
          }
        },
        onError: (e: any) => setError(e?.data?.error || e?.message || 'Could not send the text'),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Text {fmt(phone)}</DialogTitle>
          <DialogDescription>
            Sent from {fromUserId
              ? `${senders.find((u) => String(u.id) === fromUserId)?.name ?? 'their'} masked number — their reply goes to that person's phone`
              : `the office number${status?.officeNumber ? ` ${fmt(status.officeNumber)}` : ''} — a reply opens a ticket for the office`}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="max-h-56 overflow-y-auto rounded-md border bg-muted/30 p-2 space-y-1.5" data-testid="sms-thread">
            {isLoading ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : !thread?.length ? (
              <p className="text-xs text-muted-foreground">No texts with this customer yet.</p>
            ) : (
              thread.map((m) => (
                <div key={m.id} className={`flex ${m.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] rounded-lg px-2.5 py-1.5 text-sm ${m.direction === 'outbound' ? 'bg-primary text-primary-foreground' : 'bg-card border'}`}>
                    <div className="whitespace-pre-wrap">{m.body}</div>
                    <div className={`mt-0.5 text-[10px] ${m.direction === 'outbound' ? 'text-primary-foreground/80' : 'text-muted-foreground'}`}>
                      {m.direction === 'outbound' ? `from ${m.userName ?? 'the office'}` : 'from customer'}
                      {' · '}{new Date(m.createdAt).toLocaleString()}
                      {m.status === 'failed' ? ` · failed${m.error ? `: ${m.error}` : ''}` : ''}
                      {m.status === 'forwarded' ? ' · forwarded to their phone' : ''}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          {senders.length > 0 && (
            <div className="grid gap-1.5">
              <Label htmlFor="sms-from">Send from</Label>
              <select
                id="sms-from"
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                value={fromUserId}
                onChange={(e) => setFromUserId(e.target.value)}
                data-testid="sms-from"
              >
                <option value="">Office number</option>
                {senders.map((u) => (
                  <option key={u.id} value={u.id}>{u.name} ({fmt(u.smsProxyNumber!)})</option>
                ))}
              </select>
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="sms-body">Message</Label>
            <Textarea
              id="sms-body"
              rows={4}
              maxLength={1000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Hi Sarah, we'll be by around 2 today."
              data-testid="sms-body"
            />
            <p className="text-xs text-muted-foreground">
              {body.length} characters · {segments} text{segments === 1 ? '' : 's'}
              {segments > 1 ? ' (each one is billed)' : ''}
            </p>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button onClick={handleSend} disabled={send.isPending || !body.trim()} data-testid="sms-send">
            {send.isPending ? 'Sending…' : 'Send text'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
