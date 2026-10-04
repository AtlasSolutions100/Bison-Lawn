import { useState } from 'react';
import { useListTickets, useCreateTicket, useUpdateTicket, useDeleteTicket, useListUsers, useListTicketCategories } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Trash2, Plus, Calendar } from 'lucide-react';
import { format } from 'date-fns';

export default function Tickets() {
  const [status, setStatus] = useState<'open'|'done'|''>('open');
  const [assigneeId, setAssigneeId] = useState('');
  // "Ticket Categories, Account Issue, Billing, Cancel Request, ..." — the
  // reason for putting a category on a ticket is being able to pull up every
  // billing question at once, so the filter is the other half of the feature.
  const [category, setCategory] = useState('');
  
  const queryParams = {
    ...(status && { status: status as any }),
    ...(assigneeId && { assignedTo: parseInt(assigneeId) }),
    ...(category && { category })
  };

  const { data: tickets, isLoading } = useListTickets(queryParams);
  const { data: users } = useListUsers();
  const { data: categories } = useListTicketCategories();
  
  const updateTicket = useUpdateTicket();
  const deleteTicket = useDeleteTicket();
  const queryClient = useQueryClient();

  const handleToggle = (id: number, currentStatus: string) => {
    updateTicket.mutate({ id, data: { status: currentStatus === 'open' ? 'done' : 'open' } }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/tickets'] })
    });
  };

  const handleDelete = (id: number) => {
    if(confirm('Delete ticket?')) {
      deleteTicket.mutate({ id }, {
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/tickets'] })
      });
    }
  };

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6 flex flex-col h-[calc(100vh-2rem)]">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Task Board</h1>
          <p className="text-muted-foreground mt-1">Internal tickets and to-dos.</p>
        </div>
        <NewTicketDialog users={users} />
      </div>

      <div className="flex items-center gap-3 bg-card p-2 rounded-lg border shadow-sm">
        <select className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm w-40" value={status} onChange={e => setStatus(e.target.value as any)}>
          <option value="">All Statuses</option>
          <option value="open">Open</option>
          <option value="done">Done</option>
        </select>
        <select className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm w-40" value={assigneeId} onChange={e => setAssigneeId(e.target.value)}>
          <option value="">All Assignees</option>
          {users?.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <select className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm w-48" value={category} onChange={e => setCategory(e.target.value)} data-testid="ticket-category-filter">
          <option value="">All Categories</option>
          {categories?.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
          <option value="none">No category yet</option>
        </select>
        {category && (
          <Button variant="ghost" size="sm" className="h-9" onClick={() => setCategory('')}>Clear</Button>
        )}
      </div>

      <div className="flex-1 overflow-auto space-y-3 pb-8">
        {isLoading ? (
          <div className="text-muted-foreground animate-pulse p-4">Loading tickets...</div>
        ) : !tickets?.length ? (
          <div className="text-center p-8 bg-card border rounded-lg text-muted-foreground">No tickets found.</div>
        ) : (
          tickets.map(t => (
            <div key={t.id} className={`p-4 bg-card border rounded-lg shadow-sm flex items-start gap-4 transition-colors hover:border-primary/30 ${t.status === 'done' ? 'opacity-60 bg-muted/30' : ''}`}>
              <div className="mt-1">
                <Checkbox checked={t.status === 'done'} onCheckedChange={() => handleToggle(t.id, t.status)} className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <h3 className={`text-lg font-bold ${t.status === 'done' ? 'line-through text-muted-foreground' : 'text-foreground'}`}>{t.title}</h3>
                {t.description && <p className="text-muted-foreground mt-1 text-sm whitespace-pre-wrap">{t.description}</p>}
                
                <div className="flex flex-wrap items-center gap-3 mt-3">
                  {t.category && (
                    <button
                      type="button"
                      className="bg-secondary text-secondary-foreground border px-2 py-0.5 rounded text-xs font-semibold hover:border-primary/40"
                      title={`Show only ${t.category} tickets`}
                      onClick={() => setCategory(t.category!)}
                    >
                      {t.category}
                    </button>
                  )}
                  {t.clientName && (
                    <span className="bg-accent/10 text-accent-foreground border border-accent/20 px-2 py-0.5 rounded text-xs font-semibold">
                      Client: {t.clientName}
                    </span>
                  )}
                  {t.assignedToName && (
                    <span className="bg-primary/10 text-primary border border-primary/20 px-2 py-0.5 rounded text-xs font-semibold">
                      @{t.assignedToName}
                    </span>
                  )}
                  {t.dueDate && (
                    <span className={`flex items-center gap-1 text-xs font-semibold ${new Date(t.dueDate) < new Date() && t.status === 'open' ? 'text-destructive' : 'text-muted-foreground'}`}>
                      <Calendar className="w-3 h-3" /> {t.dueDate}
                    </span>
                  )}
                </div>
              </div>
              <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive shrink-0" onClick={() => handleDelete(t.id)}>
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function NewTicketDialog({ users }: { users: any }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [category, setCategory] = useState('');
  
  const createTicket = useCreateTicket();
  // His own list, not a hard-coded one: a category he adds in Settings turns up
  // here without anybody shipping code.
  const { data: categories } = useListTicketCategories({}, { query: { enabled: open, queryKey: ['/api/ticket-categories'] } });
  const queryClient = useQueryClient();

  const handleSave = () => {
    createTicket.mutate({
      data: {
        title,
        description,
        dueDate: dueDate || undefined,
        assignedToId: assignedTo ? parseInt(assignedTo) : undefined,
        category: category || null
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['/api/tickets'] });
        setOpen(false);
        setTitle('');
        setDescription('');
        setDueDate('');
        setAssignedTo('');
        setCategory('');
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="bg-primary text-primary-foreground font-semibold shadow-sm">
          <Plus className="w-4 h-4 mr-2" /> New Ticket
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Ticket</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div>
            <label className="text-sm font-medium mb-1 block">Title</label>
            <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="What needs to be done?" autoFocus />
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">Description</label>
            <textarea 
              className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm" 
              value={description} onChange={e => setDescription(e.target.value)} 
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">Category</label>
            <select
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={category}
              onChange={e => setCategory(e.target.value)}
              data-testid="ticket-category"
            >
              <option value="">No category</option>
              {categories?.map((c: { id: number; name: string }) => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
            <p className="text-xs text-muted-foreground mt-1">Add to this list in Settings.</p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Due Date</label>
              <Input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Assignee</label>
              <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={assignedTo} onChange={e => setAssignedTo(e.target.value)}>
                <option value="">Unassigned</option>
                {users?.map((u:any) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={createTicket.isPending || !title.trim()}>Save Ticket</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
