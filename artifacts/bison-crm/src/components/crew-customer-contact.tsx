import { useState } from 'react';
import {
  useGetOnTheWayNotice,
  useSendOnTheWayNotice,
  getGetOnTheWayNoticeQueryKey,
  useGetSmsStatus,
  useSendJobSms,
  type Job,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Mail, MessageSquare, Phone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { segmentsOf, smsHref, telHref } from '@/components/client/text-client-button';

/**
 * The two ways a contractor reaches the customer from a job card.
 *
 * OnTheWayNotice (feedback 49): after tapping On The Way, one more tap emails
 * the customer the "On the way" document. Offered, never automatic — a wrong
 * tap must not email a customer — and it says why when it cannot (no email,
 * asked for no email, already sent).
 *
 * TextCustomerButton: with texting on, sends from this person's masked
 * number so the reply comes back to them. With texting off, it opens the
 * phone's own Messages app and says the customer will see the real number.
 */

export function OnTheWayNotice({ job }: { job: Job }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const onTheWay = job.status === 'on_the_way';
  const { data: notice } = useGetOnTheWayNotice(job.id, {
    query: { queryKey: getGetOnTheWayNoticeQueryKey(job.id), enabled: onTheWay },
  });
  const send = useSendOnTheWayNotice();

  if (!onTheWay || !notice) return null;

  const done = () => queryClient.invalidateQueries({ queryKey: getGetOnTheWayNoticeQueryKey(job.id) });

  if (!notice.canSend) {
    const why =
      notice.reason === 'already_sent'
        ? `Customer was emailed that you're on the way${notice.sentAt ? ` at ${new Date(notice.sentAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}.`
        : notice.reason === 'no_email'
          ? 'Customer has no email on file, so they cannot be told you are on the way.'
          : notice.reason === 'do_not_email'
            ? 'Customer asked not to be emailed.'
            : null;
    return why ? (
      <p className="px-3 pb-3 text-xs text-muted-foreground" data-testid="on-the-way-notice-why">{why}</p>
    ) : null;
  }

  return (
    <div className="px-3 pb-3">
      <Button
        variant="outline"
        className="w-full h-11 border-2 font-bold"
        disabled={send.isPending}
        onClick={() =>
          send.mutate(
            { id: job.id },
            {
              onSuccess: (r) => {
                done();
                toast(
                  r.sent
                    ? { title: 'Customer emailed', description: `${job.clientName} knows you're on the way.` }
                    : { title: 'Not sent', description: r.reason === 'failed' ? 'The email did not go through — the office can send it.' : 'Nothing to send.' },
                );
              },
              onError: (e: any) => toast({ title: 'Not sent', description: e?.data?.error || e?.message }),
            },
          )
        }
        data-testid="on-the-way-notice-send"
      >
        <Mail className="w-4 h-4 mr-2" /> {send.isPending ? 'Sending…' : `Email ${job.clientName ?? 'customer'}: we're on our way`}
      </Button>
    </div>
  );
}

export function TextCustomerButton({ job }: { job: Job }) {
  const { data: status } = useGetSmsStatus();
  const [open, setOpen] = useState(false);
  const sms = smsHref(job.clientPhone);
  const tel = telHref(job.clientPhone);
  if (!job.clientPhone || (!sms && !tel)) return null;

  if (!status?.configured) {
    return (
      <div className="space-y-1">
        <div className="grid grid-cols-2 gap-2">
          {sms && (
            <Button asChild variant="outline" className="h-11 border-2">
              <a href={sms} data-testid="text-customer-sms-link"><MessageSquare className="w-4 h-4 mr-2" /> Text customer</a>
            </Button>
          )}
          {tel && (
            <Button asChild variant="outline" className="h-11 border-2">
              <a href={tel}><Phone className="w-4 h-4 mr-2" /> Call customer</a>
            </Button>
          )}
        </div>
        {/* Nobody should assume the company number is on when it is not. */}
        <p className="text-[11px] text-muted-foreground">Opens your own Messages app — the customer will see your number.</p>
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" className="h-11 border-2" onClick={() => setOpen(true)} data-testid="text-customer-open">
          <MessageSquare className="w-4 h-4 mr-2" /> Text customer
        </Button>
        {tel && (
          <Button asChild variant="outline" className="h-11 border-2">
            <a href={tel}><Phone className="w-4 h-4 mr-2" /> Call customer</a>
          </Button>
        )}
      </div>
      {open && <JobTextDialog job={job} myNumber={status.myNumber ?? status.officeNumber} onClose={() => setOpen(false)} />}
    </>
  );
}

function JobTextDialog({ job, myNumber, onClose }: { job: Job; myNumber: string | null; onClose: () => void }) {
  const { toast } = useToast();
  const send = useSendJobSms();
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const segments = segmentsOf(body);

  const handleSend = () => {
    setError(null);
    send.mutate(
      { id: job.id, data: { body: body.trim() } },
      {
        onSuccess: (r) => {
          if (r.sent) {
            toast({ title: 'Text sent', description: `${job.clientName} will see it from your company number.` });
            onClose();
          } else {
            setError(r.error || 'The text did not go through.');
          }
        },
        onError: (e: any) => setError(e?.data?.error || e?.message || 'Could not send the text'),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Text {job.clientName}</DialogTitle>
          <DialogDescription>
            {myNumber
              ? 'Sent from your company texting number. Their reply comes to your own phone.'
              : 'You have no texting number yet — ask the office to give you one on the Team page.'}
          </DialogDescription>
        </DialogHeader>
        <Textarea
          rows={4}
          maxLength={1000}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Running about 20 minutes late — see you soon."
          data-testid="job-sms-body"
        />
        <p className="text-xs text-muted-foreground">{body.length} characters · {segments} text{segments === 1 ? '' : 's'}</p>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSend} disabled={send.isPending || !body.trim()} data-testid="job-sms-send">
            {send.isPending ? 'Sending…' : 'Send text'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
