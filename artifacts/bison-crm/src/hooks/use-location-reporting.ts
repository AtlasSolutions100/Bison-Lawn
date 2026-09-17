import { useCallback, useEffect, useState } from 'react';
import { format } from 'date-fns';
import { useListMyJobs, getListMyJobsQueryKey, reportMyLocation } from '@workspace/api-client-react';

/**
 * The contractor's phone telling the office where it is.
 *
 * Only with the person's say-so (asked once, remembered on this phone), only
 * while Bison Field is open on screen, and only while one of today's jobs is
 * On The Way or Started. A browser cannot report from a pocket — iOS stops
 * location the moment the screen locks — so the office is shown "last seen N
 * min ago" rather than a promise of a live dot. One report every 30 seconds
 * is plenty for "is he there yet" and easy on the battery.
 */

const CONSENT_KEY = 'bison.shareLocation';
const REPORT_EVERY_MS = 30_000;

export type LocationConsent = 'unasked' | 'granted' | 'declined';

function readConsent(): LocationConsent {
  try {
    const v = localStorage.getItem(CONSENT_KEY);
    return v === 'yes' ? 'granted' : v === 'no' ? 'declined' : 'unasked';
  } catch {
    return 'unasked';
  }
}

export function useLocationReporting() {
  const [consent, setConsentState] = useState<LocationConsent>(readConsent);
  const [sharing, setSharing] = useState(false);
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState === 'visible',
  );

  const today = format(new Date(), 'yyyy-MM-dd');
  // Same key the My Jobs page uses, so tapping On The Way there is seen here
  // the moment that list refreshes; the interval covers the route page.
  const { data: jobs } = useListMyJobs(
    { date: today },
    { query: { queryKey: getListMyJobsQueryKey({ date: today }), refetchInterval: consent === 'granted' ? 60_000 : false } },
  );
  const activeJob =
    jobs?.find((j) => j.status === 'on_the_way') ?? jobs?.find((j) => j.status === 'in_progress') ?? null;
  const activeJobId = activeJob?.id ?? null;
  // Fine-grained GPS only while driving to the stop; once the job has started
  // a coarse fix says "at the house" just as well for much less battery.
  const highAccuracy = activeJob?.status === 'on_the_way';

  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  useEffect(() => {
    if (consent !== 'granted' || activeJobId == null || !visible) {
      setSharing(false);
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setError('This phone cannot share its location from the browser.');
      setSharing(false);
      return;
    }
    let lastSent = 0;
    let inflight = false;
    const watchId = navigator.geolocation.watchPosition(
      async (p) => {
        const now = Date.now();
        if (inflight || now - lastSent < REPORT_EVERY_MS) return;
        inflight = true;
        lastSent = now;
        try {
          await reportMyLocation({
            lat: p.coords.latitude,
            lng: p.coords.longitude,
            accuracyM: p.coords.accuracy ?? null,
            heading: Number.isFinite(p.coords.heading) ? p.coords.heading : null,
            speedMps: Number.isFinite(p.coords.speed) ? p.coords.speed : null,
            jobId: activeJobId,
            recordedAt: new Date(p.timestamp).toISOString(),
          });
          setLastSentAt(now);
          setError(null);
        } catch (e: any) {
          setError(e?.data?.error || e?.message || 'Could not send your location');
        } finally {
          inflight = false;
        }
      },
      (err) => {
        setError(
          err.code === err.PERMISSION_DENIED
            ? 'Location is blocked for this site in your phone settings.'
            : 'Could not get a location fix yet.',
        );
      },
      { enableHighAccuracy: highAccuracy, maximumAge: 15_000, timeout: 30_000 },
    );
    setSharing(true);
    return () => {
      navigator.geolocation.clearWatch(watchId);
      setSharing(false);
    };
  }, [consent, activeJobId, highAccuracy, visible]);

  const setConsent = useCallback((next: LocationConsent) => {
    try {
      if (next === 'unasked') localStorage.removeItem(CONSENT_KEY);
      else localStorage.setItem(CONSENT_KEY, next === 'granted' ? 'yes' : 'no');
    } catch {
      // A private window forgets the answer; the banner simply asks again.
    }
    setConsentState(next);
  }, []);

  return {
    consent,
    grant: () => setConsent('granted'),
    decline: () => setConsent('declined'),
    sharing,
    lastSentAt,
    error,
    activeJob,
  };
}
