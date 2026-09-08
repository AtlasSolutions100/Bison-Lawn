import assert from "node:assert/strict";
import test from "node:test";
import type { CompanyProfile } from "@workspace/db";
import {
  invitationHtml,
  invitationSubject,
  sendInvitationEmail,
  signUpUrl,
} from "../src/lib/invitationEmail.ts";

const company = { name: "Bison Lawn Care LLC" } as unknown as CompanyProfile;
const loadCompany = async () => company;

const base = {
  email: "crew@example.com",
  role: "contractor",
  invitedByName: "Adam Johnson",
  note: null as string | null,
};

test("the subject names the company so it is recognisable in an inbox", () => {
  assert.equal(invitationSubject(company), "You have been added to Bison Lawn Care LLC");
  assert.equal(invitationSubject(undefined), "You have been added to the crew");
});

// The role is attached to the invited address and only redeemed when someone
// signs in with that address verified. Sign up with a different one and the
// invitation is never redeemed, so the person lands as a plain contractor with
// none of the access they were given — invisibly.
test("the body tells them which address to sign up with", () => {
  const html = invitationHtml({ ...base, company });
  assert.ok(html.includes("crew@example.com"), "the invited address must appear");
  assert.ok(/sign up using/i.test(html), "must say to use that address");
});

test("the body carries the inviter, the role and a link to sign up", () => {
  const html = invitationHtml({ ...base, role: "admin", company });
  assert.ok(html.includes("Adam Johnson"));
  assert.ok(html.includes("an admin"));
  assert.ok(html.includes(signUpUrl()));
});

test("a note from the office is included when there is one, and omitted when not", () => {
  assert.ok(invitationHtml({ ...base, note: "Start Monday at the shop", company }).includes("Start Monday at the shop"));
  const without = invitationHtml({ ...base, note: "   ", company });
  assert.ok(!without.includes("background:#ebf1ee"), "an empty note should not render its box");
});

test("customer text is escaped rather than injected into the email", () => {
  const html = invitationHtml({
    ...base,
    invitedByName: '<script>alert("x")</script>',
    note: "<b>bold</b>",
    company,
  });
  assert.ok(!html.includes("<script>"), "script tag must not survive");
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&lt;b&gt;bold&lt;/b&gt;"));
});

test("a successful send reports that it went", async () => {
  let captured: any = null;
  const proxy = async (_c: string, path: string, init: any) => {
    captured = { path, init };
    return new Response(JSON.stringify({ id: "gmail-inv-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const result = await sendInvitationEmail(base, proxy as any, loadCompany);
  assert.deepEqual(result, { emailed: true, error: null });
  assert.equal(captured.path, "/gmail/v1/users/me/messages/send");
  const raw = Buffer.from(JSON.parse(captured.init.body).raw, "base64url").toString();
  assert.ok(raw.includes("To: crew@example.com"));
});

// The invitation row is still worth keeping when the mail fails — the role
// applies the moment they sign in either way. But the failure must be reported,
// because the office being told "invited" when nothing was sent is the bug this
// whole change exists to fix.
test("a failed send is reported rather than thrown or swallowed", async () => {
  const proxy = async () => new Response("mailbox unavailable", { status: 550 });
  const result = await sendInvitationEmail(base, proxy as any, loadCompany);
  assert.equal(result.emailed, false);
  assert.ok(result.error && result.error.length > 0, "a reason must come back for the office to see");
});
