import { getGoogleAccessToken } from "./googleOAuth";
import { forgetRefusedSenderAddress, isSenderRejection, senderHeaders } from "./sendAs";

const GMAIL_API_ORIGIN = "https://gmail.googleapis.com";

export const toBase64Url = (value: string | Buffer) =>
  Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * The shape every sender talks to. The first argument named the Replit Connector
 * when this went through Replit's broker; it is kept so the delivery modules and
 * their tests — which inject their own proxies — did not all have to change when
 * we moved to our own Google OAuth client. It is ignored here.
 */
export type GmailProxy = (
  connector: string,
  path: string,
  init: { method: string; body: string; headers: Record<string, string> },
) => Promise<Response>;

/**
 * Calls the Gmail REST API directly with an access token minted from the app's
 * own refresh token. `path` is a Gmail API path such as
 * `/gmail/v1/users/me/messages/send`.
 */
export const defaultGmailProxy: GmailProxy = async (_connector, path, init) => {
  const accessToken = await getGoogleAccessToken();
  return fetch(`${GMAIL_API_ORIGIN}${path}`, {
    method: init.method,
    body: init.body,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${accessToken}`,
    },
  });
};

/**
 * Add headers the message does not already carry, at the top of the header
 * block.
 *
 * Only the text before the first blank line is examined. A base64 body can
 * contain anything, including something that looks like a header, and a
 * document whose text happens to start a line with "From:" must not stop us
 * naming the sender.
 */
export function withHeaders(mime: string, headers: string[]): string {
  if (!headers.length) return mime;
  const split = mime.indexOf("\r\n\r\n");
  const head = split === -1 ? mime : mime.slice(0, split);
  const missing = headers.filter((header) => {
    const name = header.slice(0, header.indexOf(":"));
    return name.length > 0 && !new RegExp(`^${name}:`, "im").test(head);
  });
  return missing.length ? `${missing.join("\r\n")}\r\n${mime}` : mime;
}

/**
 * Hand a fully built RFC 2822 message to Gmail. Throws on any non-2xx response.
 *
 * Every customer-facing email in the app ends up here, which is why the sender
 * identity is stamped here and nowhere else (contract A1): his company on the
 * From line and his address on Reply-To, on letters, bills, estimates, crew
 * notices and invitations alike, without each of those having to remember.
 *
 * A caller that built its own From keeps it — withHeaders only fills gaps.
 */
export async function sendRawGmailMessage(mime: string, proxy: GmailProxy = defaultGmailProxy) {
  const send = (body: string) =>
    proxy("google-mail", "/gmail/v1/users/me/messages/send", {
      method: "POST",
      body: JSON.stringify({ raw: toBase64Url(body) }),
      headers: { "Content-Type": "application/json" },
    });

  // Never let working out who we are stop a letter going out. Without this the
  // app would be worse off than before: today's emails send fine with no From
  // header at all.
  let stamped = mime;
  try {
    stamped = withHeaders(mime, await senderHeaders());
  } catch {
    stamped = mime;
  }

  let response = await send(stamped);
  if (!response.ok) {
    const detail = await response.text();
    // Gmail refuses a From it has not been given permission to use, and the
    // customer gets nothing at all. One retry without our From puts the letter
    // in their hands; the Settings page then says the address was refused.
    // 403 as well as 400: Google answers "Delegation denied for ..." with a 403
    // when the mailbox may not send as the address we chose, and since we now
    // try his own address without being able to ask Google first, that answer
    // has to put the letter in the customer's hands too, not bin it.
    if ((response.status === 400 || response.status === 403) && stamped !== mime && isSenderRejection(detail)) {
      forgetRefusedSenderAddress(`Google said: ${detail.slice(0, 200)}`);
      response = await send(mime);
      if (!response.ok) {
        const second = await response.text();
        throw new Error(`Gmail delivery failed (${response.status}): ${second.slice(0, 300)}`);
      }
      return (await response.json()) as { id?: string };
    }
    throw new Error(`Gmail delivery failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  return (await response.json()) as { id?: string };
}
