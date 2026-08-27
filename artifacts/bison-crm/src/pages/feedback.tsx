import { useState } from 'react';
import { format } from 'date-fns';
import { useListFeedback, useUpdateFeedback } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';

const FILTERS = [
  { value: undefined, label: 'All' },
  { value: 'new' as const, label: 'New' },
  { value: 'read' as const, label: 'Read' },
  { value: 'done' as const, label: 'Done' },
];

const CATEGORY_LABEL: Record<string, string> = {
  idea: 'Idea',
  problem: 'Problem',
  other: 'Other',
};

export default function FeedbackPage() {
  const [status, setStatus] = useState<'new' | 'read' | 'done' | undefined>(undefined);
  const { data: items, isLoading, refetch } = useListFeedback(status ? { status } : undefined);
  const { toast } = useToast();

  const updateFeedback = useUpdateFeedback({
    mutation: {
      onSuccess: () => void refetch(),
      onError: () => toast({ title: 'Could not update that', variant: 'destructive' }),
    },
  });

  const setStatusOf = (id: number, next: 'new' | 'read' | 'done') =>
    updateFeedback.mutate({ id, data: { status: next } });

  return (
    <div className="p-6 max-w-4xl mx-auto w-full">
      <h1 className="text-3xl font-bold text-foreground">Feedback</h1>
      <p className="mt-1 text-muted-foreground">
        Sent from inside the app by admins and contractors. Each one records the screen it came
        from.
      </p>

      <div className="mt-6 flex gap-1">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            type="button"
            onClick={() => setStatus(f.value)}
            className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
              status === f.value
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-input text-muted-foreground hover:text-foreground'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="mt-4 space-y-3">
        {isLoading ? (
          <p className="py-12 text-center text-muted-foreground animate-pulse">Loading…</p>
        ) : !items?.length ? (
          <p className="py-12 text-center text-muted-foreground">
            Nothing here yet. The Feedback button is on every screen, bottom right.
          </p>
        ) : (
          items.map((f) => (
            <Card key={f.id}>
              <CardContent className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={f.category === 'problem' ? 'destructive' : 'secondary'}>
                    {CATEGORY_LABEL[f.category] ?? f.category}
                  </Badge>
                  {f.status === 'new' && <Badge>New</Badge>}
                  {f.status === 'done' && <Badge variant="outline">Done</Badge>}
                  <span className="text-sm font-medium text-foreground">
                    {f.userName ?? 'Unknown'}
                  </span>
                  {f.userRole && (
                    <span className="text-xs text-muted-foreground">({f.userRole})</span>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {f.createdAt ? format(new Date(f.createdAt), 'MMM d, h:mm a') : ''}
                  </span>
                </div>

                <p className="mt-3 whitespace-pre-wrap text-[15px] leading-relaxed text-foreground">
                  {f.message}
                </p>

                {/* What was done about it. Stored since the table was added but
                    never shown, which made the reply invisible to the person who
                    raised it — the half of the loop that actually closes it. */}
                {f.adminNote && (
                  <div className="mt-3 rounded-md border-l-2 border-primary bg-primary/5 py-2 pl-3 pr-2">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-primary">
                      {f.status === 'done' ? 'What we did' : 'Where this stands'}
                    </span>
                    <p className="mt-0.5 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                      {f.adminNote}
                    </p>
                  </div>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  {f.page && (
                    <span>
                      on <span className="font-mono text-foreground">{f.page}</span>
                    </span>
                  )}
                  {f.userEmail && <span>{f.userEmail}</span>}
                  <span className="ml-auto flex gap-2">
                    {f.status !== 'read' && (
                      <Button variant="ghost" size="sm" onClick={() => setStatusOf(f.id, 'read')}>
                        Mark read
                      </Button>
                    )}
                    {f.status !== 'done' && (
                      <Button variant="outline" size="sm" onClick={() => setStatusOf(f.id, 'done')}>
                        Done
                      </Button>
                    )}
                    {f.status === 'done' && (
                      <Button variant="ghost" size="sm" onClick={() => setStatusOf(f.id, 'new')}>
                        Reopen
                      </Button>
                    )}
                  </span>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
