import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useGetUnopenedAlert,
  useUpdateUnopenedAlert,
  useRunUnopenedAlertNow,
  getGetUnopenedAlertQueryKey,
  type UnopenedAlertRow,
} from '@workspace/api-client-react';
import { Bell, Eye, MailQuestion, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';

/**
 * "Automation sent to admin for unopened invoices/emails."
 *
 * The only rule in the app that emails HIM. It reads as one sentence like the
 * others, ships switched off like the others, and has a Preview so he can see
 * exactly which customers would be on the list before anything reaches his
 * inbox.
 *
 * The wording never says the customer ignored him. We only know an email was
 * opened when the pictures in it load, and plenty of mail programs never load
 * them — so every line here says "not opened yet", which is a reason to ring
 * somebody, not a fact about what they did.
 */

const selectClass = 'h-9 rounded-md border border-input bg-background px-2 text-sm';

function rowLine(row: UnopenedAlertRow) {
  return `${row.clientName} — ${row.subject ?? '(no subject)'} — sent ${row.sentAt.slice(0, 10)}, ${row.daysUnopened} day${row.daysUnopened === 1 ? '' : 's'} ago`;
}

export function UnopenedEmailAlertPanel() {
  const { data, isLoading } = useGetUnopenedAlert();
  const update = useUpdateUnopenedAlert();
  const runNow = useRunUnopenedAlertNow();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [showList, setShowList] = useState(false);
  const [email, setEmail] = useState('');
  const [days, setDays] = useState(3);

  // Seeded from the server once it answers, then his to type over.
  useEffect(() => {
    if (!data) return;
    setEmail(data.notifyEmail ?? '');
    setDays(data.afterDays);
  }, [data?.notifyEmail, data?.afterDays]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: getGetUnopenedAlertQueryKey() });

  const save = (patch: { enabled?: boolean; afterDays?: number; scope?: 'invoices' | 'all'; notifyEmail?: string | null }) => {
    update.mutate({ data: patch }, {
      onSuccess: (next) => {
        refresh();
        if (patch.enabled === true) {
          toast({ title: 'Switched on', description: `You will hear about emails that go ${next.afterDays} days without being opened.` });
        } else if (patch.enabled === false) {
          toast({ title: 'Switched off', description: 'Nothing about unopened emails reaches your inbox.' });
        } else {
          toast({ title: 'Saved' });
        }
      },
      onError: (e: any) => toast({ title: 'Not saved', description: e?.message ?? 'Try again.', variant: 'destructive' }),
    });
  };

  const sendNow = () => {
    // Say the address out loud first. The box can be empty, and then this goes
    // to the company email on the Settings page — which is not obvious from a
    // button that only says "Send it to me now".
    const where = email.trim() || data?.notifyEmail;
    if (!where) {
      toast({ title: 'Nowhere to send it', description: 'Type an address in the box, or fill in your company email on the Settings page.' });
      return;
    }
    if (!window.confirm(`Email the not-opened-yet list to ${where} right now?`)) return;
    runNow.mutate(undefined, {
      onSuccess: (result) => {
        refresh();
        toast({
          title: result.error ? 'Could not send it' : result.reported ? 'Sent to your inbox' : 'Nothing to report',
          description: result.error
            ? result.error
            : result.reported
              ? `${result.reported} email${result.reported === 1 ? '' : 's'} on the list, sent to ${result.to}.`
              : 'No email has crossed the line since the last check.',
          variant: result.error ? 'destructive' : undefined,
        });
      },
      onError: (e: any) => toast({ title: 'Could not send it', description: e?.message ?? 'Try again.', variant: 'destructive' }),
    });
  };

  const enabled = data?.enabled ?? false;
  const standing = data?.stillUnopened ?? [];
  const next = data?.wouldReport ?? [];

  return (
    <div className="space-y-3" data-testid="unopened-alert-panel">
      <div>
        <h2 className="text-xl font-bold flex items-center gap-2">
          <Bell className="w-5 h-5 text-primary" /> Tell Me About Unopened Emails
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          This one emails you, not the customer. Press Preview to see who is on the list today before you switch it on.
        </p>
      </div>

      <div className="rounded-lg border bg-card p-4 space-y-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>When</span>
              <select
                className={selectClass}
                value={data?.scope ?? 'invoices'}
                onChange={(e) => save({ scope: e.target.value as 'invoices' | 'all' })}
                data-testid="select-unopened-scope"
              >
                <option value="invoices">an invoice email</option>
                <option value="all">any email</option>
              </select>
              <span>has gone</span>
              <Input
                type="number"
                min={1}
                max={60}
                className="h-9 w-20"
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                onBlur={() => { if (days !== data?.afterDays && days >= 1) save({ afterDays: days }); }}
                data-testid="input-unopened-days"
              />
              <span>days without being opened, email</span>
              <Input
                type="email"
                placeholder={data?.notifyEmail ?? 'your email'}
                className="h-9 w-64"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onBlur={() => { if (email.trim() !== (data?.notifyEmail ?? '')) save({ notifyEmail: email.trim() || null }); }}
                data-testid="input-unopened-email"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant={enabled ? 'default' : 'outline'}
                onClick={() => save({ enabled: !enabled })}
                disabled={update.isPending}
                data-testid="button-unopened-toggle"
              >
                {enabled ? 'Switched on' : 'Switched off'}
              </Button>
              <Button variant="outline" onClick={() => setShowList((v) => !v)} data-testid="button-unopened-preview">
                <Eye className="w-4 h-4 mr-2" /> {showList ? 'Hide preview' : 'Preview'}
              </Button>
              <Button variant="outline" onClick={sendNow} disabled={runNow.isPending} data-testid="button-unopened-send-now">
                <Send className="w-4 h-4 mr-2" /> {runNow.isPending ? 'Sending…' : 'Send it to me now'}
              </Button>
              <span className="text-sm text-muted-foreground">
                {standing.length === 0
                  ? 'Nothing is sitting unopened past that many days.'
                  : `${standing.length} email${standing.length === 1 ? '' : 's'} not opened yet · ${next.length} would go in the next one.`}
              </span>
            </div>

            {data?.problem && (
              <p className="text-sm text-amber-700 dark:text-amber-500" data-testid="text-unopened-problem">{data.problem}</p>
            )}
            {data?.lastError && (
              <p className="text-sm text-destructive">Last try failed — {data.lastError}</p>
            )}
            {data?.lastSentAt && (
              <p className="text-xs text-muted-foreground">
                Last sent to {data.notifyEmail} on {data.lastSentAt.slice(0, 10)}.
              </p>
            )}

            {showList && (
              <div className="rounded-md border bg-muted/40 p-3 space-y-2" data-testid="unopened-alert-preview">
                <p className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-2">
                  <MailQuestion className="w-4 h-4" /> Not opened yet
                </p>
                {standing.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nothing to show. Every email you have sent has been opened, or is not old enough yet.</p>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {standing.map((row) => (
                      <li key={row.emailSendId} className="flex items-start gap-2">
                        <span className="text-muted-foreground">•</span>
                        <span>{rowLine(row)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {/* The honest footnote. Without it he rings a customer who read the bill on their phone. */}
                <p className="text-xs text-muted-foreground">
                  We know an email was opened when the pictures in it load. Some mail programs never load pictures and
                  some load them before anyone reads anything, so this is worth a phone call rather than proof the
                  customer ignored you.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default UnopenedEmailAlertPanel;
