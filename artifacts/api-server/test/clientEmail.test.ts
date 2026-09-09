import assert from "node:assert/strict";
import test from "node:test";
import { sendClientEmailViaGmail } from "../src/lib/clientEmail.ts";

/** Captures the RFC 2822 message instead of handing it to Gmail. */
function capturingProxy() {
  const seen: { raw: string } = { raw: "" };
  const proxy = async (_connector: string, _path: string, init: any) => {
    seen.raw = Buffer.from(JSON.parse(init.body).raw, "base64url").toString();
    return new Response(JSON.stringify({ id: "gmail-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { seen, proxy: proxy as any };
}

const base = { toEmail: "owner@example.com", subject: "Your lawn", body: "Hello" };

test("a plain send carries no Cc or Bcc header at all", async () => {
  const { seen, proxy } = capturingProxy();
  await sendClientEmailViaGmail(base, proxy);
  assert.ok(seen.raw.includes("To: owner@example.com"));
  assert.ok(!/^Cc:/m.test(seen.raw), "an empty Cc must not be sent as a header");
  assert.ok(!/^Bcc:/m.test(seen.raw), "an empty Bcc must not be sent as a header");
});

test("Cc and Bcc are sent as headers when given", async () => {
  const { seen, proxy } = capturingProxy();
  await sendClientEmailViaGmail(
    { ...base, cc: ["book@example.com", " spouse@example.com "], bcc: ["office@example.com"] },
    proxy,
  );
  assert.match(seen.raw, /^Cc: book@example\.com, spouse@example\.com$/m, "trimmed and joined");
  assert.match(seen.raw, /^Bcc: office@example\.com$/m);
});

test("blank entries are dropped rather than sent as empty addresses", async () => {
  const { seen, proxy } = capturingProxy();
  await sendClientEmailViaGmail({ ...base, cc: ["", "   "], bcc: [] }, proxy);
  assert.ok(!/^Cc:/m.test(seen.raw), "a Cc of only blanks is no Cc");
});

// A newline in an address is a header injection: everything after it becomes a
// new MIME header, which is how a Cc quietly becomes an extra Bcc to someone
// else. These addresses are typed by hand in the office, which is exactly where
// a pasted address with a stray newline comes from.
test("a newline in any address is refused, not passed through", async () => {
  for (const [field, payload] of [
    ["to", { ...base, toEmail: "a@b.com\nBcc: sneak@evil.com" }],
    ["cc", { ...base, cc: ["a@b.com\nBcc: sneak@evil.com"] }],
    ["bcc", { ...base, bcc: ["a@b.com\r\nSubject: replaced"] }],
  ] as const) {
    const { seen, proxy } = capturingProxy();
    await assert.rejects(
      () => sendClientEmailViaGmail(payload, proxy),
      /Invalid/i,
      `${field} must be rejected`,
    );
    assert.equal(seen.raw, "", `nothing may be sent when ${field} is malformed`);
  }
});
