import { useMemo, useRef, useState, type FormEvent } from 'react';
import {
  useCreateWebRequest,
  useListWebRequests,
  useUpdateWebRequest,
  type WebRequest,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import {
  Check,
  Clipboard,
  ClipboardCheck,
  Code2,
  Mail,
  MapPin,
  Phone,
  Plus,
  RotateCcw,
  TicketCheck,
  UserPlus,
  X,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';

type RequestWithRaw = WebRequest & { rawPayload?: Record<string, unknown> };
type Filter = '' | 'new' | 'converted' | 'dismissed';

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Please try again.';
}

/**
 * The sender's email, with one click to get it.
 *
 * "can I copy the email and put it in there in with one click?" — it was plain
 * text on a line that also held a phone number and an address, so getting it
 * anywhere meant selecting it by hand.
 *
 * The copy is done synchronously, and that ordering is deliberate. Measured in
 * Chrome on this app: inside a real click `document.execCommand('copy')`
 * returns true, while `navigator.clipboard.writeText` sometimes never settles
 * at all — neither resolving nor rejecting — so an implementation that awaited
 * it left a button that looked broken. execCommand is deprecated but it is
 * synchronous, needs no permission inside a gesture, and cannot hang. The
 * modern API is kept as a fallback, deliberately not awaited, for whenever
 * execCommand is finally removed.
 *
 * The address is also left selected. That is the part that cannot fail, so even
 * where the clipboard refuses entirely he gets it highlighted ready for Ctrl+C,
 * and the label says which of the two actually happened rather than claiming a
 * copy that did not.
 */
function CopyableEmail({ email }: { email: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'selected'>('idle');
  const addressRef = useRef<HTMLSpanElement>(null);

  const selectAddress = () => {
    const node = addressRef.current;
    const selection = window.getSelection();
    if (!node || !selection) return false;
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  };

  const handleClick = () => {
    const selected = selectAddress();
    let copied = false;
    try {
      // The address is already selected, so this copies it directly.
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    if (!copied) {
      navigator.clipboard?.writeText(email).then(
        () => setState('copied'),
        () => undefined,
      );
    }
    setState(copied ? 'copied' : selected ? 'selected' : 'idle');
    setTimeout(() => setState('idle'), 2500);
  };

  return (
    <span className="flex items-center gap-1">
      <button
        type="button"
        onClick={handleClick}
        title="Copy this email address"
        data-testid={`copy-email-${email}`}
        className="flex items-center gap-1 rounded px-1 -mx-1 hover:bg-muted hover:text-foreground"
      >
        <Mail className="h-3.5 w-3.5" />
        <span ref={addressRef}>{email}</span>
      </button>
      <span className="text-xs text-muted-foreground/70" data-testid={`copy-state-${email}`}>
        {state === 'copied' ? 'copied' : state === 'selected' ? 'selected — press Ctrl+C' : 'copy'}
      </span>
    </span>
  );
}

export default function WebRequests() {
  const [status, setStatus] = useState<Filter>('new');
  const [copied, setCopied] = useState(false);
  const params = status ? { status } : undefined;
  const requestsQuery = useListWebRequests(params);
  const webhookUrl = `${window.location.origin}/api/inbound/web-request`;
  const webhookConfigured = useMemo(() => {
    // The authenticated list response sets only this non-sensitive indicator.
    const match = document.cookie.match(/(?:^|;\s*)web_request_webhook_configured=([01])/);
    return match?.[1];
  }, [requestsQuery.data, requestsQuery.dataUpdatedAt]);
  const { toast } = useToast();

  const copyWebhookUrl = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      toast({ title: 'Webhook URL copied' });
      window.setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      toast({
        title: 'Could not copy the webhook URL',
        description: errorMessage(error),
        variant: 'destructive',
      });
    }
  };

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Web Requests</h1>
        {/* "Incoming web requests....where do they come from?" — the page never
            said, so the only way to find out was to ask us. Each row also names
            its own source underneath the status. */}
        <p className="text-muted-foreground mt-1">
          Turn incoming service inquiries into leads and tasks before they get lost.
          These arrive automatically from the contact form on <strong>bisonlawncare.net</strong>,
          which posts straight into this page. Anything you take by phone can be typed in below and
          is marked <em>manual</em>.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <ManualRequestForm />
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Code2 className="h-5 w-5 text-primary" />
              Squarespace webhook
            </CardTitle>
            <CardDescription>
              Use this destination for the website form and send the shared secret in the{' '}
              <code className="text-foreground">X-Web-Request-Secret</code> header.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Input value={webhookUrl} readOnly aria-label="Squarespace webhook URL" />
              <Button variant="outline" onClick={copyWebhookUrl}>
                {copied ? <ClipboardCheck className="h-4 w-4 mr-2" /> : <Clipboard className="h-4 w-4 mr-2" />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <div className="flex items-center gap-2 text-sm">
              {webhookConfigured === '1' ? (
                <>
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Check className="h-4 w-4" />
                  </span>
                  <span className="font-medium">Shared secret is configured</span>
                </>
              ) : webhookConfigured === '0' ? (
                <>
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                    <X className="h-4 w-4" />
                  </span>
                  <span className="font-medium text-destructive">Shared secret is not configured</span>
                </>
              ) : (
                <span className="text-muted-foreground">Checking shared secret configuration…</span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              For security, the secret itself is never shown here. Ask the system administrator to set{' '}
              <code className="text-foreground">WEB_REQUEST_WEBHOOK_SECRET</code> on the API server.
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">Incoming requests</h2>
          <p className="text-sm text-muted-foreground">Newest submissions appear first.</p>
        </div>
        <select
          className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm w-44"
          value={status}
          onChange={event => setStatus(event.target.value as Filter)}
          aria-label="Filter requests by status"
        >
          <option value="">All statuses</option>
          <option value="new">New</option>
          <option value="converted">Converted</option>
          <option value="dismissed">Dismissed</option>
        </select>
      </div>

      {requestsQuery.isLoading ? (
        <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground animate-pulse">
          Loading web requests…
        </div>
      ) : requestsQuery.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load web requests</AlertTitle>
          <AlertDescription>{errorMessage(requestsQuery.error)}</AlertDescription>
        </Alert>
      ) : !requestsQuery.data?.length ? (
        <div className="rounded-lg border bg-card p-10 text-center">
          <Mail className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-3 font-medium">
            {status ? `No ${status} requests found.` : 'No requests found.'}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            New website submissions and requests entered by hand will appear here.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {(requestsQuery.data as RequestWithRaw[]).map(request => (
            <RequestCard key={request.id} request={request} />
          ))}
        </div>
      )}
    </div>
  );
}

function ManualRequestForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [message, setMessage] = useState('');
  const createRequest = useCreateWebRequest();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    createRequest.mutate(
      {
        data: {
          source: 'manual',
          ...(name.trim() && { name: name.trim() }),
          ...(email.trim() && { email: email.trim() }),
          ...(phone.trim() && { phone: phone.trim() }),
          ...(address.trim() && { address: address.trim() }),
          ...(message.trim() && { message: message.trim() }),
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ['/api/web-requests'] });
          setName('');
          setEmail('');
          setPhone('');
          setAddress('');
          setMessage('');
          toast({ title: 'Request added', description: 'It is now in the incoming request list.' });
        },
        onError: error => {
          toast({
            title: 'Could not add request',
            description: errorMessage(error),
            variant: 'destructive',
          });
        },
      },
    );
  };

  return (
    <Card className="border-primary/20">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Plus className="h-5 w-5 text-primary" />
          Paste a request in by hand
        </CardTitle>
        <CardDescription>
          Use this for a phone call or paste the important details from an email.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input value={name} onChange={event => setName(event.target.value)} placeholder="Customer name" aria-label="Customer name" />
            <Input type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="Email" aria-label="Email" />
            <Input value={phone} onChange={event => setPhone(event.target.value)} placeholder="Phone" aria-label="Phone" />
            <Input value={address} onChange={event => setAddress(event.target.value)} placeholder="Service address" aria-label="Service address" />
          </div>
          <Textarea
            value={message}
            onChange={event => setMessage(event.target.value)}
            placeholder="Paste the request or describe what they need…"
            className="min-h-24"
            aria-label="Request details"
          />
          <div className="flex items-center justify-between gap-4">
            <p className="text-xs text-muted-foreground">Add at least a name, contact method, or request details.</p>
            <Button
              type="submit"
              disabled={createRequest.isPending || ![name, email, phone, address, message].some(value => value.trim())}
            >
              {createRequest.isPending ? 'Adding…' : 'Add request'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function RequestCard({ request }: { request: RequestWithRaw }) {
  const updateRequest = useUpdateWebRequest();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const update = (
    data: { status?: 'new' | 'converted' | 'dismissed'; convertToClient?: boolean; createTicket?: boolean },
    success: string,
  ) => {
    updateRequest.mutate(
      { id: request.id, data },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ['/api/web-requests'] });
          queryClient.invalidateQueries({ queryKey: ['/api/tickets'] });
          queryClient.invalidateQueries({ queryKey: ['/api/clients'] });
          toast({ title: success });
        },
        onError: error => {
          toast({
            title: 'Could not update request',
            description: errorMessage(error),
            variant: 'destructive',
          });
        },
      },
    );
  };

  const statusStyle = {
    new: 'bg-accent/20 text-accent-foreground border-accent/30',
    converted: 'bg-primary/10 text-primary border-primary/20',
    dismissed: 'bg-muted text-muted-foreground border-border',
  }[request.status];

  return (
    <Card className={request.status === 'dismissed' ? 'opacity-70' : ''}>
      <CardContent className="p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-start">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-lg font-bold">{request.name || request.email || request.phone || 'Unknown sender'}</h3>
              <Badge variant="outline" className={statusStyle}>{request.status}</Badge>
              <span className="text-xs text-muted-foreground">
                {format(new Date(request.createdAt), 'MMM d, yyyy h:mm a')} · {request.source}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
              {request.email && <CopyableEmail email={request.email} />}
              {request.phone && <span className="flex items-center gap-1"><Phone className="h-3.5 w-3.5" />{request.phone}</span>}
              {request.address && <span className="flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{request.address}</span>}
            </div>
            {request.message ? (
              <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed">{request.message}</p>
            ) : (
              <p className="mt-3 text-sm italic text-muted-foreground">No request details were recognized. View the raw submission below.</p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
              {request.clientId && <span className="font-medium text-primary">Lead/client #{request.clientId}{request.clientName ? ` · ${request.clientName}` : ''}</span>}
              {request.ticketId && <span className="font-medium text-primary">Task #{request.ticketId} created</span>}
              <RawSubmission request={request} />
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap gap-2 md:max-w-72 md:justify-end">
            {request.status === 'dismissed' ? (
              <Button size="sm" variant="outline" disabled={updateRequest.isPending} onClick={() => update({ status: 'new' }, 'Request restored')}>
                <RotateCcw className="mr-2 h-4 w-4" /> {updateRequest.isPending ? 'Restoring…' : 'Restore'}
              </Button>
            ) : (
              <>
                {(!request.clientId || !request.ticketId) && (
                  <Button
                    size="sm"
                    disabled={updateRequest.isPending}
                    onClick={() => update(
                      { convertToClient: !request.clientId, createTicket: !request.ticketId, status: 'converted' },
                      'Request converted and task created',
                    )}
                  >
                    <UserPlus className="mr-2 h-4 w-4" />
                    {updateRequest.isPending ? 'Working…' : 'Convert & create task'}
                  </Button>
                )}
                {!request.ticketId && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={updateRequest.isPending}
                    onClick={() => update({ createTicket: true }, 'Task created')}
                  >
                    <TicketCheck className="mr-2 h-4 w-4" /> {updateRequest.isPending ? 'Creating…' : 'Create task only'}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  disabled={updateRequest.isPending}
                  onClick={() => update({ status: 'dismissed' }, 'Request dismissed')}
                >
                  {updateRequest.isPending ? 'Updating…' : 'Dismiss'}
                </Button>
              </>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function RawSubmission({ request }: { request: RequestWithRaw }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" className="underline underline-offset-2 text-muted-foreground hover:text-foreground">
          View raw submission
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Raw submission #{request.id}</DialogTitle>
        </DialogHeader>
        <pre className="max-h-[60vh] overflow-auto rounded-md bg-muted p-4 text-xs whitespace-pre-wrap break-words">
          {JSON.stringify(request.rawPayload ?? {}, null, 2)}
        </pre>
      </DialogContent>
    </Dialog>
  );
}