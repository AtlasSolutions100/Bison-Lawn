import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Job } from '@workspace/api-client-react';

/**
 * The dispatch board's map.
 *
 * Modelled on the screen he already dispatches from: pins numbered by route
 * order, a lasso to grab an area, and a panel that totals what is inside it
 * before anything is committed.
 *
 * OpenStreetMap tiles rather than Google. His old system used Google, and this
 * will look different — but Google's JS map needs a billed API key per client
 * deployment, and the interactions below are the part he actually works with.
 * Swapping the tile layer later changes one line.
 */

const money = (n: number) =>
  `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export type MapJob = Job & { clientLat?: number | null; clientLng?: number | null };

/** Jobs we can actually place. Everything else is reported, never silently dropped. */
function placeable(jobs: MapJob[]) {
  return jobs.filter((j) => j.clientLat != null && j.clientLng != null);
}

/** Even-odd ray casting. Small enough to own rather than take a dependency for. */
function insidePolygon(point: [number, number], polygon: [number, number][]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i];
    const [yj, xj] = polygon[j];
    const intersects =
      yi > point[0] !== yj > point[0] &&
      point[1] < ((xj - xi) * (point[0] - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pinIcon(label: string, state: 'default' | 'selected' | 'unassigned') {
  const bg = state === 'selected' ? '#b45309' : state === 'unassigned' ? '#6f675f' : '#215343';
  return L.divIcon({
    className: '',
    html:
      `<div style="background:${bg};color:#fff;width:26px;height:26px;border-radius:50% 50% 50% 0;` +
      `transform:rotate(-45deg);display:flex;align-items:center;justify-content:center;` +
      `box-shadow:0 1px 4px rgba(0,0,0,.4);border:2px solid #fff">` +
      `<span style="transform:rotate(45deg);font:bold 11px/1 Arial">${label}</span></div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 26],
  });
}

export function DispatchMap({
  jobs,
  contractors,
  onCommit,
  busy,
}: {
  jobs: MapJob[];
  contractors: { id: number; name: string }[];
  onCommit: (input: {
    jobIds: number[];
    assignedToId?: number | null;
    scheduledDate?: string | null;
    routeOrderFrom?: number | null;
  }) => void;
  busy: boolean;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const markerLayer = useRef<L.LayerGroup | null>(null);
  const lassoLayer = useRef<L.Polygon | L.Polyline | null>(null);

  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [lassoing, setLassoing] = useState(false);
  const [assignTo, setAssignTo] = useState('');
  const [moveTo, setMoveTo] = useState('');
  const [routeFrom, setRouteFrom] = useState('');

  const shown = useMemo(() => placeable(jobs), [jobs]);
  const missing = jobs.length - shown.length;
  const selected = useMemo(
    () => shown.filter((j) => selectedIds.includes(j.id)),
    [shown, selectedIds],
  );

  // Totals for whatever is inside the lasso, the same three his Group Selection
  // shows — the numbers that decide whether a shape is one crew's day.
  const totals = useMemo(
    () => ({
      stops: selected.length,
      amount: selected.reduce((s, j) => s + (j.amount ?? 0), 0),
      hours: selected.reduce((s, j) => s + (j.budgetedHours ?? 0), 0),
    }),
    [selected],
  );

  // --- map lifecycle ---------------------------------------------------------
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

  // --- pins ------------------------------------------------------------------
  useEffect(() => {
    const m = map.current;
    const layer = markerLayer.current;
    if (!m || !layer) return;
    layer.clearLayers();

    shown.forEach((job) => {
      const isSel = selectedIds.includes(job.id);
      const marker = L.marker([job.clientLat!, job.clientLng!], {
        icon: pinIcon(
          job.routeOrder != null ? String(job.routeOrder) : '•',
          isSel ? 'selected' : job.assignedToId == null ? 'unassigned' : 'default',
        ),
      });
      marker.bindPopup(
        `<div style="font:13px/1.45 Arial">
           <strong>${job.clientName ?? 'Job'}</strong><br/>
           ${job.clientAddress ?? ''}<br/>
           ${job.serviceName ?? ''} — ${money(job.amount ?? 0)}<br/>
           <span style="color:#6f675f">${job.assignedToName ?? 'Unassigned'}${
             job.routeOrder != null ? ` · stop ${job.routeOrder}` : ''
           }</span>
         </div>`,
      );
      // Clicking a pin toggles it into the selection, so a route can be built by
      // tapping stops in the order they should be driven — which is what the
      // route-order box below then writes.
      marker.on('click', () => {
        setSelectedIds((cur) =>
          cur.includes(job.id) ? cur.filter((id) => id !== job.id) : [...cur, job.id],
        );
      });
      marker.addTo(layer);
    });

    if (shown.length > 0 && !selectedIds.length) {
      const bounds = L.latLngBounds(shown.map((j) => [j.clientLat!, j.clientLng!] as [number, number]));
      m.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
    }
  }, [shown, selectedIds]);

  // --- lasso -----------------------------------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (!lassoing) {
      m.dragging.enable();
      return;
    }
    // Dragging has to go while drawing, or the map pans under the pointer and
    // the shape ends up somewhere the user never traced.
    m.dragging.disable();
    const points: [number, number][] = [];
    let drawing = false;

    const down = (e: L.LeafletMouseEvent) => {
      drawing = true;
      points.length = 0;
      lassoLayer.current?.remove();
      lassoLayer.current = L.polyline([], { color: '#b45309', weight: 2, dashArray: '4 4' }).addTo(m);
      points.push([e.latlng.lat, e.latlng.lng]);
    };
    const move = (e: L.LeafletMouseEvent) => {
      if (!drawing) return;
      points.push([e.latlng.lat, e.latlng.lng]);
      (lassoLayer.current as L.Polyline)?.setLatLngs(points as unknown as L.LatLngExpression[]);
    };
    const up = () => {
      if (!drawing) return;
      drawing = false;
      if (points.length > 2) {
        lassoLayer.current?.remove();
        lassoLayer.current = L.polygon(points as unknown as L.LatLngExpression[], {
          color: '#b45309',
          weight: 2,
          fillOpacity: 0.08,
        }).addTo(m);
        const hits = shown
          .filter((j) => insidePolygon([j.clientLat!, j.clientLng!], points))
          .map((j) => j.id);
        setSelectedIds(hits);
      }
      setLassoing(false);
    };

    m.on('mousedown', down);
    m.on('mousemove', move);
    m.on('mouseup', up);
    return () => {
      m.off('mousedown', down);
      m.off('mousemove', move);
      m.off('mouseup', up);
    };
  }, [lassoing, shown]);

  const clearSelection = () => {
    setSelectedIds([]);
    lassoLayer.current?.remove();
    lassoLayer.current = null;
  };

  const commit = () => {
    if (selectedIds.length === 0) return;
    onCommit({
      jobIds: selectedIds,
      ...(assignTo !== '' ? { assignedToId: assignTo === 'unassign' ? null : Number(assignTo) } : {}),
      ...(moveTo !== '' ? { scheduledDate: moveTo } : {}),
      ...(routeFrom !== '' ? { routeOrderFrom: Number(routeFrom) } : {}),
    });
  };

  const nothingToApply = assignTo === '' && moveTo === '' && routeFrom === '';

  return (
    <div className="relative overflow-hidden rounded-lg border bg-card shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2">
        <button
          type="button"
          onClick={() => setLassoing((v) => !v)}
          className={`rounded-md border px-3 py-1 text-xs font-medium transition ${
            lassoing ? 'border-amber-600 bg-amber-600 text-white' : 'bg-background hover:border-primary/50'
          }`}
        >
          {lassoing ? 'Drawing — drag on the map' : 'Select an area'}
        </button>
        <span className="text-xs text-muted-foreground">or click pins to build a route in order</span>
        {selectedIds.length > 0 && (
          <button type="button" onClick={clearSelection} className="ml-auto text-xs text-muted-foreground hover:text-foreground">
            Clear selection
          </button>
        )}
      </div>

      <div ref={container} className="h-[420px] w-full" />

      {/* Stated on the map, not in a log. A stop with no coordinates cannot be
          lassoed, so a dispatcher working only from the map would never see it. */}
      {missing > 0 && (
        <div className="border-t bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {missing} job{missing === 1 ? ' has' : 's have'} no coordinates and {missing === 1 ? 'is' : 'are'} not on the map.
          {' '}Use the table below for {missing === 1 ? 'it' : 'them'}.
        </div>
      )}

      {selectedIds.length > 0 && (
        <div className="border-t p-3">
          <div className="mb-3 flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <span className="text-sm"><strong>{totals.stops}</strong> stop{totals.stops === 1 ? '' : 's'} selected</span>
            <span className="text-sm"><strong>{money(totals.amount)}</strong></span>
            <span className="text-sm text-muted-foreground">
              {totals.hours > 0 ? `${totals.hours.toFixed(1)} hrs budgeted` : 'no hours budgeted'}
            </span>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Assign to</label>
              <select
                className="h-9 w-44 rounded-md border border-input bg-background px-2 text-sm"
                value={assignTo}
                onChange={(e) => setAssignTo(e.target.value)}
              >
                <option value="">Leave as is</option>
                <option value="unassign">Unassign</option>
                {contractors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Move to</label>
              <input
                type="date"
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                value={moveTo}
                onChange={(e) => setMoveTo(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Route order from</label>
              <input
                type="number"
                min={1}
                placeholder="e.g. 1"
                className="h-9 w-28 rounded-md border border-input bg-background px-2 text-sm"
                value={routeFrom}
                onChange={(e) => setRouteFrom(e.target.value)}
              />
            </div>
            <button
              type="button"
              onClick={commit}
              disabled={busy || nothingToApply}
              className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {busy ? 'Applying…' : `Apply to ${totals.stops}`}
            </button>
          </div>
          {routeFrom !== '' && (
            <p className="mt-2 text-xs text-muted-foreground">
              Stops are numbered in the order you picked them, starting at {routeFrom || '1'}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
