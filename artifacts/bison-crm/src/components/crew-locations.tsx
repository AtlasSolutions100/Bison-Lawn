import { useEffect, useRef } from 'react';
import L from 'leaflet';
import { useListTeamLocations, getListTeamLocationsQueryKey, type TeamLocation } from '@workspace/api-client-react';
import { contractorColor, initialsOf } from '@/lib/contractor-color';

/**
 * Where the crew is, on the dispatch map and in a strip under it.
 *
 * "Where's my guy?" — a customer calls, and today the office has to ring the
 * sub, who is driving. This answers it from the phone's own reports: a marker
 * with the person's initials in their colour, and a line that says "at 615 E
 * 18th Ave · 2 min ago". Honest about its limits: a phone only reports while
 * Bison Field is open on screen, so a stale marker is greyed and dated rather
 * than left looking current.
 */

const REFRESH_MS = 30_000;

export function ageLabel(seconds: number | null | undefined): string {
  if (seconds == null) return 'never';
  if (seconds < 45) return 'just now';
  const min = Math.round(seconds / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  return day === 1 ? 'yesterday' : `${day} days ago`;
}

/** "at 615 E 18th Ave", "on the way to 615 E 18th Ave", "no job going" — the words the office says back to the customer. */
export function whereLabel(p: TeamLocation): string {
  switch (p.status) {
    case 'at_job':
      return `at ${p.jobAddress ?? p.jobClientName ?? 'a job'}`;
    case 'en_route':
      return `on the way to ${p.jobAddress ?? p.jobClientName ?? 'a job'}`;
    case 'idle':
      return 'no job going';
    case 'stale':
      return p.jobAddress ? `last seen near ${p.jobAddress}` : 'last seen';
    default:
      return "hasn't reported yet";
  }
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function crewIcon(p: TeamLocation) {
  const stale = p.status === 'stale' || p.status === 'unknown';
  const bg = stale ? '#9ca3af' : contractorColor(p.userId);
  const ring = p.status === 'at_job' ? '#16a34a' : p.status === 'en_route' ? '#f59e0b' : '#fff';
  return L.divIcon({
    className: '',
    html:
      `<div style="background:${bg};color:#fff;width:30px;height:30px;border-radius:50%;` +
      `display:flex;align-items:center;justify-content:center;font:bold 11px/1 Arial;` +
      `border:3px solid ${ring};box-shadow:0 1px 4px rgba(0,0,0,.45);${stale ? 'opacity:.7;' : ''}">` +
      `${esc(initialsOf(p.userName))}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    popupAnchor: [0, -14],
  });
}

function popupHtml(p: TeamLocation): string {
  const bits = [esc(p.userName), ageLabel(p.ageSeconds), esc(whereLabel(p))];
  const foot =
    p.source === 'clock'
      ? 'From their last clock-in, not a live report.'
      : p.status === 'stale'
        ? 'Their phone has not reported for a while — the app is closed or the screen is locked.'
        : '';
  return (
    `<div style="font:13px/1.45 Arial"><strong>${bits.join(' · ')}</strong>` +
    (p.accuracyM != null && p.accuracyM > 100 ? `<br/><span style="color:#6f675f">±${Math.round(p.accuracyM)} m</span>` : '') +
    (foot ? `<br/><span style="color:#6f675f">${foot}</span>` : '') +
    `</div>`
  );
}

/**
 * Crew markers on the dispatch map. Owns its own layer group so the job-pin
 * effect in DispatchMap (which clears its layer on every selection change)
 * never touches these. Safe to mount before the map exists.
 */
export function CrewLocationsLayer({ map, date }: { map: L.Map | null; date: string }) {
  const { data } = useListTeamLocations(
    { date },
    { query: { queryKey: getListTeamLocationsQueryKey({ date }), refetchInterval: REFRESH_MS, enabled: map != null } },
  );
  const layer = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!map) return;
    const group = L.layerGroup().addTo(map);
    layer.current = group;
    return () => {
      group.remove();
      layer.current = null;
    };
  }, [map]);

  useEffect(() => {
    const group = layer.current;
    if (!map || !group) return;
    group.clearLayers();
    for (const p of data ?? []) {
      if (p.lat == null || p.lng == null) continue;
      L.marker([p.lat, p.lng], { icon: crewIcon(p), zIndexOffset: 1000 })
        .bindPopup(popupHtml(p))
        .addTo(group);
    }
  }, [data, map]);

  return null;
}

/** The compact "last seen" list, so the office can answer without opening the map. */
export function CrewStrip({ date }: { date: string }) {
  const { data } = useListTeamLocations(
    { date },
    { query: { queryKey: getListTeamLocationsQueryKey({ date }), refetchInterval: REFRESH_MS } },
  );
  if (!data?.length) return null;
  return (
    <div className="flex flex-wrap gap-2" data-testid="crew-strip">
      {data.map((p) => {
        const stale = p.status === 'stale' || p.status === 'unknown';
        return (
          <div
            key={p.userId}
            className={`flex items-center gap-2 rounded-md border bg-card px-2 py-1 text-xs ${stale ? 'opacity-70' : ''}`}
            title={p.source === 'clock' ? 'From their last clock-in, not a live report' : undefined}
            data-testid={`crew-strip-${p.userId}`}
          >
            <span
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
              style={{ background: stale ? '#9ca3af' : contractorColor(p.userId) }}
            >
              {initialsOf(p.userName)}
            </span>
            <span className="font-semibold">{p.userName}</span>
            <span className="text-muted-foreground">
              {whereLabel(p)}
              {p.ageSeconds != null ? ` · ${ageLabel(p.ageSeconds)}` : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}
