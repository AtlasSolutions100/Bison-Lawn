import { getGoogleAccessToken } from "./googleOAuth";

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

/** Hand a fully built RFC 2822 message to Gmail. Throws on any non-2xx response. */
export async function sendRawGmailMessage(mime: string, proxy: GmailProxy = defaultGmailProxy) {
  const response = await proxy("google-mail", "/gmail/v1/users/me/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw: toBase64Url(mime) }),
    headers: { "Content-Type": "application/json" },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gmail delivery failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  return (await response.json()) as { id?: string };
}
