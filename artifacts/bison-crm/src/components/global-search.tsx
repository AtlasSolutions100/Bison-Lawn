import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  useGlobalSearch,
  getGlobalSearchQueryKey,
  useCreateClient,
  type SearchResults,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { useToast } from '@/hooks/use-toast';
import { canOpen, useMe } from '@/lib/access';
import { Briefcase, Receipt, Search, Ticket, User, UserPlus, Wallet } from 'lucide-react';

const money = (v: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v);

const STATUS_LABEL: Record<string, string> = { lead: 'Lead', client: 'Active', former_client: 'Former' };

/** True when the key press landed in something that takes typing. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * 2026-09-15 walkthrough: "a global search box that searches clients, former
 * clients, tickets, invoices, payments at once", with a quick-add for a new
 * customer or lead beside it. One dialog from any screen: press "/" (or
 * Ctrl+K), type, pick a row, land on it. The server does the matching and
 * returns a short list per group, so nothing here filters or ranks.
 *
 * Where a row lands: a customer opens their page; an invoice or payment opens
 * the invoices screen already filtered to that customer (the payment history
 * tab is there); a ticket or a job opens the customer it belongs to, whose
 * page lists both. A ticket with no customer goes to the tickets list.
 */
export default function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [, setLocation] = useLocation();
  const { data: me } = useMe();
  const canAddClient = canOpen(me, 'clients');

  // A quarter second after the last keystroke, not on every one: eight
  // queries on the server for each letter typed is a waste he would notice
  // on a slow day.
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const slash = e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey;
      const ctrlK = e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey);
      if ((slash && !isTyping(e.target)) || ctrlK) {
        e.preventDefault();
        // The layout mounts this twice (the phone header and the desktop bar;
        // only their buttons are hidden by CSS, both components are live), and
        // the dialog is portalled to the body so a hidden one still shows. Two
        // boxes used to open stacked on top of each other, and closing one left
        // the other over the page. Whichever instance sees the key first opens;
        // this stops the sibling listener on window from opening a second.
        e.stopImmediatePropagation();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const enabled = open && q.length >= 2;
  const search = useGlobalSearch(
    { q },
    { query: { enabled, queryKey: getGlobalSearchQueryKey({ q }), staleTime: 10_000, retry: false } },
  );

  const go = (href: string) => {
    setOpen(false);
    setText('');
    setLocation(href);
  };

  const results: SearchResults | undefined = enabled ? search.data : undefined;
  const total = results
    ? results.clients.length + results.jobs.length + results.invoices.length + results.payments.length + results.tickets.length
    : 0;

  return (
    <>
      {/* Icon only in the phone header (dark bar, next to the menu); a labelled
          box with the shortcut on a desktop. Only one shows at a time. */}
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden text-white hover:bg-sidebar-accent"
        onClick={() => setOpen(true)}
        aria-label="Search"
        data-testid="global-search-open-mobile"
      >
        <Search className="h-5 w-5" />
      </Button>
      <Button
        variant="outline"
        className="hidden md:inline-flex w-72 justify-start gap-2 text-muted-foreground font-normal"
        onClick={() => setOpen(true)}
        data-testid="global-search-open"
      >
        <Search className="h-4 w-4" />
        <span className="flex-1 text-left">Search customers, invoices, payments…</span>
        <Kbd>/</Kbd>
      </Button>
      {canAddClient && (
        <Button
          variant="default"
          size="sm"
          className="hidden md:inline-flex"
          onClick={() => setAddOpen(true)}
          data-testid="quick-add-client-open"
        >
          <UserPlus className="mr-2 h-4 w-4" /> New customer
        </Button>
      )}

      <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setText(''); }}>
        <DialogContent className="overflow-hidden p-0 sm:max-w-xl" aria-describedby={undefined}>
          <DialogHeader className="sr-only">
            <DialogTitle>Search</DialogTitle>
          </DialogHeader>
          {/* shouldFilter off: the server already chose the rows, and cmdk's
              own matching would hide an invoice found by its PO number because
              the number is not in the label. */}
          <Command
            shouldFilter={false}
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2.5 [&_[cmdk-item]_svg]:h-4 [&_[cmdk-item]_svg]:w-4"
          >
            <CommandInput
              value={text}
              onValueChange={setText}
              placeholder="Name, address, phone, invoice number, payment amount, ticket…"
              data-testid="global-search-input"
            />
            <CommandList className="max-h-[60vh]">
              {q.length < 2 ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                  Type at least two letters or digits. Former customers are included.
                </p>
              ) : search.isLoading ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">Searching…</p>
              ) : search.isError ? (
                <p className="px-4 py-6 text-center text-sm text-destructive">
                  {search.error instanceof Error ? search.error.message : 'Search failed.'}
                </p>
              ) : results && total === 0 ? (
                <CommandEmpty>Nothing matches “{q}”.</CommandEmpty>
              ) : results ? (
                <>
                  {results.clients.length > 0 && (
                    <CommandGroup heading="Customers">
                      {results.clients.map(c => (
                        <CommandItem key={`c${c.id}`} value={`client-${c.id}`} onSelect={() => go(`/clients/${c.id}`)} data-testid={`hit-client-${c.id}`}>
                          <User className="text-muted-foreground" />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate font-medium">{c.name}</span>
                              <Badge variant={c.status === 'former_client' ? 'outline' : 'secondary'} className="text-[10px]">
                                {STATUS_LABEL[c.status] ?? c.status}
                              </Badge>
                            </div>
                            <p className="truncate text-xs text-muted-foreground">
                              {[c.serviceAddress, c.city].filter(Boolean).join(', ') || c.phone || c.email || ''}
                            </p>
                          </div>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                  {results.jobs.length > 0 && (
                    <CommandGroup heading="Jobs by address">
                      {results.jobs.map(j => (
                        <CommandItem key={`j${j.id}`} value={`job-${j.id}`} onSelect={() => go(`/clients/${j.clientId}`)} data-testid={`hit-job-${j.id}`}>
                          <Briefcase className="text-muted-foreground" />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate font-medium">{j.serviceName ?? 'Job'} · {j.clientName}</span>
                              <Badge variant="outline" className="text-[10px]">{j.status.replace(/_/g, ' ')}</Badge>
                            </div>
                            <p className="truncate text-xs text-muted-foreground">
                              {j.scheduledDate ?? 'Unscheduled'} · {[j.address, j.city].filter(Boolean).join(', ')}
                            </p>
                          </div>
                          <span className="text-xs tabular-nums text-muted-foreground">{money(j.amount)}</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                  {results.invoices.length > 0 && (
                    <CommandGroup heading="Invoices">
                      {results.invoices.map(i => (
                        <CommandItem key={`i${i.id}`} value={`invoice-${i.id}`} onSelect={() => go(`/invoices?clientId=${i.clientId}`)} data-testid={`hit-invoice-${i.id}`}>
                          <Receipt className="text-muted-foreground" />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate font-medium">Invoice #{i.number} · {i.clientName}</span>
                              <Badge variant="outline" className="text-[10px]">{i.status}</Badge>
                            </div>
                            <p className="truncate text-xs text-muted-foreground">
                              {i.invoiceDate ?? ''}{i.poNumber ? ` · PO ${i.poNumber}` : ''} · {money(i.total)}
                              {i.balance > 0 ? ` · ${money(i.balance)} owed` : ''}
                            </p>
                          </div>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                  {results.payments.length > 0 && (
                    <CommandGroup heading="Payments">
                      {results.payments.map(p => (
                        <CommandItem key={`p${p.id}`} value={`payment-${p.id}`} onSelect={() => go(`/invoices?clientId=${p.clientId}`)} data-testid={`hit-payment-${p.id}`}>
                          <Wallet className="text-muted-foreground" />
                          <div className="min-w-0 flex-1">
                            <span className="truncate font-medium">{money(p.amount)} · {p.clientName}</span>
                            <p className="truncate text-xs text-muted-foreground">
                              {p.createdAt.slice(0, 10)} · {p.method}{p.reference ? ` · ref ${p.reference}` : ''}
                              {p.invoiceId == null ? ' · unapplied' : ''}
                            </p>
                          </div>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                  {results.tickets.length > 0 && (
                    <CommandGroup heading="Tickets">
                      {results.tickets.map(t => (
                        <CommandItem
                          key={`t${t.id}`}
                          value={`ticket-${t.id}`}
                          onSelect={() => go(t.clientId != null ? `/clients/${t.clientId}` : '/tickets')}
                          data-testid={`hit-ticket-${t.id}`}
                        >
                          <Ticket className="text-muted-foreground" />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate font-medium">{t.title}</span>
                              <Badge variant="outline" className="text-[10px]">{t.status}</Badge>
                            </div>
                            <p className="truncate text-xs text-muted-foreground">
                              {t.clientName ?? 'No customer'}{t.dueDate ? ` · due ${t.dueDate}` : ''}
                            </p>
                          </div>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                </>
              ) : null}
              {canAddClient && (
                <>
                  <CommandSeparator />
                  <CommandGroup heading="Actions">
                    <CommandItem value="new-client" onSelect={() => { setOpen(false); setAddOpen(true); }} data-testid="hit-new-client">
                      <UserPlus className="text-muted-foreground" />
                      <span>New customer or lead{text.trim() ? ` “${text.trim()}”` : ''}</span>
                    </CommandItem>
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>

      <QuickAddClient open={addOpen} onOpenChange={setAddOpen} initialName={text.trim()} />
    </>
  );
}

/**
 * The quick-add. Only what he knows when someone rings: a name, how to reach
 * them, where the lawn is, and whether they are a lead or already a customer.
 * Everything else lives on the customer page it opens on save.
 */
function QuickAddClient({
  open,
  onOpenChange,
  initialName,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initialName: string;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [serviceAddress, setServiceAddress] = useState('');
  const [city, setCity] = useState('');
  const [status, setStatus] = useState<'lead' | 'client'>('lead');
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createClient = useCreateClient();

  useEffect(() => {
    if (open) {
      // What was typed in the search box is usually the name that was not found.
      setName(initialName && !/^\d+$/.test(initialName) ? initialName : '');
      setPhone(''); setEmail(''); setServiceAddress(''); setCity(''); setStatus('lead');
    }
  }, [open, initialName]);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    createClient.mutate(
      {
        data: {
          name: trimmed,
          status,
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          ...(email.trim() ? { email: email.trim() } : {}),
          ...(serviceAddress.trim() ? { serviceAddress: serviceAddress.trim() } : {}),
          ...(city.trim() ? { city: city.trim() } : {}),
        },
      },
      {
        onSuccess: (res) => {
          queryClient.invalidateQueries({ queryKey: ['/api/clients'] });
          onOpenChange(false);
          toast({ title: status === 'lead' ? 'Lead added' : 'Customer added', description: trimmed });
          setLocation(`/clients/${res.id}`);
        },
        onError: (err) => {
          toast({ title: 'Could not add them', description: err instanceof Error ? err.message : 'Try again.', variant: 'destructive' });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New customer or lead</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => { e.preventDefault(); submit(); }}
        >
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Name</label>
            <Input value={name} onChange={e => setName(e.target.value)} autoFocus placeholder="Full name or company" data-testid="quick-add-name" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Phone</label>
              <Input value={phone} onChange={e => setPhone(e.target.value)} data-testid="quick-add-phone" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Email</label>
              <Input type="email" value={email} onChange={e => setEmail(e.target.value)} data-testid="quick-add-email" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="mb-1 block text-xs text-muted-foreground">Service address</label>
              <Input value={serviceAddress} onChange={e => setServiceAddress(e.target.value)} data-testid="quick-add-address" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">City</label>
              <Input value={city} onChange={e => setCity(e.target.value)} data-testid="quick-add-city" />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">They are a</label>
            <select
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              value={status}
              onChange={e => setStatus(e.target.value as 'lead' | 'client')}
              data-testid="quick-add-status"
            >
              <option value="lead">Lead (not a customer yet)</option>
              <option value="client">Customer</option>
            </select>
          </div>
          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!name.trim() || createClient.isPending} data-testid="quick-add-save">
              {createClient.isPending ? 'Saving…' : 'Save and open'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
