# Importing a Service Autopilot export

`service-autopilot-to-sql.cjs` turns Adam's two exports into one reviewable
`.sql` file. Parsing happens locally where the xlsx reader lives; the output is
read before it runs, because it touches every customer record he has.

```
npm install --no-save xlsx@0.18.5
node service-autopilot-to-sql.cjs          # writes import.sql
# read it, then:
docker exec -i <db> psql -U bison -d bisonlawn -v ON_ERROR_STOP=1 -q < import.sql
```

Everything upserts on `external_id`, so re-running updates rather than
duplicating. `property_data` is **merged**, not replaced, so anything typed in
this app survives a re-import while the exported values refresh.

## Two things the export will catch you out on

**`Code` is not unique.** `PEST` covers all four Pest Control tiers, `TREE`
covers both Tree Removal and Tree Service. Keying services on `Code` alone
silently collapsed ten services into four — a quiet loss, since the import
reports success and the count is only wrong if you check it. The key is
`Code::ServiceName`; ServiceName is unique across all 146.

**Three customers have no `UserName`**, Adam among them. Dropping them loses
live accounts and a null key duplicates them next time, so they get a
deterministic `NOUSER-<name>` key instead.

## What the export does not contain

The **rate matrix bands**. Services arrive with a rate, budgeted hours and which
property detail prices them (`MatrixCustomField`), but not the From/To/Rate rows
— his nineteen-band mowing matrix is not in the file. Those are entered in the
app or exported separately from Service Autopilot.

Also absent: jobs, invoices, estimates and payment history. This brings across
the customer list and the service catalogue, nothing more.

## Billing columns

The customer export carries a full billing record and this script ignored it
until 2026-09-08, so the first import left all 709 customers with an empty
billing record and every invoice addressed the property being mowed. That is
wrong for the property-managed accounts, which are a large share of the book —
`B.S.P.M. 1712 W Durham Dr` is serviced in Coeur d'Alene, Idaho and billed to
Sequim, **Washington**.

Now mapped, under the names his export actually uses:

| Export column | Column here |
|---|---|
| `NameOnInvoice` | `name_on_invoice` |
| `BillingAddress` | `billing_address_line1` |
| `BillingCity` / `BillingState` / `BillingZip` | `billing_city` / `billing_state` / `billing_postal_code` |
| `BillingEmail` | `billing_email` |
| `AccountNumber` | `account_number` |
| `BillingTerms` | `billing_terms` |
| `InvoiceFrequency` | `invoice_frequency` |
| `InvoiceDelivery` | `invoice_delivery` (email / print / both) |
| `AccountType` | `account_type` (residential / commercial) |

`InvoiceDelivery` and `AccountType` are constrained sets, so his wording is
mapped: "Email and Print" becomes `both`. Anything unrecognised becomes null
rather than a wrong guess — "not set" is visible in the app, whereas quietly
filing a customer as Residential decides how their mowing is edged.

The billing columns update with `COALESCE(EXCLUDED.x, clients.x)`: a re-import
fills blanks and refreshes values, but never wipes a billing address someone
corrected in the app with a blank column from a stale export.

**Read this before re-importing.** The billing columns are safe, but the older
columns in the same statement are not: `name`, `service_address`, `city`,
`state`, `postal_code`, `email`, `phone`, `map_code` and `account_balance` are
overwritten from the export outright. Anything corrected in the app since the
last import is lost. On the 2026-09-08 run that mattered: 628 of 698 customers
carry payment terms and all 698 carry a delivery preference, so there is a lot
to gain — but it is a decision, not a routine step.
