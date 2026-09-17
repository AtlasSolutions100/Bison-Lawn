/**
 * Texting. The office texts a customer; a contractor texts the customer of
 * their job from a masked number; a customer's reply comes back through that
 * number to the contractor it belongs to. The customer only ever sees the
 * masked number, never the contractor's own phone.
 *
 * None of that is possible without a company that owns phone numbers and
 * carries messages on the phone network, and that costs money — see
 * SMS_COST_NOTE below, which is the same text Adam reads in Settings. So this
 * file is a seam: with SMS_PROVIDER=none every send answers honestly that
 * texting is off, and with SMS_PROVIDER=twilio the same code talks to Twilio
 * over plain REST (mirroring gmail.ts — no SDK for two endpoints).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { db, smsMessagesTable } from "@workspace/db";
import type { SmsMessage } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

export type SmsProviderName = "none" | "twilio";

export const SMS_ENV_KEYS: { key: string; note: string }[] = [
  { key: "SMS_PROVIDER", note: "none or twilio" },
  { key: "TWILIO_ACCOUNT_SID", note: "from the Twilio console, starts with AC" },
  { key: "TWILIO_AUTH_TOKEN", note: "from the Twilio console; also signs the reply webhook" },
  { key: "SMS_OFFICE_NUMBER", note: "the office's own texting number, e.g. +12085550142" },
];

/** The words Adam reads in Settings. Kept here so the status endpoint and the docs agree. */
export const SMS_COST_NOTE =
  "Masked numbers are not free. A local number is about $1 a month each, plus a fraction of a cent " +
  "per text (about $0.008). Before US carriers will deliver business texts, the business has to be " +
  "registered once (A2P 10DLC) — a small one-time fee, a few dollars a month, it takes days to a few " +
  "weeks to approve, and it needs the company EIN and address. Work Optional can set it up; the bill " +
  "is roughly $5–15 a month for a crew this size.";

export function smsProviderName(): SmsProviderName {
  return (process.env.SMS_PROVIDER ?? "none").trim().toLowerCase() === "twilio" ? "twilio" : "none";
}

export function smsConfigured(): boolean {
  return (
    smsProviderName() === "twilio" &&
    Boolean(process.env.TWILIO_ACCOUNT_SID?.trim()) &&
    Boolean(process.env.TWILIO_AUTH_TOKEN?.trim())
  );
}

/** The office's own texting number, normalised, or null when none is set. */
export function officeNumber(): string | null {
  return normalizePhone(process.env.SMS_OFFICE_NUMBER);
}

/**
 * Phone numbers are typed free-hand everywhere in this app — "(208) 555-0142",
 * "208.555.0142", "+1 208 555 0142" — and a provider wants exactly one shape.
 * Ten digits are taken as US; eleven starting with 1 likewise. Anything else
 * is not a number this app can text, and saying so beats sending to garbage.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** The part two spellings of the same number have in common, for matching an inbound sender. */
export function phoneKey(raw: string | null | undefined): string | null {
  const normalized = normalizePhone(raw);
  return normalized ? normalized.slice(-10) : null;
}

/** "(208) 555-0142" for screens; anything not US is shown as stored. */
export function formatPhone(value: string | null | undefined): string {
  const normalized = normalizePhone(value);
  if (!normalized) return value ?? "";
  const d = normalized.slice(-10);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/**
 * How many texts one message really is. Plain ASCII fits 160 characters in
 * one; an emoji or a curly quote switches the whole message to a costlier
 * encoding that fits 70. Each extra segment is billed as another text.
 */
export function segmentsOf(body: string): number {
  if (!body) return 0;
  // eslint-disable-next-line no-control-regex
  const gsm = /^[\x00-\x7F€]*$/.test(body);
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  return body.length <= single ? 1 : Math.ceil(body.length / multi);
}

// ---------------------------------------------------------------- provider --

export type SmsProvider = (msg: { to: string; from: string; body: string }) => Promise<{ providerId: string | null }>;

const TWILIO_API = "https://api.twilio.com/2010-04-01";

/** Twilio's Messages endpoint. Throws on any non-2xx, with the reason Twilio gave. */
export const twilioProvider: SmsProvider = async ({ to, from, body }) => {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim() ?? "";
  const token = process.env.TWILIO_AUTH_TOKEN?.trim() ?? "";
  const response = await fetch(`${TWILIO_API}/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`SMS delivery failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  const data = (await response.json()) as { sid?: string };
  return { providerId: data.sid ?? null };
};

let providerForTests: SmsProvider | null = null;

/** Swap the provider for a capturing fake (tests only). */
export function setSmsProviderForTests(provider: SmsProvider | null) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("The SMS provider can only be replaced in tests");
  }
  providerForTests = provider;
}

function currentProvider(): SmsProvider {
  if (providerForTests) return providerForTests;
  if (!smsConfigured()) {
    return async () => {
      throw new Error("Texting is not switched on for this server");
    };
  }
  return twilioProvider;
}

/** True when a send would actually go somewhere: a real provider, or a test double. */
export function smsSendable(): boolean {
  return providerForTests != null || smsConfigured();
}

// -------------------------------------------------------------------- send --

/**
 * Send one text and keep the record. The row is written before the provider
 * is called and updated after, so a crash mid-send leaves a "queued" row the
 * office can see rather than a text that vanished. Never throws: the outcome
 * is in the row's status, and the caller decides what to tell the person.
 */
export async function sendSms(input: {
  to: string;
  from: string;
  body: string;
  clientId?: number | null;
  userId?: number | null;
  jobId?: number | null;
}): Promise<SmsMessage> {
  const [queued] = await db
    .insert(smsMessagesTable)
    .values({
      direction: "outbound",
      clientId: input.clientId ?? null,
      userId: input.userId ?? null,
      jobId: input.jobId ?? null,
      fromNumber: input.from,
      toNumber: input.to,
      body: input.body,
      status: "queued",
    })
    .returning();
  try {
    const { providerId } = await currentProvider()({ to: input.to, from: input.from, body: input.body });
    const [sent] = await db
      .update(smsMessagesTable)
      .set({ status: "sent", providerMessageId: providerId })
      .where(eq(smsMessagesTable.id, queued.id))
      .returning();
    return sent;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, to: input.to }, "sms send failed");
    const [failed] = await db
      .update(smsMessagesTable)
      .set({ status: "failed", error: message.slice(0, 500) })
      .where(eq(smsMessagesTable.id, queued.id))
      .returning();
    return failed;
  }
}

// --------------------------------------------------------- webhook signing --

/**
 * Twilio signs every webhook: HMAC-SHA1 over the exact public URL it posted
 * to followed by the form fields sorted by name (name then value, no
 * separators), keyed with the account's auth token, base64. Anyone can post
 * a form to a public URL; only Twilio can produce this header.
 */
export function twilioSignature(url: string, params: Record<string, string>, authToken: string): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", authToken).update(data).digest("base64");
}

export function twilioSignatureMatches(
  url: string,
  params: Record<string, string>,
  authToken: string,
  received: string | undefined,
): boolean {
  if (!authToken || !received) return false;
  const expected = Buffer.from(twilioSignature(url, params, authToken));
  const got = Buffer.from(received);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

// ------------------------------------------------------- inbound routing --

/**
 * A contractor replying from their own phone picks the customer by starting
 * with "#<id>" — the id the forwarded text was labelled with. Without it, the
 * reply goes to whoever texted that line most recently.
 */
export function parseReplyRef(body: string): { messageId: number | null; text: string } {
  const m = /^\s*#(\d+)\s*[:\-–]?\s*/.exec(body);
  if (!m) return { messageId: null, text: body.trim() };
  return { messageId: Number(m[1]), text: body.slice(m[0].length).trim() };
}

const OPT_OUT = /^\s*(stop|stopall|unsubscribe|cancel|end|quit)\s*$/i;

export type InboundLine = {
  /** The contractor this masked number belongs to; null for the office line. */
  userId: number;
  userName: string;
  /** Their real phone, where customer texts are forwarded. */
  userPhone: string | null;
  proxyNumber: string;
};

export type InboundInput = {
  /** The id of the inbound row already stored, so the forward can be labelled with it. */
  inboundId: number;
  from: string;
  to: string;
  body: string;
  line: InboundLine | null;
  isOfficeLine: boolean;
  /** The customer matched by the sender's number, if any. */
  client: { id: number; name: string } | null;
  /** The customer message a "#<id>" reply points at, looked up by the caller. */
  referenced: { clientId: number | null; clientName: string | null; customerNumber: string } | null;
  /** The most recent customer text on this line within a day, for replies with no "#<id>". */
  lastCustomer: { clientId: number | null; clientName: string | null; customerNumber: string } | null;
};

export type InboundDecision =
  | { kind: "opt_out"; clientId: number | null }
  | { kind: "reply_to_customer"; to: string; from: string; text: string; clientId: number | null }
  | { kind: "no_thread"; to: string; from: string; text: string }
  | { kind: "forward_to_contractor"; to: string; from: string; text: string; clientId: number | null }
  | { kind: "office_ticket"; clientId: number | null; title: string; description: string }
  | { kind: "unroutable"; reason: string };

/**
 * Who a text is from and where it should go next. Pure, so the whole decision
 * table can be tested without a phone, a provider or a database.
 */
export function routeInboundSms(input: InboundInput): InboundDecision {
  const body = input.body.trim();
  if (OPT_OUT.test(body)) {
    // The provider blocks further sends to this number itself; we just keep
    // the record and stay quiet.
    return { kind: "opt_out", clientId: input.client?.id ?? null };
  }

  const line = input.line;
  const fromContractor =
    line != null && line.userPhone != null && phoneKey(input.from) === phoneKey(line.userPhone);

  if (line && fromContractor) {
    const { messageId, text } = parseReplyRef(body);
    // He named a customer with #number and we could not find them. Guessing
    // "the last person who texted" would send his answer to the wrong
    // customer, so tell him the number is wrong instead.
    if (messageId != null && !input.referenced) {
      return {
        kind: "no_thread",
        to: line.userPhone!,
        from: line.proxyNumber,
        text: `No text #${messageId} on your line — check the number on the message you are answering.`,
      };
    }
    const target = input.referenced ?? input.lastCustomer;
    if (!target || !text) {
      return {
        kind: "no_thread",
        to: line.userPhone!,
        from: line.proxyNumber,
        text: !text
          ? "Nothing to send — put your message after the #number."
          : "No customer to reply to yet. Reply to a customer's text here, or start with #<number> to pick one.",
      };
    }
    return {
      kind: "reply_to_customer",
      to: target.customerNumber,
      from: line.proxyNumber,
      text,
      clientId: target.clientId,
    };
  }

  const who = input.client?.name ?? formatPhone(input.from);
  if (line) {
    if (line.userPhone) {
      return {
        kind: "forward_to_contractor",
        to: line.userPhone,
        from: line.proxyNumber,
        text: `[#${input.inboundId} ${who}] ${body}`,
        clientId: input.client?.id ?? null,
      };
    }
    return {
      kind: "office_ticket",
      clientId: input.client?.id ?? null,
      title: `Text from ${who} for ${line.userName}`,
      description: `${body}\n\n${line.userName} has no phone on file, so this could not be forwarded. Sent to ${formatPhone(line.proxyNumber)}.`,
    };
  }
  if (input.isOfficeLine) {
    return {
      kind: "office_ticket",
      clientId: input.client?.id ?? null,
      title: `Text from ${who}`,
      description: `${body}\n\nSent to the office number ${formatPhone(input.to)}.`,
    };
  }
  return { kind: "unroutable", reason: `No one owns the number ${formatPhone(input.to)}` };
}
