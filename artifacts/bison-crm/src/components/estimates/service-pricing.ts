import type { EstimateField, Service } from '@workspace/api-client-react';

/**
 * The estimate builder's copy of the server's pricing, in its own file so a
 * test can run it side by side with the real save route (api-server
 * test/adamBugs.test.ts). It mirrors priceEstimateLines in
 * artifacts/api-server/src/routes/estimates.ts, and B1 is what happens when
 * the two drift: the quote he builds on screen stops being the quote that gets
 * saved, and the saved one is the one that prints on the customer's copy.
 */

export type ServiceLineDraft = {
  /** Local identity only; never sent. */
  key: number;
  serviceId: number;
  label: string;
  /** The property measurement the matrix prices from (Turf Sqft, zones). */
  value: string;
  /** Blank means the service's own default. */
  quantity: string;
  /** Blank means the service's visits per season, or one. */
  visits: string;
  packageId: number | null;
  packageKey: string | null;
  packageName: string | null;
};

/**
 * Which property detail a service prices from. Null pricingFieldId means turf
 * square footage — what every matrix meant before that column existed — so the
 * turf field is found by its label, the same way the server does it.
 */
export function pricingFieldFor(service: Service, fields: EstimateField[] | undefined): EstimateField | null {
  if (!fields) return null;
  if (service.pricingFieldId != null) return fields.find(f => f.id === service.pricingFieldId) ?? null;
  return (
    fields.find(f => /turf/i.test(f.label) && /sq/i.test(f.label)) ??
    fields.find(f => /sq\s?ft|sqft|square/i.test(f.label) && f.fieldType === 'calculable') ??
    null
  );
}

export const hasMatrix = (service: Service) => (service.pricingEquations ?? []).length > 0;

/**
 * A measurement the way it gets typed or imported: "14,500", " 6200 ".
 * Null means there is no number here, which is not the same as zero.
 */
export function measurementOf(raw: string | null | undefined): number | null {
  const text = String(raw ?? '').replace(/[$,\s]/g, '');
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** Where the number that priced a line came from, so the screen can say so. */
export type MeasureSource = 'line' | 'estimate' | 'account';

/**
 * The three places a service line's measurement can come from. The server
 * reads all three; the builder used to read only the box on the line, so
 * clearing that box showed the flat rate while the save wrote the band price
 * off the account — $1,260 on his screen, $2,660 on the customer's copy.
 */
export type MeasureSources = {
  fields: EstimateField[] | undefined;
  /**
   * This estimate's own property details, by field id. Only the ticked ones
   * are sent to the server, so only the ticked ones may price a line here.
   */
  fieldValues?: Record<number, { selected: boolean; value: string }> | null;
  /** What the customer's file holds, by the detail's label. */
  propertyData?: Record<string, string> | null;
};

/**
 * The measurement a line is priced from, in the order the office expects it:
 * what was typed on the line, then what was measured on this estimate's own
 * property details, then what the account says. The same order, off the same
 * three places, as measurementFor in routes/estimates.ts.
 */
export function measurementForLine(
  service: Service,
  value: string,
  sources?: MeasureSources,
): { value: number | null; from: MeasureSource | null } {
  const typed = measurementOf(value);
  if (typed != null) return { value: typed, from: 'line' };
  if (!sources) return { value: null, from: null };
  const field = pricingFieldFor(service, sources.fields);
  if (!field) return { value: null, from: null };
  const onThisEstimate = sources.fieldValues?.[field.id];
  const measured = onThisEstimate?.selected ? measurementOf(onThisEstimate.value) : null;
  if (measured != null) return { value: measured, from: 'estimate' };
  const onFile = measurementOf(sources.propertyData?.[field.label]);
  return onFile == null ? { value: null, from: null } : { value: onFile, from: 'account' };
}

/** Mirrors calculatePrice on the server: the band for the measurement, base plus increments. */
export function serviceUnitPrice(
  service: Service,
  value: string,
  sources?: MeasureSources,
): { rate: number; fromMatrix: boolean; measurement: number | null; measuredFrom: MeasureSource | null } {
  // Work billed by the hour is quoted at the hours it is budgeted for times the
  // hourly rate, the way the server prices it — the bare $65/hr is not what a
  // three-hour clean-up costs.
  if (service.billingMode === 'time') {
    return {
      rate: Math.round(service.rate * (service.billableHours ?? 1) * 100) / 100,
      fromMatrix: false,
      measurement: null,
      measuredFrom: null,
    };
  }
  const found = measurementForLine(service, value, sources);
  const numeric = found.value;
  // A band carrying no money at all is a placeholder — an empty row left by an
  // "Add tier" click or by the import. The server skips those; this screen used
  // to match on them, so a 1,500 sqft lawn read $0.00 in the builder and then
  // saved at the first real band's price. The quote he was looking at and the
  // quote the customer got were different numbers.
  // A band with a floor and nothing else — "never less than $49" — is a real
  // band, so it counts here exactly as it counts on the server.
  const eqs = (service.pricingEquations ?? []).filter(
    e => e.basePrice > 0 || e.incrementPrice > 0 || (e.minPrice ?? 0) > 0,
  );
  if (eqs.length > 0 && numeric != null) {
    let idx = eqs.findIndex(e => e.upToSqft != null && numeric <= e.upToSqft);
    if (idx === -1) {
      idx = eqs.findIndex(e => e.upToSqft == null);
      if (idx === -1) idx = eqs.length - 1;
    }
    const eq = eqs[idx];
    let price = eq.basePrice;
    if (numeric > eq.baseSqft && eq.incrementSqft > 0) {
      price += Math.ceil((numeric - eq.baseSqft) / eq.incrementSqft) * eq.incrementPrice;
    }
    // The floor goes on last, over the base and every increment — the same
    // order calculatePrice does it in. Leaving it out here is how the builder
    // would show $30 for a lawn the saved quote then charged $49 for, which is
    // the same complaint all over again in a new place.
    const floor = eq.minPrice ?? null;
    if (floor != null && floor > price) price = floor;
    return {
      rate: Math.round(price * 100) / 100,
      fromMatrix: true,
      measurement: numeric,
      measuredFrom: found.from,
    };
  }
  return {
    rate: Math.round(service.rate * 100) / 100,
    fromMatrix: false,
    measurement: numeric,
    measuredFrom: found.from,
  };
}

/** A typed count, or the fallback when the box is blank. Null when it is not a number. */
export function lineCount(raw: string, fallback: number): number | null {
  if (raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function defaultVisits(service: Service) {
  return service.visitsPerSeason ?? 1;
}

export function serviceLineMath(service: Service, line: ServiceLineDraft, sources?: MeasureSources) {
  const unit = serviceUnitPrice(service, line.value, sources);
  const quantity = lineCount(line.quantity, service.quantity ?? 1);
  const visits = lineCount(line.visits, defaultVisits(service));
  const valid = quantity != null && visits != null;
  const total = valid ? Math.round(unit.rate * quantity * visits * 100) / 100 : null;
  return { ...unit, quantity, visits, valid, total };
}

/**
 * What a property detail on its own adds to the estimate. The comma off the
 * Service Autopilot import is a number here too: a bare Number() turned
 * "14,500" into nothing, which put "Enter a number" and a dead Save button on
 * every estimate for an imported customer while the server had been happy to
 * price that very same sqft all along.
 */
export function fieldLinePrice(field: EstimateField, value: string): number | null {
  if (field.fieldType !== 'calculable') return null;
  const numeric = measurementOf(value);
  if (numeric == null) return null;
  const unitSize = field.unitSize && field.unitSize > 0 ? field.unitSize : 1;
  return Math.round((numeric / unitSize) * (field.pricePerUnit ?? 0) * 100) / 100;
}

/** True when a ticked detail holds something the server would refuse to price. */
export function calculableNeedsNumber(field: EstimateField, value: string): boolean {
  return field.fieldType === 'calculable' && measurementOf(value) == null;
}

/**
 * What a property detail starts at on a new estimate: whatever the customer's
 * file holds, ticked because it is known. A measurement goes in as the plain
 * number — the sqft box is a number box and shows nothing at all for the
 * "14,500" the import wrote, so he would be looking at an empty box with a
 * price beside it. A text detail keeps exactly what he wrote.
 */
export function prefillFieldValue(
  field: EstimateField,
  saved: string | undefined,
): { selected: boolean; value: string } {
  const numeric = field.fieldType === 'calculable' ? measurementOf(saved) : null;
  return { selected: saved != null, value: numeric != null ? String(numeric) : (saved ?? '') };
}
