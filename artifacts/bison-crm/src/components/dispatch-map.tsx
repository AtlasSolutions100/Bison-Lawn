import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Job } from '@workspace/api-client-react';
import { contractorColor } from '@/lib/contractor-color';

/**
 * The map the dispatch board and the waiting list share.
 *
 * Modelled on the screen he already dispatches from: pins coloured by
 * contractor and numbered by route order, a lasso to grab an area, and the
 * selection lives on the page — so a pin clicked here ticks the row in the
 * table, and a row ticked in the table lights up here. "Select all, or select
 * some, and see the selection on the board/map" is one selection, not two.
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
export function insidePolygon(point: [number, number], polygon: [number, number][]) {
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

/**
 * A pin in the contractor's colour. Selected pins keep their colour and get an
 * amber ring instead of turning amber, so "whose is it" and "is it picked" can
 * both be read off the same pin.
 */
function pinIcon(label: string, color: string, selected: boolean) {
  const ring = selected ? 'box-shadow:0 0 0 3px #b45309,0 1px 4px rgba(0,0,0,.4);' : 'box-shadow:0 1px 4px rgba(0,0,0,.4);';
  return L.divIcon({
    className: '',
    html:
      `<div style="background:${color};color:#fff;width:26px;height:26px;border-radius:50% 50% 50% 0;` +
      `transform:rotate(-45deg);display:flex;align-items:center;justify-content:center;` +
      `${ring}border:2px solid #fff">` +
      `<span style="transform:rotate(45deg);font:bold 11px/1 Arial">${label}</span></div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 26],
  });
}

type LassoMode = 'box' | 'shape' | null;

export function DispatchMap({
  jobs,
  contractors,
  selectedIds,
  onSelectionChange,
  variant = 'board',
  renumber = null,
  onMapReady,
  quickDispatch,
  defaultDate,
}: {
  jobs: MapJob[];
  contractors: { id: number; name: string }[];
  selectedIds: number[];
  onSelectionChange: (ids: number[]) => void;
  variant?: 'board' | 'waiting';
  /**
   * "Set route order": while this is set, clicking a pin adds it to the order
   * instead of the selection, and the pin shows the number it is about to get.
   */
  renumber?: { scope: number[]; order: number[]; onPick: (id: number) => void } | null;
  /** Hands the Leaflet map out so the crew-location layer can draw on it. */
  onMapReady?: (map: L.Map | null) => void;
  /**
   * The waiting list's one press: date + contractor for everything lassoed.
   * The board does not need it — its actions bar sits right under the map.
   */
  quickDispatch?: {
    busy: boolean;
    onRun: (input: { scheduledDate: string; assignedToId: number | null }) => void;
  };
  defaultDate?: string;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const markerLayer = useRef<L.LayerGroup | null>(null);
  const lassoLayer = useRef<L.Polygon | L.Polyline | null>(null);
  const fittedFor = useRef<string>('');

  const [lasso, setLasso] = useState<LassoMode>(null);
  const [shapePoints, setShapePoints] = useState<[number, number][]>([]);
  const [dispatchOn, setDispatchOn] = useState(defaultDate ?? '');
  const [dispatchTo, setDispatchTo] = useState('');

  const shown = useMemo(() => placeable(jobs), [jobs]);
  const missing = jobs.length - shown.length;
  const selected = useMemo(() => shown.filter((j) => selectedIds.includes(j.id)), [shown, selectedIds]);

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

  // Who is on the map, for the legend: one swatch per contractor with pins.
  const legend = useMemo(() => {
    const counts = new Map<number | null, number>();
    for (const j of shown) counts.set(j.assignedToId ?? null, (counts.get(j.assignedToId ?? null) ?? 0) + 1);
    return [...counts.entries()]
      .map(([id, count]) => ({
        id,
        count,
        name: id == null ? 'Unassigned' : (shown.find((j) => j.assignedToId === id)?.assignedToName ?? contractors.find((c) => c.id === id)?.name ?? `User #${id}`),
        color: contractorColor(id),
      }))
      .sort((a, b) => (a.id == null ? 1 : b.id == null ? -1 : b.count - a.count));
  }, [shown, contractors]);

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
    onMapReady?.(m);
    return () => {
      onMapReady?.(null);
      m.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- pins ------------------------------------------------------------------
  useEffect(() => {
    const m = map.current;
    const layer = markerLayer.current;
    if (!m || !layer) return;
    layer.clearLayers();

    shown.forEach((job) => {
      const isSel = selectedIds.includes(job.id);
      const inScope = renumber ? renumber.scope.includes(job.id) : false;
      const pending = inScope ? renumber!.order.indexOf(job.id) : -1;
      const label = inScope
        ? pending >= 0 ? String(pending + 1) : '?'
        : job.routeOrder != null ? String(job.routeOrder) : '•';
      const marker = L.marker([job.clientLat!, job.clientLng!], {
        icon: pinIcon(label, contractorColor(job.assignedToId), isSel || pending >= 0),
        // A pin that is not part of the renumbering fades back so the ones to
        // click stand out.
        opacity: renumber && !inScope ? 0.35 : 1,
      });
      marker.bindTooltip(
        `<div style="font:12px/1.4 Arial">
           <strong>${escapeHtml(job.clientName ?? 'Job')}</strong><br/>
           ${escapeHtml(job.clientAddress ?? '')}<br/>
           ${escapeHtml(job.serviceName ?? '')} — ${money(job.amount ?? 0)}<br/>
           <span style="color:#6f675f">${escapeHtml(job.assignedToName ?? 'Unassigned')}${
             // Everybody else on the truck. "Document crew member on clean
             // ups" — a pin that reads one name on a three-man clean-up is the
             // same wrong answer the row was giving.
             job.crew?.length ? escapeHtml(`, ${job.crew.map((c) => c.name).join(', ')}`) : ''
           }${
             job.routeOrder != null ? ` · stop ${job.routeOrder}` : ''
           }${job.scheduledDate ? ` · ${job.scheduledDate}` : ''}</span>
         </div>`,
        { direction: 'top', offset: [0, -24] },
      );
      marker.on('click', () => {
        // Drawing a shape: a click on a pin is a corner of the shape, not a pick.
        if (lasso === 'shape') {
          setShapePoints((pts) => [...pts, [job.clientLat!, job.clientLng!]]);
          return;
        }
        if (renumber) {
          if (inScope) renumber.onPick(job.id);
          return;
        }
        // Clicking a pin toggles it into the selection, so a route can be built
        // by tapping stops in the order they should be driven.
        onSelectionChange(
          selectedIds.includes(job.id) ? selectedIds.filter((id) => id !== job.id) : [...selectedIds, job.id],
        );
      });
      marker.addTo(layer);
    });

    // Zoom to the pins when the set of jobs changes (a new date, a filter), not
    // when the selection does — re-zooming after every click is dizzying.
    const key = shown.map((j) => j.id).join(',');
    if (shown.length > 0 && fittedFor.current !== key) {
      fittedFor.current = key;
      const bounds = L.latLngBounds(shown.map((j) => [j.clientLat!, j.clientLng!] as [number, number]));
      m.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
    }
  }, [shown, selectedIds, renumber, lasso, onSelectionChange]);

  const addInside = (polygon: [number, number][]) => {
    const inside = shown.filter((j) => insidePolygon([j.clientLat!, j.clientLng!], polygon)).map((j) => j.id);
    // Adds to what is already picked, so two areas can be lassoed one after
    // the other. Clear selection is one click away.
    onSelectionChange([...new Set([...selectedIds, ...inside])]);
  };

  // --- box lasso ---------------------------------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (lasso !== 'box') {
      m.dragging.enable();
      return;
    }
    // Dragging has to go while drawing, or the map pans under the pointer and
    // the shape ends up somewhere the user never traced.
    m.dragging.disable();
    let corner: L.LatLng | null = null;

    const rectangle = (a: L.LatLng, b: L.LatLng): [number, number][] => [
      [a.lat, a.lng],
      [a.lat, b.lng],
      [b.lat, b.lng],
      [b.lat, a.lng],
    ];

    const down = (e: L.LeafletMouseEvent) => {
      corner = e.latlng;
      lassoLayer.current?.remove();
      lassoLayer.current = L.polygon(rectangle(e.latlng, e.latlng) as unknown as L.LatLngExpression[], {
        color: '#b45309',
        weight: 2,
        dashArray: '4 4',
        fillOpacity: 0.08,
      }).addTo(m);
    };
    const move = (e: L.LeafletMouseEvent) => {
      if (!corner) return;
      (lassoLayer.current as L.Polygon)?.setLatLngs(rectangle(corner, e.latlng) as unknown as L.LatLngExpression[]);
    };
    const up = (e: L.LeafletMouseEvent) => {
      if (!corner) return;
      const box = rectangle(corner, e.latlng);
      corner = null;
      // A stray click is not an area. Selecting nothing is the honest response.
      const dragged = Math.abs(box[0][0] - box[2][0]) > 1e-5 || Math.abs(box[0][1] - box[2][1]) > 1e-5;
      if (dragged) {
        (lassoLayer.current as L.Polygon)?.setStyle({ dashArray: undefined });
        addInside(box);
      } else {
        lassoLayer.current?.remove();
        lassoLayer.current = null;
      }
      setLasso(null);
    };

    m.on('mousedown', down);
    m.on('mousemove', move);
    m.on('mouseup', up);
    return () => {
      m.off('mousedown', down);
      m.off('mousemove', move);
      m.off('mouseup', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lasso, shown, selectedIds]);

  // --- shape lasso -------------------------------------------------------------
  // "Lasso an area / a direction": click the corners of any shape — one side of
  // a highway, a wedge heading out of town — and everything inside is picked.
  // Double-click, or the Finish button, closes it. Plain point-in-polygon; no
  // drawing plugin needed for a shape with a handful of corners.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (lasso !== 'shape') {
      m.doubleClickZoom.enable();
      return;
    }
    m.doubleClickZoom.disable();
    const click = (e: L.LeafletMouseEvent) => {
      setShapePoints((pts) => [...pts, [e.latlng.lat, e.latlng.lng]]);
    };
    const dbl = () => finishShape();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelShape();
    };
    m.on('click', click);
    m.on('dblclick', dbl);
    window.addEventListener('keydown', key);
    return () => {
      m.off('click', click);
      m.off('dblclick', dbl);
      window.removeEventListener('keydown', key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lasso, shapePoints, shown, selectedIds]);

  // Draw the shape as it grows.
  useEffect(() => {
    const m = map.current;
    if (!m || lasso !== 'shape') return;
    lassoLayer.current?.remove();
    lassoLayer.current = null;
    if (shapePoints.length === 0) return;
    lassoLayer.current = (shapePoints.length >= 3 ? L.polygon : L.polyline)(
      shapePoints as unknown as L.LatLngExpression[],
      { color: '#b45309', weight: 2, dashArray: '4 4', fillOpacity: 0.08 },
    ).addTo(m);
  }, [shapePoints, lasso]);

  const finishShape = () => {
    // A double-click lands two clicks on the same spot first; drop the repeat.
    const pts = shapePoints.filter((p, i) => i === 0 || Math.abs(p[0] - shapePoints[i - 1][0]) > 1e-7 || Math.abs(p[1] - shapePoints[i - 1][1]) > 1e-7);
    if (pts.length >= 3) {
      (lassoLayer.current as L.Polygon | null)?.setStyle?.({ dashArray: undefined });
      addInside(pts);
    } else {
      lassoLayer.current?.remove();
      lassoLayer.current = null;
    }
    setShapePoints([]);
    setLasso(null);
  };

  const cancelShape = () => {
    lassoLayer.current?.remove();
    lassoLayer.current = null;
    setShapePoints([]);
    setLasso(null);
  };

  const clearSelection = () => {
    onSelectionChange([]);
    lassoLayer.current?.remove();
    lassoLayer.current = null;
  };

  const toggleLasso = (mode: Exclude<LassoMode, null>) => {
    if (lasso === 'shape') cancelShape();
    setLasso((cur) => (cur === mode ? null : mode));
  };

  return (
    <div className="relative overflow-hidden rounded-lg border bg-card shadow-sm" data-testid="dispatch-map">
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2">
        {renumber ? (
          <span className="text-xs font-medium text-amber-800">
            Setting route order: click the pins in driving order ({renumber.order.length} of {renumber.scope.length} numbered).
          </span>
        ) : (
          <>
            <button
              type="button"
              onClick={() => toggleLasso('box')}
              className={`rounded-md border px-3 py-1 text-xs font-medium transition ${
                lasso === 'box' ? 'border-amber-600 bg-amber-600 text-white' : 'bg-background hover:border-primary/50'
              }`}
              data-testid="map-lasso-box"
            >
              {lasso === 'box' ? 'Drag a box on the map' : 'Drag a box'}
            </button>
            <button
              type="button"
              onClick={() => toggleLasso('shape')}
              className={`rounded-md border px-3 py-1 text-xs font-medium transition ${
                lasso === 'shape' ? 'border-amber-600 bg-amber-600 text-white' : 'bg-background hover:border-primary/50'
              }`}
              data-testid="map-lasso-shape"
            >
              {lasso === 'shape' ? `Click the corners (${shapePoints.length})` : 'Draw a shape'}
            </button>
            {lasso === 'shape' && (
              <>
                <button type="button" onClick={finishShape} disabled={shapePoints.length < 3} className="rounded-md border bg-background px-3 py-1 text-xs font-medium disabled:opacity-50" data-testid="map-lasso-finish">
                  Finish shape
                </button>
                <button type="button" onClick={cancelShape} className="text-xs text-muted-foreground hover:text-foreground">
                  Cancel
                </button>
              </>
            )}
            {lasso !== 'shape' && (
              <span className="text-xs text-muted-foreground">or click pins one by one</span>
            )}
          </>
        )}
        {selectedIds.length > 0 && !renumber && (
          <button type="button" onClick={clearSelection} className="ml-auto text-xs text-muted-foreground hover:text-foreground" data-testid="map-clear-selection">
            Clear selection
          </button>
        )}
      </div>

      <div ref={container} className={`w-full ${variant === 'waiting' ? 'h-[460px]' : 'h-[420px]'}`} />

      {/* One swatch per contractor on the map, the same colour the board's
          Assigned column uses, so the two can be read against each other. */}
      {legend.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-3 py-1.5 text-xs" data-testid="map-legend">
          {legend.map((l) => (
            <span key={l.id ?? 'none'} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-3 w-3 rounded-full border border-white shadow" style={{ background: l.color }} />
              {l.name} <span className="text-muted-foreground">({l.count})</span>
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <span className="inline-block h-3 w-3 rounded-full border-2 border-amber-600" /> selected
          </span>
        </div>
      )}

      {/* Stated on the map, not in a log. A stop with no coordinates cannot be
          lassoed, so a dispatcher working only from the map would never see it. */}
      {missing > 0 && (
        <div className="border-t bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {missing} job{missing === 1 ? ' has' : 's have'} no coordinates and {missing === 1 ? 'is' : 'are'} not on the map.
          {' '}Use the table below for {missing === 1 ? 'it' : 'them'}.
        </div>
      )}

      {selectedIds.length > 0 && !renumber && (
        <div className="border-t p-3">
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <span className="text-sm"><strong>{totals.stops}</strong> stop{totals.stops === 1 ? '' : 's'} selected on the map</span>
            {selectedIds.length > totals.stops && (
              <span className="text-xs text-muted-foreground">+ {selectedIds.length - totals.stops} ticked in the list without a pin</span>
            )}
            <span className="text-sm"><strong>{money(totals.amount)}</strong></span>
            <span className="text-sm text-muted-foreground">
              {totals.hours > 0 ? `${totals.hours.toFixed(1)} hrs budgeted` : 'no hours budgeted'}
            </span>
          </div>
          {quickDispatch && (
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Dispatch on</label>
                <input
                  type="date"
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                  value={dispatchOn}
                  onChange={(e) => setDispatchOn(e.target.value)}
                  data-testid="map-dispatch-date"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Contractor</label>
                <select
                  className="h-9 w-44 rounded-md border border-input bg-background px-2 text-sm"
                  value={dispatchTo}
                  onChange={(e) => setDispatchTo(e.target.value)}
                  data-testid="map-dispatch-contractor"
                >
                  <option value="">Leave as is / unassigned</option>
                  {contractors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <button
                type="button"
                onClick={() => quickDispatch.onRun({ scheduledDate: dispatchOn, assignedToId: dispatchTo ? Number(dispatchTo) : null })}
                disabled={quickDispatch.busy || !dispatchOn}
                className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
                data-testid="map-dispatch-apply"
              >
                {quickDispatch.busy ? 'Dispatching…' : `Dispatch ${selectedIds.length}`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
