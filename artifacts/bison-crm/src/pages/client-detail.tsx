import { useState, useEffect, useMemo } from 'react';
import { useRoute, useSearch } from 'wouter';
import {
  useGetClient,
  useUpdateClient,
  useListClientAudit,
  useListServices,
  useListEstimates,
  useCreateJob,
  useCreateTicket,
  useEmailClient,
  useListClients,
  getListClientsQueryKey,
  useListRelatedClients,
  getListRelatedClientsQueryKey,
  useListClientContacts,
  getListClientContactsQueryKey,
  useCreateClientContact,
  useUpdateClientContact,
  useDeleteClientContact,
  useListClientSources,
  getListClientSourcesQueryKey,
  useListEstimateFields,
  useListDocumentTemplates,
  getListDocumentTemplatesQueryKey,
  useSendDocumentTemplate,
  type Client,
  type ClientContact,
  type ClientUpdate,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, MapPin, Phone, Mail, Calendar, FileText,
  Settings, Plus, MessageSquare, Briefcase, ListTodo,
  Droplets, Route, Timer, X, Receipt, Users, Building2, Crosshair,
  ExternalLink, Pencil, Trash2, Megaphone, MailX, LocateFixed, ClipboardPaste,
} from 'lucide-react';
import { MapCodeBadge, WaterProviderLookupLink } from '@/components/map-code';
import { Link, useLocation } from 'wouter';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { format, parseISO } from 'date-fns';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import AssignedServicesPanel from '@/components/client/assigned-services';
import ClientAccountingPanel from '@/components/client/accounting-panel';
import ClientJobsPanel from '@/components/client/jobs-panel';
import ClientActivityPanel from '@/components/client/activity-panel';
import TextClientButton from '@/components/client/text-client-button';

/**
 * The customer's account, laid out the way his old system laid it out because
 * that is the shape his hands know: name, balance and the office note at the
 * top of every visit, then tabs for the rest. He runs the office alone and
 * lives on this page, so nothing here is more than one click away and the tab
 * sits in the address bar so a link from a ticket or a report lands on the
 * right one.
 */
const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'details', label: 'Details' },
  { key: 'sales', label: 'Sales' },
  { key: 'billing', label: 'Billing' },
  { key: 'custom', label: 'Custom fields' },
  { key: 'services', label: 'Services' },
  { key: 'jobs', label: 'Jobs' },
  { key: 'accounting', label: 'Accounting' },
  { key: 'activity', label: 'Activity' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const selectClass = 'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm';

export default function ClientDetail() {
  const [, params] = useRoute('/clients/:id');
  const id = params?.id ? parseInt(params.id) : 0;
  const [, setLocation] = useLocation();
  const search = useSearch();
  const queryClient = useQueryClient();

  const { data: client, isLoading } = useGetClient(id);
  const updateClient = useUpdateClient();

  const requested = new URLSearchParams(search).get('tab');
  const tab: TabKey = TABS.some(t => t.key === requested) ? (requested as TabKey) : 'overview';
  const showTab = (next: string) => setLocation(`/clients/${id}?tab=${next}`, { replace: true });

  if (isLoading) return <div className="p-8">Loading client...</div>;
  if (!client) return <div className="p-8">Client not found.</div>;

  const updateStatus = (status: 'lead' | 'client' | 'former_client') => {
    updateClient.mutate({ id, data: { status } }, {
      onSuccess: (data) => {
        queryClient.setQueryData([`/api/clients/${id}`], data);
      }
    });
  };

  const isMaster = (client.relatedPropertyCount ?? 0) > 0;
  const relatedTotal = client.relatedBalanceTotal ?? client.accountBalance;

  // key on the whole page: one customer page is reused for every /clients/:id,
  // and a customer you looked at in the last few minutes comes back out of the
  // cache with no "Loading" in between. Without the key the edit boxes keep the
  // last customer's name, address, note and pin — and Save would write them
  // onto this customer. The key throws the old boxes away and fills them in
  // fresh from whoever is on screen now.
  return (
    <div key={client.id} className="flex flex-col h-[calc(100vh-2rem)]">
      {/* Header Area */}
      <div className="bg-card border-b px-8 py-6 shadow-sm z-10 shrink-0">
        <div className="max-w-7xl mx-auto">
          <Link href="/clients" className="inline-flex items-center text-sm font-medium text-muted-foreground hover:text-primary mb-4 transition-colors">
            <ArrowLeft className="w-4 h-4 mr-1" /> Back to Clients
          </Link>

          <div className="flex flex-col md:flex-row md:items-start justify-between gap-6">
            <div className="space-y-1">
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-3xl font-extrabold tracking-tight text-foreground">{client.name}</h1>
                <select
                  value={client.status}
                  onChange={(e) => updateStatus(e.target.value as any)}
                  className={`text-xs font-bold px-2 py-1 rounded-md border outline-none cursor-pointer
                    ${client.status === 'lead' ? 'bg-accent/20 text-accent-foreground border-accent/30' :
                      client.status === 'client' ? 'bg-primary/10 text-primary border-primary/20' :
                      'bg-muted text-muted-foreground border-border'}
                  `}
                >
                  <option value="lead">LEAD</option>
                  <option value="client">ACTIVE</option>
                  <option value="former_client">FORMER</option>
                </select>
                {client.mapCode?.trim() && <MapCodeBadge code={client.mapCode} />}
                {client.doNotEmail && (
                  <span
                    className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-xs font-semibold text-destructive"
                    title="Bulk emails skip this customer. Invoices still go out."
                    data-testid="do-not-email-badge"
                  >
                    <MailX className="w-3 h-3" /> Do not email
                  </span>
                )}
                {isMaster && (
                  <span className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground" data-testid="master-badge">
                    <Building2 className="w-3 h-3" /> Master account · {client.relatedPropertyCount} {client.relatedPropertyCount === 1 ? 'property' : 'properties'}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-4 text-sm text-muted-foreground pt-1 flex-wrap">
                {client.phone && <span className="flex items-center gap-1"><Phone className="w-4 h-4"/> {client.phone}</span>}
                {client.email && <span className="flex items-center gap-1"><Mail className="w-4 h-4"/> {client.email}</span>}
                <span className="flex items-center gap-1"><MapPin className="w-4 h-4"/> {[client.serviceAddress, client.city].filter(Boolean).join(', ') || 'No address'}</span>
                {client.parentClientId != null && (
                  <span className="flex items-center gap-1" data-testid="header-master-link">
                    <Building2 className="w-4 h-4" /> Property under{' '}
                    <Link href={`/clients/${client.parentClientId}`} className="font-medium text-primary hover:underline">
                      {client.parentClientName ?? `#${client.parentClientId}`}
                    </Link>
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-4">
                <Button size="sm" onClick={() => setLocation(`/estimates?clientId=${id}&new=1`)}>
                  <FileText className="w-4 h-4 mr-1" /> Create Estimate
                </Button>
                <EmailClientDialog client={client} />
                <TextClientButton clientId={id} phone={client.phone ?? null} />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={client.lat == null && client.lng == null && !client.serviceAddress}
                  title={client.lat == null && client.lng == null && !client.serviceAddress ? 'Add a service address or map location first' : undefined}
                  onClick={() => window.open(mapsUrlFor(client), '_blank', 'noopener,noreferrer')}
                >
                  <MapPin className="w-4 h-4 mr-1" /> Show on Map
                </Button>
                <AddJobDialog client={client} />
                <AddTicketDialog client={client} />
              </div>
            </div>

            {/* gap-6, because the balance and the button had exactly zero
                pixels between them — measured, not guessed. A four-figure
                balance would have run straight into the button. */}
            <div className="bg-primary/5 border border-primary/20 rounded-xl p-4 min-w-[220px] flex items-center justify-between gap-6">
              <div>
                <p className="text-sm font-semibold text-primary/80 uppercase tracking-wider">Balance</p>
                <p className={`text-3xl font-bold mt-1 whitespace-nowrap ${client.accountBalance > 0 ? 'text-destructive' : client.accountBalance < 0 ? 'text-primary' : 'text-foreground'}`} data-testid="balance">
                  {money(client.accountBalance)}
                </p>
                {/* A property manager asks "what do I owe you in all", not "what
                    does the HOA office itself owe". Both numbers stay visible so
                    neither one is mistaken for the other. */}
                {isMaster && (
                  <p className="text-xs font-medium text-muted-foreground mt-1 whitespace-nowrap" data-testid="related-total">
                    With {client.relatedPropertyCount} {client.relatedPropertyCount === 1 ? 'property' : 'properties'}:{' '}
                    <span className={relatedTotal > 0 ? 'text-destructive font-bold' : 'text-foreground font-bold'}>{money(relatedTotal)}</span>
                  </p>
                )}
              </div>
              <RecordPaymentDialog clientId={id} />
            </div>
          </div>
        </div>
      </div>

      {/* Main Content scrollable */}
      <div className="flex-1 overflow-y-auto p-8 bg-muted/20">
        {/* Pinned above everything: "an office note ... that shows up on the
            front of client account". A note the office has to remember is worth
            nothing three cards down the page. */}
        <div className="max-w-7xl mx-auto mb-6">
          <ClientOfficeNote client={client} />
        </div>

        <div className="max-w-7xl mx-auto">
          <Tabs value={tab} onValueChange={showTab}>
            <TabsList className="flex flex-wrap h-auto justify-start gap-1 mb-6 bg-card border p-1">
              {TABS.map(t => (
                <TabsTrigger key={t.key} value={t.key} data-testid={`tab-${t.key}`}>{t.label}</TabsTrigger>
              ))}
            </TabsList>

            <TabsContent value="overview">
              <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
                <div className="xl:col-span-2 space-y-8">
                  <ClientPersonalInfo client={client} />
                  <ClientContacts client={client} />
                </div>
                <div className="space-y-8">
                  <ClientMasterAccount client={client} />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="details">
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
                <ClientRouting client={client} />
                <ClientMapPin client={client} />
              </div>
            </TabsContent>

            <TabsContent value="sales">
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
                <ClientSales client={client} />
              </div>
            </TabsContent>

            <TabsContent value="billing">
              <ClientBilling client={client} />
            </TabsContent>

            <TabsContent value="custom">
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
                <ClientProperties client={client} />
              </div>
            </TabsContent>

            <TabsContent value="services">
              <AssignedServicesPanel clientId={id} />
            </TabsContent>

            <TabsContent value="jobs">
              <ClientJobsPanel clientId={id} />
            </TabsContent>

            <TabsContent value="accounting">
              <div className="space-y-8">
                <ClientAccountingPanel clientId={id} />
                <ClientEstimates clientId={id} />
              </div>
            </TabsContent>

            <TabsContent value="activity">
              <div className="space-y-8">
                <ClientActivityPanel clientId={id} />
                <ClientAudit clientId={id} />
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}

/** Google Maps prefers the pin when there is one; an address is a guess, a pin is not. */
function mapsUrlFor(client: Pick<Client, 'lat' | 'lng' | 'serviceAddress' | 'city'>) {
  const destination = client.lat != null && client.lng != null
    ? `${client.lat},${client.lng}`
    : [client.serviceAddress, client.city].filter(Boolean).join(', ');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(destination)}`;
}

function RecordPaymentDialog({ clientId }: { clientId: number }) {
  // We'll implement payment recording in the invoices/payments sections, but keep the button here.
  const [, setLocation] = useLocation();
  return (
    <Button size="sm" onClick={() => setLocation(`/invoices?clientId=${clientId}`)}>
      Payments
    </Button>
  );
}

/**
 * One hook for every card that edits the customer: PATCH, put the fresh row in
 * the cache, refresh the list, say so. Each card used to carry its own copy of
 * this and they had drifted apart in small ways.
 */
function useSaveClient(client: Client, savedMessage: string) {
  const updateClient = useUpdateClient();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const save = (data: ClientUpdate, options?: { message?: string; onSuccess?: (fresh: Client) => void }) => {
    updateClient.mutate({ id: client.id, data }, {
      onSuccess: (fresh) => {
        queryClient.setQueryData([`/api/clients/${client.id}`], fresh);
        queryClient.invalidateQueries({ queryKey: ['/api/clients'] });
        queryClient.invalidateQueries({ queryKey: [`/api/clients/${client.id}/audit`] });
        toast({ title: options?.message ?? savedMessage });
        options?.onSuccess?.(fresh);
      },
      onError: (error) => toast({
        title: 'Could not save',
        description: error instanceof Error ? error.message : 'Please try again.',
        variant: 'destructive',
      }),
    });
  };
  return { save, saving: updateClient.isPending };
}

// Blank clears the field rather than storing "", so an empty box never reads
// as a real answer in a filter or on an invoice.
const clean = (v: string) => (v.trim() ? v.trim() : null);

/**
 * The office email, with the recipient editable and Cc / Bcc.
 *
 * "ability to delete email address when sending email to customer and the
 * ability to add a different email and or CC, BCC". The To box used to be a
 * line of read-only text, and the button was disabled outright for a customer
 * with no address on file — so a customer whose email you happened to know but
 * had not saved could not be emailed at all.
 *
 * Cc and Bcc are hidden until asked for. Most sends are one address to one
 * customer, and two empty boxes on every send is clutter charged to everyone to
 * serve the occasional case.
 *
 * "Use a document" sends one of his saved documents instead of typed text: the
 * aeration notice, the welcome letter. That path goes through the same sender
 * the board and the automations use, so it lands in the email activity list
 * and honours Do not email the same way everywhere.
 */
function EmailClientDialog({ client }: { client: Client }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'write' | 'document'>('write');
  const [templateId, setTemplateId] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [to, setTo] = useState(client.email ?? '');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [showCopies, setShowCopies] = useState(false);
  const emailClient = useEmailClient();
  const sendDocument = useSendDocumentTemplate();
  const { data: templates } = useListDocumentTemplates(undefined, { query: { enabled: open, queryKey: getListDocumentTemplatesQueryKey() } });
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Typed as "a@b.com, c@d.com" and sent as a list.
  const splitAddresses = (value: string) =>
    value.split(/[,;]/).map(a => a.trim()).filter(Boolean);

  const reset = () => {
    setSubject('');
    setBody('');
    setCc('');
    setBcc('');
    setShowCopies(false);
    setTemplateId('');
    setOpen(false);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (mode === 'document') {
      if (!templateId) return;
      sendDocument.mutate({ id: Number(templateId), data: { clientIds: [client.id], source: 'client_page' } }, {
        onSuccess: (result) => {
          queryClient.invalidateQueries({ queryKey: [`/api/clients/${client.id}/audit`] });
          const skip = result.skipped[0];
          if (result.sent > 0) {
            toast({ title: 'Document sent', description: `Emailed to ${client.email ?? 'the customer'}.` });
            reset();
          } else {
            toast({
              title: 'Not sent',
              description: skip?.reason === 'do_not_email'
                ? 'Do not email is on for this customer. Turn it off on the Overview tab, or write the email yourself.'
                : skip?.reason === 'no_email'
                  ? 'This customer has no email on file. Add one on the Overview tab first.'
                  : 'The email could not be delivered. Try again in a minute.',
              variant: 'destructive',
            });
          }
        },
        onError: (error) => toast({
          title: 'Document could not be sent',
          description: error instanceof Error ? error.message : 'Please try again.',
          variant: 'destructive',
        }),
      });
      return;
    }
    const ccList = splitAddresses(cc);
    const bccList = splitAddresses(bcc);
    emailClient.mutate({
      id: client.id,
      data: {
        subject,
        body,
        toEmail: to.trim(),
        ...(ccList.length ? { cc: ccList } : {}),
        ...(bccList.length ? { bcc: bccList } : {}),
      },
    }, {
      onSuccess: (result) => {
        const copies = [
          result.cc?.length ? `cc ${result.cc.length}` : null,
          result.bcc?.length ? `bcc ${result.bcc.length}` : null,
        ].filter(Boolean).join(', ');
        toast({
          title: 'Email sent',
          description: `Delivered to ${result.to}${copies ? ` (${copies})` : ''}.`,
        });
        reset();
      },
      onError: (error) => toast({
        title: 'Email could not be sent',
        description: error instanceof Error ? error.message : 'Please try again.',
        variant: 'destructive',
      }),
    });
  };

  const pending = emailClient.isPending || sendDocument.isPending;
  const chosen = templates?.find(t => String(t.id) === templateId);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" data-testid="send-email-open">
          <Mail className="w-4 h-4 mr-1" /> Send Email
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Email {client.name}</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="flex gap-2">
            <Button type="button" size="sm" variant={mode === 'write' ? 'default' : 'outline'} onClick={() => setMode('write')} data-testid="email-mode-write">
              Write it
            </Button>
            <Button type="button" size="sm" variant={mode === 'document' ? 'default' : 'outline'} onClick={() => setMode('document')} data-testid="email-mode-document">
              <FileText className="w-4 h-4 mr-1" /> Use a document
            </Button>
          </div>

          {client.doNotEmail && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive" data-testid="email-do-not-email-warning">
              Do not email is on for this customer. A document send is skipped like any bulk email;
              an email you write here still goes, so use that for something they asked for.
            </p>
          )}

          {mode === 'document' ? (
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium mb-1 block">Document</label>
                <select
                  className={selectClass}
                  value={templateId}
                  onChange={e => setTemplateId(e.target.value)}
                  required
                  data-testid="email-template"
                >
                  <option value="">Pick a document...</option>
                  {templates?.map(t => (
                    <option key={t.id} value={t.id}>{t.name} — {t.category}</option>
                  ))}
                </select>
                {templates && templates.length === 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">No documents yet. Build one under Settings › Documents.</p>
                )}
              </div>
              {chosen && (
                <div className="rounded-md border bg-muted/40 p-3 text-xs space-y-1">
                  {chosen.subject && <p><span className="font-semibold">Subject:</span> {chosen.subject}</p>}
                  <p className="text-muted-foreground">
                    Goes to {client.email ? <span className="font-medium text-foreground">{client.email}</span> : 'no address — this customer has no email on file'} with the
                    logo, your company block and this customer's details filled in.
                  </p>
                </div>
              )}
            </div>
          ) : (
            <>
              <div>
                <label className="text-sm font-medium mb-1 block">To</label>
                <Input
                  type="email"
                  value={to}
                  onChange={e => setTo(e.target.value)}
                  placeholder="Nobody on file — type an address"
                  maxLength={320}
                  required
                  data-testid="email-to"
                />
                {!client.email && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    This customer has no email saved. Sending here does not save it — add it on the
                    customer if you want it kept.
                  </p>
                )}
              </div>

              {showCopies ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="text-sm font-medium mb-1 block">Cc</label>
                    <Input value={cc} onChange={e => setCc(e.target.value)} placeholder="Comma separated" data-testid="email-cc" />
                  </div>
                  <div>
                    <label className="text-sm font-medium mb-1 block">Bcc</label>
                    <Input value={bcc} onChange={e => setBcc(e.target.value)} placeholder="Comma separated" data-testid="email-bcc" />
                  </div>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground"
                  onClick={() => setShowCopies(true)}
                  data-testid="email-add-copies"
                >
                  + Add Cc / Bcc
                </Button>
              )}

              <div>
                <label className="text-sm font-medium mb-1 block">Subject</label>
                <Input value={subject} onChange={e => setSubject(e.target.value)} maxLength={200} required />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Message</label>
                <textarea className="flex min-h-40 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={body} onChange={e => setBody(e.target.value)} maxLength={10000} required />
              </div>
            </>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              type="submit"
              disabled={pending || (mode === 'document' ? !templateId : (!to.trim() || !subject.trim() || !body.trim()))}
              data-testid="email-send"
            >
              {pending ? 'Sending...' : mode === 'document' ? 'Send document' : 'Send Email'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AddJobDialog({ client }: { client: Client }) {
  const [open, setOpen] = useState(false);
  const [serviceId, setServiceId] = useState('');
  const [scheduledDate, setScheduledDate] = useState('');
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const { data: services } = useListServices();
  const createJob = useCreateJob();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    createJob.mutate({
      data: {
        clientId: client.id,
        serviceId: serviceId ? Number(serviceId) : null,
        scheduledDate: scheduledDate || null,
        amount: Number(amount),
        notes: notes || null,
      },
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['/api/jobs'] });
        queryClient.invalidateQueries({ queryKey: [`/api/clients/${client.id}/jobs`] });
        toast({ title: 'Job added' });
        setOpen(false);
      },
      onError: () => toast({ title: 'Job could not be added', variant: 'destructive' }),
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="outline"><Briefcase className="w-4 h-4 mr-1" /> Add Job</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Add Job for {client.name}</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="text-sm font-medium mb-1 block">Service</label>
            <select className={selectClass} value={serviceId} onChange={e => setServiceId(e.target.value)}>
              <option value="">General / no service</option>
              {services?.map(service => <option key={service.id} value={service.id}>{service.name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="text-sm font-medium mb-1 block">Scheduled Date</label><Input type="date" value={scheduledDate} onChange={e => setScheduledDate(e.target.value)} /></div>
            <div><label className="text-sm font-medium mb-1 block">Amount</label><Input type="number" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} required /></div>
          </div>
          <div><label className="text-sm font-medium mb-1 block">Notes</label><textarea className="flex min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={notes} onChange={e => setNotes(e.target.value)} /></div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={createJob.isPending || amount === ''}>{createJob.isPending ? 'Adding...' : 'Add Job'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AddTicketDialog({ client }: { client: Client }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const createTicket = useCreateTicket();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    createTicket.mutate({ data: { clientId: client.id, title, description, dueDate: dueDate || null } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['/api/tickets'] });
        toast({ title: 'Ticket added' });
        setOpen(false);
      },
      onError: () => toast({ title: 'Ticket could not be added', variant: 'destructive' }),
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="outline"><ListTodo className="w-4 h-4 mr-1" /> Add Ticket</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Add Ticket for {client.name}</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div><label className="text-sm font-medium mb-1 block">Title</label><Input value={title} onChange={e => setTitle(e.target.value)} required /></div>
          <div><label className="text-sm font-medium mb-1 block">Description</label><textarea className="flex min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={description} onChange={e => setDescription(e.target.value)} /></div>
          <div><label className="text-sm font-medium mb-1 block">Due Date</label><Input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} /></div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={createTicket.isPending || !title.trim()}>{createTicket.isPending ? 'Adding...' : 'Add Ticket'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The customer's own name, phone, email and the address we mow. This card did
 * not exist: the only way to fix a misspelled name was the list page. The
 * branch is the state — he has an Idaho side and a Washington side and nothing
 * else, so a second field would only be a second place to get it wrong.
 */
function ClientPersonalInfo({ client }: { client: Client }) {
  const initial = {
    name: client.name,
    phone: client.phone ?? '',
    email: client.email ?? '',
    serviceAddress: client.serviceAddress ?? '',
    addressLine2: client.addressLine2 ?? '',
    city: client.city ?? '',
    state: client.state ?? '',
    postalCode: client.postalCode ?? '',
  };
  type Form = typeof initial;
  const [form, setForm] = useState<Form>(initial);
  const { save, saving } = useSaveClient(client, 'Personal info saved');
  const set = (key: keyof Form, value: string) => setForm(current => ({ ...current, [key]: value }));
  const dirty = (Object.keys(initial) as (keyof Form)[]).some(k => initial[k] !== form[k]);

  const branches = ['ID', 'WA'];
  const otherState = form.state && !branches.includes(form.state) ? form.state : null;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.name.trim()) return;
    save({
      name: form.name.trim(),
      phone: clean(form.phone),
      email: clean(form.email),
      serviceAddress: clean(form.serviceAddress),
      addressLine2: clean(form.addressLine2),
      city: clean(form.city),
      state: clean(form.state),
      postalCode: clean(form.postalCode),
    });
  };

  // A plain function, not a component: a component declared inside render is
  // a new type every render, so React remounts the input and drops focus on
  // every keystroke.
  const field = ({ label, name, placeholder, type }: { label: string; name: keyof Form; placeholder?: string; type?: string }) => (
    <div>
      <label className="text-xs font-semibold text-muted-foreground uppercase mb-1 block">{label}</label>
      <Input type={type} value={form[name]} placeholder={placeholder} onChange={e => set(name, e.target.value)} data-testid={`personal-${name}`} />
    </div>
  );

  return (
    <Card className="shadow-sm border-border">
      <CardHeader className="pb-3 border-b bg-card/50">
        <CardTitle className="text-lg font-bold flex items-center gap-2">
          <Users className="w-5 h-5 text-muted-foreground" /> Personal info
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4">
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            {field({ label: 'Name', name: 'name' })}
            {field({ label: 'Phone', name: 'phone', placeholder: '208-555-0100' })}
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {field({ label: 'Notification email', name: 'email', type: 'email', placeholder: 'Where notices and bulk emails go' })}
            <div className="text-xs text-muted-foreground self-end pb-2">
              Notices, on-the-way texts by email and bulk emails go here. Invoices go to the billing
              email on the Billing tab, or here when that is blank.
            </div>
          </div>

          <div className="rounded-md border p-3 space-y-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase">Service address</p>
            {field({ label: 'Address', name: 'serviceAddress' })}
            {field({ label: 'Address line 2', name: 'addressLine2' })}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="col-span-2">{field({ label: 'City', name: 'city' })}</div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase mb-1 block">Branch / state</label>
                <select className={selectClass} value={form.state} onChange={e => set('state', e.target.value)} data-testid="personal-state">
                  <option value="">Not set</option>
                  <option value="ID">Idaho (ID)</option>
                  <option value="WA">Washington (WA)</option>
                  {otherState && <option value={otherState}>{otherState}</option>}
                </select>
              </div>
              {field({ label: 'ZIP', name: 'postalCode' })}
            </div>
          </div>

          <DoNotEmailSwitch client={client} />

          <Button type="submit" size="sm" disabled={!dirty || saving || !form.name.trim()} data-testid="personal-save">
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * His checkbox. Saved the moment it is flipped, on its own, because a switch
 * that waits for a Save button further down is a switch that gets left half
 * done — and this one decides whether a customer who asked to be left alone
 * gets the spring letter anyway.
 */
function DoNotEmailSwitch({ client }: { client: Client }) {
  const { save, saving } = useSaveClient(client, 'Saved');
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border p-3">
      <div>
        <label htmlFor="do-not-email" className="text-sm font-semibold flex items-center gap-1.5">
          <MailX className="w-4 h-4 text-muted-foreground" /> Do not email
        </label>
        <p className="text-xs text-muted-foreground mt-0.5">
          Stops every bulk email — board, waiting list, automations. Invoices still go out.
        </p>
      </div>
      <Switch
        id="do-not-email"
        checked={Boolean(client.doNotEmail)}
        disabled={saving}
        onCheckedChange={(on) => save({ doNotEmail: on }, { message: on ? 'Do not email is on' : 'Do not email is off' })}
        data-testid="do-not-email"
      />
    </div>
  );
}

/** "03-14" or "1990-03-14" the way the office reads it, not the way it is stored. */
function birthdayLabel(value: string | null | undefined) {
  if (!value) return null;
  try {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return format(parseISO(value), 'MMM d, yyyy');
    if (/^\d{2}-\d{2}$/.test(value)) return format(parseISO(`2000-${value}`), 'MMM d');
  } catch {
    // fall through to the raw value
  }
  return value;
}

type ContactForm = { name: string; role: string; phone: string; email: string; birthday: string };
const emptyContact: ContactForm = { name: '', role: '', phone: '', email: '', birthday: '' };

/**
 * The other people on the account — the CPA who gets the bill, the HOA
 * president, the son who pays. His old system kept these apart from the
 * customer's own phone and email, and so do we.
 *
 * The imported "Additional contact" line (mostly "Home 208-...") is shown until
 * it is turned into a real contact, so nothing from the import is lost on the
 * way over.
 */
function ClientContacts({ client }: { client: Client }) {
  const clientId = client.id;
  const { data: contacts, isLoading } = useListClientContacts(clientId);
  const createContact = useCreateClientContact();
  const updateContact = useUpdateClientContact();
  const deleteContact = useDeleteClientContact();
  const { save: saveClient } = useSaveClient(client, 'Saved');
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [form, setForm] = useState<ContactForm>(emptyContact);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getListClientContactsQueryKey(clientId) });
    queryClient.invalidateQueries({ queryKey: [`/api/clients/${clientId}/audit`] });
  };
  const fail = (title: string) => (error: unknown) => toast({
    title,
    description: error instanceof Error ? error.message : 'Please try again.',
    variant: 'destructive',
  });

  const startNew = (prefill: Partial<ContactForm> = {}) => {
    setForm({ ...emptyContact, ...prefill });
    setEditing('new');
  };
  const startEdit = (c: ClientContact) => {
    setForm({ name: c.name, role: c.role ?? '', phone: c.phone ?? '', email: c.email ?? '', birthday: c.birthday ?? '' });
    setEditing(c.id);
  };
  const cancel = () => { setEditing(null); setForm(emptyContact); };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const data = {
      name: form.name.trim(),
      role: clean(form.role),
      phone: clean(form.phone),
      email: clean(form.email),
      birthday: clean(form.birthday),
    };
    if (!data.name) return;
    if (editing === 'new') {
      createContact.mutate({ id: clientId, data }, {
        onSuccess: () => {
          refresh();
          toast({ title: 'Contact added' });
          // The imported line has done its job once it is a real contact.
          if (client.additionalContact && form.phone && client.additionalContact.includes(form.phone)) {
            saveClient({ additionalContact: null }, { message: 'Contact added' });
          }
          cancel();
        },
        onError: fail('Contact could not be added'),
      });
    } else if (typeof editing === 'number') {
      updateContact.mutate({ id: editing, data }, {
        onSuccess: () => { refresh(); toast({ title: 'Contact saved' }); cancel(); },
        onError: fail('Contact could not be saved'),
      });
    }
  };

  const remove = (c: ClientContact) => {
    if (!confirm(`Remove ${c.name} from this account?`)) return;
    deleteContact.mutate({ id: c.id }, {
      onSuccess: () => { refresh(); toast({ title: 'Contact removed' }); },
      onError: fail('Contact could not be removed'),
    });
  };

  const pending = createContact.isPending || updateContact.isPending;
  const legacy = client.additionalContact?.trim();
  const legacyPhone = legacy?.match(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/)?.[0] ?? '';

  const editor = (
    <form onSubmit={submit} className="rounded-md border bg-muted/30 p-3 space-y-3" data-testid="contact-form">
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label className="text-xs font-semibold text-muted-foreground uppercase mb-1 block">Name</label>
          <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required autoFocus data-testid="contact-name" />
        </div>
        <div>
          <label className="text-xs font-semibold text-muted-foreground uppercase mb-1 block">Who they are</label>
          <Input value={form.role} placeholder="CPA, spouse, HOA president" onChange={e => setForm({ ...form, role: e.target.value })} data-testid="contact-role" />
        </div>
        <div>
          <label className="text-xs font-semibold text-muted-foreground uppercase mb-1 block">Phone</label>
          <Input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} data-testid="contact-phone" />
        </div>
        <div>
          <label className="text-xs font-semibold text-muted-foreground uppercase mb-1 block">Email</label>
          <Input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} data-testid="contact-email" />
        </div>
        <div>
          <label className="text-xs font-semibold text-muted-foreground uppercase mb-1 block">Birthday</label>
          <Input value={form.birthday} placeholder="yyyy-mm-dd, or mm-dd" onChange={e => setForm({ ...form, birthday: e.target.value })} data-testid="contact-birthday" />
          <p className="text-xs text-muted-foreground mt-1">The year is optional — nobody asks a CPA her birth year.</p>
        </div>
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending || !form.name.trim()} data-testid="contact-save">
          {pending ? 'Saving...' : editing === 'new' ? 'Add contact' : 'Save'}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={cancel}>Cancel</Button>
      </div>
    </form>
  );

  return (
    <Card className="shadow-sm border-border">
      <CardHeader className="pb-3 border-b bg-card/50">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg font-bold flex items-center gap-2">
            <Phone className="w-5 h-5 text-muted-foreground" /> Contacts
          </CardTitle>
          {editing === null && (
            <Button size="sm" variant="outline" className="h-8" onClick={() => startNew()} data-testid="contact-add">
              <Plus className="w-4 h-4 mr-1" /> Add contact
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-4 space-y-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground animate-pulse">Loading contacts...</p>
        ) : !contacts?.length && editing !== 'new' && !legacy ? (
          <p className="text-sm text-muted-foreground">
            Nobody else on this account. Add the CPA, a spouse, the HOA president — anyone the office may need to call.
          </p>
        ) : null}

        {contacts?.map(c => editing === c.id ? (
          <div key={c.id}>{editor}</div>
        ) : (
          <div key={c.id} className="flex items-start justify-between gap-3 rounded-md border p-3" data-testid={`contact-${c.id}`}>
            <div className="text-sm space-y-0.5">
              <p className="font-semibold">
                {c.name}
                {c.role && <span className="ml-2 text-xs font-normal text-muted-foreground">{c.role}</span>}
              </p>
              <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-muted-foreground">
                {c.phone && <span className="flex items-center gap-1"><Phone className="w-3 h-3" /> {c.phone}</span>}
                {c.email && <span className="flex items-center gap-1"><Mail className="w-3 h-3" /> {c.email}</span>}
                {c.birthday && <span className="flex items-center gap-1"><Calendar className="w-3 h-3" /> {birthdayLabel(c.birthday)}</span>}
              </div>
            </div>
            <div className="flex gap-1 shrink-0">
              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => startEdit(c)} aria-label={`Edit ${c.name}`} data-testid={`contact-edit-${c.id}`}>
                <Pencil className="w-4 h-4" />
              </Button>
              <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => remove(c)} aria-label={`Remove ${c.name}`} data-testid={`contact-remove-${c.id}`}>
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          </div>
        ))}

        {editing === 'new' && editor}

        {legacy && editing === null && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-dashed p-3 text-sm">
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase">From the import</p>
              <p>{legacy}</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => startNew({ phone: legacyPhone, role: legacy.replace(legacyPhone, '').trim() })} data-testid="contact-convert">
              Make it a contact
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Find a customer by name for the pickers. 700 customers is too many for a
 * dropdown and too few to need anything cleverer than the list search.
 */
function ClientPicker({ placeholder, exclude, onPick, testId }: {
  placeholder: string;
  exclude: (c: Client) => string | null;
  onPick: (c: Client) => void;
  testId: string;
}) {
  const [term, setTerm] = useState('');
  const ready = term.trim().length >= 2;
  const { data: results, isFetching } = useListClients({ search: term.trim() }, { query: { enabled: ready, queryKey: getListClientsQueryKey({ search: term.trim() }) } });
  return (
    <div className="space-y-2">
      <Input value={term} placeholder={placeholder} onChange={e => setTerm(e.target.value)} data-testid={testId} />
      {ready && (
        <div className="max-h-56 overflow-y-auto rounded-md border divide-y bg-background">
          {isFetching && !results ? (
            <p className="p-2 text-xs text-muted-foreground animate-pulse">Searching...</p>
          ) : !results?.length ? (
            <p className="p-2 text-xs text-muted-foreground">No customer matches "{term}".</p>
          ) : results.slice(0, 20).map(c => {
            const why = exclude(c);
            return (
              <button
                key={c.id}
                type="button"
                disabled={why != null}
                title={why ?? undefined}
                onClick={() => { onPick(c); setTerm(''); }}
                className="w-full text-left px-3 py-2 text-sm hover:bg-muted/60 disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid={`${testId}-pick-${c.id}`}
              >
                <span className="font-medium">{c.name}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {[c.serviceAddress, c.city].filter(Boolean).join(', ')}
                  {why ? ` — ${why}` : ''}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Master account and related properties. A property manager or an HOA is one
 * customer with several addresses under it; each address is its own customer
 * with its own invoices and its own jobs, and the master is where he reads the
 * total. One level only — the server refuses anything deeper.
 */
function ClientMasterAccount({ client }: { client: Client }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const updateClient = useUpdateClient();
  const isMaster = (client.relatedPropertyCount ?? 0) > 0;
  const { data: related, isLoading } = useListRelatedClients(client.id, { query: { enabled: isMaster, queryKey: getListRelatedClientsQueryKey(client.id) } });
  const [picking, setPicking] = useState<'property' | 'master' | null>(null);

  // Linking edits the PROPERTY row, whichever page we are on: the child
  // carries the pointer, the master only counts them.
  const link = (childId: number, parentClientId: number | null, message: string) => {
    updateClient.mutate({ id: childId, data: { parentClientId } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: [`/api/clients/${client.id}`] });
        queryClient.invalidateQueries({ queryKey: [`/api/clients/${childId}`] });
        queryClient.invalidateQueries({ queryKey: getListRelatedClientsQueryKey(client.id) });
        queryClient.invalidateQueries({ queryKey: ['/api/clients'] });
        queryClient.invalidateQueries({ queryKey: [`/api/clients/${client.id}/audit`] });
        toast({ title: message });
        setPicking(null);
      },
      onError: (error) => toast({
        title: 'Could not change the master account',
        description: error instanceof Error ? error.message : 'Please try again.',
        variant: 'destructive',
      }),
    });
  };

  const total = client.relatedBalanceTotal ?? client.accountBalance;

  return (
    <Card className="shadow-sm border-border">
      <CardHeader className="pb-3 border-b bg-card/50">
        <CardTitle className="text-lg font-bold flex items-center gap-2">
          <Building2 className="w-5 h-5 text-muted-foreground" />
          {client.parentClientId != null ? 'Master account' : 'Related properties'}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4 space-y-4">
        {client.parentClientId != null ? (
          <>
            <p className="text-sm">
              This property is under{' '}
              <Link href={`/clients/${client.parentClientId}`} className="font-semibold text-primary hover:underline" data-testid="master-link">
                {client.parentClientName ?? `#${client.parentClientId}`}
              </Link>
              . Its invoices stay here; the master sees this balance added to its total.
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={updateClient.isPending}
              onClick={() => {
                if (confirm(`Take ${client.name} off ${client.parentClientName ?? 'its master account'}?`)) {
                  link(client.id, null, 'Taken off the master account');
                }
              }}
              data-testid="master-remove"
            >
              Take it off the master account
            </Button>
          </>
        ) : (
          <>
            {isMaster ? (
              isLoading ? (
                <p className="text-sm text-muted-foreground animate-pulse">Loading properties...</p>
              ) : (
                <div className="rounded-md border divide-y" data-testid="related-list">
                  {related?.map(p => (
                    <div key={p.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                      <div className="min-w-0">
                        <Link href={`/clients/${p.id}`} className="font-semibold text-primary hover:underline">{p.name}</Link>
                        <p className="text-xs text-muted-foreground truncate">{[p.serviceAddress, p.city].filter(Boolean).join(', ')}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={`font-bold ${p.accountBalance > 0 ? 'text-destructive' : ''}`}>{money(p.accountBalance)}</span>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          aria-label={`Remove ${p.name}`}
                          disabled={updateClient.isPending}
                          onClick={() => { if (confirm(`Take ${p.name} off this master account?`)) link(p.id, null, `${p.name} taken off`); }}
                          data-testid={`related-remove-${p.id}`}
                        >
                          <X className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                  <div className="flex items-center justify-between p-3 text-sm bg-muted/40">
                    <span className="font-semibold">Total with this account</span>
                    <span className={`font-bold ${total > 0 ? 'text-destructive' : ''}`} data-testid="related-list-total">{money(total)}</span>
                  </div>
                </div>
              )
            ) : (
              <p className="text-sm text-muted-foreground">
                No properties under this account. A property manager or HOA gets its properties listed here,
                each with its own balance, and the total at the bottom.
              </p>
            )}

            {picking === 'property' ? (
              <div className="space-y-2">
                <ClientPicker
                  placeholder="Type a customer's name to add as a property"
                  testId="related-picker"
                  exclude={(c) =>
                    c.id === client.id ? 'this account'
                      : c.parentClientId != null ? 'already under a master'
                        : (c.relatedPropertyCount ?? 0) > 0 ? 'is a master itself'
                          : null}
                  onPick={(c) => link(c.id, client.id, `${c.name} added as a property`)}
                />
                <Button size="sm" variant="ghost" onClick={() => setPicking(null)}>Cancel</Button>
              </div>
            ) : picking === 'master' ? (
              <div className="space-y-2">
                <ClientPicker
                  placeholder="Type the master account's name"
                  testId="master-picker"
                  exclude={(c) =>
                    c.id === client.id ? 'this account'
                      : c.parentClientId != null ? 'is a property itself'
                        : null}
                  onPick={(c) => link(client.id, c.id, `Now under ${c.name}`)}
                />
                <Button size="sm" variant="ghost" onClick={() => setPicking(null)}>Cancel</Button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setPicking('property')} data-testid="related-add">
                  <Plus className="w-4 h-4 mr-1" /> Add a property
                </Button>
                {!isMaster && (
                  <Button size="sm" variant="ghost" onClick={() => setPicking('master')} data-testid="master-set">
                    Put this account under a master
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ClientRouting({ client }: { client: Client }) {
  const [mapCode, setMapCode] = useState(client.mapCode ?? '');
  const [waterDistrict, setWaterDistrict] = useState(client.waterDistrict ?? '');
  const [mapNote, setMapNote] = useState(client.mapNote ?? '');
  const { save, saving } = useSaveClient(client, 'Routing details saved');

  const dirty = (client.mapCode ?? '') !== mapCode
    || (client.waterDistrict ?? '') !== waterDistrict
    || (client.mapNote ?? '') !== mapNote;

  return (
    <Card className="shadow-sm border-border">
      <CardHeader className="pb-3 border-b bg-card/50">
        <CardTitle className="text-lg font-bold flex items-center gap-2">
          <Route className="w-5 h-5 text-muted-foreground" />
          Routing & Water District
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4 space-y-4">
        <div>
          <label className="text-xs font-semibold text-muted-foreground uppercase mb-1 block">Map Code</label>
          <Input
            className="uppercase"
            placeholder="e.g. PF"
            maxLength={16}
            value={mapCode}
            onChange={(e) => setMapCode(e.target.value)}
            data-testid="routing-mapCode"
          />
          <p className="text-xs text-muted-foreground mt-1">Route zone shorthand. Groups and colour-codes this client on the client list.</p>
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs font-semibold text-muted-foreground uppercase flex items-center gap-1.5">
              <Droplets className="w-3.5 h-3.5" /> Water District
            </label>
            <WaterProviderLookupLink />
          </div>
          <Input
            placeholder="e.g. Whitworth Water District No. 2"
            value={waterDistrict}
            onChange={(e) => setWaterDistrict(e.target.value)}
          />
          <p className="text-xs text-muted-foreground mt-1">
            Sets which district's rules govern this property's backflow test and blow-out. Check the address on the lookup, then type the answer here.
          </p>
        </div>
        <div>
          <label className="text-xs font-semibold text-muted-foreground uppercase mb-1 block">Map / crew note</label>
          <Textarea
            rows={2}
            placeholder="Gate on the left side. Dog in the back yard."
            value={mapNote}
            onChange={(e) => setMapNote(e.target.value)}
            data-testid="routing-mapNote"
          />
          <p className="text-xs text-muted-foreground mt-1">The crew sees this on every job card for this address.</p>
        </div>
        <Button
          size="sm"
          onClick={() => save({
            // Blank clears the field rather than storing "", so an unknown district
            // never reads as a real answer on the list or in a district filter.
            mapCode: mapCode.trim().toUpperCase() || null,
            waterDistrict: clean(waterDistrict),
            mapNote: clean(mapNote),
          })}
          disabled={!dirty || saving}
          data-testid="routing-save"
        >
          {saving ? 'Saving...' : 'Save'}
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * Pulls "47.71, -116.95" out of whatever was pasted: a bare pair, a Google
 * Maps link with @lat,lng in it, a share link with q=lat,lng, or the
 * !3d..!4d.. form. Returns null when there is no pair to be found.
 */
function parseCoordinates(text: string): { lat: number; lng: number } | null {
  const num = '(-?\\d{1,3}(?:\\.\\d+)?)';
  const patterns = [
    new RegExp(`^\\s*${num}\\s*[, ]\\s*${num}\\s*$`),
    new RegExp(`@${num},${num}`),
    new RegExp(`[?&](?:q|query|ll|destination)=${num},${num}`),
    new RegExp(`!3d${num}!4d${num}`),
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
    }
  }
  return null;
}

/**
 * The map pin, for the lots that have no street address yet. New construction
 * is where the crew gets lost: the address is a lot number the map has never
 * heard of. Standing on the lot with a phone and pressing one button beats
 * typing seven decimal places, so that is the first button; pasting a Google
 * Maps link is the second; the numbers themselves are last.
 */
function ClientMapPin({ client }: { client: Client }) {
  const [lat, setLat] = useState(client.lat != null ? String(client.lat) : '');
  const [lng, setLng] = useState(client.lng != null ? String(client.lng) : '');
  const [paste, setPaste] = useState('');
  const [locating, setLocating] = useState(false);
  const { save, saving } = useSaveClient(client, 'Map pin saved');
  const { toast } = useToast();

  const latNum = lat.trim() === '' ? null : Number(lat);
  const lngNum = lng.trim() === '' ? null : Number(lng);
  const halfDone = (latNum == null) !== (lngNum == null);
  const invalid = (latNum != null && (Number.isNaN(latNum) || Math.abs(latNum) > 90))
    || (lngNum != null && (Number.isNaN(lngNum) || Math.abs(lngNum) > 180));
  const dirty = (client.lat != null ? String(client.lat) : '') !== lat || (client.lng != null ? String(client.lng) : '') !== lng;

  const useMyLocation = () => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      toast({ title: 'This browser cannot find your location', variant: 'destructive' });
      return;
    }
    setLocating(true);
    // Dismissing the permission prompt (as opposed to answering it) fires
    // neither callback in some browsers, so a timer stands in for the answer.
    let settled = false;
    const finish = (pos: { lat: number; lng: number } | null, why?: string) => {
      if (settled) return;
      settled = true;
      setLocating(false);
      if (!pos) {
        toast({ title: 'Could not get your location', description: why ?? 'Allow location for this site and try again.', variant: 'destructive' });
        return;
      }
      setLat(pos.lat.toFixed(6));
      setLng(pos.lng.toFixed(6));
    };
    navigator.geolocation.getCurrentPosition(
      p => finish({ lat: p.coords.latitude, lng: p.coords.longitude }),
      err => finish(null, err.message),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
    );
    setTimeout(() => finish(null, 'No answer from the phone.'), 9000);
  };

  const applyPaste = (value: string) => {
    setPaste(value);
    const parsed = parseCoordinates(value);
    if (parsed) {
      setLat(String(parsed.lat));
      setLng(String(parsed.lng));
      setPaste('');
    }
  };

  const pinUrl = latNum != null && lngNum != null && !invalid
    ? `https://www.google.com/maps/search/?api=1&query=${latNum},${lngNum}`
    : null;

  return (
    <Card className="shadow-sm border-border">
      <CardHeader className="pb-3 border-b bg-card/50">
        <CardTitle className="text-lg font-bold flex items-center gap-2">
          <Crosshair className="w-5 h-5 text-muted-foreground" />
          Map pin
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4 space-y-4">
        <p className="text-xs text-muted-foreground">
          For new construction with no street address yet, or any lot the map gets wrong. The crew's
          navigation and the route builder use the pin before the address.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={useMyLocation} disabled={locating} data-testid="pin-use-location">
            <LocateFixed className="w-4 h-4 mr-1" /> {locating ? 'Finding you...' : 'Use my phone location'}
          </Button>
          {pinUrl && (
            <Button asChild size="sm" variant="outline">
              <a href={pinUrl} target="_blank" rel="noopener noreferrer" data-testid="pin-open-maps">
                <ExternalLink className="w-4 h-4 mr-1" /> Open pin in Google Maps
              </a>
            </Button>
          )}
        </div>
        <div>
          <label className="text-xs font-semibold text-muted-foreground uppercase mb-1 flex items-center gap-1.5">
            <ClipboardPaste className="w-3.5 h-3.5" /> Paste a Google Maps link or "lat, lng"
          </label>
          <Input
            value={paste}
            placeholder="47.7123, -116.9512  or  https://maps.google.com/...@47.71,-116.95..."
            onChange={e => applyPaste(e.target.value)}
            data-testid="pin-paste"
          />
          {paste && !parseCoordinates(paste) && (
            <p className="text-xs text-muted-foreground mt-1">No coordinates found in that yet.</p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-semibold text-muted-foreground uppercase mb-1 block">Latitude</label>
            <Input type="number" step="any" min={-90} max={90} value={lat} onChange={e => setLat(e.target.value)} data-testid="pin-lat" />
          </div>
          <div>
            <label className="text-xs font-semibold text-muted-foreground uppercase mb-1 block">Longitude</label>
            <Input type="number" step="any" min={-180} max={180} value={lng} onChange={e => setLng(e.target.value)} data-testid="pin-lng" />
          </div>
        </div>
        {halfDone && <p className="text-xs text-destructive">Latitude and longitude go together — give both, or clear both.</p>}
        {invalid && <p className="text-xs text-destructive">Latitude runs -90 to 90 and longitude -180 to 180. Around here it is about 47.7, -116.8.</p>}
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={!dirty || saving || halfDone || invalid}
            onClick={() => save({ lat: latNum, lng: lngNum })}
            data-testid="pin-save"
          >
            {saving ? 'Saving...' : 'Save pin'}
          </Button>
          {(lat || lng) && (
            <Button size="sm" variant="outline" onClick={() => { setLat(''); setLng(''); }} data-testid="pin-clear">
              Clear
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Where they came from and who sent them. The source list is whatever
 * customers already carry — typing a new one on this customer is what adds it
 * to the list everyone else is offered — because his old system made him
 * maintain a Client Source screen and it was always out of date.
 */
function ClientSales({ client }: { client: Client }) {
  const [source, setSource] = useState(client.source ?? '');
  const [referredBy, setReferredBy] = useState<{ id: number; name: string } | null>(
    client.referredByClientId != null ? { id: client.referredByClientId, name: client.referredByClientName ?? `#${client.referredByClientId}` } : null,
  );
  const [picking, setPicking] = useState(false);
  const { data: sources } = useListClientSources();
  const queryClient = useQueryClient();
  const { save, saving } = useSaveClient(client, 'Sales details saved');

  const dirty = (client.source ?? '') !== source || (client.referredByClientId ?? null) !== (referredBy?.id ?? null);

  return (
    <Card className="shadow-sm border-border">
      <CardHeader className="pb-3 border-b bg-card/50">
        <CardTitle className="text-lg font-bold flex items-center gap-2">
          <Megaphone className="w-5 h-5 text-muted-foreground" /> Sales
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4 space-y-4">
        <div>
          <label className="text-xs font-semibold text-muted-foreground uppercase mb-1 block">Source</label>
          <Input
            list="client-sources"
            value={source}
            placeholder="Door Hanger, Google, Customer Referral..."
            onChange={e => setSource(e.target.value)}
            data-testid="sales-source"
          />
          <datalist id="client-sources">
            {sources?.map(s => <option key={s} value={s} />)}
          </datalist>
          <p className="text-xs text-muted-foreground mt-1">
            Pick one already in use or type a new one — it is offered on every other customer from then on.
          </p>
        </div>
        <div>
          <label className="text-xs font-semibold text-muted-foreground uppercase mb-1 block">Referred by</label>
          {referredBy && !picking ? (
            <div className="flex items-center gap-2 text-sm">
              <Link href={`/clients/${referredBy.id}`} className="font-semibold text-primary hover:underline" data-testid="sales-referred-link">
                {referredBy.name}
              </Link>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setPicking(true)}>Change</Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => setReferredBy(null)} data-testid="sales-referred-clear">Clear</Button>
            </div>
          ) : (
            <ClientPicker
              placeholder="Type the name of the customer who sent them"
              testId="sales-referred-picker"
              exclude={(c) => c.id === client.id ? 'this account' : null}
              onPick={(c) => { setReferredBy({ id: c.id, name: c.name }); setPicking(false); }}
            />
          )}
        </div>
        <Button
          size="sm"
          disabled={!dirty || saving}
          onClick={() => save({ source: clean(source), referredByClientId: referredBy?.id ?? null }, {
            onSuccess: () => queryClient.invalidateQueries({ queryKey: getListClientSourcesQueryKey() }),
          })}
          data-testid="sales-save"
        >
          {saving ? 'Saving...' : 'Save'}
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * The office note and the customer's tags, pinned to the top of the page.
 *
 * Asked for as "an office note on clients account that shows up on the front of
 * client account" and "ability to add custom tags to clients for specific look
 * up in the future, example = above ground back flow, inside turn on/off".
 *
 * The office note is deliberately not the Map / Contractor note and not a
 * property detail. Both of those are carried onto the crew's job card by
 * design, so anything written there is read by whoever turns up to mow. This is
 * the one place for something the office needs and the crew should not see —
 * "always argues about the bill", "do not discuss price on site".
 *
 * Tags are stored lowercase so "Backflow" and "backflow" are one tag rather
 * than two that look identical in a search, and they are searchable from the
 * same box on the client list he already types names into.
 */
function ClientOfficeNote({ client }: { client: Client }) {
  const [note, setNote] = useState(client.officeNote ?? '');
  const [tagDraft, setTagDraft] = useState('');
  const [expanded, setExpanded] = useState(false);
  const tags = client.tags ?? [];
  const { save, saving } = useSaveClient(client, 'Saved');

  const persist = (data: { officeNote?: string | null; tags?: string[] }, message: string) =>
    save(data, { message });

  const addTag = () => {
    const next = tagDraft.trim().toLowerCase();
    if (!next) return;
    setTagDraft('');
    if (tags.includes(next)) return;
    persist({ tags: [...tags, next] }, `Tagged "${next}"`);
  };

  const removeTag = (tag: string) =>
    persist({ tags: tags.filter(t => t !== tag) }, `Removed "${tag}"`);

  const noteDirty = (client.officeNote ?? '') !== note;

  /*
    Collapsed until it has something to say.

    Expanded, this is a titled panel with a two-row textarea, a tag field and
    two lines of help — roughly 200px at the very top of the page. It is empty
    for almost every one of the 709 customers, so on almost every visit the
    first thing on the page was a large box containing nothing, pushing the
    services, estimates and invoices below the fold. Prominence has to be earned
    by content: with a note or a tag it stays exactly as loud as before, and
    without one it is a single quiet line.
  */
  const hasContent = Boolean((client.officeNote ?? '').trim()) || tags.length > 0;

  if (!hasContent && !expanded) {
    return (
      <div className="flex items-center gap-4 text-sm">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
          data-testid="office-note-open"
        >
          <MessageSquare className="w-3.5 h-3.5" />
          Add an office note or tag
        </button>
        {client.createdAt && (
          <span className="text-muted-foreground/70">
            Added {new Date(client.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}
          </span>
        )}
      </div>
    );
  }

  return (
    <Card className="shadow-sm border-accent/40 bg-accent/5">
      <CardContent className="pt-4 space-y-3">
        <div>
          <label className="text-xs font-semibold text-muted-foreground uppercase mb-1 flex items-center gap-1.5">
            <MessageSquare className="w-3.5 h-3.5" /> Office note
            <span className="font-normal normal-case text-muted-foreground/70">— the crew never sees this</span>
          </label>
          <Textarea
            rows={2}
            className="resize-y bg-background"
            placeholder="Anything the office needs to remember about this customer."
            value={note}
            onChange={e => setNote(e.target.value)}
            data-testid="office-note"
          />
          {noteDirty && (
            <Button
              size="sm"
              className="mt-2"
              onClick={() => persist({ officeNote: note.trim() || null }, 'Office note saved')}
              disabled={saving}
              data-testid="office-note-save"
            >
              {saving ? 'Saving...' : 'Save note'}
            </Button>
          )}
        </div>

        <div>
          <label className="text-xs font-semibold text-muted-foreground uppercase mb-1 block">Tags</label>
          <div className="flex flex-wrap items-center gap-1.5">
            {tags.map(tag => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-xs"
                data-testid={`tag-${tag}`}
              >
                {tag}
                <button
                  type="button"
                  onClick={() => removeTag(tag)}
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={`Remove tag ${tag}`}
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
            <Input
              className="h-7 w-44 text-xs"
              placeholder="Add a tag + Enter"
              value={tagDraft}
              onChange={e => setTagDraft(e.target.value)}
              onKeyDown={e => {
                // Enter adds the tag rather than submitting anything — there is
                // no form here, but the habit is worth honouring.
                if (e.key === 'Enter') { e.preventDefault(); addTag(); }
              }}
              data-testid="tag-input"
            />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Searchable from the client list — try "above ground backflow".
          </p>
        </div>

        {client.createdAt && (
          <p className="text-xs text-muted-foreground">
            Added {new Date(client.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * A select with the usual answers plus "Other" that opens a free box. Imported
 * rows hold whatever his old system had in them ("Invoice on the 30th"), and
 * those must stay readable and saveable rather than being forced into a list.
 */
function ChoiceOrOther({ value, onChange, choices, placeholder, testId }: {
  value: string;
  onChange: (v: string) => void;
  choices: string[];
  placeholder: string;
  testId: string;
}) {
  const known = value === '' || choices.includes(value);
  const [other, setOther] = useState(!known);
  useEffect(() => { if (!known) setOther(true); }, [known]);
  return (
    <div className="space-y-2">
      <select
        className={selectClass}
        value={other ? '__other' : value}
        onChange={e => {
          if (e.target.value === '__other') { setOther(true); return; }
          setOther(false);
          onChange(e.target.value);
        }}
        data-testid={testId}
      >
        <option value="">Not set</option>
        {choices.map(c => <option key={c} value={c}>{c}</option>)}
        <option value="__other">Other...</option>
      </select>
      {other && (
        <Input value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} data-testid={`${testId}-other`} />
      )}
    </div>
  );
}

const TERMS = ['Due on receipt', 'Net 15', 'Net 30', 'Net 60'];
const FREQUENCIES = ['Daily', 'Weekly', 'Bi-weekly', 'Monthly', 'Per service'];
const PAY_METHODS: { value: NonNullable<Client['preferredPaymentMethod']>; label: string }[] = [
  { value: 'check', label: 'Check' },
  { value: 'cash', label: 'Cash' },
  { value: 'venmo', label: 'Venmo' },
  { value: 'zelle', label: 'Zelle' },
  { value: 'credit_card', label: 'Credit card' },
  { value: 'ach', label: 'ACH / bank transfer' },
  { value: 'other', label: 'Other' },
];

/**
 * Billing details — where the bill goes, on what terms, and how.
 *
 * Every field here already existed and already drove the invoice: the Bill To
 * block, the account number printed on the payment coupon, the terms
 * snapshotted onto each invoice, the address a bill is emailed to. None of them
 * were shown anywhere in the app, so the office was billing customers from data
 * it could neither see nor correct. Asked for as "having a billing tab in
 * clients account with email(s) to send invoices to, selection of them being
 * emailed or printed or both, how they like to pay".
 *
 * The billing address deliberately stays empty for the ordinary customer whose
 * bill goes to the house being mowed. Filling it in is what makes the invoice
 * address a property manager instead, so a blank here is a real answer rather
 * than a missing one — and the placeholder says so, because an empty field that
 * means something is exactly the kind of thing someone "helpfully" fills in.
 * "Copy service address" is for the customer who wants it written out anyway.
 */
function ClientBilling({ client }: { client: Client }) {
  const initial = {
    email: client.email ?? '',
    nameOnInvoice: client.nameOnInvoice ?? '',
    billingAddressLine1: client.billingAddressLine1 ?? '',
    billingAddressLine2: client.billingAddressLine2 ?? '',
    billingCity: client.billingCity ?? '',
    billingState: client.billingState ?? '',
    billingPostalCode: client.billingPostalCode ?? '',
    billingEmail: client.billingEmail ?? '',
    accountNumber: client.accountNumber ?? '',
    billingTerms: client.billingTerms ?? '',
    invoiceFrequency: client.invoiceFrequency ?? '',
    invoiceDelivery: client.invoiceDelivery ?? '',
    accountType: client.accountType ?? '',
    preferredPaymentMethod: client.preferredPaymentMethod ?? '',
  };
  type BillingForm = typeof initial;
  const [form, setForm] = useState<BillingForm>(initial);
  const { save, saving } = useSaveClient(client, 'Billing details saved');

  const set = (key: keyof BillingForm, value: string) =>
    setForm(current => ({ ...current, [key]: value }));

  const dirty = (Object.keys(initial) as (keyof BillingForm)[]).some(k => initial[k] !== form[k]);
  const hasAnyEmail = Boolean(form.billingEmail.trim() || form.email.trim());

  const copyServiceAddress = () => setForm(current => ({
    ...current,
    billingAddressLine1: client.serviceAddress ?? '',
    billingAddressLine2: client.addressLine2 ?? '',
    billingCity: client.city ?? '',
    billingState: client.state ?? '',
    billingPostalCode: client.postalCode ?? '',
  }));

  const submit = () => {
    save({
      email: clean(form.email),
      nameOnInvoice: clean(form.nameOnInvoice),
      billingAddressLine1: clean(form.billingAddressLine1),
      billingAddressLine2: clean(form.billingAddressLine2),
      billingCity: clean(form.billingCity),
      billingState: clean(form.billingState),
      billingPostalCode: clean(form.billingPostalCode),
      billingEmail: clean(form.billingEmail),
      accountNumber: clean(form.accountNumber),
      billingTerms: clean(form.billingTerms),
      invoiceFrequency: clean(form.invoiceFrequency),
      invoiceDelivery: clean(form.invoiceDelivery) as 'email' | 'print' | 'both' | null,
      accountType: clean(form.accountType) as 'residential' | 'commercial' | null,
      preferredPaymentMethod: clean(form.preferredPaymentMethod) as Client['preferredPaymentMethod'],
    });
  };

  // Same reason as the personal-info card: a function, so the input keeps focus.
  const billingField = ({ label, name, placeholder, type }: {
    label: string; name: keyof BillingForm; placeholder?: string; type?: string;
  }) => (
    <div>
      <label className="text-xs font-semibold text-muted-foreground uppercase mb-1 block">{label}</label>
      <Input
        type={type}
        value={form[name]}
        placeholder={placeholder}
        onChange={e => set(name, e.target.value)}
        data-testid={'billing-' + String(name)}
      />
    </div>
  );

  return (
    <Card className="shadow-sm border-border">
      <CardHeader className="pb-3 border-b bg-card/50">
        <CardTitle className="text-lg font-bold flex items-center gap-2">
          <Receipt className="w-5 h-5 text-muted-foreground" />
          Billing
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4 space-y-6">
        <div className="rounded-md border p-3 space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            {billingField({ label: 'Notification email', name: 'email', type: 'email', placeholder: 'Where notices go' })}
            {billingField({ label: 'Billing email', name: 'billingEmail', type: 'email', placeholder: form.email || 'Falls back to the notification email' })}
          </div>
          <p className="text-xs text-muted-foreground">
            Notices and bulk emails go to the notification email; invoices go to the billing email — the CPA,
            the property manager — and to the notification email when that is blank.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-4">
            <div className="grid gap-3">
              {billingField({ label: 'Name on invoice', name: 'nameOnInvoice', placeholder: client.name })}
              {billingField({ label: 'Account number', name: 'accountNumber', placeholder: 'Quoted when they pay' })}
            </div>

            <div className="rounded-md border p-3 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  Bill To address. Leave empty when the bill goes to the property being serviced — fill it
                  in only when someone else is billed, such as a property manager or a second home.
                </p>
                <Button type="button" size="sm" variant="outline" className="h-7 shrink-0 text-xs" onClick={copyServiceAddress} data-testid="billing-copy-service-address">
                  Copy service address
                </Button>
              </div>
              <div className="grid gap-3">
                {billingField({ label: 'Address line 1', name: 'billingAddressLine1', placeholder: 'Same as service address' })}
                {billingField({ label: 'Address line 2', name: 'billingAddressLine2' })}
                {billingField({ label: 'City', name: 'billingCity' })}
                {/* State and ZIP are genuinely short, so they keep sharing a row. */}
                <div className="grid grid-cols-2 gap-3">
                  {billingField({ label: 'State', name: 'billingState' })}
                  {billingField({ label: 'ZIP', name: 'billingPostalCode' })}
                </div>
              </div>
            </div>
          </div>

          <div className="grid gap-3 content-start">
            <div>
              <label className="text-xs font-semibold text-muted-foreground uppercase mb-1 block">Send invoice by</label>
              <select
                className={selectClass}
                value={form.invoiceDelivery}
                onChange={e => set('invoiceDelivery', e.target.value)}
                data-testid="billing-invoiceDelivery"
              >
                <option value="">Not set</option>
                <option value="email" disabled={!hasAnyEmail}>Email{hasAnyEmail ? '' : ' — needs an email'}</option>
                <option value="print">Print</option>
                <option value="both" disabled={!hasAnyEmail}>Both{hasAnyEmail ? '' : ' — needs an email'}</option>
              </select>
              {!hasAnyEmail && (
                <p className="text-xs text-muted-foreground mt-1">
                  No email of either kind, so invoices can only be printed. Add one above to email them.
                </p>
              )}
            </div>
            <div>
              <label className="text-xs font-semibold text-muted-foreground uppercase mb-1 block">How they pay</label>
              <select
                className={selectClass}
                value={form.preferredPaymentMethod}
                onChange={e => set('preferredPaymentMethod', e.target.value)}
                data-testid="billing-preferredPaymentMethod"
              >
                <option value="">Not set</option>
                {PAY_METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold text-muted-foreground uppercase mb-1 block">Terms</label>
              <ChoiceOrOther value={form.billingTerms} onChange={v => set('billingTerms', v)} choices={TERMS} placeholder="e.g. Net 45" testId="billing-billingTerms" />
              <p className="text-xs text-muted-foreground mt-1">Printed on each invoice as it is issued.</p>
            </div>
            <div>
              <label className="text-xs font-semibold text-muted-foreground uppercase mb-1 block">How often invoiced</label>
              <ChoiceOrOther value={form.invoiceFrequency} onChange={v => set('invoiceFrequency', v)} choices={FREQUENCIES} placeholder="e.g. Invoice on the 30th" testId="billing-invoiceFrequency" />
            </div>
            <div>
              <label className="text-xs font-semibold text-muted-foreground uppercase mb-1 block">Account type</label>
              <select
                className={selectClass}
                value={form.accountType}
                onChange={e => set('accountType', e.target.value)}
                data-testid="billing-accountType"
              >
                <option value="">Not set</option>
                <option value="residential">Residential</option>
                <option value="commercial">Commercial</option>
              </select>
            </div>
          </div>
        </div>

        <Button size="sm" onClick={submit} disabled={!dirty || saving} data-testid="billing-save">
          {saving ? 'Saving...' : 'Save'}
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * Where the controller and valve boxes are. Adam asked for this so a crew at an
 * unfamiliar house is not walking the property looking for a timer, so it lives
 * in propertyData: that whole map is already carried onto the job card, which is
 * the only client information a contractor can see.
 */
const TIMER_LOCATION_LABEL = 'Sprinkler Timer & Valve Locations';

/**
 * Custom fields — Turf sqft, Sprinkler Zones, Gate Code, Dog. The defined
 * fields (the same list the estimate builder and the rate matrix read) come
 * first with the right kind of box, so "Turf Sqft" is typed once, spelled one
 * way, and the matrix can price from it. Anything else is a free label/value
 * pair for the one-offs.
 */
function ClientProperties({ client }: { client: Client }) {
  // Saved property details, keyed by estimate field label. Estimates prefill
  // from these values and can write corrected values back on save.
  const saved = (client.propertyData ?? {}) as Record<string, string>;
  const { data: fields } = useListEstimateFields();
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const { save: saveClient, saving } = useSaveClient(client, 'Custom fields saved');

  const defined = useMemo(
    () => (fields ?? []).filter(f => f.label !== TIMER_LOCATION_LABEL).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id),
    [fields],
  );
  const definedLabels = new Set(defined.map(f => f.label));
  const timerLocation = saved[TIMER_LOCATION_LABEL];
  const otherSaved = Object.entries(saved).filter(([label]) => label !== TIMER_LOCATION_LABEL && !definedLabels.has(label));

  const save = (next: Record<string, string>) => {
    // The whole map goes every time: property_data is one JSON document and the
    // PATCH replaces it, which is also the only way a removed detail stays gone.
    const cleaned = Object.fromEntries(
      Object.entries(next).filter(([label, value]) => label.trim() !== '' && value.trim() !== ''),
    );
    saveClient({ propertyData: cleaned }, {
      onSuccess: () => { setDraft(null); setNewLabel(''); },
    });
  };

  const setValue = (label: string, value: string) => setDraft(prev => ({ ...(prev ?? {}), [label]: value }));
  const dropKey = (label: string) => setDraft(prev => prev && Object.fromEntries(Object.entries(prev).filter(([key]) => key !== label)));

  return (
    <Card className="shadow-sm border-border">
      <CardHeader className="pb-3 border-b bg-card/50">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg font-bold flex items-center gap-2">
            <Settings className="w-5 h-5 text-muted-foreground" />
            Custom fields
          </CardTitle>
          {draft === null && (
            <Button size="sm" variant="outline" className="h-8" onClick={() => setDraft({ ...saved })} data-testid="custom-edit">
              Edit
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-4 space-y-4">
        {draft !== null ? (
          <div className="space-y-3">
            {defined.length > 0 && (
              <div className="grid gap-3 sm:grid-cols-2">
                {defined.map(field => (
                  <div key={field.id}>
                    <label className="text-xs font-semibold text-muted-foreground uppercase mb-1 block">{field.label}</label>
                    {field.fieldType === 'boolean' ? (
                      <select className={selectClass} value={draft[field.label] ?? ''} onChange={e => setValue(field.label, e.target.value)} data-testid={`custom-${field.label}`}>
                        <option value="">Not set</option>
                        <option value="Yes">Yes</option>
                        <option value="No">No</option>
                      </select>
                    ) : field.fieldType === 'text' ? (
                      <Input value={draft[field.label] ?? ''} onChange={e => setValue(field.label, e.target.value)} data-testid={`custom-${field.label}`} />
                    ) : (
                      <Input type="number" step="any" value={draft[field.label] ?? ''} onChange={e => setValue(field.label, e.target.value)} data-testid={`custom-${field.label}`} />
                    )}
                  </div>
                ))}
              </div>
            )}

            <div>
              <label className="text-xs font-semibold text-muted-foreground uppercase mb-1 flex items-center gap-1.5">
                <Timer className="w-3.5 h-3.5" /> Timer & valve locations
              </label>
              <textarea
                className="flex min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                placeholder="Timer in the garage on the north wall by the freezer. Valve boxes: one behind the shed, one in the flower bed left of the driveway."
                value={draft[TIMER_LOCATION_LABEL] ?? ''}
                onChange={(e) => setValue(TIMER_LOCATION_LABEL, e.target.value)}
                data-testid="custom-timer"
              />
            </div>

            {Object.entries(draft)
              .filter(([label]) => label !== TIMER_LOCATION_LABEL && !definedLabels.has(label))
              .map(([label, value]) => (
                <div key={label}>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-semibold text-muted-foreground uppercase">{label}</label>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={`Remove ${label}`}
                      onClick={() => dropKey(label)}
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <Input value={value} onChange={(e) => setValue(label, e.target.value)} data-testid={`custom-${label}`} />
                </div>
              ))}

            <div className="flex gap-2 pt-1">
              <Input
                placeholder="Another field, e.g. Gate Code"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                data-testid="custom-new-label"
              />
              <Button
                type="button"
                variant="outline"
                disabled={!newLabel.trim() || newLabel.trim() in draft}
                onClick={() => { setValue(newLabel.trim(), ''); setNewLabel(''); }}
                data-testid="custom-new-add"
              >
                <Plus className="w-4 h-4" />
              </Button>
            </div>

            <div className="flex gap-2 pt-1">
              <Button size="sm" onClick={() => save(draft)} disabled={saving} data-testid="custom-save">
                {saving ? 'Saving...' : 'Save'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => { setDraft(null); setNewLabel(''); }}>Cancel</Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Fields left blank are removed on save. Everything here shows on the crew's job card, and the
              rate matrix prices from the sqft fields.
            </p>
          </div>
        ) : (
          <>
            {defined.length > 0 && (
              <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2" data-testid="custom-defined">
                {defined.map(field => (
                  <div key={field.id} className="flex items-baseline justify-between gap-3 border-b border-dashed py-1 text-sm">
                    <span className="text-xs font-semibold text-muted-foreground uppercase">{field.label}</span>
                    <span className={saved[field.label] ? 'font-medium' : 'text-muted-foreground/60'}>{saved[field.label] ?? '—'}</span>
                  </div>
                ))}
              </div>
            )}

            <div>
              <span className="text-xs font-semibold text-muted-foreground uppercase flex items-center gap-1.5">
                <Timer className="w-3.5 h-3.5" /> Timer & Valve Locations
              </span>
              {timerLocation ? (
                <p className="text-sm whitespace-pre-wrap bg-muted/50 border p-2 rounded-md mt-1">{timerLocation}</p>
              ) : (
                <div className="mt-1">
                  <p className="text-sm text-muted-foreground mb-2">
                    Not recorded. Describe where the timer and valve boxes are so the crew is not hunting for them.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDraft({ ...saved, [TIMER_LOCATION_LABEL]: '' })}
                  >
                    <Plus className="w-4 h-4 mr-1" /> Add timer & valve locations
                  </Button>
                </div>
              )}
            </div>

            {otherSaved.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {otherSaved.map(([label, value]) => (
                  <div key={label} className="bg-muted px-2.5 py-1 rounded-md text-xs border">
                    <span className="font-semibold text-muted-foreground mr-1">{label}:</span>
                    {value}
                  </div>
                ))}
              </div>
            )}
            {defined.length === 0 && otherSaved.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Nothing saved yet. Use Edit above, or build an estimate for this client and keep “Save these field values” checked to record them here.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ClientEstimates({ clientId }: { clientId: number }) {
  const { data: estimates, isLoading, isError } = useListEstimates({ clientId });
  return (
    <Card className="shadow-sm border-border">
      <CardHeader className="pb-3 border-b bg-card/50">
        <CardTitle className="text-lg font-bold flex items-center gap-2">
          <FileText className="w-5 h-5 text-muted-foreground" /> Estimates
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="p-6 text-center text-muted-foreground animate-pulse">Loading estimates...</div>
        ) : isError ? (
          <div className="p-6 text-center text-destructive">Estimates could not be loaded.</div>
        ) : !estimates?.length ? (
          <div className="p-6 text-center text-muted-foreground">No estimates for this client.</div>
        ) : (
          <div className="divide-y">
            {estimates.map(estimate => (
              <Link key={estimate.id} href={`/estimates?clientId=${clientId}&estimateId=${estimate.id}`} className="flex items-center justify-between p-4 hover:bg-muted/30">
                <div><p className="font-medium">Estimate #{estimate.id}</p><p className="text-xs text-muted-foreground">{format(new Date(estimate.createdAt), 'MMM d, yyyy')}</p></div>
                <div className="text-right"><p className="font-bold">${estimate.total.toFixed(2)}</p><p className="text-xs capitalize text-muted-foreground">{estimate.status}</p></div>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ClientAudit({ clientId }: { clientId: number }) {
  const [open, setOpen] = useState(false);
  const { data: audit, isLoading } = useListClientAudit(clientId, { query: { enabled: open, queryKey: [`/api/clients/${clientId}/audit`] } });

  return (
    <Card className="shadow-sm border-border">
      <CardHeader className="pb-3 border-b bg-card/50 cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => setOpen(!open)}>
        <CardTitle className="text-sm font-bold flex items-center justify-between text-muted-foreground">
          <span>Audit Trail (History)</span>
          <span className="text-xs font-normal">{open ? 'Hide' : 'Show'}</span>
        </CardTitle>
      </CardHeader>
      {open && (
        <CardContent className="p-4">
          {isLoading ? <div className="text-xs animate-pulse">Loading history...</div> :
           !audit?.length ? <div className="text-xs">No history found.</div> :
           <div className="space-y-3">
             {audit.map(a => (
               <div key={a.id} className="text-sm flex gap-4">
                 <span className="w-32 shrink-0 text-xs text-muted-foreground font-medium">{format(new Date(a.createdAt), 'MM/dd/yy h:mm a')}</span>
                 <div>
                   <span className="font-semibold text-foreground mr-2">{a.action}</span>
                   <span className="text-muted-foreground">{a.description}</span>
                 </div>
               </div>
             ))}
           </div>
          }
        </CardContent>
      )}
    </Card>
  );
}
