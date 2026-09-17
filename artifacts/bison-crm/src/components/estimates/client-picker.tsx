import { useMemo, useState } from 'react';
import type { Client } from '@workspace/api-client-react';
import { Check, ChevronsUpDown, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { cn } from '@/lib/utils';

/** The "start a new lead from here" choice, kept out of the id space. */
export const NEW_PROSPECT = '__new_prospect__';

/** How many rows to show before he has typed anything: enough to scroll, not 709. */
const IDLE_ROWS = 25;
const MAX_ROWS = 60;

const digitsOf = (value: string | null | undefined) => (value ?? '').replace(/\D/g, '');

/**
 * Feedback 111: "pick the client by name or address when starting an
 * estimate". One box, and whatever he knows about the customer finds them —
 * the name, the street, the town, or the phone number they called from.
 */
export function clientMatches(client: Client, needle: string): boolean {
  const q = needle.trim().toLowerCase();
  if (!q) return true;
  const words = q.split(/\s+/);
  const haystack = [client.name, client.serviceAddress, client.city, client.email]
    .map(part => (part ?? '').toLowerCase())
    .join(' ');
  const phone = digitsOf(client.phone);
  const qDigits = digitsOf(q);
  if (qDigits.length >= 3 && phone.includes(qDigits)) return true;
  return words.every(word => haystack.includes(word));
}

/** One line that tells two "John Smith"s apart. */
export function clientCaption(client: Client): string {
  return [client.serviceAddress, client.city].map(v => (v ?? '').trim()).filter(Boolean).join(', ');
}

export default function ClientPicker({
  clients,
  value,
  onChange,
  disabled,
}: {
  clients: Client[] | undefined;
  /** A client id as a string, NEW_PROSPECT, or '' for nothing chosen yet. */
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const selected = value && value !== NEW_PROSPECT ? clients?.find(c => String(c.id) === value) : undefined;

  const results = useMemo(() => {
    const all = clients ?? [];
    const matched = query.trim() ? all.filter(c => clientMatches(c, query)) : all;
    return matched.slice(0, query.trim() ? MAX_ROWS : IDLE_ROWS);
  }, [clients, query]);
  const hiddenCount = (query.trim() ? (clients ?? []).filter(c => clientMatches(c, query)).length : (clients ?? []).length) - results.length;

  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
    setQuery('');
  };

  return (
    <Popover open={open} onOpenChange={next => { setOpen(next); if (!next) setQuery(''); }}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between h-auto min-h-10 py-2 font-normal"
        >
          {selected ? (
            <span className="text-left min-w-0">
              <span className="block font-medium truncate">{selected.name}</span>
              {clientCaption(selected) && (
                <span className="block text-xs text-muted-foreground truncate">{clientCaption(selected)}</span>
              )}
            </span>
          ) : value === NEW_PROSPECT ? (
            <span className="flex items-center gap-2"><UserPlus className="w-4 h-4" /> New prospect</span>
          ) : (
            <span className="text-muted-foreground">Pick a customer — type a name, address, city or phone</span>
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) min-w-80 p-0" align="start">
        {/* Filtering is ours (name, address, city, phone), so cmdk's own fuzzy
            match must stay out of the way or "Post Falls" would also surface
            every "Paul". */}
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Name, address, city or phone…"
            value={query}
            onValueChange={setQuery}
            autoFocus
          />
          <CommandList>
            <CommandGroup>
              <CommandItem value={NEW_PROSPECT} onSelect={() => choose(NEW_PROSPECT)}>
                <UserPlus className="w-4 h-4" />
                <span>New prospect…</span>
                <span className="ml-auto text-xs text-muted-foreground">saved as a lead</span>
              </CommandItem>
            </CommandGroup>
            {!clients ? (
              <CommandEmpty>Loading customers…</CommandEmpty>
            ) : results.length === 0 ? (
              <CommandEmpty>No customer matches “{query}”. Try part of the street name, or add them as a new prospect.</CommandEmpty>
            ) : (
              <CommandGroup heading={query.trim() ? `Matches (${results.length}${hiddenCount > 0 ? ` of ${results.length + hiddenCount}` : ''})` : 'Customers'}>
                {results.map(client => (
                  <CommandItem
                    key={client.id}
                    value={String(client.id)}
                    onSelect={() => choose(String(client.id))}
                    className="items-start"
                  >
                    <Check className={cn('mt-0.5 h-4 w-4', String(client.id) === value ? 'opacity-100' : 'opacity-0')} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="font-medium truncate">{client.name}</span>
                        {client.status !== 'client' && (
                          <span className="text-[10px] uppercase tracking-wide text-muted-foreground shrink-0">
                            {client.status === 'lead' ? 'lead' : 'former'}
                          </span>
                        )}
                      </span>
                      <span className="block text-xs text-muted-foreground truncate">
                        {[clientCaption(client), client.phone].filter(Boolean).join(' · ') || 'No address on file'}
                      </span>
                    </span>
                  </CommandItem>
                ))}
                {hiddenCount > 0 && (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    {hiddenCount} more — keep typing to narrow it down.
                  </div>
                )}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
