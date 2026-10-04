import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useLocation } from 'wouter';
import type { Client } from '@workspace/api-client-react';
import { COLOR_CHOICES } from '@/lib/contractor-color';

/**
 * "Show all clients on map."
 *
 * His whole book of business on one map, so he can see it the way he drives it.
 * The same Leaflet and the same OpenStreetMap tiles the dispatch board and the
 * waiting list already use — a second mapping library would be a second set of
 * keys, a second bill and a second thing that breaks.
 *
 * The rows it draws are the rows the client list is showing: every filter,
 * every search, the status tabs. Filter the list to "Post Falls, balance
 * greater than 0" and the map is those customers and nobody else, because the
 * page hands this the list it has already filtered rather than fetching its
 * own.
 *
 * What a pin's colour means is his choice — zone, status or who owes money —
 * because those are the three questions he asks of a map of customers.
 */

type ColorBy = 'zone' | 'status' | 'balance';

const COLOR_BY: { key: ColorBy; label: string }[] = [
  { key: 'zone', label: 'Zone' },
  { key: 'status', label: 'Lead / active / former' },
  { key: 'balance', label: 'Who owes money' },
];

const GREY = '#6b7280';
const STATUS_COLORS: Record<string, string> = {
  lead: '#ca8a04',
  client: '#16a34a',
  former_client: GREY,
};
const STATUS_WORDS: Record<string, string> = { lead: 'Lead', client: 'Active', former_client: 'Former' };

/**
 * A zone's colour is a pure function of its code, the same trick the zone chip
 * on the list uses: a new map code he invents this morning is coloured without
 * anything to set up, and PF is the same colour on every screen and after every
 * reload.
 */
function zoneColor(code: string): string {
  let hash = 0;
  for (const char of code) hash = (hash * 31 + char.charCodeAt(0)) % 1000003;
  return COLOR_CHOICES[hash % COLOR_CHOICES.length];
}

/** Which bucket a customer falls in, and what to call it in the legend. */
function bucketOf(client: Client, colorBy: ColorBy): { key: string; label: string; color: string } {
  if (colorBy === 'status') {
    return {
      key: client.status,
      label: STATUS_WORDS[client.status] ?? client.status,
      color: STATUS_COLORS[client.status] ?? GREY,
    };
  }
  if (colorBy === 'balance') {
    // The three answers he acts on: chase them, nothing to do, they are in
    // credit. A cent-level split would colour the map by rounding.
    if (client.accountBalance > 0) return { key: 'owes', label: 'Owes money', color: '#dc2626' };
    if (client.accountBalance < 0) return { key: 'credit', label: 'In credit', color: '#2563eb' };
    return { key: 'square', label: 'Square', color: '#16a34a' };
  }
  const code = client.mapCode?.trim().toUpperCase() ?? '';
  if (!code) return { key: '', label: 'No zone', color: GREY };
  return { key: code, label: code, color: zoneColor(code) };
}

const money = (n: number) =>
  `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A plain round dot: a customer has no route order to carry, so there is no number to show. */
function dotIcon(color: string) {
  return L.divIcon({
    className: '',
    html:
      `<div style="background:${color};width:14px;height:14px;border-radius:50%;` +
      `border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.45)"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

export default function ClientsMap({ clients, filtered }: {
  /** The rows the list is showing — already filtered, already searched. */
  clients: Client[];
  /** True when a filter or search is narrowing the list, so the map can say so. */
  filtered: boolean;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const markerLayer = useRef<L.LayerGroup | null>(null);
  const fittedFor = useRef<string>('');
  const [, setLocation] = useLocation();
  const [colorBy, setColorBy] = useState<ColorBy>('zone');
  const [hidden, setHidden] = useState<string[]>([]);

  // Reading the legend against the map only works while the buckets mean the
  // same thing, so switching what the colour means starts them all shown.
  useEffect(() => { setHidden([]); }, [colorBy]);

  const placed = useMemo(() => clients.filter((c) => c.lat != null && c.lng != null), [clients]);
  const missing = clients.length - placed.length;

  const legend = useMemo(() => {
    const groups = new Map<string, { key: string; label: string; color: string; count: number }>();
    for (const client of placed) {
      const bucket = bucketOf(client, colorBy);
      const entry = groups.get(bucket.key) ?? { ...bucket, count: 0 };
      entry.count += 1;
      groups.set(bucket.key, entry);
    }
    return [...groups.values()].sort((a, b) => {
      // "No zone" last: it is the pile still needing a decision, not a zone.
      if (!a.key !== !b.key) return a.key ? -1 : 1;
      return b.count - a.count || a.label.localeCompare(b.label);
    });
  }, [placed, colorBy]);

  const shown = useMemo(() => placed.filter((c) => !hidden.includes(bucketOf(c, colorBy).key)), [placed, hidden, colorBy]);

  useEffect(() => {
    if (!container.current || map.current) return;
    const m = L.map(container.current, { zoomControl: true, attributionControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(m);
    m.setView([47.68, -116.78], 11); // Coeur d'Alene, where his work is
    markerLayer.current = L.layerGroup().addTo(m);
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    const layer = markerLayer.current;
    if (!m || !layer) return;
    layer.clearLayers();

    for (const client of shown) {
      const bucket = bucketOf(client, colorBy);
      const marker = L.marker([client.lat!, client.lng!], { icon: dotIcon(bucket.color) });
      marker.bindTooltip(
        `<div style="font:12px/1.4 Arial">
           <strong>${escapeHtml(client.name)}</strong><br/>
           ${escapeHtml([client.serviceAddress, client.city].filter(Boolean).join(', '))}<br/>
           <span style="color:#6f675f">${escapeHtml(bucket.label)}${
             client.accountBalance !== 0 ? ` · ${money(client.accountBalance)}` : ''
           }</span><br/>
           <span style="color:#6f675f">Click to open the account</span>
         </div>`,
        { direction: 'top', offset: [0, -10] },
      );
      marker.on('click', () => setLocation(`/clients/${client.id}`));
      marker.addTo(layer);
    }

    // Zoom to the pins when the set of customers changes — a filter, a search,
    // a different colouring — and not on every re-render, which would fight
    // him for the map every time he panned.
    const key = shown.map((c) => c.id).join(',');
    if (shown.length > 0 && fittedFor.current !== key) {
      fittedFor.current = key;
      m.fitBounds(L.latLngBounds(shown.map((c) => [c.lat!, c.lng!] as [number, number])), {
        padding: [40, 40],
        maxZoom: 15,
      });
    }
  }, [shown, colorBy, setLocation]);

  const toggle = (key: string) =>
    setHidden((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  return (
    <div className="bg-card border rounded-lg shadow-sm flex-1 overflow-hidden flex flex-col" data-testid="clients-map">
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2">
        <span className="text-sm font-semibold">
          {shown.length} {shown.length === 1 ? 'customer' : 'customers'} on the map
        </span>
        {filtered && <span className="text-xs text-muted-foreground">— the same filters as the list</span>}
        <span className="ml-auto text-xs text-muted-foreground">Colour by</span>
        <select
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          value={colorBy}
          onChange={(e) => setColorBy(e.target.value as ColorBy)}
          aria-label="What the pin colours mean"
          data-testid="clients-map-color-by"
        >
          {COLOR_BY.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
      </div>

      <div ref={container} className="w-full flex-1 min-h-[420px]" />

      {legend.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-1.5 text-xs" data-testid="clients-map-legend">
          {legend.map((l) => {
            const off = hidden.includes(l.key);
            return (
              <button
                key={l.key || 'none'}
                type="button"
                onClick={() => toggle(l.key)}
                title={off ? `Put ${l.label} back on the map` : `Take ${l.label} off the map`}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 transition ${
                  off ? 'opacity-40 line-through' : 'hover:border-primary/50'
                }`}
                data-testid={`clients-map-legend-${l.key || 'none'}`}
              >
                <span className="inline-block h-3 w-3 rounded-full border border-white shadow" style={{ background: l.color }} />
                {l.label} <span className="text-muted-foreground">({l.count})</span>
              </button>
            );
          })}
        </div>
      )}

      {/*
        Said on the map rather than left as a short list. A customer with no pin
        cannot be drawn anywhere, and a map that quietly leaves out a hundred
        customers is worse than one that says it has.
      */}
      {missing > 0 && (
        <div className="border-t bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {missing} of these {missing === 1 ? 'customers has' : 'customers have'} no map pin yet, so{' '}
          {missing === 1 ? 'it is' : 'they are'} not on the map. Open the account, Details tab, Map pin — paste a
          Google Maps link or "lat, lng", or press Use my phone location while you are standing there.
        </div>
      )}
    </div>
  );
}
