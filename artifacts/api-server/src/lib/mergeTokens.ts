import type { Client, CompanyProfile } from "@workspace/db";

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
    "name" | "serviceAddress" | "addressLine2" | "city" | "state" | "postalCode" | "email" | "phone"
  > | null;
  company: CompanyProfile;
  /** Rendered block of quoted services, for estimate documents. */
  servicesBlock?: string | null;
  quoteTotal?: number | null;
};

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

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
