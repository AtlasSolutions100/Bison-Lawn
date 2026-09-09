import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { AlertCircle } from 'lucide-react';

/**
 * The page a wrong link lands on.
 *
 * This was scaffold left over from the starter: it asked "Did you forget to add
 * the page to the router?" — a question for whoever wrote the app, shown to
 * whoever is using it — and painted itself in hardcoded greys that ignore the
 * app's own colours, so it did not look like the same product. It also offered
 * no way back, which is the one thing a lost page owes you.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-muted/20 p-4">
      <Card className="w-full max-w-md">
        <CardContent className="space-y-4 pt-6">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-6 w-6 shrink-0 text-destructive" />
            <h1 className="text-xl font-bold text-foreground">We can&rsquo;t find that page</h1>
          </div>

          <p className="text-sm text-muted-foreground">
            The link may be out of date, or the page may have been renamed. Nothing is lost —
            head back and pick up where you were.
          </p>

          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href="/">Go to the dashboard</Link>
            </Button>
            <Button variant="outline" onClick={() => window.history.back()}>
              Back
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
