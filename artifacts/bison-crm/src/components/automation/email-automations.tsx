import { useState } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import {
  useListAutomationRules,
  useCreateAutomationRule,
  useUpdateAutomationRule,
  useDeleteAutomationRule,
  usePreviewAutomationRule,
  useRunAutomationRulesNow,
  useGetEmailAutomationStatus,
  getListAutomationRulesQueryKey,
  getGetEmailAutomationStatusQueryKey,
  useListDocumentTemplates,
  useListServices,
  useListEmailBatches,
  useGetEmailBatch,
  getListEmailBatchesQueryKey,
  type AutomationRule,
  type AutomationRuleTrigger,
  type AutomationRuleUpdate,
  type AutomationRulePreview,
  type EmailAutomationRun,
  type EmailBatch,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import {
  Plus, Trash2, Eye, PlayCircle, Clock, MailCheck, MailWarning, Mail, ChevronDown, ChevronRight, Send, Inbox,
} from 'lucide-react';

/**
 * His automations read as one sentence: "N days after X, send Y, unless Z".
 * Every trigger carries the words that go into that sentence so the row and
 * the audit line say the same thing.
 */
const TRIGGER_META: Record<AutomationRuleTrigger, { after: string; unpaid?: boolean; noResponse?: boolean; service?: boolean }> = {
  invoice_past_due: { after: 'an invoice is due', unpaid: true },
  invoice_sent: { after: 'an invoice is sent', unpaid: true },
  estimate_sent: { after: 'an estimate is sent', noResponse: true },
  job_completed: { after: 'a job is completed', service: true },
  client_added: { after: 'a new customer is added' },
  fixed_date: { after: 'every year on' },
  after_rule: { after: 'an earlier notice went out', unpaid: true, noResponse: true },
};

const TRIGGER_ORDER: AutomationRuleTrigger[] = [
  'invoice_past_due', 'invoice_sent', 'estimate_sent', 'job_completed', 'client_added', 'fixed_date', 'after_rule',
];

const selectClass = 'h-9 rounded-md border border-input bg-background px-2 text-sm';

function ruleSentence(rule: AutomationRule): string {
  const meta = TRIGGER_META[rule.trigger];
  const when = rule.trigger === 'fixed_date'
    ? `Every year on ${rule.monthDay ?? '??-??'}${rule.offsetDays ? ` (+${rule.offsetDays} days)` : ''}`
    : rule.trigger === 'after_rule'
      ? `${rule.offsetDays} day${rule.offsetDays === 1 ? '' : 's'} after "${rule.afterRuleName ?? 'an earlier notice'}" went out`
      : `${rule.offsetDays} day${rule.offsetDays === 1 ? '' : 's'} after ${meta.after}`;
  const unless = [
    rule.conditions.stillUnpaid ? 'still unpaid' : null,
    rule.conditions.noResponse ? 'no answer yet' : null,
    rule.serviceName ? `for ${rule.serviceName}` : null,
  ].filter(Boolean);
  return `${when}, send "${rule.templateName ?? '(no document picked)'}"${unless.length ? `, only if ${unless.join(' and ')}` : ''}.`;
}

/**
 * The "N days after X, send Y" rules, the daily run that fires them, and the
 * log of what each run did. Nothing here sends until he flips a rule on.
 */
export function EmailAutomationsPanel() {
  const { data: rules, isLoading } = useListAutomationRules();
  const { data: templates } = useListDocumentTemplates();
  const { data: services } = useListServices();
  const { data: status } = useGetEmailAutomationStatus();
  const runNow = useRunAutomationRulesNow();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const refreshAll = () => {
    queryClient.invalidateQueries({ queryKey: getListAutomationRulesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetEmailAutomationStatusQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListEmailBatchesQueryKey() });
  };

  const enabledCount = (rules ?? []).filter((r) => r.enabled).length;

  const handleRunNow = () => {
    if (!confirm(`Run the ${enabledCount} switched-on automation${enabledCount === 1 ? '' : 's'} right now? Anything due today goes out to real customers.`)) return;
    runNow.mutate(undefined, {
      onSuccess: (r) => {
        refreshAll();
        toast({ title: 'Automations ran', description: r.summary });
      },
      onError: (e: any) => toast({ title: 'Could not run', description: e?.message ?? 'Try again in a minute.', variant: 'destructive' }),
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Send className="w-5 h-5 text-primary" /> Automated Emails
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Each line is one rule: so many days after something happens, send one of your documents. Press Preview to see exactly who would get it today before you switch it on.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" onClick={handleRunNow} disabled={runNow.isPending || !enabledCount} title={enabledCount ? '' : 'Switch a rule on first'}>
            <PlayCircle className="w-4 h-4 mr-2" /> {runNow.isPending ? 'Running...' : 'Run now'}
          </Button>
          <NewAutomationDialog rules={rules ?? []} templates={templates ?? []} services={services ?? []} onCreated={refreshAll} />
        </div>
      </div>

      {isLoading ? (
        <div className="text-muted-foreground animate-pulse p-4">Loading...</div>
      ) : !rules?.length ? (
        <div className="text-center p-6 bg-card border rounded-lg text-muted-foreground text-sm">
          No automations yet. Add one, like "2 days after an invoice is due, send Past Due".
        </div>
      ) : (
        rules.map((r) => (
          <AutomationRuleRow key={r.id} rule={r} rules={rules} templates={templates ?? []} services={services ?? []} onChanged={refreshAll} />
        ))
      )}

      {status && (
        <div className="bg-card border rounded-lg p-4 shadow-sm space-y-2">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Clock className="w-4 h-4 text-primary" /> Daily run
          </div>
          <p className="text-sm text-muted-foreground">
            {status.enabled
              ? `Checks every rule once a day at ${status.runAtLocalTime} (${status.timeZone.replace('_', ' ')}). If the server was asleep at that time it catches up as soon as it is back. Today is ${status.today}.`
              : 'The daily run is not going on this server. Use "Run now" to send what is due.'}
          </p>
          <RunLog runs={status.runs} />
        </div>
      )}
    </div>
  );
}

function RunLog({ runs }: { runs: EmailAutomationRun[] }) {
  const [open, setOpen] = useState(false);
  if (!runs.length) return <p className="text-xs text-muted-foreground">Has not run yet.</p>;
  const shown = open ? runs : runs.slice(0, 3);
  return (
    <div className="space-y-1">
      {shown.map((run) => (
        <p key={run.id} className="text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">{format(new Date(run.startedAt), "d MMM yyyy 'at' h:mm a")}</span>
          {' '}· {run.trigger === 'manual' ? `by hand${run.triggeredBy ? ` (${run.triggeredBy})` : ''}` : 'automatic'}
          {' '}— {run.status === 'failed' ? `failed: ${run.error ?? 'unknown error'}` : run.status === 'running' ? 'in progress' : (run.summary ?? `${run.sent} sent`)}
        </p>
      ))}
      {runs.length > 3 && (
        <button type="button" className="text-xs text-primary underline" onClick={() => setOpen(!open)}>
          {open ? 'Show fewer' : `Show all ${runs.length} runs`}
        </button>
      )}
    </div>
  );
}

type NamedRow = { id: number; name: string };

/**
 * One rule as an editable sentence. Every control saves on change, the way
 * the scheduling rules do, so trying a different number of days is one click.
 */
function AutomationRuleRow({ rule, rules, templates, services, onChanged }: {
  rule: AutomationRule;
  rules: AutomationRule[];
  templates: NamedRow[];
  services: NamedRow[];
  onChanged: () => void;
}) {
  const updateRule = useUpdateAutomationRule();
  const deleteRule = useDeleteAutomationRule();
  const previewRule = usePreviewAutomationRule();
  const { toast } = useToast();
  const [offsetDays, setOffsetDays] = useState(String(rule.offsetDays));
  const [monthDay, setMonthDay] = useState(rule.monthDay ?? '');
  const [preview, setPreview] = useState<AutomationRulePreview | null>(null);

  const meta = TRIGGER_META[rule.trigger];
  const save = (data: AutomationRuleUpdate) =>
    updateRule.mutate({ id: rule.id, data }, {
      onSuccess: onChanged,
      onError: (e: any) => toast({ title: 'Could not save', description: e?.message ?? 'Try again.', variant: 'destructive' }),
    });
  const saveConditions = (patch: Partial<AutomationRule['conditions']>) => save({ conditions: { ...rule.conditions, ...patch } });

  const handlePreview = () =>
    previewRule.mutate({ id: rule.id }, {
      onSuccess: setPreview,
      onError: (e: any) => toast({ title: 'Could not preview', description: e?.message ?? 'Try again.', variant: 'destructive' }),
    });

  const otherRules = rules.filter((r) => r.id !== rule.id);

  return (
    <div className={`p-3 bg-card border rounded-lg space-y-2 ${rule.enabled ? '' : 'opacity-70'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-sm mr-1">{rule.name}</span>
        <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${rule.enabled ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
          {rule.enabled ? 'On' : 'Off'}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="outline" onClick={handlePreview} disabled={previewRule.isPending}>
            <Eye className="w-4 h-4 mr-1" /> {previewRule.isPending ? 'Checking...' : 'Preview'}
          </Button>
          <Button size="sm" variant={rule.enabled ? 'outline' : 'default'} onClick={() => save({ enabled: !rule.enabled })} disabled={updateRule.isPending}>
            {rule.enabled ? 'Switch off' : 'Switch on'}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => { if (confirm(`Delete "${rule.name}"? Nothing already sent is affected.`)) deleteRule.mutate({ id: rule.id }, { onSuccess: onChanged }); }}
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        {rule.trigger === 'fixed_date' ? (
          <>
            <span className="text-muted-foreground">Every year on</span>
            <Input
              value={monthDay}
              onChange={(e) => setMonthDay(e.target.value)}
              onBlur={() => { if (/^\d{2}-\d{2}$/.test(monthDay) && monthDay !== rule.monthDay) save({ monthDay }); else setMonthDay(rule.monthDay ?? ''); }}
              placeholder="09-01"
              className="w-24 h-9"
            />
          </>
        ) : (
          <>
            <Input
              type="number"
              min="0"
              value={offsetDays}
              onChange={(e) => setOffsetDays(e.target.value)}
              onBlur={() => {
                const days = parseInt(offsetDays);
                if (!Number.isNaN(days) && days >= 0 && days !== rule.offsetDays) save({ offsetDays: days });
                else setOffsetDays(String(rule.offsetDays));
              }}
              className="w-20 h-9"
            />
            <span className="text-muted-foreground">days after</span>
          </>
        )}

        <select className={selectClass} value={rule.trigger} onChange={(e) => save({ trigger: e.target.value as AutomationRuleTrigger })}>
          {TRIGGER_ORDER.map((t) => (
            <option key={t} value={t}>{t === 'fixed_date' ? 'that date' : TRIGGER_META[t].after}</option>
          ))}
        </select>

        {rule.trigger === 'after_rule' && (
          <select
            className={selectClass}
            value={rule.conditions.afterRuleId ?? ''}
            onChange={(e) => saveConditions({ afterRuleId: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">Pick the earlier notice...</option>
            {otherRules.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        )}

        <span className="text-muted-foreground">send</span>
        <select
          className={`${selectClass} min-w-[12rem]`}
          value={rule.templateId ?? ''}
          onChange={(e) => save({ templateId: e.target.value ? Number(e.target.value) : null })}
        >
          <option value="">Pick a document...</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>

        {(meta.unpaid || meta.noResponse || meta.service) && <span className="text-muted-foreground">only if</span>}
        {meta.unpaid && (
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={Boolean(rule.conditions.stillUnpaid)} onChange={(e) => saveConditions({ stillUnpaid: e.target.checked })} />
            still unpaid
          </label>
        )}
        {meta.noResponse && (
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={Boolean(rule.conditions.noResponse)} onChange={(e) => saveConditions({ noResponse: e.target.checked })} />
            no answer yet
          </label>
        )}
        {meta.service && (
          <select
            className={selectClass}
            value={rule.conditions.serviceId ?? ''}
            onChange={(e) => saveConditions({ serviceId: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">any service</option>
            {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        {ruleSentence(rule)} Sent {rule.sentTotal} so far.
        {rule.lastRunAt ? ` Last checked ${format(new Date(rule.lastRunAt), "d MMM 'at' h:mm a")}.` : ''}
        {!rule.templateId && ' Pick a document in Settings › Document templates, then choose it here.'}
      </p>

      <PreviewDialog preview={preview} onClose={() => setPreview(null)} />
    </div>
  );
}

/** "Would send to 14 customers: …" — the dry run, with one rendered sample. */
function PreviewDialog({ preview, onClose }: { preview: AutomationRulePreview | null; onClose: () => void }) {
  if (!preview) return null;
  const skipped = preview.recipients.filter((r) => r.wouldSkip);
  const going = preview.recipients.filter((r) => !r.wouldSkip);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Preview: {preview.ruleName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {preview.problem && (
            <p className="text-sm bg-destructive/10 border border-destructive/30 text-destructive rounded-md p-2">{preview.problem}</p>
          )}
          <p className="text-sm">
            If this ran today ({preview.today}) it would send <span className="font-bold">"{preview.templateName ?? '(no document)'}"</span> to{' '}
            <span className="font-bold">{preview.count} customer{preview.count === 1 ? '' : 's'}</span>.
            {' '}Nothing was sent.
          </p>
          {going.length > 0 && (
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1">Would go to</p>
              <ul className="text-sm space-y-0.5 max-h-56 overflow-y-auto border rounded-md p-2">
                {going.map((r) => (
                  <li key={`${r.clientId}-${r.subjectLabel}`} className="flex flex-wrap justify-between gap-2">
                    <Link href={`/clients/${r.clientId}`} className="font-medium hover:underline">{r.clientName}</Link>
                    <span className="text-muted-foreground text-xs">{r.subjectLabel}{r.email ? ` · ${r.email}` : ''}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {skipped.length > 0 && (
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1">Would be skipped</p>
              <ul className="text-sm space-y-0.5 max-h-40 overflow-y-auto border rounded-md p-2">
                {skipped.map((r) => (
                  <li key={`${r.clientId}-${r.subjectLabel}`} className="flex flex-wrap justify-between gap-2">
                    <Link href={`/clients/${r.clientId}`} className="font-medium hover:underline">{r.clientName}</Link>
                    <span className="text-muted-foreground text-xs">{r.wouldSkip === 'do_not_email' ? 'marked do not email' : 'no email on file'} · {r.subjectLabel}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {preview.sample && (
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1">As {preview.sample.clientName} would read it</p>
              {preview.sample.subject && <p className="text-sm font-semibold mb-1">{preview.sample.subject}</p>}
              <pre className="whitespace-pre-wrap font-sans text-sm leading-6 bg-muted/40 border rounded-md p-3 max-h-72 overflow-y-auto">{preview.sample.body}</pre>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewAutomationDialog({ rules, templates, services, onCreated }: {
  rules: AutomationRule[];
  templates: NamedRow[];
  services: NamedRow[];
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState<AutomationRuleTrigger>('invoice_past_due');
  const [offsetDays, setOffsetDays] = useState('2');
  const [monthDay, setMonthDay] = useState('09-01');
  const [templateId, setTemplateId] = useState('');
  const [afterRuleId, setAfterRuleId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [stillUnpaid, setStillUnpaid] = useState(true);
  const [noResponse, setNoResponse] = useState(true);
  const createRule = useCreateAutomationRule();
  const { toast } = useToast();

  const meta = TRIGGER_META[trigger];
  const days = parseInt(offsetDays) || 0;

  const handleSave = () => {
    createRule.mutate({
      data: {
        name: name.trim(),
        enabled: false,
        trigger,
        offsetDays: trigger === 'fixed_date' ? 0 : days,
        monthDay: trigger === 'fixed_date' ? monthDay : null,
        templateId: templateId ? Number(templateId) : null,
        conditions: {
          stillUnpaid: meta.unpaid ? stillUnpaid : false,
          noResponse: meta.noResponse ? noResponse : false,
          serviceId: meta.service && serviceId ? Number(serviceId) : null,
          afterRuleId: trigger === 'after_rule' && afterRuleId ? Number(afterRuleId) : null,
        },
      },
    }, {
      onSuccess: () => {
        onCreated();
        setOpen(false);
        setName('');
        toast({ title: 'Automation added', description: 'It is switched off. Press Preview to see who would get it, then switch it on.' });
      },
      onError: (e: any) => toast({ title: 'Could not add', description: e?.message ?? 'Try again.', variant: 'destructive' }),
    });
  };

  const sentence = trigger === 'fixed_date'
    ? `Every year on ${monthDay || '??-??'}, send`
    : `${days} day${days === 1 ? '' : 's'} after ${trigger === 'after_rule' ? `"${rules.find((r) => String(r.id) === afterRuleId)?.name ?? 'an earlier notice'}" went out` : meta.after}, send`;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="shrink-0"><Plus className="w-4 h-4 mr-2" /> New Automation</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>New automated email</DialogTitle></DialogHeader>
        <div className="space-y-4 py-4">
          <div>
            <label className="text-sm font-medium mb-1 block">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Past due notice" autoFocus />
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">When</label>
            <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={trigger} onChange={(e) => setTrigger(e.target.value as AutomationRuleTrigger)}>
              {TRIGGER_ORDER.map((t) => (
                <option key={t} value={t}>{t === 'fixed_date' ? 'Every year on a date' : `Some days after ${TRIGGER_META[t].after}`}</option>
              ))}
            </select>
          </div>
          {trigger === 'fixed_date' ? (
            <div>
              <label className="text-sm font-medium mb-1 block">Date (MM-DD)</label>
              <Input value={monthDay} onChange={(e) => setMonthDay(e.target.value)} placeholder="09-01" className="w-28" />
            </div>
          ) : (
            <div>
              <label className="text-sm font-medium mb-1 block">Wait this many days</label>
              <Input type="number" min="0" value={offsetDays} onChange={(e) => setOffsetDays(e.target.value)} className="w-28" />
            </div>
          )}
          {trigger === 'after_rule' && (
            <div>
              <label className="text-sm font-medium mb-1 block">After which notice</label>
              <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={afterRuleId} onChange={(e) => setAfterRuleId(e.target.value)}>
                <option value="">Pick one...</option>
                {rules.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="text-sm font-medium mb-1 block">Send this document</label>
            <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">Pick one...</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <p className="text-xs text-muted-foreground mt-1">Documents live in Settings › Document templates.</p>
          </div>
          {(meta.unpaid || meta.noResponse || meta.service) && (
            <div className="space-y-2">
              <label className="text-sm font-medium block">Only if</label>
              {meta.unpaid && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={stillUnpaid} onChange={(e) => setStillUnpaid(e.target.checked)} /> the invoice is still unpaid
                </label>
              )}
              {meta.noResponse && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={noResponse} onChange={(e) => setNoResponse(e.target.checked)} /> the estimate has no answer yet
                </label>
              )}
              {meta.service && (
                <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
                  <option value="">the job is for any service</option>
                  {services.map((s) => <option key={s.id} value={s.id}>the job is {s.name}</option>)}
                </select>
              )}
            </div>
          )}
          <p className="text-sm bg-muted/50 border rounded-md p-3">
            {sentence} <span className="font-semibold">"{templates.find((t) => String(t.id) === templateId)?.name ?? '...'}"</span>.
            {' '}It starts switched off.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            onClick={handleSave}
            disabled={createRule.isPending || !name.trim() || !templateId || (trigger === 'after_rule' && !afterRuleId) || (trigger === 'fixed_date' && !/^\d{2}-\d{2}$/.test(monthDay))}
          >
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------- email activity ----

/**
 * Every bulk send, newest first: "42 of 44 sent, 21 opened". Click a line to
 * see who, and when each of them opened it. "Opened" means the pictures in
 * the email were loaded — close enough, and honest about what Gmail tells us.
 */
export function EmailActivityPanel() {
  const { data: batches, isLoading } = useListEmailBatches({ limit: 100 });
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-xl font-bold flex items-center gap-2">
          <Inbox className="w-5 h-5 text-primary" /> Email Activity
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Every batch of emails the app sent — from the board, the waiting list, a customer's page, an invoice or an automation. Click one to see who got it and who has opened it. Gmail does not tell us about bounces, so "sent" means Gmail accepted it.
        </p>
      </div>
      {isLoading ? (
        <div className="text-muted-foreground animate-pulse p-4">Loading...</div>
      ) : !batches?.length ? (
        <div className="text-center p-6 bg-card border rounded-lg text-muted-foreground text-sm">
          Nothing sent yet.
        </div>
      ) : (
        <div className="bg-card border rounded-lg divide-y">
          <div className="hidden md:grid grid-cols-[1.5fr_2fr_1fr_repeat(4,4.5rem)] gap-2 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            <span>When</span><span>Document</span><span>From</span><span>Sent</span><span>Failed</span><span>Skipped</span><span>Opened</span>
          </div>
          {batches.map((b) => (
            <BatchRow key={b.batchId} batch={b} open={openId === b.batchId} onToggle={() => setOpenId(openId === b.batchId ? null : b.batchId)} />
          ))}
        </div>
      )}
    </div>
  );
}

function BatchRow({ batch: b, open, onToggle }: { batch: EmailBatch; open: boolean; onToggle: () => void }) {
  const what = b.templateName ?? b.ruleName ?? b.subject ?? '(no subject)';
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div>
      <button type="button" onClick={onToggle} className="w-full text-left px-3 py-2 hover:bg-muted/40 grid grid-cols-1 md:grid-cols-[1.5fr_2fr_1fr_repeat(4,4.5rem)] gap-2 items-center text-sm">
        <span className="flex items-center gap-1"><Chevron className="w-4 h-4 text-muted-foreground shrink-0" />{format(new Date(b.createdAt), "d MMM yyyy h:mm a")}</span>
        <span className="font-medium truncate" title={b.subject ?? ''}>{what}{b.ruleName && b.templateName ? <span className="text-muted-foreground font-normal"> · {b.ruleName}</span> : null}</span>
        <span className="text-muted-foreground truncate">{b.sourceLabel}{b.sentByName ? ` · ${b.sentByName}` : ''}</span>
        <span><span className="md:hidden text-muted-foreground">Sent </span>{b.sent} <span className="text-muted-foreground">of {b.total}</span></span>
        <span className={b.failed ? 'text-destructive font-semibold' : 'text-muted-foreground'}><span className="md:hidden">Failed </span>{b.failed}</span>
        <span className="text-muted-foreground"><span className="md:hidden">Skipped </span>{b.skipped}</span>
        <span className={b.opened ? 'text-primary font-semibold' : 'text-muted-foreground'}><span className="md:hidden">Opened </span>{b.opened}</span>
      </button>
      {open && <BatchRecipients batchId={b.batchId} />}
    </div>
  );
}

function BatchRecipients({ batchId }: { batchId: string }) {
  const { data: rows, isLoading } = useGetEmailBatch(batchId);
  if (isLoading) return <div className="px-3 pb-3 text-xs text-muted-foreground animate-pulse">Loading...</div>;
  if (!rows?.length) return <div className="px-3 pb-3 text-xs text-muted-foreground">Nobody in this batch.</div>;
  return (
    <div className="px-3 pb-3">
      <ul className="border rounded-md divide-y text-sm">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1.5">
            {r.clientId != null
              ? <Link href={`/clients/${r.clientId}`} className="font-medium hover:underline">{r.clientName}</Link>
              : <span className="font-medium">{r.clientName}</span>}
            <span className="text-xs text-muted-foreground">{r.toEmail ?? 'no email'}</span>
            <span className="ml-auto text-xs flex items-center gap-1">
              {r.status === 'sent' && r.openedAt && (
                <span className="text-primary font-semibold flex items-center gap-1"><MailCheck className="w-3.5 h-3.5" /> Opened {format(new Date(r.openedAt), "d MMM 'at' h:mm a")}{r.openCount > 1 ? ` (${r.openCount}×)` : ''}</span>
              )}
              {r.status === 'sent' && !r.openedAt && (
                <span className="text-muted-foreground flex items-center gap-1"><Mail className="w-3.5 h-3.5" /> Sent{r.sentAt ? ` ${format(new Date(r.sentAt), "d MMM h:mm a")}` : ''}, not opened yet</span>
              )}
              {r.status === 'failed' && (
                <span className="text-destructive font-semibold flex items-center gap-1" title={r.error ?? ''}><MailWarning className="w-3.5 h-3.5" /> Failed{r.error ? `: ${r.error}` : ''}</span>
              )}
              {r.status === 'skipped' && (
                <span className="text-muted-foreground">{r.skipReason === 'do_not_email' ? 'Skipped — marked do not email' : 'Skipped — no email on file'}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
