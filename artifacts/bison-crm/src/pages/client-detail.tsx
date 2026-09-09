import { useState, useRef, useEffect } from 'react';
import { useRoute } from 'wouter';
import { 
  useGetClient, 
  useUpdateClient, 
  useDeleteClient,
  useListClientNotes,
  useCreateClientNote,
  useListClientAudit,
  useListClientServices,
  useCreateClientService,
  useUpdateClientService,
  useDeleteClientService,
  useListServices,
  useListPackages,
  useCalculateServicePrice,
  useListEstimates,
  useListInvoices,
  useCreateJob,
  useCreateTicket,
  useEmailClient,
  Client
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, MapPin, Phone, Mail, DollarSign, Calendar, FileText,
  Settings, Plus, MessageSquare, Clock, Trash2, Briefcase, ListTodo,
  Droplets, Route, Timer, X, Receipt
} from 'lucide-react';
import { MapCodeBadge, WaterProviderLookupLink } from '@/components/map-code';
import { Link, useLocation } from 'wouter';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { format } from 'date-fns';
import { 
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter 
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';

export default function ClientDetail() {
  const [, params] = useRoute('/clients/:id');
  const id = params?.id ? parseInt(params.id) : 0;
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  const { data: client, isLoading } = useGetClient(id);
  const updateClient = useUpdateClient();

  if (isLoading) return <div className="p-8">Loading client...</div>;
  if (!client) return <div className="p-8">Client not found.</div>;

  const updateStatus = (status: 'lead' | 'client' | 'former_client') => {
    updateClient.mutate({ id, data: { status } }, {
      onSuccess: (data) => {
        queryClient.setQueryData([`/api/clients/${id}`], data);
      }
    });
  };

  return (
    <div className="flex flex-col h-[calc(100vh-2rem)]">
      {/* Header Area */}
      <div className="bg-card border-b px-8 py-6 shadow-sm z-10 shrink-0">
        <div className="max-w-7xl mx-auto">
          <Link href="/clients" className="inline-flex items-center text-sm font-medium text-muted-foreground hover:text-primary mb-4 transition-colors">
            <ArrowLeft className="w-4 h-4 mr-1" /> Back to Clients
          </Link>
          
          <div className="flex flex-col md:flex-row md:items-start justify-between gap-6">
            <div className="space-y-1">
              <div className="flex items-center gap-3">
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
              </div>
              <div className="flex items-center gap-4 text-sm text-muted-foreground pt-1">
                {client.phone && <span className="flex items-center gap-1"><Phone className="w-4 h-4"/> {client.phone}</span>}
                {client.email && <span className="flex items-center gap-1"><Mail className="w-4 h-4"/> {client.email}</span>}
                <span className="flex items-center gap-1"><MapPin className="w-4 h-4"/> {client.serviceAddress}, {client.city}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-4">
                <Button size="sm" onClick={() => setLocation(`/estimates?clientId=${id}&new=1`)}>
                  <FileText className="w-4 h-4 mr-1" /> Create Estimate
                </Button>
                <EmailClientDialog client={client} />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={client.lat == null && client.lng == null && !client.serviceAddress}
                  title={client.lat == null && client.lng == null && !client.serviceAddress ? 'Add a service address or map location first' : undefined}
                  onClick={() => {
                    const destination = client.lat != null && client.lng != null
                      ? `${client.lat},${client.lng}`
                      : [client.serviceAddress, client.city].filter(Boolean).join(', ');
                    window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(destination)}`, '_blank', 'noopener,noreferrer');
                  }}
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
                <p className={`text-3xl font-bold mt-1 whitespace-nowrap ${client.accountBalance > 0 ? 'text-destructive' : client.accountBalance < 0 ? 'text-primary' : 'text-foreground'}`}>
                  ${client.accountBalance.toLocaleString(undefined, {minimumFractionDigits: 2})}
                </p>
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
        <div className="max-w-7xl mx-auto mb-8">
          <ClientOfficeNote client={client} />
        </div>
        <div className="max-w-7xl mx-auto grid grid-cols-1 xl:grid-cols-3 gap-8">
          
          <div className="xl:col-span-2 space-y-8">
            <ClientServices clientId={id} />
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <ClientEstimates clientId={id} />
              <ClientInvoices clientId={id} />
            </div>

            <ClientAudit clientId={id} />
          </div>

          <div className="space-y-8">
            <ClientBilling client={client} />
            <ClientRouting client={client} />
            <ClientProperties client={client} />
            <ClientNotes clientId={id} />
          </div>
          
        </div>
      </div>
    </div>
  );
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
 */
function EmailClientDialog({ client }: { client: Client }) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [to, setTo] = useState(client.email ?? '');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [showCopies, setShowCopies] = useState(false);
  const emailClient = useEmailClient();
  const { toast } = useToast();

  // Typed as "a@b.com, c@d.com" and sent as a list.
  const splitAddresses = (value: string) =>
    value.split(/[,;]/).map(a => a.trim()).filter(Boolean);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
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
        setSubject('');
        setBody('');
        setCc('');
        setBcc('');
        setShowCopies(false);
        setOpen(false);
      },
      onError: (error) => toast({
        title: 'Email could not be sent',
        description: error instanceof Error ? error.message : 'Please try again.',
        variant: 'destructive',
      }),
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Mail className="w-4 h-4 mr-1" /> Send Email
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Email {client.name}</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="space-y-4">
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
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={emailClient.isPending || !to.trim() || !subject.trim() || !body.trim()}>
              {emailClient.isPending ? 'Sending...' : 'Send Email'}
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
            <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={serviceId} onChange={e => setServiceId(e.target.value)}>
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

function ClientRouting({ client }: { client: Client }) {
  const [mapCode, setMapCode] = useState(client.mapCode ?? '');
  const [waterDistrict, setWaterDistrict] = useState(client.waterDistrict ?? '');
  const updateClient = useUpdateClient();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const dirty = (client.mapCode ?? '') !== mapCode || (client.waterDistrict ?? '') !== waterDistrict;

  const save = () => {
    updateClient.mutate({
      id: client.id,
      // Blank clears the field rather than storing "", so an unknown district
      // never reads as a real answer on the list or in a district filter.
      data: {
        mapCode: mapCode.trim().toUpperCase() || null,
        waterDistrict: waterDistrict.trim() || null,
      },
    }, {
      onSuccess: (data) => {
        queryClient.setQueryData([`/api/clients/${client.id}`], data);
        queryClient.invalidateQueries({ queryKey: ['/api/clients'] });
        toast({ title: 'Routing details saved' });
      },
      onError: (error) => toast({
        title: 'Routing details could not be saved',
        description: error instanceof Error ? error.message : 'Please try again.',
        variant: 'destructive',
      }),
    });
  };

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
        <Button size="sm" onClick={save} disabled={!dirty || updateClient.isPending}>
          {updateClient.isPending ? 'Saving...' : 'Save'}
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
  const updateClient = useUpdateClient();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const persist = (data: { officeNote?: string | null; tags?: string[] }, message: string) => {
    updateClient.mutate({ id: client.id, data }, {
      onSuccess: (fresh) => {
        queryClient.setQueryData([`/api/clients/${client.id}`], fresh);
        queryClient.invalidateQueries({ queryKey: ['/api/clients'] });
        toast({ title: message });
      },
      onError: (error) => toast({
        title: 'Could not save',
        description: error instanceof Error ? error.message : 'Please try again.',
        variant: 'destructive',
      }),
    });
  };

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
              disabled={updateClient.isPending}
              data-testid="office-note-save"
            >
              {updateClient.isPending ? 'Saving...' : 'Save note'}
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
 */
function ClientBilling({ client }: { client: Client }) {
  const initial = {
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
  };
  type BillingForm = typeof initial;
  const [form, setForm] = useState<BillingForm>(initial);
  const updateClient = useUpdateClient();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const set = (key: keyof BillingForm, value: string) =>
    setForm(current => ({ ...current, [key]: value }));

  const dirty = (Object.keys(initial) as (keyof BillingForm)[]).some(k => initial[k] !== form[k]);

  const save = () => {
    // Blank clears the field rather than storing "": an empty billing city must
    // not read as a real answer when the invoice decides which address to print.
    const clean = (v: string) => (v.trim() ? v.trim() : null);
    updateClient.mutate({
      id: client.id,
      data: {
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
      },
    }, {
      onSuccess: (data) => {
        queryClient.setQueryData([`/api/clients/${client.id}`], data);
        queryClient.invalidateQueries({ queryKey: ['/api/clients'] });
        toast({ title: 'Billing details saved' });
      },
      onError: (error) => toast({
        title: 'Billing details could not be saved',
        description: error instanceof Error ? error.message : 'Please try again.',
        variant: 'destructive',
      }),
    });
  };

  const BillingField = ({ label, name, placeholder, type }: {
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
      <CardContent className="pt-4 space-y-4">
        {/* Single column: this card sits in a ~330px sidebar, and sm:grid-cols-2
            keys off the viewport rather than the container, so on any normal
            screen it split that column in half and every input clipped
            mid-word — "B.S.P.M. 1712 W Durha", "Quoted when they pay". */}
        <div className="grid gap-3">
          <BillingField label="Name on invoice" name="nameOnInvoice" placeholder={client.name} />
          <BillingField label="Account number" name="accountNumber" placeholder="Quoted when they pay" />
        </div>

        <div className="rounded-md border p-3 space-y-3">
          <p className="text-xs text-muted-foreground">
            Bill To address. Leave empty when the bill goes to the property being serviced — fill it
            in only when someone else is billed, such as a property manager or a second home.
          </p>
          <div className="grid gap-3">
            <BillingField label="Address line 1" name="billingAddressLine1" placeholder="Same as service address" />
            <BillingField label="Address line 2" name="billingAddressLine2" />
            <BillingField label="City" name="billingCity" />
            {/* State and ZIP are genuinely short, so they keep sharing a row. */}
            <div className="grid grid-cols-2 gap-3">
              <BillingField label="State" name="billingState" />
              <BillingField label="ZIP" name="billingPostalCode" />
            </div>
          </div>
        </div>

        <div className="grid gap-3">
          <BillingField
            label="Invoice email"
            name="billingEmail"
            type="email"
            placeholder={client.email ?? 'Falls back to their contact email'}
          />
          <BillingField label="Terms" name="billingTerms" placeholder="e.g. Net 15, Net 30, Due on receipt" />
          <BillingField label="How often invoiced" name="invoiceFrequency" placeholder="e.g. Monthly, Per service" />
          <div>
            <label className="text-xs font-semibold text-muted-foreground uppercase mb-1 block">Send invoice by</label>
            <select
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={form.invoiceDelivery}
              onChange={e => set('invoiceDelivery', e.target.value)}
              data-testid="billing-invoiceDelivery"
            >
              <option value="">Not set</option>
              <option value="email">Email</option>
              <option value="print">Print</option>
              <option value="both">Both</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold text-muted-foreground uppercase mb-1 block">Account type</label>
            <select
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
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

        <Button size="sm" onClick={save} disabled={!dirty || updateClient.isPending} data-testid="billing-save">
          {updateClient.isPending ? 'Saving...' : 'Save'}
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

function ClientProperties({ client }: { client: Client }) {
  // Saved property details, keyed by estimate field label. Estimates prefill
  // from these values and can write corrected values back on save.
  const saved = (client.propertyData ?? {}) as Record<string, string>;
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const updateClient = useUpdateClient();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const timerLocation = saved[TIMER_LOCATION_LABEL];
  const otherProperties = Object.entries(saved).filter(([label]) => label !== TIMER_LOCATION_LABEL);

  const save = (next: Record<string, string>) => {
    // The whole map goes every time: property_data is one JSON document and the
    // PATCH replaces it, which is also the only way a removed detail stays gone.
    const cleaned = Object.fromEntries(
      Object.entries(next).filter(([label, value]) => label.trim() !== '' && value.trim() !== ''),
    );
    updateClient.mutate({ id: client.id, data: { propertyData: cleaned } }, {
      onSuccess: (data) => {
        queryClient.setQueryData([`/api/clients/${client.id}`], data);
        queryClient.invalidateQueries({ queryKey: [`/api/clients/${client.id}/audit`] });
        setDraft(null);
        setNewLabel('');
        toast({ title: 'Property details saved' });
      },
      onError: (error) => toast({
        title: 'Property details could not be saved',
        description: error instanceof Error ? error.message : 'Please try again.',
        variant: 'destructive',
      }),
    });
  };

  return (
    <Card className="shadow-sm border-border">
      <CardHeader className="pb-3 border-b bg-card/50">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg font-bold flex items-center gap-2">
            <Settings className="w-5 h-5 text-muted-foreground" />
            Property Details
          </CardTitle>
          {draft === null && (
            <Button size="sm" variant="outline" className="h-8" onClick={() => setDraft({ ...saved })}>
              Edit
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-4 space-y-4">
        {client.mapNote && (
          <div>
            <span className="text-xs font-semibold text-muted-foreground uppercase">Map / Contractor Note</span>
            <p className="text-sm font-medium bg-accent/10 border border-accent/20 p-2 rounded-md mt-1 text-accent-foreground">
              {client.mapNote}
            </p>
          </div>
        )}

        {draft !== null ? (
          <div className="space-y-3">
            {Object.keys(draft).length === 0 && (
              <p className="text-sm text-muted-foreground">Add a detail below.</p>
            )}
            {Object.entries(draft).map(([label, value]) => (
              <div key={label}>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-semibold text-muted-foreground uppercase">{label}</label>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={`Remove ${label}`}
                    onClick={() => setDraft((prev) => prev && Object.fromEntries(
                      Object.entries(prev).filter(([key]) => key !== label),
                    ))}
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                {label === TIMER_LOCATION_LABEL ? (
                  <textarea
                    className="flex min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    placeholder="Timer in the garage on the north wall by the freezer. Valve boxes: one behind the shed, one in the flower bed left of the driveway."
                    value={value}
                    onChange={(e) => setDraft({ ...draft, [label]: e.target.value })}
                  />
                ) : (
                  <Input value={value} onChange={(e) => setDraft({ ...draft, [label]: e.target.value })} />
                )}
              </div>
            ))}

            <div className="flex gap-2 pt-1">
              <Input
                placeholder="New detail label, e.g. Gate Code"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                disabled={!newLabel.trim() || newLabel.trim() in draft}
                onClick={() => { setDraft({ ...draft, [newLabel.trim()]: '' }); setNewLabel(''); }}
              >
                <Plus className="w-4 h-4" />
              </Button>
            </div>

            <div className="flex gap-2 pt-1">
              <Button size="sm" onClick={() => save(draft)} disabled={updateClient.isPending}>
                {updateClient.isPending ? 'Saving...' : 'Save Details'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => { setDraft(null); setNewLabel(''); }}>Cancel</Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Details left blank are removed on save. Everything here shows on the crew's job card.
            </p>
          </div>
        ) : (
          <>
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

            {otherProperties.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No other property details saved yet. Use Edit above, or build an estimate for this client and keep “Save these field values” checked to record them here.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {otherProperties.map(([label, value]) => (
                  <div key={label} className="bg-muted px-2.5 py-1 rounded-md text-xs border">
                    <span className="font-semibold text-muted-foreground mr-1">{label}:</span>
                    {value}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ClientNotes({ clientId }: { clientId: number }) {
  const { data: notes, isLoading } = useListClientNotes(clientId);
  const createNote = useCreateClientNote();
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    createNote.mutate({ id: clientId, data: { body } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: [`/api/clients/${clientId}/notes`] });
        setBody("");
      }
    });
  };

  return (
    <Card className="shadow-sm border-border flex flex-col h-[500px]">
      <CardHeader className="pb-3 border-b bg-card/50">
        <CardTitle className="text-lg font-bold flex items-center gap-2">
          <MessageSquare className="w-5 h-5 text-muted-foreground" /> 
          Notes Timeline
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto p-4 space-y-4">
        {isLoading ? <div className="text-sm text-muted-foreground animate-pulse">Loading notes...</div> : 
         !notes?.length ? <div className="text-sm text-muted-foreground text-center py-4">No notes yet.</div> :
         notes.map(note => (
          <div key={note.id} className="bg-muted/30 border p-3 rounded-lg">
            <div className="flex items-center justify-between mb-1 text-xs">
              <span className="font-semibold text-foreground">{note.authorName}</span>
              <span className="text-muted-foreground">{format(new Date(note.createdAt), 'MMM d, h:mm a')}</span>
            </div>
            <p className="text-sm whitespace-pre-wrap">{note.body}</p>
          </div>
        ))}
      </CardContent>
      <div className="p-4 border-t bg-card/50 mt-auto">
        <form onSubmit={handleSubmit} className="flex gap-2">
          <Input 
            placeholder="Add a note..." 
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="flex-1"
          />
          <Button type="submit" disabled={!body.trim() || createNote.isPending}>Add</Button>
        </form>
      </div>
    </Card>
  );
}

function ClientServices({ clientId }: { clientId: number }) {
  const { data: services, isLoading } = useListClientServices(clientId);
  const deleteService = useDeleteClientService();
  const queryClient = useQueryClient();

  return (
    <Card className="shadow-sm border-border">
      <CardHeader className="pb-3 border-b bg-card/50">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg font-bold flex items-center gap-2">
            <Calendar className="w-5 h-5 text-muted-foreground" /> 
            Active Services & Subscriptions
          </CardTitle>
          <AddServiceDialog clientId={clientId} />
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? <div className="p-6 text-center text-muted-foreground animate-pulse">Loading...</div> : 
         !services?.length ? <div className="p-6 text-center text-muted-foreground">No active services.</div> :
         <div className="divide-y">
           {services.map(s => (
             <div key={s.id} className="p-4 hover:bg-muted/30 transition-colors flex items-center justify-between group">
               <div>
                 <h4 className="font-bold text-foreground">{s.serviceName || s.packageName}</h4>
                 <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
                   <span className="font-medium text-foreground">${s.amount.toLocaleString(undefined, {minimumFractionDigits:2})}</span>
                   {s.scheduleType === 'recurring' ? (
                     <span className="flex items-center gap-1"><Clock className="w-3 h-3"/> Every {s.frequencyWeeks} week(s)</span>
                   ) : (
                     <span className="flex items-center gap-1"><Calendar className="w-3 h-3"/> Window: {s.startDate} to {s.endDate}</span>
                   )}
                 </div>
               </div>
               <Button 
                 variant="ghost" 
                 size="icon" 
                 className="text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                 onClick={() => {
                   if(confirm('Remove this service?')) {
                     deleteService.mutate({ id: s.id }, {
                       onSuccess: () => queryClient.invalidateQueries({ queryKey: [`/api/clients/${clientId}/client-services`] })
                     });
                   }
                 }}
               >
                 <Trash2 className="w-4 h-4" />
               </Button>
             </div>
           ))}
         </div>
        }
      </CardContent>
    </Card>
  );
}

function AddServiceDialog({ clientId }: { clientId: number }) {
  const [open, setOpen] = useState(false);
  const { data: services } = useListServices();
  const { data: packages } = useListPackages();
  const createService = useCreateClientService();
  const calculatePrice = useCalculateServicePrice();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [type, setType] = useState<'service'|'package'>('service');
  const [itemId, setItemId] = useState<string>('');
  const [sqft, setSqft] = useState<number>(0);
  const [priceOverride, setPriceOverride] = useState<string>('');
  const [scheduleType, setScheduleType] = useState<'window'|'recurring'|'one_time'>('recurring');
  const [firstServiceDate, setFirstServiceDate] = useState('');
  const [frequencyWeeks, setFrequencyWeeks] = useState('1');
  const [seasonEndDate, setSeasonEndDate] = useState('');
  const [windowStart, setWindowStart] = useState('');
  const [windowEnd, setWindowEnd] = useState('');

  const [livePrice, setLivePrice] = useState<number|null>(null);

  const selectItem = (value: string) => {
    setItemId(value);
    if (type !== 'package') return;
    const selected = packages?.find(pkg => String(pkg.id) === value);
    if (!selected) return;
    if (selected.scheduleType === 'window' || selected.scheduleType === 'recurring' || selected.scheduleType === 'one_time') {
      setScheduleType(selected.scheduleType);
    }
    setWindowStart(selected.startDate ?? '');
    setWindowEnd(selected.endDate ?? '');
    setFirstServiceDate(selected.startDate ?? '');
    setFrequencyWeeks(selected.frequencyWeeks ? String(selected.frequencyWeeks) : '1');
    setSeasonEndDate(selected.seasonEndDate ?? '');
  };

  // Live price effect
  useEffect(() => {
    if (type === 'service' && itemId && sqft > 0) {
      calculatePrice.mutate({ id: parseInt(itemId), data: { sqft } }, {
        onSuccess: (data) => setLivePrice(data.price)
      });
    } else {
      setLivePrice(null);
    }
  }, [type, itemId, sqft]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const finalPrice = priceOverride ? parseFloat(priceOverride) : livePrice;
    
    const payload: any = {
      scheduleType,
      ...(finalPrice != null ? { amount: finalPrice } : {}),
      ...(type === 'service' ? { serviceId: parseInt(itemId) } : { packageId: parseInt(itemId) }),
      ...(scheduleType === 'recurring' ? {
        frequencyWeeks: parseInt(frequencyWeeks),
        firstServiceDate,
        seasonEndDate: seasonEndDate || null,
      } : scheduleType === 'window' ? {
        startDate: windowStart,
        endDate: windowEnd,
      } : {
        firstServiceDate: firstServiceDate || null,
      })
    };

    createService.mutate({ id: clientId, data: payload }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: [`/api/clients/${clientId}/client-services`] });
        toast({ title: 'Service assigned' });
        setOpen(false);
      },
      onError: (error) => toast({
        title: 'Service could not be assigned',
        description: error instanceof Error ? error.message : 'Check the schedule and try again.',
        variant: 'destructive',
      }),
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="h-8 bg-primary text-primary-foreground hover:bg-primary/90">
          <Plus className="w-4 h-4 mr-1" /> Assign Service
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign Service or Package</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-4">
          
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Type</label>
              <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none" value={type} onChange={(e) => {setType(e.target.value as any); setItemId('');}}>
                <option value="service">Single Service</option>
                <option value="package">Package / Bundle</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Item</label>
              <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none" value={itemId} onChange={(e) => selectItem(e.target.value)} required>
                <option value="">Select...</option>
                {type === 'service' 
                  ? services?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)
                  : packages?.map(p => <option key={p.id} value={p.id}>{p.name}</option>)
                }
              </select>
            </div>
          </div>

          {scheduleType === 'recurring' ? (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="text-sm font-medium mb-1 block">First Service Date</label>
                <Input type="date" value={firstServiceDate} onChange={e => setFirstServiceDate(e.target.value)} required />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Frequency (weeks)</label>
                <Input type="number" min="1" step="1" value={frequencyWeeks} onChange={e => setFrequencyWeeks(e.target.value)} required />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Season End Date</label>
                <Input type="date" value={seasonEndDate} onChange={e => setSeasonEndDate(e.target.value)} />
              </div>
            </div>
          ) : scheduleType === 'window' ? (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium mb-1 block">Window Start</label>
                <Input type="date" value={windowStart} onChange={e => setWindowStart(e.target.value)} required />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Window End</label>
                <Input type="date" value={windowEnd} onChange={e => setWindowEnd(e.target.value)} required />
              </div>
            </div>
          ) : (
            <div>
              <label className="text-sm font-medium mb-1 block">Service Date (optional)</label>
              <Input type="date" value={firstServiceDate} onChange={e => setFirstServiceDate(e.target.value)} />
            </div>
          )}

          {type === 'service' && itemId && (
            <div className="grid grid-cols-2 gap-4 p-4 bg-muted/50 rounded-lg border">
              <div>
                <label className="text-sm font-medium mb-1 block">Property Sqft</label>
                <Input type="number" value={sqft || ''} onChange={(e) => setSqft(parseInt(e.target.value)||0)} />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Calculated Price</label>
                <div className="h-10 flex items-center px-3 font-bold text-lg bg-background border rounded-md text-primary">
                  {livePrice !== null ? `$${livePrice.toFixed(2)}` : '--'}
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Price Override ($)</label>
              <Input type="number" step="0.01" value={priceOverride} onChange={(e) => setPriceOverride(e.target.value)} placeholder="Leave blank for calc" />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Schedule Type</label>
              <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none" value={scheduleType} onChange={(e) => setScheduleType(e.target.value as any)}>
                <option value="recurring">Recurring (Weekly/etc)</option>
                <option value="window">Date Window (One-off)</option>
                <option value="one_time">One-time</option>
              </select>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={!itemId || createService.isPending}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
              <Link key={estimate.id} href="/estimates" className="flex items-center justify-between p-4 hover:bg-muted/30">
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

function ClientInvoices({ clientId }: { clientId: number }) {
  const { data: invoices, isLoading, isError } = useListInvoices({ clientId });
  return (
    <Card className="shadow-sm border-border">
      <CardHeader className="pb-3 border-b bg-card/50">
        <CardTitle className="text-lg font-bold flex items-center gap-2">
          <DollarSign className="w-5 h-5 text-muted-foreground" /> Invoices
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="p-6 text-center text-muted-foreground animate-pulse">Loading invoices...</div>
        ) : isError ? (
          <div className="p-6 text-center text-destructive">Invoices could not be loaded.</div>
        ) : !invoices?.length ? (
          <div className="p-6 text-center text-muted-foreground">No invoices for this client.</div>
        ) : (
          <div className="divide-y">
            {invoices.map(invoice => (
              <Link key={invoice.id} href={`/invoices?clientId=${clientId}`} className="flex items-center justify-between p-4 hover:bg-muted/30">
                <div><p className="font-medium">Invoice #{invoice.id}</p><p className="text-xs text-muted-foreground">{format(new Date(invoice.createdAt), 'MMM d, yyyy')}</p></div>
                <div className="text-right"><p className="font-bold">${invoice.total.toFixed(2)}</p><p className="text-xs capitalize text-muted-foreground">{invoice.status}</p></div>
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
  const { data: audit, isLoading } = useListClientAudit(clientId, { query: { enabled: open, queryKey: ['/api/clients', clientId, 'audit'] } });

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
