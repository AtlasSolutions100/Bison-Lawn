/**
 * The Polish control: "an AI version in CRM".
 *
 * "When sending emails — having an option to use AI for clarity and
 * professionalism, currently use chatgpt. Like in GMail." So this sits next to
 * any box where he types something a customer will read, and does the ChatGPT
 * round trip in place: press Polish, read what came back, press Use this or
 * Keep mine.
 *
 * It NEVER writes into his box on its own. The rewrite appears underneath,
 * labelled, with his own words still sitting in the box above it, and only Use
 * this moves it across. Nothing is sent but the text in that one box — no
 * customer name, no invoice, no history.
 *
 * With no AI key on the server the button is still there and still pressable:
 * it comes back saying the rewrite is not switched on. A control that silently
 * does nothing is worse than one that explains itself.
 */
import { useState } from 'react';
import { usePolishText } from '@workspace/api-client-react';
import type { PolishTone } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Sparkles, Check, X } from 'lucide-react';

const TONES: { value: PolishTone; label: string }[] = [
  { value: 'clear', label: 'Clearer' },
  { value: 'professional', label: 'More professional' },
  { value: 'friendly', label: 'Friendlier' },
];

type Props = {
  /** What he has typed. Read only — this component never edits it. */
  value: string;
  /** Called only when he presses Use this. */
  onAccept: (text: string) => void;
  /** "email" or "letter": goes into the button and the panel wording. */
  what?: string;
  /** For the orchestrator and the tests to find the right one on a page. */
  testId?: string;
};

export function AiPolish({ value, onAccept, what = 'email', testId = 'ai-polish' }: Props) {
  const [tone, setTone] = useState<PolishTone>('clear');
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** The exact words the rewrite was made from, so a stale one can be spotted. */
  const [polishedFrom, setPolishedFrom] = useState<string | null>(null);
  const polish = usePolishText();

  const hasText = value.trim().length > 0;

  /**
   * A rewrite is only about the words it was made from. If the box has changed
   * since — he carried on typing, or he clicked a different letter in the list
   * on the left — then "Your own words are still in the box above" is no longer
   * true, and Use this would paste the old rewrite over words it never saw.
   * That is how a polished spring letter could land in the aeration letter. So
   * the panel disappears the moment the box stops matching.
   */
  const fresh = polishedFrom === value;
  const shownSuggestion = fresh ? suggestion : null;
  const shownNote = fresh ? note : null;

  const run = (nextTone: PolishTone = tone) => {
    setTone(nextTone);
    setSuggestion(null);
    setNote(null);
    setPolishedFrom(value);
    polish.mutate(
      { data: { text: value, tone: nextTone } },
      {
        onSuccess: (result) => {
          // `changed` is the server's word for "this is a rewrite he has not
          // seen". Anything else — no key, nothing to tidy, a rewrite that
          // mangled a merge token — comes back as his own text plus the reason.
          if (result.changed) setSuggestion(result.text);
          setNote(result.note ?? null);
        },
        onError: (error) =>
          setNote(
            error instanceof Error
              ? error.message
              : 'The rewrite could not be fetched. Your words are untouched — try again in a minute.',
          ),
      },
    );
  };

  const dismiss = () => {
    setSuggestion(null);
    setNote(null);
    setPolishedFrom(null);
  };

  return (
    <div className="mt-2 space-y-2" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => run()}
          disabled={!hasText || polish.isPending}
          data-testid={`${testId}-run`}
        >
          <Sparkles className="mr-1 h-4 w-4" />
          {polish.isPending ? 'Polishing…' : `Polish this ${what} with AI`}
        </Button>
        <select
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          value={tone}
          onChange={(event) => setTone(event.target.value as PolishTone)}
          disabled={polish.isPending}
          aria-label="How to rewrite it"
          data-testid={`${testId}-tone`}
        >
          {TONES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        {!hasText && (
          <span className="text-xs text-muted-foreground">Type something first.</span>
        )}
      </div>

      {/* The reason it did not rewrite, in his words. Shown on its own when
          there is no suggestion, and under one when the rewrite came back
          identical to what he wrote. */}
      {shownNote && (
        <p
          className="rounded-md border bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
          data-testid={`${testId}-note`}
        >
          {shownNote}
        </p>
      )}

      {shownSuggestion != null && (
        <div className="rounded-md border border-primary/40 bg-primary/5 p-3" data-testid={`${testId}-suggestion`}>
          <p className="text-xs font-semibold">The AI version</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Your own words are still in the box above. Read this first — nothing changes until you press Use this.
          </p>
          <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-sm">
            {shownSuggestion}
          </pre>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                onAccept(shownSuggestion);
                dismiss();
              }}
              data-testid={`${testId}-accept`}
            >
              <Check className="mr-1 h-4 w-4" /> Use this
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={dismiss} data-testid={`${testId}-reject`}>
              <X className="mr-1 h-4 w-4" /> Keep mine
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => run()}
              disabled={polish.isPending}
              data-testid={`${testId}-again`}
            >
              Try again
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
