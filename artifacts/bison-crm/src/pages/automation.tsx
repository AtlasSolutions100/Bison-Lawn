import { useState } from 'react';
import {
  useListSuggestedActions,
  useApproveSuggestedAction,
  useRejectSuggestedAction,
  useUpdateSuggestedAction,
  useResendSuggestedActionMessage,
  useListWeatherRules,
  useCreateWeatherRule,
  useUpdateWeatherRule,
  useDeleteWeatherRule,
  useRunWeatherCheck,
  SuggestedAction,
  WeatherRule,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import {
  CloudRain, Wind, Thermometer, Snowflake, Plus, Trash2, CheckCircle2, XCircle,
  Pencil, CalendarClock, SkipForward, Mail, MailCheck, MailWarning, PlayCircle, Send,
} from 'lucide-react';

const CONDITION_META: Record<string, { label: string; unit: string; icon: any }> = {
  rain: { label: 'Rain', unit: 'mm', icon: CloudRain },
  wind: { label: 'Wind', unit: 'km/h', icon: Wind },
  heat: { label: 'Heat (high ≥)', unit: '°C', icon: Thermometer },
  cold: { label: 'Cold (low ≤)', unit: '°C', icon: Snowflake },
};

export default function Automation() {
  const [statusFilter, setStatusFilter] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const { data: suggestions, isLoading } = useListSuggestedActions({ status: statusFilter });

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Automation Review</h1>
        <p className="text-muted-foreground mt-1">
          Weather rules prepare skip/reschedule actions and draft customer messages. Approving applies the schedule change and emails the approved message to the customer.
        </p>
      </div>

      <WeatherCheckPanel />

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold">Review Queue</h2>
          <select
            className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm w-40"
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value as any)}
          >
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
        </div>
        {isLoading ? (
          <div className="text-muted-foreground animate-pulse p-4">Loading...</div>
        ) : !suggestions?.length ? (
          <div className="text-center p-8 bg-card border rounded-lg text-muted-foreground">
            No {statusFilter} suggestions.
          </div>
        ) : (
          suggestions.map(s => <SuggestionCard key={s.id} suggestion={s} />)
        )}
      </div>

      <WeatherRulesPanel />
    </div>
  );
}

function WeatherCheckPanel() {
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [result, setResult] = useState<string | null>(null);
  const runCheck = useRunWeatherCheck();
  const queryClient = useQueryClient();

  const handleRun = () => {
    setResult(null);
    runCheck.mutate({ data: { date } }, {
      onSuccess: (r) => {
        queryClient.invalidateQueries({ queryKey: ['/api/suggested-actions'] });
        setResult(
          `Checked ${r.jobsChecked} job(s); prepared ${r.suggestionsCreated} suggestion(s).` +
          (r.forecastSummary ? ` ${r.forecastSummary}` : ''),
        );
      },
      onError: () => setResult('Weather check failed. Please try again.'),
    });
  };

  return (
    <div className="bg-card border rounded-lg p-4 shadow-sm space-y-3">
      <h2 className="text-lg font-bold flex items-center gap-2"><CloudRain className="w-5 h-5 text-primary" /> Run Weather Check</h2>
      <p className="text-sm text-muted-foreground">
        Checks the forecast at each client's location for jobs scheduled on the selected date and prepares actions for any rule that triggers.
      </p>
      <div className="flex items-center gap-3">
        <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="w-44" />
        <Button onClick={handleRun} disabled={runCheck.isPending}>
          <PlayCircle className="w-4 h-4 mr-2" /> {runCheck.isPending ? 'Checking...' : 'Check Weather'}
        </Button>
      </div>
      {result && <p className="text-sm bg-muted/50 border rounded-md p-3">{result}</p>}
    </div>
  );
}

function SuggestionCard({ suggestion: s }: { suggestion: SuggestedAction }) {
  const approve = useApproveSuggestedAction();
  const reject = useRejectSuggestedAction();
  const update = useUpdateSuggestedAction();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState(s.customerMessage ?? '');
  const [newDate, setNewDate] = useState(s.newDate ?? '');

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['/api/suggested-actions'] });

  const willEmail = Boolean(s.customerMessage?.trim() && s.clientEmail);
  const missingEmail = Boolean(s.customerMessage?.trim() && !s.clientEmail);

  const handleApprove = () => {
    const consequence = willEmail
      ? `The schedule change will be applied and the message below will be emailed to ${s.clientEmail}.`
      : missingEmail
        ? 'The schedule change will be applied, but this client has no email address on file, so the message cannot be sent.'
        : 'The schedule change will be applied.';
    if (!confirm(`Approve this ${s.actionType}? ${consequence}`)) return;
    approve.mutate({ id: s.id }, {
      onSuccess: (updated) => {
        refresh();
        if (updated.messageDeliveryState === 'failed') {
          alert(`The ${s.actionType} was applied, but the customer email could not be sent: ${updated.messageDeliveryError ?? 'unknown error'}`);
        } else if (updated.messageDeliveryState === 'abandoned' || updated.messageDeliveryState === 'sending') {
          alert(`The ${s.actionType} was applied, but the customer email never finished sending. Check the delivery status and contact the customer if needed.`);
        } else if (updated.messageDeliveryState === 'no_email') {
          alert(`The ${s.actionType} was applied, but the customer message was not sent — this client has no email address on file.`);
        }
      },
      onError: (e: any) => alert(e?.message ?? 'Could not approve'),
    });
  };

  const handleSaveEdit = () => {
    update.mutate(
      { id: s.id, data: { customerMessage: message || null, ...(s.actionType === 'reschedule' ? { newDate: newDate || null } : {}) } },
      { onSuccess: () => { setEditing(false); refresh(); } },
    );
  };

  const ActionIcon = s.actionType === 'reschedule' ? CalendarClock : SkipForward;
  const isPending = s.status === 'pending';

  return (
    <div className="p-4 bg-card border rounded-lg shadow-sm space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1 bg-primary/10 text-primary border border-primary/20 px-2 py-0.5 rounded text-xs font-semibold uppercase">
              <ActionIcon className="w-3 h-3" /> {s.actionType}
            </span>
            {s.clientName && <span className="text-sm font-bold">{s.clientName}</span>}
            {s.jobId && <span className="text-xs text-muted-foreground">Job #{s.jobId}</span>}
            {s.ruleName && <span className="text-xs text-muted-foreground">Rule: {s.ruleName}</span>}
          </div>
          <p className="text-sm mt-2">{s.reason}</p>
          <div className="flex flex-wrap gap-3 mt-1 text-xs text-muted-foreground">
            {s.targetDate && <span>Scheduled: {s.targetDate}</span>}
            {s.actionType === 'reschedule' && s.newDate && <span className="font-semibold text-foreground">→ New date: {s.newDate}</span>}
          </div>
        </div>
        {!isPending && (
          <span className={`text-xs font-bold px-2 py-1 rounded ${s.status === 'approved' ? 'bg-primary/10 text-primary' : 'bg-destructive/10 text-destructive'}`}>
            {s.status.toUpperCase()}{s.reviewedByName ? ` · ${s.reviewedByName}` : ''}
          </span>
        )}
      </div>

      {editing ? (
        <div className="space-y-2 border-t pt-3">
          {s.actionType === 'reschedule' && (
            <div>
              <label className="text-xs font-semibold block mb-1">New date</label>
              <Input type="date" value={newDate} onChange={e => setNewDate(e.target.value)} className="w-44" />
            </div>
          )}
          <label className="text-xs font-semibold block">Customer message</label>
          <textarea
            className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={message}
            onChange={e => setMessage(e.target.value)}
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={handleSaveEdit} disabled={update.isPending}>Save</Button>
            <Button size="sm" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        s.customerMessage && (
          <div className="border-t pt-3">
            <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1 mb-1">
              <Mail className="w-3 h-3" /> Customer message{' '}
              {isPending && (willEmail ? `(will be emailed to ${s.clientEmail} on approval)` : '(no email on file — cannot be sent)')}
            </span>
            <p className="text-sm bg-muted/40 border rounded-md p-2 whitespace-pre-wrap">{s.customerMessage}</p>
            {!isPending && <DeliveryStatus suggestion={s} />}
          </div>
        )
      )}

      {isPending && !editing && (
        <div className="flex gap-2 border-t pt-3">
          <Button size="sm" onClick={handleApprove} disabled={approve.isPending}>
            <CheckCircle2 className="w-4 h-4 mr-1" /> Approve & Apply
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            <Pencil className="w-4 h-4 mr-1" /> Edit
          </Button>
          <Button size="sm" variant="outline" className="text-destructive" onClick={() => reject.mutate({ id: s.id }, { onSuccess: refresh })} disabled={reject.isPending}>
            <XCircle className="w-4 h-4 mr-1" /> Reject
          </Button>
        </div>
      )}
    </div>
  );
}

/** Shows whether the approved customer message actually reached the customer. */
function DeliveryStatus({ suggestion: s }: { suggestion: SuggestedAction }) {
  const resend = useResendSuggestedActionMessage();
  const queryClient = useQueryClient();

  if (s.status === 'rejected' || s.messageDeliveryState === 'not_applicable') return null;

  const handleResend = () => {
    resend.mutate({ id: s.id }, {
      onSuccess: (updated) => {
        queryClient.invalidateQueries({ queryKey: ['/api/suggested-actions'] });
        if (updated.messageDeliveryState === 'sent') {
          alert(`The customer message was emailed to ${updated.messageSentToEmail}.`);
        } else {
          alert(`The email still could not be sent: ${updated.messageDeliveryError ?? 'unknown error'}`);
        }
      },
      onError: (e: any) => alert(e?.message ?? 'Could not resend the message'),
    });
  };

  // A message that already reached the customer must never be sent twice, so a
  // retry is only offered once delivery ended with nothing sent.
  const canResend =
    (s.messageDeliveryState === 'failed' || s.messageDeliveryState === 'no_email') && Boolean(s.clientEmail);

  const resendButton = canResend ? (
    <Button size="sm" variant="outline" className="mt-2" onClick={handleResend} disabled={resend.isPending}>
      <Send className="w-3.5 h-3.5 mr-1" /> {resend.isPending ? 'Resending...' : `Resend to ${s.clientEmail}`}
    </Button>
  ) : null;

  if (s.messageDeliveryState === 'sent') {
    return (
      <p className="text-xs text-primary font-semibold flex items-center gap-1 mt-2">
        <MailCheck className="w-3.5 h-3.5" />
        Emailed to {s.messageSentToEmail}
        {s.messageSentAt ? ` on ${format(new Date(s.messageSentAt), 'MMM d, yyyy h:mm a')}` : ''}
      </p>
    );
  }

  if (s.messageDeliveryState === 'failed') {
    return (
      <div className="mt-2 text-xs bg-destructive/10 border border-destructive/30 text-destructive rounded-md p-2">
        <span className="font-bold flex items-center gap-1">
          <MailWarning className="w-3.5 h-3.5" /> Email failed{s.messageSentToEmail ? ` to ${s.messageSentToEmail}` : ''}
        </span>
        {s.messageDeliveryError && <p className="mt-1 break-words">{s.messageDeliveryError}</p>}
        <p className="mt-1">
          {canResend
            ? 'They were not notified. Try the email again, or contact this customer directly.'
            : 'Contact this customer directly — they were not notified.'}
        </p>
        {resendButton}
      </div>
    );
  }

  if (s.messageDeliveryState === 'no_email') {
    return (
      <div className="mt-2 text-xs bg-destructive/10 border border-destructive/30 text-destructive rounded-md p-2">
        <span className="font-bold flex items-center gap-1">
          <MailWarning className="w-3.5 h-3.5" /> Not sent — no email address on file
        </span>
        <p className="mt-1">
          {canResend
            ? 'This client now has an email address — send the approved message to them.'
            : 'Add an email to this client, or contact them directly.'}
        </p>
        {resendButton}
      </div>
    );
  }

  // A claim that never reported an outcome: the send was interrupted and no
  // one knows whether the customer got it. Never leave it looking in-flight.
  if (s.messageDeliveryState === 'abandoned') {
    return (
      <div className="mt-2 text-xs bg-destructive/10 border border-destructive/30 text-destructive rounded-md p-2">
        <span className="font-bold flex items-center gap-1">
          <MailWarning className="w-3.5 h-3.5" /> Never completed — sending was interrupted
          {s.messageDeliveryClaimedAt ? `, started ${format(new Date(s.messageDeliveryClaimedAt), 'MMM d, yyyy h:mm a')}` : ''}
        </span>
        <p className="mt-1">
          No delivery outcome was recorded{s.messageSentToEmail ? ` for ${s.messageSentToEmail}` : ''}. Assume this customer was not notified and contact them directly.
        </p>
      </div>
    );
  }

  // A live claim — the send is in flight right now.
  return (
    <p className="text-xs text-muted-foreground flex items-center gap-1 mt-2">
      <Mail className="w-3.5 h-3.5" /> Sending right now...
    </p>
  );
}

function WeatherRulesPanel() {
  const { data: rules } = useListWeatherRules();
  const updateRule = useUpdateWeatherRule();
  const deleteRule = useDeleteWeatherRule();
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['/api/weather-rules'] });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">Weather Rules</h2>
        <NewRuleDialog />
      </div>
      {!rules?.length ? (
        <div className="text-center p-6 bg-card border rounded-lg text-muted-foreground text-sm">
          No rules yet. Add one (e.g. "Rain ≥ 10 mm → reschedule +1 day") to start preparing weather actions.
        </div>
      ) : (
        rules.map(r => {
          const meta = CONDITION_META[r.conditionType] ?? CONDITION_META.rain;
          const Icon = meta.icon;
          return (
            <div key={r.id} className={`p-3 bg-card border rounded-lg flex items-center gap-3 ${r.enabled ? '' : 'opacity-60'}`}>
              <Icon className="w-5 h-5 text-primary shrink-0" />
              <div className="flex-1">
                <span className="font-semibold">{r.name}</span>
                <p className="text-xs text-muted-foreground">
                  {meta.label} {r.conditionType === 'cold' ? '≤' : '≥'} {r.threshold} {meta.unit} → {r.actionType === 'reschedule' ? `reschedule +${r.rescheduleDays} day(s)` : 'skip'}
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={() => updateRule.mutate({ id: r.id, data: { enabled: !r.enabled } }, { onSuccess: refresh })}>
                {r.enabled ? 'Disable' : 'Enable'}
              </Button>
              <Button size="icon" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => { if (confirm('Delete rule?')) deleteRule.mutate({ id: r.id }, { onSuccess: refresh }); }}>
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          );
        })
      )}
    </div>
  );
}

function NewRuleDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [conditionType, setConditionType] = useState<'rain'|'wind'|'heat'|'cold'>('rain');
  const [threshold, setThreshold] = useState('10');
  const [actionType, setActionType] = useState<'skip'|'reschedule'>('reschedule');
  const [rescheduleDays, setRescheduleDays] = useState('1');
  const [messageTemplate, setMessageTemplate] = useState('');
  const createRule = useCreateWeatherRule();
  const queryClient = useQueryClient();

  const handleSave = () => {
    createRule.mutate({
      data: {
        name,
        conditionType,
        threshold: parseFloat(threshold),
        actionType,
        rescheduleDays: parseInt(rescheduleDays) || 1,
        messageTemplate: messageTemplate || undefined,
      },
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['/api/weather-rules'] });
        setOpen(false);
        setName('');
        setMessageTemplate('');
      },
    });
  };

  const unit = CONDITION_META[conditionType].unit;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline"><Plus className="w-4 h-4 mr-2" /> New Rule</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>New Weather Rule</DialogTitle></DialogHeader>
        <div className="space-y-4 py-4">
          <div>
            <label className="text-sm font-medium mb-1 block">Name</label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="Heavy rain — push a day" autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Condition</label>
              <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={conditionType} onChange={e => setConditionType(e.target.value as any)}>
                <option value="rain">Rain (mm)</option>
                <option value="wind">Wind (km/h)</option>
                <option value="heat">Heat — high temp (°C)</option>
                <option value="cold">Cold — low temp (°C)</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Threshold ({unit})</label>
              <Input type="number" value={threshold} onChange={e => setThreshold(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Action</label>
              <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={actionType} onChange={e => setActionType(e.target.value as any)}>
                <option value="reschedule">Reschedule</option>
                <option value="skip">Skip (back to waiting list)</option>
              </select>
            </div>
            {actionType === 'reschedule' && (
              <div>
                <label className="text-sm font-medium mb-1 block">Push by (days)</label>
                <Input type="number" min="1" value={rescheduleDays} onChange={e => setRescheduleDays(e.target.value)} />
              </div>
            )}
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">Customer message template (optional)</label>
            <textarea
              className="flex min-h-[70px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={messageTemplate}
              onChange={e => setMessageTemplate(e.target.value)}
              placeholder="Hi {clientName}, due to {reason} we need to {action} your service on {date}.{newDatePart}"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Placeholders: {'{clientName} {reason} {action} {date} {newDate} {newDatePart}'}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={createRule.isPending || !name.trim() || !threshold}>Save Rule</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
