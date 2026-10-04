import type { CompanyProfile } from "@workspace/db";
import { getCompanyProfile } from "./companyProfile";
import { getGoogleAccessToken } from "./googleOAuth";

/**
 * Who his customers see when the app emails them — "Document comes from Koby,
 * needs from Bison Lawn Care".
 *
 * Every letter, bill, estimate and notice goes out through one Gmail mailbox,
 * the one behind GOOGLE_REFRESH_TOKEN, and that mailbox is not his. Gmail will
 * only put an address in From: that the signed-in account owns or has verified
 * as an alias, so we cannot simply write his address there and hope.
 *
 * What we can always do, and now always do:
 *   - the DISPLAY NAME is his company, so the inbox line reads
 *     "Bison Lawn Care LLC" instead of a person's name;
 *   - REPLY-TO is his own address from the Settings page, so the customer
 *     pressing Reply writes to him, not to us.
 *
 * And if that mailbox does have his address set up as a verified "send mail as"
 * alias, we use it as the real From and the email is fully his. We ask Gmail
 * once and cache the answer; the Settings page prints what we found so he is
 * never guessing which address his customers are looking at.
 */

const GMAIL_API_ORIGIN = "https://gmail.googleapis.com";

/** How long a resolved identity is trusted before we ask Gmail again. */
const IDENTITY_TTL_MS = 10 * 60 * 1000;
/** The company profile is read on every send, so it is held briefly too. */
const COMPANY_TTL_MS = 60 * 1000;

export type SenderSource =
  /** GMAIL_SEND_AS in the environment — somebody set it on purpose. */
  | "env"
  /** A verified "send mail as" alias on the sending mailbox. */
  | "alias"
  /** The signed-in mailbox itself. */
  | "mailbox"
  /**
   * We could not ask Google, so we are trying his own company address and
   * letting Google answer. If it refuses, the next send goes out without a
   * From and the Settings page says so.
   */
  | "optimistic"
  /** We could not find out, so no From header is set and Gmail fills it in. */
  | "unknown";

export type SenderIdentity = {
  /** The address Gmail will accept in From:, or null when we could not learn one. */
  address: string | null;
  source: SenderSource;
  /** True when the From address is his own company address, not ours. */
  ownDomain: boolean;
  /** Verified aliases the mailbox offers, for the Settings page. */
  aliases: string[];
  /** Why we could not do better, in words he can read. Null when all is well. */
  note: string | null;
};

const UNKNOWN: SenderIdentity = {
  address: null,
  source: "unknown",
  ownDomain: false,
  aliases: [],
  note: null,
};

let cachedIdentity: { at: number; value: SenderIdentity } | null = null;
let identityInFlight: Promise<SenderIdentity> | null = null;
let cachedCompany: { at: number; value: CompanyProfile } | null = null;
/** Set by a test, or by a send Gmail refused because of the From we chose. */
let forcedIdentity: SenderIdentity | null = null;

const trimmed = (value: string | null | undefined) => (value ?? "").trim() || null;

/**
 * An address is only usable in a header if it has no newline in it: everything
 * after a newline becomes a new MIME header, which is how a From turns into an
 * extra Bcc. Same check the client email sender makes on the To line.
 */
function safeAddress(value: string | null | undefined): string | null {
  const address = trimmed(value);
  if (!address) return null;
  if (/[\r\n]/.test(address)) return null;
  if (!address.includes("@")) return null;
  return address;
}

/**
 * The display name as a mail header puts it.
 *
 * Quoted, with quotes and backslashes escaped, because "Bison Lawn Care, LLC"
 * has a comma in it and an unquoted comma in a From header means a second
 * recipient. A name with anything outside plain ASCII is encoded the way the
 * Subject line already is, so an accent does not arrive as mojibake.
 */
export function encodeDisplayName(name: string): string {
  const clean = name.replace(/[\r\n]+/g, " ").trim();
  if (!clean) return "";
  // eslint-disable-next-line no-control-regex
  if (/[^\x20-\x7E]/.test(clean)) {
    return `=?UTF-8?B?${Buffer.from(clean).toString("base64")}?=`;
  }
  return `"${clean.replace(/([\\"])/g, "\\$1")}"`;
}

/** The name on the inbox line: his company, always. */
export function senderDisplayName(company: CompanyProfile | undefined): string {
  return trimmed(company?.name) ?? "Bison Lawn Care LLC";
}

/**
 * The `From:` header value every customer-facing email uses (contract A1).
 *
 * Returns an empty string when we do not know which mailbox is sending — the
 * caller then sends no From header at all and Gmail writes its own, which is
 * exactly today's behaviour and better than a header Gmail would reject.
 */
export function companyFrom(company: CompanyProfile | undefined, identity?: SenderIdentity): string {
  const known = identity ?? forcedIdentity ?? cachedIdentity?.value ?? UNKNOWN;
  // The resolved identity is the only thing read here. GMAIL_SEND_AS is read in
  // one place — resolveSenderIdentity — so an address Google has just refused
  // cannot walk back in through a second door: forgetRefusedSenderAddress drops
  // the address, and without this every later email would carry the same
  // refused From, pay for the same 400 and send twice. On a 709-bill batch that
  // is 1,418 calls to Google and a quota error in the middle of his billing.
  const address = safeAddress(known.address);
  if (!address) return "";
  const name = encodeDisplayName(senderDisplayName(company));
  return name ? `${name} <${address}>` : address;
}

/**
 * The address a customer's Reply goes to: his own, off the Settings page.
 *
 * Nothing is read off the From line for this. The whole point of B5 is that
 * the From line may not be his, and the Reply has to reach him regardless.
 */
export function companyReplyTo(company: CompanyProfile | undefined): string | null {
  return safeAddress(company?.email);
}

/** The address inside a `Name <addr>` header value, for comparing the two. */
function addressOf(header: string): string | null {
  const angled = header.match(/<([^>]+)>/);
  return safeAddress(angled ? angled[1] : header);
}

/**
 * Ask Gmail which addresses this mailbox may send as.
 *
 * Needs the gmail.settings.basic scope, which the app does not currently ask
 * for — it holds gmail.send and nothing else, deliberately. So this is
 * expected to come back 403, and a 403 is not an error worth logging: it is
 * the answer, and it is what the Settings page reports.
 */
async function fetchAliases(): Promise<{ aliases: string[]; primary: string | null; note: string | null }> {
  let token: string;
  try {
    token = await getGoogleAccessToken();
  } catch {
    return {
      aliases: [],
      primary: null,
      note: "Google email is not connected on this install, so we cannot tell which mailbox would send.",
    };
  }

  let response: Response;
  try {
    response = await fetch(`${GMAIL_API_ORIGIN}/gmail/v1/users/me/settings/sendAs`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { aliases: [], primary: null, note: "Google could not be reached to check the sending address." };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      aliases: [],
      primary: null,
      note:
        "Google will not tell us which addresses this mailbox can send as — the app only has permission to send " +
        "mail, not to read mail settings.",
    };
  }
  if (!response.ok) {
    return { aliases: [], primary: null, note: "Google would not answer which addresses this mailbox can send as." };
  }

  const body = (await response.json().catch(() => null)) as {
    sendAs?: { sendAsEmail?: string; isPrimary?: boolean; isDefault?: boolean; verificationStatus?: string }[];
  } | null;
  const entries = body?.sendAs ?? [];
  const usable = entries.filter(
    (entry) =>
      safeAddress(entry.sendAsEmail) &&
      // An alias Google has not verified cannot be used as a From; the owner
      // has to click the link in the confirmation mail first.
      (entry.isPrimary || entry.verificationStatus === "accepted"),
  );
  const primary = usable.find((e) => e.isPrimary) ?? usable.find((e) => e.isDefault) ?? usable[0];
  return {
    aliases: usable.map((e) => safeAddress(e.sendAsEmail)!),
    primary: primary ? safeAddress(primary.sendAsEmail) : null,
    note: null,
  };
}

/** The company profile, held for a minute so a 44-letter batch is one query. */
async function company(): Promise<CompanyProfile | undefined> {
  if (cachedCompany && Date.now() - cachedCompany.at < COMPANY_TTL_MS) return cachedCompany.value;
  try {
    const profile = await getCompanyProfile();
    cachedCompany = { at: Date.now(), value: profile };
    return profile;
  } catch {
    // No database here means a unit test with a fake mail proxy. The send is
    // still worth making; it just goes out the way it does today.
    return undefined;
  }
}

/**
 * Which mailbox is sending, and whether it can send as his own address.
 *
 * GMAIL_SEND_AS wins when it is set, because setting it is a deliberate act by
 * whoever configured the deployment and they know what that mailbox allows.
 */
export async function resolveSenderIdentity(): Promise<SenderIdentity> {
  if (forcedIdentity) return forcedIdentity;
  if (cachedIdentity && Date.now() - cachedIdentity.at < IDENTITY_TTL_MS) return cachedIdentity.value;
  if (identityInFlight) return identityInFlight;

  identityInFlight = (async (): Promise<SenderIdentity> => {
    const profile = await company();
    const his = safeAddress(profile?.email);
    const configured = safeAddress(process.env.GMAIL_SEND_AS);

    // A test never calls out to Google. Tests that care about the From header
    // set the identity themselves with setSenderIdentityForTests.
    const probe =
      process.env.NODE_ENV === "test"
        ? { aliases: [] as string[], primary: null as string | null, note: null as string | null }
        : await fetchAliases();

    const matchesHis = (address: string | null) =>
      Boolean(address && his && address.toLowerCase() === his.toLowerCase());

    if (configured) {
      return {
        address: configured,
        source: "env",
        ownDomain: matchesHis(configured),
        aliases: probe.aliases,
        note: null,
      };
    }
    const alias = probe.aliases.find((address) => matchesHis(address));
    if (alias) {
      return { address: alias, source: "alias", ownDomain: true, aliases: probe.aliases, note: null };
    }
    if (probe.primary) {
      return {
        address: probe.primary,
        source: "mailbox",
        ownDomain: matchesHis(probe.primary),
        aliases: probe.aliases,
        note: null,
      };
    }
    // Google would not tell us. That is the normal answer on his install — the
    // app holds gmail.send and nothing else — so it must not end with no From
    // at all, which is the very thing he complained about: Gmail then stamps
    // the connected mailbox's own name and the customer is back to reading a
    // stranger's name on every bill. So we put HIS address on the From line and
    // let Google answer. If Google refuses it, sendRawGmailMessage sends again
    // without the From, the customer still gets the letter, and from then on
    // the Settings page says the address was refused.
    if (his) {
      return {
        address: his,
        source: "optimistic",
        // Unproven on purpose: Google never confirmed this mailbox may use his
        // address, so the Settings page must not tell him it is fully his.
        ownDomain: false,
        aliases: probe.aliases,
        note:
          `${probe.note ? `${probe.note} ` : ""}So we put ${his} on the From line and let Google answer. If Google ` +
          `refuses it, the next email goes out under the connected mailbox's own name and this will say so.`,
      };
    }
    return { ...UNKNOWN, aliases: probe.aliases, note: probe.note };
  })()
    .then((value) => {
      cachedIdentity = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      identityInFlight = null;
    });

  return identityInFlight;
}

/**
 * The sender headers to stamp on an outgoing customer email.
 *
 * From is left out entirely when we do not know the sending mailbox — Gmail
 * then writes its own, which is what happens today. Reply-To is set whenever he
 * has filled his email in on the Settings page, because that is the address his
 * customers actually hit Reply on, and it works no matter whose mailbox sent.
 */
export async function senderHeaders(): Promise<string[]> {
  const profile = await company();
  const identity = await resolveSenderIdentity();
  const headers: string[] = [];

  // One helper writes every From line in the app (contract A1), so nothing can
  // drift to a different display name or forget to quote a comma.
  const from = companyFrom(profile, identity);
  if (from) headers.push(`From: ${from}`);
  const address = from ? addressOf(from) : null;

  const replyTo = companyReplyTo(profile);
  // No point repeating ourselves: an email already sent from his own address
  // does not need to be told to reply to it.
  if (replyTo && (!address || replyTo.toLowerCase() !== address.toLowerCase())) {
    headers.push(`Reply-To: ${replyTo}`);
  }
  return headers;
}

/**
 * Gmail refused the From we chose. Stop choosing it.
 *
 * This happens when GMAIL_SEND_AS names an address the mailbox is not actually
 * allowed to send as: Gmail answers 400 and nothing is delivered. Rather than
 * failing every email until somebody reads the log, we forget the address and
 * the caller sends again with no From — the customer gets their letter, and the
 * Settings page says the address was refused.
 */
export function forgetRefusedSenderAddress(reason: string): void {
  const refused = (forcedIdentity ?? cachedIdentity?.value)?.address ?? process.env.GMAIL_SEND_AS ?? "(none)";
  forcedIdentity = {
    ...UNKNOWN,
    note: `Google refused to send as ${refused}, so emails go out from the connected mailbox instead. ${reason}`.trim(),
  };
  cachedIdentity = { at: Date.now(), value: forcedIdentity };
}

/** True when the message Gmail rejected was rejected because of our From header. */
export function isSenderRejection(detail: string): boolean {
  return /from|sendas|send-as|delegat/i.test(detail);
}

/**
 * What the Settings page prints. Honest about the limit: the display name is
 * ours to set, the address is not, and sending fully as his own domain needs
 * work outside this app.
 */
export async function senderStatus() {
  const profile = await company();
  const identity = await resolveSenderIdentity();
  const address = safeAddress(identity.address);
  const replyTo = companyReplyTo(profile);
  const name = senderDisplayName(profile);

  // What it says has to be true. With no address we write no From header at
  // all, so Gmail fills one in from the connected mailbox and his company name
  // is NOT what the customer reads — saying otherwise on the one card built to
  // stop him guessing is worse than saying nothing.
  const customersSee = !address
    ? "Whatever name Google has on the mailbox this app is connected to — not your company name yet"
    : identity.source === "optimistic"
      ? `${name} <${address}>, unless Google refuses that address`
      : `${name} <${address}>`;

  const whatWouldBeNeeded = identity.ownDomain
    ? null
    : replyTo
      ? `To have ${replyTo} itself on the From line, that address has to be added to the sending Google account ` +
        `under Settings → Accounts → "Send mail as" and confirmed from its own inbox. Until then customers see ` +
        `your company name, and replies come to you.`
      : `Fill in your company email on this page first — that is the address replies go to, and the one we would ` +
        `add to Google as a "send mail as" address.`;

  return {
    fromName: name,
    fromAddress: address,
    replyTo,
    ownDomain: identity.ownDomain,
    source: identity.source,
    aliases: identity.aliases,
    customersSee,
    note: identity.note,
    whatWouldBeNeeded,
  };
}

/** Tests only: pin the identity instead of asking Google. */
export function setSenderIdentityForTests(identity: Partial<SenderIdentity> | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("The sender identity can only be pinned in tests");
  }
  forcedIdentity = identity ? { ...UNKNOWN, ...identity } : null;
  cachedIdentity = null;
}

/** Tests only: pin the company profile, so no database is needed. */
export function setSenderCompanyForTests(profile: CompanyProfile | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("The sender company can only be pinned in tests");
  }
  cachedCompany = profile ? { at: Number.MAX_SAFE_INTEGER, value: profile } : null;
}
