/**
 * Turn Adam's Service Autopilot exports into SQL.
 *
 * Parsing happens here (where the xlsx reader lives) and the output is a single
 * reviewable .sql file rather than a live connection, so the exact statements
 * that touch 698 real customer records can be read before they run.
 *
 * Everything upserts on external_id, so running it twice updates rather than
 * duplicating.
 */
const XLSX = require('xlsx');
const fs = require('fs');

const ROOT = 'C:/Users/kobys/OneDrive/Desktop/OptionallyWorking/BisonLawn';
const OUT = 'C:/Users/kobys/.claude-second/jobs/324ddeb4/tmp/import.sql';

const s = (v) => {
  const t = String(v ?? '').trim();
  return t === '' ? null : t;
};
const num = (v) => {
  const t = s(v);
  if (t === null) return null;
  const n = Number(t.replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
};
/** Dollar-quoted so apostrophes in names and notes need no escaping at all. */
const q = (v) => (v === null || v === undefined ? 'NULL' : `$sa$${String(v)}$sa$`);
const qn = (v) => (v === null || v === undefined ? 'NULL' : String(v));

// His column name on the left, the estimate-field label we use on the right.
// "Driveway Sq. Ft." and "Driveway Sqft" are the same measurement spelled two
// ways; mapping them keeps one field rather than creating a near-duplicate the
// office would have to choose between.
const PROPERTY_FIELDS = [
  ['TurfSqft', 'Turf Sqft'],
  ['SprinklerZones', 'Sprinkler Zones'],
  ['BedSqft', 'Bed Sqft'],
  ['DrivewaySqFt', 'Driveway Sqft'],
  ['GateCode', 'Gate Code'],
  ['GarageCode', 'Garage Code'],
  ['Dog', 'Dog'],
  ['BackflowDevices', 'Backflow Devices'],
  ['SynctaID', 'Syncta ID'],
  ['RoofGutterLine', 'Roof & Gutter Line'],
  ['HouseSQFT', 'House SQFT'],
  ['HoseBibs', 'Hose Bibs'],
  ['Hours', 'Hours'],
  ['Rental', 'Rental'],
  ['ExteriorWindows', 'Exterior Windows'],
  ['InteriorWindows', 'Interior Windows'],
];
const MATRIX_FIELD_ALIASES = { 'Driveway Sq. Ft.': 'Driveway Sqft' };

const out = [];
out.push('-- Generated from Adam\'s Service Autopilot exports. Upserts on external_id.');
out.push('BEGIN;');
out.push('');

// ---------------------------------------------------------------- services --
const svcRows = XLSX.utils.sheet_to_json(
  XLSX.readFile(`${ROOT}/services.xls`).Sheets.ServiceExport,
  { defval: '', raw: false },
);
const active = svcRows.filter((r) => String(r.Active) === 'True');

// Fields the services price off that we do not have yet. Created before the
// services so pricing_field_id can resolve.
const neededFields = new Set(
  active.map((r) => MATRIX_FIELD_ALIASES[s(r.MatrixCustomField)] ?? s(r.MatrixCustomField)).filter(Boolean),
);
out.push('-- Property details his services price off, created if missing.');
for (const label of [...neededFields].sort()) {
  out.push(
    `INSERT INTO estimate_fields (label, field_type) SELECT ${q(label)}, 'calculable' ` +
      `WHERE NOT EXISTS (SELECT 1 FROM estimate_fields WHERE lower(label) = lower(${q(label)}));`,
  );
}
out.push('');

out.push(`-- ${active.length} active services.`);
for (const r of active) {
  const code = s(r.Code);
  const name = s(r.ServiceName);
  if (!code || !name) continue;
  // Service Autopilot reuses a Code across services — PEST covers all four Pest
  // Control tiers, TREE covers Tree Removal and Tree Service. Keying on Code
  // alone silently collapsed ten services into four on the first run. ServiceName
  // is unique across all 146, so the pair identifies a service and still keeps
  // the code visible in the key.
  const externalId = `${code}::${name}`;
  const matrixField = MATRIX_FIELD_ALIASES[s(r.MatrixCustomField)] ?? s(r.MatrixCustomField);
  const pricingField = matrixField
    ? `(SELECT id FROM estimate_fields WHERE lower(label) = lower(${q(matrixField)}) LIMIT 1)`
    : 'NULL';
  out.push(
    `INSERT INTO services (external_id, name, description, rate, billable_hours, quantity, pricing_field_id, pricing_equations)
VALUES (${q(externalId)}, ${q(name)}, ${q(s(r.InvoiceDescription) ?? s(r.EstimateDescription))}, ${qn(num(r.DefaultRate) ?? 0)}, ${qn(num(r.DefaultBudgetedHours))}, 1, ${pricingField}, '[]'::jsonb)
ON CONFLICT (external_id) DO UPDATE SET
  name = EXCLUDED.name, description = EXCLUDED.description, rate = EXCLUDED.rate,
  billable_hours = EXCLUDED.billable_hours, pricing_field_id = EXCLUDED.pricing_field_id;`,
  );
}
out.push('');

// --------------------------------------------------------------- customers --
const cliRows = XLSX.utils.sheet_to_json(
  XLSX.readFile(`${ROOT}/Customer_List.xls`).Sheets.Clients,
  { defval: '', raw: false },
);

let skipped = 0;
out.push(`-- ${cliRows.length} customers from the export.`);
for (const r of cliRows) {
  // Three real customers in this export have no UserName, Adam himself among
  // them. Dropping them loses live accounts; leaving the key null duplicates
  // them on the next import. A deterministic key off the sorted name is stable
  // across exports and collides with nothing, since real UserNames never start
  // with this prefix.
  const ext = s(r.UserName) ?? (s(r.ClientName) ? `NOUSER-${s(r.ClientName).toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 40)}` : null);
  // NameOnInvoice reads as a person ("Duke Custom Plumbing"); ClientName is
  // sorted ("Plumbing, Duke Custom"). Prefer the readable one.
  const name = s(r.NameOnInvoice) ?? s(r.ClientName) ?? s(r.ShipToName);
  if (!ext || !name) { skipped += 1; continue; }

  const property = {};
  for (const [col, label] of PROPERTY_FIELDS) {
    const v = s(r[col]);
    if (v) property[label] = v;
  }

  const status = String(r.CustomerType ?? '').toLowerCase() === 'client' ? 'client' : 'lead';
  out.push(
    `INSERT INTO clients (external_id, name, status, service_address, address_line2, city, state, postal_code,
  lat, lng, email, phone, additional_contact, map_note, map_code, account_balance, property_data)
VALUES (${q(ext)}, ${q(name)}, ${q(status)}, ${q(s(r.PhysicalAddress))}, NULL, ${q(s(r.PhysicalCity))}, ${q(s(r.PhysicalState))}, ${q(s(r.PhysicalZip))},
  ${qn(num(r.Latitude))}, ${qn(num(r.Longitude))}, ${q(s(r.Email) ?? s(r.BillingEmail))}, ${q(s(r.CellPhone) ?? s(r.HomePhone))},
  ${q(s(r.HomePhone) && s(r.CellPhone) && s(r.HomePhone) !== s(r.CellPhone) ? `Home ${s(r.HomePhone)}` : null)},
  ${q(s(r.OfficeNotes))}, ${q(s(r.MapCode))}, ${qn(num(r.AccountBalance) ?? 0)}, ${q(JSON.stringify(property))}::jsonb)
ON CONFLICT (external_id) DO UPDATE SET
  name = EXCLUDED.name, status = EXCLUDED.status, service_address = EXCLUDED.service_address,
  city = EXCLUDED.city, state = EXCLUDED.state, postal_code = EXCLUDED.postal_code,
  lat = EXCLUDED.lat, lng = EXCLUDED.lng, email = EXCLUDED.email, phone = EXCLUDED.phone,
  additional_contact = EXCLUDED.additional_contact, map_note = EXCLUDED.map_note,
  map_code = EXCLUDED.map_code, account_balance = EXCLUDED.account_balance,
  -- Merge, not replace: anything typed in our app for this customer survives a
  -- re-import, while the exported values refresh.
  property_data = clients.property_data || EXCLUDED.property_data;`,
  );
}

out.push('');
out.push('COMMIT;');
out.push('');
out.push("SELECT 'services: ' || count(*) FROM services WHERE external_id IS NOT NULL;");
out.push("SELECT 'clients:  ' || count(*) FROM clients WHERE external_id IS NOT NULL;");
out.push("SELECT 'with map code: ' || count(*) FROM clients WHERE external_id IS NOT NULL AND map_code IS NOT NULL;");
out.push("SELECT 'with turf sqft: ' || count(*) FROM clients WHERE property_data ? 'Turf Sqft';");

fs.writeFileSync(OUT, out.join('\n'), 'utf8');

console.log(`services active: ${active.length} of ${svcRows.length}`);
console.log(`customers:       ${cliRows.length}, skipped for missing id/name: ${skipped}`);
console.log(`new fields to create: ${[...neededFields].sort().join(', ')}`);
console.log(`\nwrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB, ${out.length} statements-ish)`);
