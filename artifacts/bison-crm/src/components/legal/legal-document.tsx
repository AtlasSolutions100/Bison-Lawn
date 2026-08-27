import { type ReactNode } from 'react';
import { Link } from 'wouter';

/**
 * Shell for the public legal pages. These must render without a session:
 * Google's OAuth verification fetches them anonymously, and a page that only
 * renders for signed-in users reads to the reviewer as a broken link.
 */
export function LegalDocument({
  title,
  effectiveDate,
  children,
}: {
  title: string;
  effectiveDate: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-[100dvh] bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link href="/" className="font-bold text-foreground hover:opacity-80">
            Bison Lawn Care
          </Link>
          <nav className="flex gap-4 text-sm text-muted-foreground">
            <Link href="/privacy" className="hover:text-foreground">Privacy</Link>
            <Link href="/terms" className="hover:text-foreground">Terms</Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-3xl font-bold text-foreground">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Effective {effectiveDate}
        </p>
        <div className="mt-8 space-y-6 text-[15px] leading-relaxed text-foreground/90">
          {children}
        </div>
      </main>

      <footer className="border-t">
        <div className="mx-auto max-w-3xl px-6 py-8 text-sm text-muted-foreground">
          Bison Lawn Care LLC · bisonlawncarellc@gmail.com
        </div>
      </footer>
    </div>
  );
}

export function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-foreground">{heading}</h2>
      <div className="mt-2 space-y-3">{children}</div>
    </section>
  );
}
