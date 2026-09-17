import { MapPin, MapPinOff } from 'lucide-react';
import { useLocationReporting } from '@/hooks/use-location-reporting';

/**
 * The strip under the Bison Field header that asks once, then says plainly
 * whether the office can see where this phone is. Mounted once in the
 * contractor layout; it owns the only location watcher in the app.
 */
export function LocationBeacon() {
  const { consent, grant, decline, sharing, lastSentAt, error, activeJob } = useLocationReporting();

  if (consent === 'unasked') {
    return (
      <div className="bg-amber-50 border-b border-amber-200 px-4 py-3 text-sm text-amber-900">
        <div className="flex items-start gap-2">
          <MapPin className="w-5 h-5 shrink-0 mt-0.5" />
          <div className="space-y-2">
            <p className="font-semibold">Share your location with the office while you're on a job?</p>
            <p className="text-xs leading-relaxed">
              Only while this app is open on your screen and a job is On The Way or Started. The office
              sees you on the dispatch map so they can answer "where's my guy" without calling you.
              Nobody else sees it, and it is kept for a week.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={grant}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground"
              >
                Yes, share while I'm on a job
              </button>
              <button
                type="button"
                onClick={decline}
                className="rounded-md border border-amber-300 px-3 py-1.5 text-xs font-semibold"
              >
                Not now
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (consent === 'declined') {
    return (
      <div className="bg-muted/60 border-b px-4 py-1.5 text-[11px] text-muted-foreground flex items-center gap-2">
        <MapPinOff className="w-3.5 h-3.5" />
        <span className="flex-1">Location sharing is off — the office can't see where you are.</span>
        <button type="button" onClick={grant} className="font-semibold underline">Turn on</button>
      </div>
    );
  }

  if (!activeJob) {
    return (
      <div className="bg-muted/60 border-b px-4 py-1.5 text-[11px] text-muted-foreground flex items-center gap-2">
        <MapPin className="w-3.5 h-3.5" />
        <span className="flex-1">Location sharing is on. It only sends while a job is On The Way or Started.</span>
        <button type="button" onClick={decline} className="font-semibold underline">Turn off</button>
      </div>
    );
  }

  const ago = lastSentAt ? Math.round((Date.now() - lastSentAt) / 1000) : null;
  return (
    <div className="bg-emerald-50 border-b border-emerald-200 px-4 py-1.5 text-[11px] text-emerald-900 flex items-center gap-2">
      <span className={`inline-block w-2 h-2 rounded-full ${sharing ? 'bg-emerald-500 animate-pulse' : 'bg-muted-foreground'}`} />
      <span className="flex-1">
        {error
          ? error
          : sharing
            ? `Sharing your location with the office${ago != null ? ` · sent ${ago < 5 ? 'just now' : `${ago}s ago`}` : ' · getting a fix…'}`
            : 'Location sharing paused while the app is in the background.'}
      </span>
      <button type="button" onClick={decline} className="font-semibold underline">Turn off</button>
    </div>
  );
}
