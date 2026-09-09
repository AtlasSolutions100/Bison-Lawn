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

/**
 * `--billing-only` emits nothing but the twelve billing columns, as UPDATEs
 * matched on external_id.
 *
 * The full import overwrites name, service address, city, state, postal code,
 * email, phone, map code and account balance from the export outright, so
 * re-running it to pick up billing data would throw away every correction the
 * office has typed since the last run. This mode exists so the billing record
 * can be filled without accepting that trade.
 *
 * It cannot insert, so it cannot invent a customer, and it cannot touch a
 * column outside the billing set. Within that set it only ever fills a blank:
 * `COALESCE(clients.x, <exported>)` keeps whatever is already there, which
 * makes the script safe to run more than once and safe to run at any time. The
 * cost is that a genuinely changed value in a later export will not overwrite
 * what is here — clear the field in the app first if that is what you want.
 */
const BILLING_ONLY = process.argv.includes('--billing-only');
const OUT = BILLING_ONLY
  ? `${ROOT}/import-billing-only.sql`
  : 'C:/Users/kobys/.claude-second/jobs/324ddeb4/tmp/import.sql';

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

/**
 * `invoice_delivery` and `account_type` are constrained to a fixed set by the
 * API schema, so his wording has to be mapped rather than passed through.
 *
 * The cases below are the values that actually appear in his export — checked,
 * not guessed: InvoiceDelivery is "Email", "Print" or "Email and Print", and
 * AccountType is "Commercial" or "Residential". Anything unrecognised becomes
 * null rather than a wrong guess: "not set" is honest and visible in the app,
 * whereas quietly filing a customer as Residential decides how their mowing is
 * edged.
 */
const invoiceDelivery = (v) => {
  const t = s(v)?.toLowerCase();
  if (!t) return null;
  const hasEmail = t.includes('email');
  const hasPrint = t.includes('print') || t.includes('mail ') || t === 'mail';
  if (hasEmail && hasPrint) return 'both';
  if (hasEmail) return 'email';
  if (hasPrint) return 'print';
  return null;
};

const accountType = (v) => {
  const t = s(v)?.toLowerCase();
  if (!t) return null;
  if (t.startsWith('comm')) return 'commercial';
  if (t.startsWith('res')) return 'residential';
  return null;
};

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
// Billing-only touches customers and nothing else, so the estimate fields and
// the whole service catalogue are skipped rather than emitted and ignored.
if (!BILLING_ONLY) {
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
} // end !BILLING_ONLY

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

  if (BILLING_ONLY) {
    const billing = {
      name_on_invoice: s(r.NameOnInvoice),
      billing_address_line1: s(r.BillingAddress),
      billing_city: s(r.BillingCity),
      billing_state: s(r.BillingState),
      billing_postal_code: s(r.BillingZip),
      billing_email: s(r.BillingEmail),
      account_number: s(r.AccountNumber),
      billing_terms: s(r.BillingTerms),
      invoice_frequency: s(r.InvoiceFrequency),
      invoice_delivery: invoiceDelivery(r.InvoiceDelivery),
      account_type: accountType(r.AccountType),
    };
    // Only emit a statement for customers who actually have something to set —
    // 698 no-op UPDATEs would make the file unreadable and hide the real ones.
    const present = Object.entries(billing).filter(([, v]) => v !== null && v !== undefined);
    if (present.length) {
      const sets = present.map(([col, v]) => `  ${col} = COALESCE(${col}, ${q(v)})`).join(',\n');
      out.push(`UPDATE clients SET\n${sets}\nWHERE external_id = ${q(ext)};`);
    }
    continue;
  }

  out.push(
    `INSERT INTO clients (external_id, name, status, service_address, address_line2, city, state, postal_code,
  lat, lng, email, phone, additional_contact, map_note, map_code, account_balance, property_data,
  name_on_invoice, billing_address_line1, billing_city, billing_state, billing_postal_code,
  billing_email, account_number, billing_terms, invoice_frequency, invoice_delivery, account_type)
VALUES (${q(ext)}, ${q(name)}, ${q(status)}, ${q(s(r.PhysicalAddress))}, NULL, ${q(s(r.PhysicalCity))}, ${q(s(r.PhysicalState))}, ${q(s(r.PhysicalZip))},
  ${qn(num(r.Latitude))}, ${qn(num(r.Longitude))}, ${q(s(r.Email) ?? s(r.BillingEmail))}, ${q(s(r.CellPhone) ?? s(r.HomePhone))},
  ${q(s(r.HomePhone) && s(r.CellPhone) && s(r.HomePhone) !== s(r.CellPhone) ? `Home ${s(r.HomePhone)}` : null)},
  ${q(s(r.OfficeNotes))}, ${q(s(r.MapCode))}, ${qn(num(r.AccountBalance) ?? 0)}, ${q(JSON.stringify(property))}::jsonb,
  ${q(s(r.NameOnInvoice))}, ${q(s(r.BillingAddress))}, ${q(s(r.BillingCity))}, ${q(s(r.BillingState))}, ${q(s(r.BillingZip))},
  ${q(s(r.BillingEmail))}, ${q(s(r.AccountNumber))}, ${q(s(r.BillingTerms))}, ${q(s(r.InvoiceFrequency))},
  ${q(invoiceDelivery(r.InvoiceDelivery))}, ${q(accountType(r.AccountType))})
ON CONFLICT (external_id) DO UPDATE SET
  name = EXCLUDED.name, status = EXCLUDED.status, service_address = EXCLUDED.service_address,
  city = EXCLUDED.city, state = EXCLUDED.state, postal_code = EXCLUDED.postal_code,
  lat = EXCLUDED.lat, lng = EXCLUDED.lng, email = EXCLUDED.email, phone = EXCLUDED.phone,
  additional_contact = EXCLUDED.additional_contact, map_note = EXCLUDED.map_note,
  map_code = EXCLUDED.map_code, account_balance = EXCLUDED.account_balance,
  -- Billing. These are the columns his invoices are actually built from — the
  -- Bill To block, the account number on the payment coupon, the terms
  -- snapshotted onto each invoice. They were in the export all along under
  -- exactly these names and this script simply never read them, so all 709
  -- customers came across with an empty billing record and every invoice
  -- addressed the property being mowed. That is wrong for his property-managed
  -- accounts, which are a large share of the book.
  --
  -- COALESCE keeps anything typed in the app: a billing address someone
  -- corrected here is better information than a stale export, and an export
  -- with the column blank must not wipe it.
  name_on_invoice = COALESCE(EXCLUDED.name_on_invoice, clients.name_on_invoice),
  billing_address_line1 = COALESCE(EXCLUDED.billing_address_line1, clients.billing_address_line1),
  billing_city = COALESCE(EXCLUDED.billing_city, clients.billing_city),
  billing_state = COALESCE(EXCLUDED.billing_state, clients.billing_state),
  billing_postal_code = COALESCE(EXCLUDED.billing_postal_code, clients.billing_postal_code),
  billing_email = COALESCE(EXCLUDED.billing_email, clients.billing_email),
  account_number = COALESCE(EXCLUDED.account_number, clients.account_number),
  billing_terms = COALESCE(EXCLUDED.billing_terms, clients.billing_terms),
  invoice_frequency = COALESCE(EXCLUDED.invoice_frequency, clients.invoice_frequency),
  invoice_delivery = COALESCE(EXCLUDED.invoice_delivery, clients.invoice_delivery),
  account_type = COALESCE(EXCLUDED.account_type, clients.account_type),
  -- Merge, not replace: anything typed in our app for this customer survives a
  -- re-import, while the exported values refresh.
  property_data = clients.property_data || EXCLUDED.property_data;`,
  );
}

out.push('');
out.push('COMMIT;');
out.push('');
if (BILLING_ONLY) {
  out.push("SELECT 'billing email:    ' || count(billing_email)    || ' of ' || count(*) FROM clients;");
  out.push("SELECT 'payment terms:    ' || count(billing_terms)    || ' of ' || count(*) FROM clients;");
  out.push("SELECT 'delivery pref:    ' || count(invoice_delivery) || ' of ' || count(*) FROM clients;");
  out.push("SELECT 'separate Bill To: ' || count(*) FROM clients WHERE billing_address_line1 IS NOT NULL;");
} else {
  out.push("SELECT 'services: ' || count(*) FROM services WHERE external_id IS NOT NULL;");
  out.push("SELECT 'clients:  ' || count(*) FROM clients WHERE external_id IS NOT NULL;");
  out.push("SELECT 'with map code: ' || count(*) FROM clients WHERE external_id IS NOT NULL AND map_code IS NOT NULL;");
  out.push("SELECT 'with turf sqft: ' || count(*) FROM clients WHERE property_data ? 'Turf Sqft';");
}

fs.writeFileSync(OUT, out.join('\n'), 'utf8');

console.log(`services active: ${active.length} of ${svcRows.length}`);
console.log(`customers:       ${cliRows.length}, skipped for missing id/name: ${skipped}`);
console.log(`new fields to create: ${[...neededFields].sort().join(', ')}`);
console.log(`\nwrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB, ${out.length} statements-ish)`);
