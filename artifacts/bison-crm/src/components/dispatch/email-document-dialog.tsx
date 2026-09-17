import { useEffect, useMemo, useState } from 'react';
import {
  useListDocumentTemplates,
  usePreviewDocumentTemplate,
  useSendDocumentTemplate,
  useBulkJobAction,
  type DocumentPreview,
  type DocumentSendResult,
  type Job,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertTriangle, MailX } from 'lucide-react';
import { selectClass } from './job-filters';

/** The note the office asked for on a customer who cannot be emailed. */
export const NO_EMAIL_NOTE = 'NO EMAIL - call or text instead';

/**
 * "Email selected": one document to every customer behind the ticked jobs.
 *
 * Used from the dispatch board ("Sprinkler blowout day is [servicedate]") and
 * the waiting list ("you are on the schedule, date to follow"). The sending
 * itself is the shared document send (contract C1); this dialog picks the
 * document, lets him type the date the tokens should say, and afterwards says
 * plainly "Sent 42 of 44 — 2 have no email" with the names, because the two he
 * has to ring are the whole reason he wanted the count.
 */
export function EmailDocumentDialog({
  open,
  onOpenChange,
  jobs,
  source,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobs: Job[];
  source: 'dispatch' | 'waiting_list';
  onSent?: () => void;
}) {
  const { data: templates } = useListDocumentTemplates();
  const preview = usePreviewDocumentTemplate();
  const send = useSendDocumentTemplate();
  const bulk = useBulkJobAction();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [templateId, setTemplateId] = useState('');
  const [serviceDate, setServiceDate] = useState('');
  const [rendered, setRendered] = useState<DocumentPreview | null>(null);
  const [result, setResult] = useState<DocumentSendResult | null>(null);
  const [noted, setNoted] = useState(false);

  // One email per customer, however many of their jobs are ticked.
  const recipients = useMemo(() => {
    const byClient = new Map<number, { id: number; name: string; email: string | null; doNotEmail: boolean; jobIds: number[] }>();
    for (const j of jobs) {
      const r = byClient.get(j.clientId) ?? {
        id: j.clientId,
        name: j.clientName ?? `Client #${j.clientId}`,
        email: j.clientEmail?.trim() || null,
        doNotEmail: j.clientDoNotEmail === true,
        jobIds: [],
      };
      r.jobIds.push(j.id);
      byClient.set(j.clientId, r);
    }
    return [...byClient.values()];
  }, [jobs]);
  const noEmail = recipients.filter((r) => !r.email);
  const doNotEmail = recipients.filter((r) => r.email && r.doNotEmail);

  // The one date all the ticked jobs share, if they share one: that is what
  // "[servicedate]" should say. A mixed selection leaves the box blank and the
  // server fills the token per job instead.
  const commonDate = useMemo(() => {
    const dates = new Set(jobs.map((j) => j.scheduledDate).filter((d): d is string => !!d));
    return dates.size === 1 ? [...dates][0] : '';
  }, [jobs]);
  const commonServiceId = useMemo(() => {
    const ids = new Set(jobs.map((j) => j.serviceId).filter((id): id is number => id != null));
    return ids.size === 1 ? [...ids][0] : null;
  }, [jobs]);

  // Fresh start each time it opens: the document that matches the selected
  // service first, then anything written for customers.
  useEffect(() => {
    if (!open) return;
    setResult(null);
    setNoted(false);
    setRendered(null);
    setServiceDate(commonDate);
    const list = templates ?? [];
    const match = (commonServiceId != null && list.find((t) => t.serviceId === commonServiceId))
      || list.find((t) => t.category === 'client')
      || list[0];
    setTemplateId(match ? String(match.id) : '');
  }, [open, templates, commonDate, commonServiceId]);

  // Show the letter against the first customer so he can read what goes out.
  useEffect(() => {
    if (!open || !templateId || recipients.length === 0) return;
    preview.mutate(
      { id: Number(templateId), data: { clientId: recipients[0].id } },
      { onSuccess: setRendered, onError: () => setRendered(null) },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, templateId, recipients[0]?.id]);

  const template = (templates ?? []).find((t) => String(t.id) === templateId);
  const total = recipients.length;
  const willSkip = noEmail.length + doNotEmail.length;

  const doSend = () => {
    if (!template) return;
    send.mutate(
      {
        id: template.id,
        data: {
          clientIds: recipients.map((r) => r.id),
          jobIds: jobs.map((j) => j.id),
          ...(serviceDate ? { tokens: { servicedate: longDate(serviceDate) } } : {}),
          source,
        },
      },
      {
        onSuccess: (res) => {
          setResult(res);
          queryClient.invalidateQueries({ queryKey: ['/api/email-activity'] });
          toast({
            title: `Sent ${res.sent} of ${res.sent + res.skipped.length}`,
            description: res.skipped.length ? `${res.skipped.length} not sent — see the list.` : undefined,
          });
          onSent?.();
        },
        onError: (error) => {
          toast({ title: 'Nothing was sent', description: error instanceof Error ? error.message : 'Try again.', variant: 'destructive' });
        },
      },
    );
  };

  // The "NO EMAIL" note on the jobs of everyone who could not be emailed, so
  // the board shows in red who has to be rung instead.
  const unreachable = (result?.skipped ?? []).filter((s) => s.reason === 'no_email' || s.reason === 'do_not_email');
  const addNoEmailNotes = () => {
    const jobIds = unreachable.flatMap((s) => recipients.find((r) => r.id === s.clientId)?.jobIds ?? []);
    if (jobIds.length === 0) return;
    bulk.mutate(
      { data: { jobIds, action: 'add_note', note: NO_EMAIL_NOTE, notesImportant: true } },
      {
        onSuccess: (r) => {
          setNoted(true);
          queryClient.invalidateQueries({ queryKey: ['/api/jobs'] });
          queryClient.invalidateQueries({ queryKey: ['/api/waiting-list'] });
          toast({ title: `Noted ${r.updated} job${r.updated === 1 ? '' : 's'}`, description: `"${NO_EMAIL_NOTE}" now shows on the row.` });
        },
      },
    );
  };

  const reasonText = (reason: string) =>
    reason === 'no_email' ? 'no email address' : reason === 'do_not_email' ? 'marked do not email' : 'could not be sent';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="email-document-dialog">
        <DialogHeader>
          <DialogTitle>Email {total} customer{total === 1 ? '' : 's'}</DialogTitle>
          <DialogDescription>
            One email per customer, filled in with their name and the service date. Customers with no email or marked do not email are skipped and listed afterwards.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3 py-2" data-testid="email-document-result">
            <div className="rounded-lg border bg-muted/40 p-3">
              <div className="text-lg font-semibold">
                Sent {result.sent} of {result.sent + result.skipped.length}
              </div>
              {result.skipped.length === 0 ? (
                <p className="text-sm text-muted-foreground">Everyone got it.</p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {unreachable.length > 0 && `${unreachable.length} ${unreachable.length === 1 ? 'has' : 'have'} no email. `}
                  {result.skipped.length - unreachable.length > 0 && `${result.skipped.length - unreachable.length} failed to send.`}
                </p>
              )}
            </div>
            {result.skipped.length > 0 && (
              <ul className="max-h-56 space-y-1 overflow-auto rounded-md border p-2 text-sm">
                {result.skipped.map((s) => (
                  <li key={s.clientId} className="flex items-center gap-2">
                    <MailX className="h-3.5 w-3.5 shrink-0 text-destructive" />
                    <span className="font-medium">{s.clientName}</span>
                    <span className="text-muted-foreground">— {reasonText(s.reason)}</span>
                  </li>
                ))}
              </ul>
            )}
            {unreachable.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" disabled={noted || bulk.isPending} onClick={addNoEmailNotes} data-testid="email-add-no-email-note">
                  <AlertTriangle className="mr-1 h-3.5 w-3.5" />
                  {noted ? 'Note added' : `Put a "${NO_EMAIL_NOTE}" note on their job${unreachable.length === 1 ? '' : 's'}`}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => navigator.clipboard?.writeText(result.skipped.map((s) => `${s.clientName} — ${reasonText(s.reason)}`).join('\n'))}
                >
                  Copy list
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <label className="col-span-2 text-sm font-medium">
                Document
                <select className={`${selectClass} mt-1 h-10`} value={templateId} onChange={(e) => setTemplateId(e.target.value)} data-testid="email-template">
                  <option value="">Pick a document…</option>
                  {(templates ?? []).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}{t.serviceName ? ` · ${t.serviceName}` : ''}{t.category !== 'client' ? ` (${t.category})` : ''}
                    </option>
                  ))}
                </select>
                {(templates ?? []).length === 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">No documents yet. Write one under Settings › Documents first.</p>
                )}
              </label>
              <label className="text-sm font-medium">
                Service date for [servicedate]
                <Input type="date" className="mt-1" value={serviceDate} onChange={(e) => setServiceDate(e.target.value)} data-testid="email-service-date" />
                <span className="mt-1 block text-xs font-normal text-muted-foreground">
                  {serviceDate
                    ? `The letter will say "${longDate(serviceDate)}".`
                    : jobs.some((j) => j.scheduledDate)
                      ? "Blank: each customer's own job date is used."
                      : 'Blank: the token is left empty ("date to follow").'}
                </span>
              </label>
              <div className="text-sm">
                <div className="font-medium">Going to</div>
                <div className="mt-1 text-muted-foreground">
                  {total} customer{total === 1 ? '' : 's'} from {jobs.length} job{jobs.length === 1 ? '' : 's'}
                  {willSkip > 0 && (
                    <span className="block text-destructive">
                      {noEmail.length > 0 && `${noEmail.length} with no email`}
                      {noEmail.length > 0 && doNotEmail.length > 0 && ', '}
                      {doNotEmail.length > 0 && `${doNotEmail.length} marked do not email`}
                      {' '}— will be skipped
                    </span>
                  )}
                </div>
              </div>
            </div>

            {template && (
              <div className="rounded-md border bg-muted/30 p-3 text-sm" data-testid="email-preview">
                <div className="mb-1 text-xs text-muted-foreground">
                  Preview for {rendered?.clientName ?? recipients[0]?.name ?? 'the first customer'}
                </div>
                {preview.isPending && !rendered ? (
                  <div className="animate-pulse text-muted-foreground">Rendering…</div>
                ) : rendered ? (
                  <>
                    <div className="font-semibold">{rendered.subject || template.name}</div>
                    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap font-sans text-xs">{rendered.body}</pre>
                    {rendered.unknownTokens.filter((t) => t !== 'servicedate' && t !== 'servicename').length > 0 && (
                      <p className="mt-1 text-xs text-amber-700">
                        Tokens with nothing to fill: {rendered.unknownTokens.filter((t) => t !== 'servicedate' && t !== 'servicename').map((t) => `[${t}]`).join(', ')}
                      </p>
                    )}
                  </>
                ) : (
                  <div className="text-muted-foreground">Could not render a preview. The send still fills the tokens.</div>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{result ? 'Done' : 'Cancel'}</Button>
          {!result && (
            <Button onClick={doSend} disabled={!template || total === 0 || send.isPending} data-testid="email-send">
              {send.isPending ? 'Sending…' : `Send to ${total - willSkip}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "September 15, 2026", the same shape the server writes for job dates. */
function longDate(iso: string) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!parts) return iso;
  const d = new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])));
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
