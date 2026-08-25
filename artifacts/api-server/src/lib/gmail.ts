import { ReplitConnectors } from "@replit/connectors-sdk";

const connectors = new ReplitConnectors();

export const toBase64Url = (value: string | Buffer) =>
  Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export type GmailProxy = (
  connector: string,
  path: string,
  init: { method: string; body: string; headers: Record<string, string> },
) => Promise<Response>;

export const defaultGmailProxy: GmailProxy = connectors.proxy.bind(connectors) as GmailProxy;

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
