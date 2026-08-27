import { useState } from 'react';
import { useLocation } from 'wouter';
import { MessageSquarePlus, X } from 'lucide-react';
import { useCreateFeedback, type FeedbackInputCategory } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';

const CATEGORIES: { value: FeedbackInputCategory; label: string }[] = [
  { value: 'idea', label: 'Idea' },
  { value: 'problem', label: 'Something is wrong' },
  { value: 'other', label: 'Other' },
];

/**
 * Floating feedback control, mounted in both the admin and contractor shells.
 *
 * It captures the current path automatically. That is the point of putting it
 * in the app rather than asking people to send an email: the one detail that
 * makes a report reproducible is the screen they were on, and it is the detail
 * nobody ever thinks to include.
 */
export function FeedbackButton() {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<FeedbackInputCategory>('idea');
  const [message, setMessage] = useState('');
  const [location] = useLocation();
  const { toast } = useToast();

  const createFeedback = useCreateFeedback({
    mutation: {
      onSuccess: () => {
        // Clear before closing so reopening never shows the last submission.
        setMessage('');
        setCategory('idea');
        setOpen(false);
        toast({
          title: 'Thanks — that went straight to the office.',
          description: 'We can see which screen you were on, so no need to describe it.',
        });
      },
      onError: () => {
        // Deliberately does not close or clear: losing what someone just typed
        // is the fastest way to make sure they never bother again.
        toast({
          title: 'That did not send',
          description: 'Your note is still here — try again in a moment.',
          variant: 'destructive',
        });
      },
    },
  });

  const submit = () => {
    const trimmed = message.trim();
    if (!trimmed) return;
    createFeedback.mutate({ data: { message: trimmed, category, page: location || '/' } });
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Send feedback"
        // bottom-20 on small screens clears the contractor bottom nav; bottom-6
        // once that nav is gone at sm and up.
        className="fixed bottom-20 right-4 sm:bottom-6 sm:right-6 z-50 flex items-center gap-2 rounded-full bg-primary px-4 py-3 text-primary-foreground shadow-lg transition-shadow hover:shadow-xl"
      >
        <MessageSquarePlus className="h-5 w-5" />
        <span className="hidden text-sm font-semibold sm:inline">Feedback</span>
      </button>
    );
  }

  return (
    <div className="fixed bottom-20 right-4 sm:bottom-6 sm:right-6 z-50 w-[min(22rem,calc(100vw-2rem))] rounded-xl border bg-card p-4 shadow-2xl">
      <div className="mb-3 flex items-start justify-between">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Send feedback</h2>
          <p className="text-xs text-muted-foreground">
            About <span className="font-mono">{location || '/'}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close feedback"
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mb-3 flex gap-1">
        {CATEGORIES.map((c) => (
          <button
            key={c.value}
            type="button"
            onClick={() => setCategory(c.value)}
            className={`flex-1 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors ${
              category === c.value
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-input text-muted-foreground hover:text-foreground'
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      <Textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="What would make this easier?"
        rows={4}
        autoFocus
      />

      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button size="sm" onClick={submit} disabled={!message.trim() || createFeedback.isPending}>
          {createFeedback.isPending ? 'Sending…' : 'Send'}
        </Button>
      </div>
    </div>
  );
}
