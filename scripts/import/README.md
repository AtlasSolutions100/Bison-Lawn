# Importing a Service Autopilot export

`service-autopilot-to-sql.js` turns Adam's two exports into one reviewable
`.sql` file. Parsing happens locally where the xlsx reader lives; the output is
read before it runs, because it touches every customer record he has.

```
npm install --no-save xlsx@0.18.5
node service-autopilot-to-sql.js          # writes import.sql
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
