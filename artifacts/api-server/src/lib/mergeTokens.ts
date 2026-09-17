import type { Client, CompanyProfile, Estimate, Invoice } from "@workspace/db";

/**
 * The owner's merge tokens, in his own square-bracket syntax.
 *
 * Deliberately NOT the `{{token}}` syntax the spring letter uses. He has years
 * of documents written as `[clientfname]`, pasted out of his previous system,
 * and asking him to rewrite them all is the kind of migration tax that stops a
 * tool being adopted. Both syntaxes coexist: the spring letter keeps `{{...}}`,
 * everything new reads `[...]`.
 *
 * Matching is case-insensitive because his own documents are inconsistent —
 * `[Bison_Full_Service]` and `[clientname]` appear in the same file.
 */
export type MergeContext = {
  client?: Pick<
    Client,
    | "name"
    | "serviceAddress"
    | "addressLine2"
    | "city"
    | "state"
    | "postalCode"
    | "email"
    | "phone"
    // The Bill To block, for a letter aimed at whoever pays rather than at the
    // lawn. Optional on the type so a caller that only has the contact columns
    // still compiles; each token falls back to the service address.
    | "nameOnInvoice"
    | "billingAddressLine1"
    | "billingAddressLine2"
    | "billingCity"
    | "billingState"
    | "billingPostalCode"
    | "billingEmail"
  > | null;
  company: CompanyProfile;
  /** Rendered block of quoted services, for estimate documents. */
  servicesBlock?: string | null;
  quoteTotal?: number | null;
  /**
   * The invoice a past-due or final notice is about. `daysOverdue` is worked
   * out by the caller against the office's calendar day, not here, so a
   * preview and a real send agree on the number.
   */
  invoice?: (Pick<Invoice, "id" | "number" | "invoiceDate" | "dueDate" | "total" | "amountPaid"> & {
    daysOverdue?: number | null;
  }) | null;
  /** The estimate a follow-up is chasing. */
  estimate?: Pick<Estimate, "id" | "sentAt" | "total"> | null;
  /** The job a board or waiting-list email is about ("blow-out day is [servicedate]"). */
  job?: { scheduledDate?: string | null; serviceName?: string | null } | null;
  /**
   * Anything the sender typed in by hand — the date he is filling into a
   * "sprinkler blow-out day" letter, say. Wins over every computed value so
   * the office can always override what the app worked out.
   */
  extra?: Record<string, string> | null;
};

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

/**
 * The calendar day an instant falls on in the office's timezone.
 *
 * Deliberately a copy of `localDay` in automationRunner rather than an import:
 * this file is the pure text renderer and the runner pulls in the database, so
 * importing it here would drag the whole db module into every preview.
 */
function officeDay(value: Date): string {
  const timeZone = process.env.APP_TIME_ZONE || "America/Los_Angeles";
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone }).format(value);
  } catch {
    return value.toISOString().slice(0, 10);
  }
}

/**
 * A date-only string the way he writes dates in a letter: "September 15, 2026".
 * A raw "2026-09-15" in a past-due notice reads like a database, not a letter.
 *
 * An instant (an estimate's sent-at, a job's completed-at) is turned into the
 * calendar day the OFFICE was on, not the day UTC was on. A quote he sent at
 * 5:30 pm on the 15th is already the 16th in UTC, and a follow-up letter that
 * says "we sent over an estimate on September 16" about Tuesday's quote makes
 * him look like he cannot read his own records. The automations already decide
 * WHEN to fire off the office day; the letter has to print the same day.
 */
export function letterDate(value: string | Date | null | undefined): string {
  if (!value) return "";
  const iso = value instanceof Date ? officeDay(value) : value.trim();
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!parts) return iso;
  const d = new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])));
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * Marks where a known token rendered to nothing, so the tidy pass can clean up
 * around exactly those spots and leave every other character alone. A NUL byte
 * cannot occur in a template body, so it can never collide with real content.
 */
const EMPTY = String.fromCharCode(0);

/**
 * First name for `[clientfname]`.
 *
 * Derived rather than stored: the app has always captured one `name`, and
 * adding a separate first-name field would leave it empty for every existing
 * customer, so every letter would open "Dear ,". Taking the first word is right
 * for "Sarah Thompson" and harmless for "Ridgeline Property Group" — it greets
 * them as "Ridgeline", which reads oddly but is not wrong, and the office can
 * always edit the name field if it matters.
 */
export function firstNameOf(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "";
  return trimmed.split(/\s+/)[0]!;
}

function buildMap(ctx: MergeContext): Record<string, string> {
  const c = ctx.client;
  const co = ctx.company;
  const inv = ctx.invoice;
  const est = ctx.estimate;
  const job = ctx.job;
  return {
    clientname: c?.name ?? "",
    clientfname: firstNameOf(c?.name),
    clientemail: c?.email ?? "",
    clientphone: c?.phone ?? "",
    physicaladdress1: c?.serviceAddress ?? "",
    physicaladdress2: c?.addressLine2 ?? "",
    physicalcity: c?.city ?? "",
    physicalstate: c?.state ?? "",
    physicalzip: c?.postalCode ?? "",

    // The Bill To block, for a letter that goes to whoever pays rather than to
    // the lawn: a property manager, a second home, a CPA. Each one falls back
    // to the service address, because a letter addressed to nowhere is worse
    // than one addressed to the house — most customers are billed there anyway.
    billingname: c?.nameOnInvoice?.trim() || c?.name || "",
    billingaddress1: c?.billingAddressLine1?.trim() || c?.serviceAddress || "",
    billingaddress2: c?.billingAddressLine2?.trim() || c?.addressLine2 || "",
    billingcity: c?.billingCity?.trim() || c?.city || "",
    billingstate: c?.billingState?.trim() || c?.state || "",
    billingzip: c?.billingPostalCode?.trim() || c?.postalCode || "",
    billingemail: c?.billingEmail?.trim() || c?.email || "",

    companyname: co.name,
    companyaddress: [co.addressLine1, co.addressLine2].filter(Boolean).join(", "),
    companycity: co.city ?? "",
    companystate: co.state ?? "",
    companyzip: co.postalCode ?? "",
    companyphonenumber: co.phone ?? "",
    companyemail: co.email ?? "",
    companywebsite: co.website ?? "",
    signatureline: co.signatureLine,

    quotetotal: ctx.quoteTotal != null ? money(ctx.quoteTotal) : "",
    // His two estimate documents each name the quoted-services block with a
    // different token. Both resolve to the same rendered block rather than
    // making him standardise his documents on ours.
    bison_full_service: ctx.servicesBlock ?? "",
    "estimate_bundle:_estimate_description_only": ctx.servicesBlock ?? "",

    // Invoice tokens for the past-due and final-notice letters. The balance is
    // what is still owed, not the invoice total — a customer who paid half
    // must be chased for the half, or the letter is simply wrong.
    // An invoice imported before we started numbering has a blank number
    // column; the lists all show its id instead. The letter has to agree with
    // them, or a past-due notice goes out reading "invoice # for $45.00" while
    // the screen he is looking at calls it invoice #319.
    invoicenumber: inv?.number != null ? String(inv.number) : inv?.id != null ? String(inv.id) : "",
    invoicedate: letterDate(inv?.invoiceDate),
    invoiceduedate: letterDate(inv?.dueDate),
    invoicetotal: inv ? money(inv.total) : "",
    invoicebalance: inv ? money(Math.max(0, Math.round((inv.total - inv.amountPaid) * 100) / 100)) : "",
    daysoverdue: inv?.daysOverdue != null ? String(inv.daysOverdue) : "",

    // Estimate tokens for the follow-up letters.
    estimatenumber: est ? String(est.id) : "",
    estimatesentdate: letterDate(est?.sentAt),
    estimatetotal: est ? money(est.total) : "",

    // Job tokens, for a letter sent from the board or the waiting list.
    servicedate: letterDate(job?.scheduledDate),
    servicename: job?.serviceName ?? "",

    // Hand-typed values last, so they win.
    ...Object.fromEntries(
      Object.entries(ctx.extra ?? {}).map(([k, v]) => [k.toLowerCase().replace(/^\[|\]$/g, ""), v ?? ""]),
    ),
  };
}

const EMPTY_COMPANY = {
  name: "",
  addressLine1: null,
  addressLine2: null,
  city: null,
  state: null,
  postalCode: null,
  phone: null,
  email: null,
  website: null,
  signatureLine: "",
} as unknown as CompanyProfile;

/** Every token this renderer understands, for showing the office what it can use. */
export function supportedTokens(): string[] {
  return Object.keys(buildMap({ company: EMPTY_COMPANY })).map((t) => `[${t}]`);
}

/**
 * Replace every `[token]` in `body`.
 *
 * An unrecognised token is left exactly as written rather than blanked. A
 * customer seeing `[speciallowerprice]` in a letter is a visible, fixable
 * mistake; silently deleting it produces a sentence that reads fine and is
 * wrong, which nobody catches until it has gone out to 400 people.
 */
export function renderTemplate(body: string, ctx: MergeContext): string {
  const map = buildMap(ctx);
  const substituted = body.replace(/\[([A-Za-z0-9_:]+)\]/g, (whole, token: string) => {
    const value = map[token.toLowerCase()];
    if (value === undefined) return whole;
    return value === "" ? EMPTY : value;
  });
  return tidy(substituted);
}

/**
 * Clean up what an empty token leaves behind — and nothing else.
 *
 * His letters juxtapose tokens with their own punctuation:
 * `[physicalcity], [physicalstate] [physicalzip]` and
 * `[companyphonenumber] | [companyemail]`. A customer with no zip on file
 * renders "Bozeman,  " with a dangling comma; a line holding only
 * `[physicaladdress2]` renders as a blank line inside the address block.
 *
 * The cleanup is anchored to the EMPTY marker, so it can only ever touch
 * punctuation sitting directly against a value that came out empty. An earlier
 * version worked line-by-line and stripped trailing separators from any line
 * containing a token — which quietly deleted the comma in "Dear [clientfname],"
 * and in his "Your Friendly Bison," sign-off. Author punctuation that is not
 * adjacent to an empty value is now untouchable by construction.
 *
 * Deliberately not general prose repair. It cannot fix a sentence whose meaning
 * depended on the missing value — "contact us at ." is left visible, because the
 * honest fix is to fill in the phone number, not to silently reword his letter.
 */
function tidy(substituted: string): string {
  const marker = EMPTY;
  const kept: string[] = [];

  for (const raw of substituted.split("\n")) {
    // A line that held only empty values (address line 2, say) disappears.
    // A blank line the author typed has no marker and survives.
    if (raw.includes(marker) && !/[A-Za-z0-9]/.test(raw)) continue;

    const line = raw
      // A separator immediately before or after an empty value belonged to it.
      .replace(new RegExp("[ \\t]*[,|][ \\t]*" + marker, "g"), marker)
      .replace(new RegExp(marker + "[ \\t]*[,|][ \\t]*", "g"), marker)
      .replace(new RegExp(marker, "g"), "")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+$/, "");
    kept.push(line);
  }
  return kept.join("\n");
}

/** Tokens present in `body` that this renderer cannot fill. */
export function unknownTokensIn(body: string): string[] {
  const known = new Set(Object.keys(buildMap({ company: EMPTY_COMPANY })));
  const found = new Set<string>();
  for (const m of body.matchAll(/\[([A-Za-z0-9_:]+)\]/g)) {
    const t = m[1]!.toLowerCase();
    if (!known.has(t)) found.add(m[0]!);
  }
  return [...found];
}
