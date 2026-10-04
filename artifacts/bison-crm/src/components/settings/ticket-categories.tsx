import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useListTicketCategories,
  getListTicketCategoriesQueryKey,
  useCreateTicketCategory,
  useUpdateTicketCategory,
  useDeleteTicketCategory,
  type TicketCategory,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { Plus, Tags, Trash2 } from 'lucide-react';

/**
 * His ticket categories: "Account Issue, Billing, Cancel Request, Change
 * Service, Email, Estimate, other, Reschedule request, Review, Schedule
 * Service, Terminate service, Upsell, Marketing."
 *
 * Shipped with exactly that list and editable, because he asked to add his
 * own. The order is his, not alphabetical — it is the order he thinks about
 * them in, and the list is short enough to read.
 */

const errText = (e: unknown, fallback: string) => {
  const err = e as { data?: { error?: string }; message?: string } | null;
  return err?.data?.error || err?.message || fallback;
};

function CategoryRow({ category }: { category: TicketCategory }) {
  const update = useUpdateTicketCategory();
  const remove = useDeleteTicketCategory();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState(category.name);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['/api/ticket-categories'] });
  const fail = (e: unknown) => toast({ title: 'Could not save the category', description: errText(e, ''), variant: 'destructive' });
  const dirty = name.trim() !== category.name && name.trim() !== '';

  const rename = () => {
    update.mutate({ id: category.id, data: { name: name.trim() } }, {
      onSuccess: () => {
        refresh();
        // A rename moves the tickets onto the new name, so say so: he needs to
        // know his filters did not just lose 12 tickets.
        if (category.ticketCount) {
          toast({ title: 'Category renamed', description: `${category.ticketCount} ticket${category.ticketCount === 1 ? '' : 's'} moved onto "${name.trim()}".` });
        }
      },
      onError: fail,
    });
  };

  return (
    <div className="flex items-center gap-2 py-2" data-testid={`ticket-category-row-${category.id}`}>
      <Input
        className={`h-9 flex-1 ${category.active ? '' : 'text-muted-foreground line-through'}`}
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && dirty) rename(); }}
      />
      <span className="w-28 shrink-0 text-xs text-muted-foreground">
        {category.ticketCount === 0 ? 'no tickets' : `${category.ticketCount} ticket${category.ticketCount === 1 ? '' : 's'}`}
      </span>
      <label className="flex w-28 shrink-0 items-center gap-2 text-xs" title="Off keeps the tickets but stops offering it on new ones">
        <Switch
          checked={category.active}
          onCheckedChange={v => update.mutate({ id: category.id, data: { active: v } }, { onSuccess: refresh, onError: fail })}
        />
        in use
      </label>
      {dirty && <Button size="sm" className="h-8" onClick={rename} disabled={update.isPending}>Save</Button>}
      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
        aria-label={`Delete ${category.name}`}
        onClick={() => {
          const warning = category.ticketCount
            ? `Take "${category.name}" off the list? The ${category.ticketCount} ticket${category.ticketCount === 1 ? '' : 's'} already filed under it keep the name.`
            : `Take "${category.name}" off the list?`;
          if (!window.confirm(warning)) return;
          remove.mutate({ id: category.id }, { onSuccess: refresh, onError: fail });
        }}
      >
        <Trash2 className="w-4 h-4" />
      </Button>
    </div>
  );
}

export default function TicketCategories() {
  // includeInactive: this is the screen where he turns one back on, so the
  // ones he has switched off have to be visible here even though the pickers
  // on the board no longer offer them.
  const { data: categories, isLoading } = useListTicketCategories(
    { includeInactive: 'true' },
    { query: { queryKey: getListTicketCategoriesQueryKey({ includeInactive: 'true' }) } },
  );
  const create = useCreateTicketCategory();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [draft, setDraft] = useState('');

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    create.mutate({ data: { name: draft.trim() } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['/api/ticket-categories'] });
        setDraft('');
      },
      onError: (err) => toast({ title: 'Could not add the category', description: errText(err, ''), variant: 'destructive' }),
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Tags className="w-5 h-5 text-muted-foreground" /> Ticket categories</CardTitle>
        <CardDescription>
          What a ticket is about, so you can pull up every billing question or every cancel request at once.
          Add your own at the bottom. Renaming one moves the tickets already filed under it; deleting one leaves them alone.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground animate-pulse">Loading…</p>
        ) : !categories?.length ? (
          <p className="text-sm text-muted-foreground">Nothing on the list yet.</p>
        ) : (
          <div className="divide-y" data-testid="ticket-category-list">
            {categories.map(c => <CategoryRow key={c.id} category={c} />)}
          </div>
        )}
        <form onSubmit={add} className="flex items-end gap-2 rounded-lg border bg-muted/30 p-3">
          <div className="flex-1">
            <Label className="text-xs">New category</Label>
            <Input
              className="h-9"
              placeholder="Backflow test"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              data-testid="ticket-category-new"
              required
            />
          </div>
          <Button type="submit" size="sm" className="h-9" disabled={create.isPending || !draft.trim()}>
            <Plus className="w-4 h-4" />
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
