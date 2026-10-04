/**
 * The Polish button, proved without a live model.
 *
 * Two things matter more than the prose coming back nicer, and both are tested
 * against a fake provider:
 *  - His merge tokens survive. A rewrite that turns `[clientname]` into
 *    `[client name]` prints the brackets to the customer, so it has to be
 *    thrown away rather than offered to him.
 *  - Nothing but the text in his box is sent. The fake provider captures the
 *    exact messages, and the test reads them.
 *
 * No real request is ever made: every test either runs with no XAI_API_KEY, or
 * sets a throwaway one and passes its own provider.
 */
import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import type { Server } from "node:http";
import { db, pool, usersTable } from "@workspace/db";
import { inArray } from "drizzle-orm";

// NODE_ENV=test plus a random per-process capability token enables the
// x-test-user-id auth bypass in requireAuth.
process.env.NODE_ENV = "test";
const TEST_AUTH_TOKEN = `test_${Math.random().toString(36).slice(2)}${Date.now()}`;
process.env.TEST_AUTH_TOKEN = TEST_AUTH_TOKEN;
// The endpoint has to be a live, explaining control with no key at all, which
// is the state the app is actually in today.
delete process.env.XAI_API_KEY;

const { default: app } = await import("../src/app.ts");
const { polishText, mergeTokensIn, polishMaxTokens, POLISH_MAX_CHARS } = await import(
  "../src/lib/aiAssistant.ts"
);

let server: Server;
let baseUrl: string;
const STAMP = Date.now();
const ids = { users: [] as number[] };
let admin: { id: number };

async function api(
  path: string,
  userId: number | null,
  init: RequestInit = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(userId != null
        ? { "x-test-user-id": String(userId), "x-test-auth-token": TEST_AUTH_TOKEN }
        : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

before(async () => {
  server = app.listen(0);
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const [a] = await db
    .insert(usersTable)
    .values([{ clerkId: `test_ai_admin_${STAMP}`, name: "AI Admin", role: "admin", roleSource: "owner_assigned" }])
    .returning();
  admin = a;
  ids.users.push(a.id);
});

after(async () => {
  if (ids.users.length) await db.delete(usersTable).where(inArray(usersTable.id, ids.users));
  server.close();
  await pool.end();
});

/**
 * A stand-in for xAI that records what it was asked and answers whatever the
 * test tells it to. `calls` being empty is itself an assertion in a couple of
 * tests: nothing should go over the wire for blank or oversized text.
 */
function fakeProvider(answer: string | (() => Promise<string>)) {
  const calls: { messages: { role: string; content: string }[]; maxTokens: number }[] = [];
  const provider = async (messages: any, maxTokens: number) => {
    calls.push({ messages, maxTokens });
    return typeof answer === "string" ? answer : answer();
  };
  return { calls, provider: provider as any };
}

/** Runs with a throwaway key set, so `available` is true and the gate opens. */
async function withKey<T>(fn: () => Promise<T>): Promise<T> {
  process.env.XAI_API_KEY = "test-key-never-sent-anywhere";
  try {
    return await fn();
  } finally {
    delete process.env.XAI_API_KEY;
  }
}

const LETTER = [
  "Hi [clientfname],",
  "",
  "your aeration at [physicaladdress1] is booked for [servicedate]. it will be $95.",
  "",
  "thanks, [clientname]",
].join("\n");

// ---- the gate ----------------------------------------------------------

test("with no AI key the text comes back untouched and says why", async () => {
  const result = await polishText("tidy this up please", "clear");
  assert.equal(result.available, false);
  assert.equal(result.changed, false);
  assert.equal(result.text, "tidy this up please");
  assert.match(result.note ?? "", /not switched on/i);
});

test("with no AI key the provider is never reached at all", async () => {
  const { calls, provider } = fakeProvider("a rewrite nobody asked for");
  const result = await polishText("hello", "clear", provider);
  assert.equal(calls.length, 0, "no key means no request, not a wasted one");
  assert.equal(result.text, "hello");
});

// ---- the merge-token rule ---------------------------------------------

test("a rewrite that keeps every merge token is offered to him", async () => {
  await withKey(async () => {
    const rewrite = [
      "Hi [clientfname],",
      "",
      "Your aeration at [physicaladdress1] is booked for [servicedate]. The cost is $95.",
      "",
      "Thanks,",
      "[clientname]",
    ].join("\n");
    const { calls, provider } = fakeProvider(rewrite);
    const result = await polishText(LETTER, "clear", provider);
    assert.equal(calls.length, 1);
    assert.equal(result.available, true);
    assert.equal(result.changed, true);
    assert.equal(result.text, rewrite);
    assert.equal(result.note, null);
  });
});

test("a rewrite that spaced out [clientname] is thrown away, not offered", async () => {
  await withKey(async () => {
    // Exactly the failure that would print "Dear [client name]," to 709 people.
    const mangled = LETTER.replace("[clientname]", "[client name]");
    const { provider } = fakeProvider(mangled);
    const result = await polishText(LETTER, "clear", provider);
    assert.equal(result.changed, false);
    assert.equal(result.text, LETTER, "his own words, character for character");
    assert.match(result.note ?? "", /merge fields/i);
  });
});

test("a rewrite that dropped one of two identical tokens is thrown away", async () => {
  await withKey(async () => {
    const twice = "Dear [clientfname], we mowed for [clientfname] on Tuesday.";
    const once = "Dear [clientfname], we mowed on Tuesday.";
    const { provider } = fakeProvider(once);
    const result = await polishText(twice, "clear", provider);
    assert.equal(result.changed, false, "a lost second mention is still a lost name");
    assert.equal(result.text, twice);
  });
});

test("the double-brace tokens the spring letter uses are protected the same way", async () => {
  await withKey(async () => {
    const letter = "Hello {{first_name}}, your price this year is {{price}}.";
    const { provider } = fakeProvider("Hello {{firstname}}, your price this year is {{price}}.");
    const bad = await polishText(letter, "clear", provider);
    assert.equal(bad.changed, false);
    assert.equal(bad.text, letter);

    const good = fakeProvider("Hi {{first_name}} — this year your price is {{price}}.");
    const ok = await polishText(letter, "clear", good.provider);
    assert.equal(ok.changed, true);
  });
});

test("tokens are compared case-insensitively, because his own documents are inconsistent", async () => {
  await withKey(async () => {
    // mergeTokens.ts resolves [ClientName] and [clientname] to the same value,
    // so a rewrite that only changed the capitals has not broken anything.
    const { provider } = fakeProvider("Hi [ClientName], your lawn is booked.");
    const result = await polishText("hi [clientname] your lawn is booked", "clear", provider);
    assert.equal(result.changed, true);
  });
});

test("mergeTokensIn counts duplicates and both syntaxes", () => {
  assert.deepEqual(mergeTokensIn("[a] {{b}} [a]"), ["[a]", "[a]", "{{b}}"]);
  assert.deepEqual(mergeTokensIn("no tokens here"), []);
  // A lone bracket pair with a space in it is not one of his tokens, and must
  // not be counted as one — otherwise ordinary prose would fail the check.
  assert.deepEqual(mergeTokensIn("see [the back page]"), []);
  // The capitals only stop mattering inside square brackets, because that is
  // the only one of the two renderers that lower-cases before it looks a token
  // up. A {{...}} token is swapped by an exact match, so it is kept verbatim.
  assert.deepEqual(mergeTokensIn("[ClientName] {{clientFirstName}}"), [
    "[clientname]",
    "{{clientFirstName}}",
  ]);
});

test("a {{token}} that came back in different capitals is thrown away", async () => {
  await withKey(async () => {
    // letterDelivery.ts swaps the literal text "{{clientFirstName}}" and nothing
    // else, so this rewrite would post "Dear {{clientfirstname}}," to the
    // customer. The merge-field rule has to catch it the same as a renamed one.
    const letter = "Dear {{clientFirstName}}, your price this year is {{total}}.";
    const { provider } = fakeProvider("Dear {{clientfirstname}}, this year your price is {{total}}.");
    const result = await polishText(letter, "clear", provider);
    assert.equal(result.changed, false);
    assert.equal(result.text, letter, "his own words, character for character");
    assert.match(result.note ?? "", /merge fields/i);

    // The same letter rewritten with the braces left alone is still offered.
    const good = fakeProvider("Dear {{clientFirstName}}, this year your price is {{total}}.");
    assert.equal((await polishText(letter, "clear", good.provider)).changed, true);
  });
});

// ---- what gets sent ----------------------------------------------------

test("only his own text is sent — no customer details, no second user message", async () => {
  await withKey(async () => {
    const { calls, provider } = fakeProvider("Tidier.");
    await polishText(LETTER, "clear", provider);
    const messages = calls[0]!.messages;
    const userTurns = messages.filter((m) => m.role === "user");
    assert.equal(userTurns.length, 1, "one user message, which is the box he typed in");
    assert.equal(userTurns[0]!.content, LETTER, "verbatim, with nothing appended");
    const everything = messages.map((m) => m.content).join("\n");
    for (const leak of ["Jackie Wagner", "615 E 18th", "@", "invoice #"]) {
      assert.ok(!everything.includes(leak), `${leak} must never be in the prompt`);
    }
  });
});

test("the prompt tells the model what the brackets are and not to touch them", async () => {
  await withKey(async () => {
    const { calls, provider } = fakeProvider("ok");
    await polishText("Hi [clientfname]", "clear", provider);
    const system = calls[0]!.messages.find((m) => m.role === "system")!.content;
    assert.match(system, /\[clientname\]/);
    assert.match(system, /\{\{first_name\}\}/);
    assert.match(system, /EXACTLY/);
    assert.match(system, /Never add a fact/i);
  });
});

test("the prompt names every formatting mark the app understands, underline included", async () => {
  await withKey(async () => {
    // "__two underscores__ to underline it" is what the Letter box promises him,
    // so a rewrite that is only told about bold and italics turns his underline
    // into bold and nothing here would notice.
    const { calls, provider } = fakeProvider("ok");
    await polishText("__Please have the gate unlocked__ so the crew can get in.", "clear", provider);
    const system = calls[0]!.messages.find((m) => m.role === "system")!.content;
    assert.match(system, /__underline__/, "the underline marker has to be named");
    assert.match(system, /\*\*bold\*\*/);
    assert.match(system, /\*italic\*/);
  });
});

test("the tone he picked is the tone in the prompt", async () => {
  await withKey(async () => {
    for (const [tone, phrase] of [
      ["clear", /clearer and shorter/i],
      ["professional", /professional note/i],
      ["friendly", /neighbourly/i],
    ] as const) {
      const { calls, provider } = fakeProvider("ok");
      await polishText("hello", tone, provider);
      assert.match(calls[0]!.messages[0]!.content, phrase, `${tone} must reach the model`);
    }
  });
});

// ---- the answers a model actually gives --------------------------------

test("a fenced or quoted answer is unwrapped before he sees it", async () => {
  await withKey(async () => {
    const fence = fakeProvider("```\nYour lawn is booked for Tuesday.\n```");
    assert.equal((await polishText("lawn booked tues", "clear", fence.provider)).text, "Your lawn is booked for Tuesday.");

    const quoted = fakeProvider('"Your lawn is booked for Tuesday."');
    assert.equal((await polishText("lawn booked tues", "clear", quoted.provider)).text, "Your lawn is booked for Tuesday.");

    // A quote mark inside the sentence means the outer pair is his, not the
    // model's wrapper, so it is left alone.
    const inner = fakeProvider('He said "no" and "maybe"');
    assert.equal((await polishText("he said no", "clear", inner.provider)).text, 'He said "no" and "maybe"');
  });
});

test("an answer identical to what he wrote says so rather than pretending to change it", async () => {
  await withKey(async () => {
    const { provider } = fakeProvider("Already fine.");
    const result = await polishText("Already fine.", "clear", provider);
    assert.equal(result.changed, false);
    assert.match(result.note ?? "", /read fine already/i);
  });
});

test("an empty answer leaves his words alone instead of wiping the box", async () => {
  await withKey(async () => {
    const { provider } = fakeProvider("   \n  ");
    const result = await polishText("keep me", "clear", provider);
    assert.equal(result.changed, false);
    assert.equal(result.text, "keep me");
    assert.match(result.note ?? "", /empty/i);
  });
});

test("blank text and over-long text are refused here, before anything is sent", async () => {
  await withKey(async () => {
    const blank = fakeProvider("ok");
    const blankResult = await polishText("   \n ", "clear", blank.provider);
    assert.equal(blank.calls.length, 0);
    assert.match(blankResult.note ?? "", /nothing written/i);

    const long = fakeProvider("ok");
    const longResult = await polishText("x".repeat(POLISH_MAX_CHARS + 1), "clear", long.provider);
    assert.equal(long.calls.length, 0, "an oversized paste must not be billed for");
    assert.match(longResult.note ?? "", /longer than/i);
    assert.equal(longResult.changed, false);
  });
});

test("an upstream failure throws, so the route can say try again rather than losing his draft", async () => {
  await withKey(async () => {
    const { provider } = fakeProvider(async () => {
      throw new Error("The assistant is unavailable right now (upstream returned 503).");
    });
    await assert.rejects(() => polishText("hello", "clear", provider), /unavailable/i);
  });
});

// ---- room for the answer ----------------------------------------------

/** A letter the length of one he really writes: a greeting and a few paragraphs. */
const LONG_LETTER =
  "Hi [clientfname], " +
  "The crew will be out to mow and edge the lawn, blow off the drive and tidy the beds. ".repeat(70);

test("the room for the answer is sized off his letter, not a flat cap", async () => {
  await withKey(async () => {
    const short = fakeProvider("Tidier.");
    await polishText("mow tues", "clear", short.provider);

    const long = fakeProvider(LONG_LETTER.replace("Hi", "Hello"));
    await polishText(LONG_LETTER, "clear", long.provider);

    assert.ok(long.calls[0]!.maxTokens > short.calls[0]!.maxTokens, "a long letter gets more room");
    // Four characters to a token is the pessimistic end of the estimate, so
    // the room asked for has to cover the whole letter even at that rate.
    assert.ok(
      long.calls[0]!.maxTokens * 4 > LONG_LETTER.length,
      `${long.calls[0]!.maxTokens} tokens is not enough room for ${LONG_LETTER.length} characters`,
    );
    // Even the longest paste he is allowed still gets enough room.
    assert.ok(polishMaxTokens("x".repeat(POLISH_MAX_CHARS)) * 4 > POLISH_MAX_CHARS);
  });
});

test("a rewrite that stopped part way through is not offered as the finished letter", async () => {
  await withKey(async () => {
    // What a cut-off answer looks like: a clean-reading fragment with the
    // greeting and its merge token intact, so the merge-field rule sees nothing
    // wrong and he is shown half a letter under the words "The AI version".
    const cutOff = LONG_LETTER.slice(0, Math.floor(LONG_LETTER.length * 0.45));
    assert.deepEqual(mergeTokensIn(cutOff), mergeTokensIn(LONG_LETTER), "the tokens all survived the cut");
    const { provider } = fakeProvider(cutOff);
    const result = await polishText(LONG_LETTER, "clear", provider);
    assert.equal(result.changed, false, "half a letter is not a rewrite");
    assert.equal(result.text, LONG_LETTER, "his own words, character for character");
    assert.match(result.note ?? "", /stopped part way through/i);
    assert.doesNotMatch(result.note ?? "", /merge fields/i, "do not blame his brackets for being cut off");
  });
});

test("a long letter genuinely tidied down a bit is still offered", async () => {
  await withKey(async () => {
    const signed = LONG_LETTER + " Thanks, [clientname]";
    const trimmed = LONG_LETTER.slice(0, Math.floor(LONG_LETTER.length * 0.75)) + " Thanks, [clientname]";
    const { provider } = fakeProvider(trimmed);
    const result = await polishText(signed, "clear", provider);
    assert.equal(result.changed, true, "shorter is the point of the clear tone");
  });
});

test("a short note cut down to a sentence is still offered", async () => {
  await withKey(async () => {
    const { provider } = fakeProvider("We will mow Tuesday if it is dry.");
    const result = await polishText(
      "hi there just letting you know we are planning on coming by on tuesday to mow for you as long as it is dry enough out, thanks a lot",
      "clear",
      provider,
    );
    assert.equal(result.changed, true, "he can read a short one at a glance");
  });
});

// ---- the endpoint ------------------------------------------------------

test("POST /ai/polish needs a signed-in user", async () => {
  const res = await api("/ai/polish", null, { method: "POST", body: JSON.stringify({ text: "hello" }) });
  assert.equal(res.status, 401);
});

test("POST /ai/polish answers available:false with his words untouched when no key is set", async () => {
  const res = await api("/ai/polish", admin.id, {
    method: "POST",
    body: JSON.stringify({ text: LETTER, tone: "professional" }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.available, false);
  assert.equal(res.body.changed, false);
  assert.equal(res.body.text, LETTER, "the contract: the original text, not an error");
  assert.equal(res.body.tone, "professional");
  assert.match(res.body.note, /not switched on/i);
});

test("POST /ai/polish refuses nothing-to-do and nonsense without pretending to work", async () => {
  const blank = await api("/ai/polish", admin.id, { method: "POST", body: JSON.stringify({ text: "   " }) });
  assert.equal(blank.status, 400);
  assert.match(blank.body.error, /nothing written/i);

  const missing = await api("/ai/polish", admin.id, { method: "POST", body: JSON.stringify({}) });
  assert.equal(missing.status, 400, "the generated zod body rejects a request with no text");

  const long = await api("/ai/polish", admin.id, {
    method: "POST",
    body: JSON.stringify({ text: "x".repeat(POLISH_MAX_CHARS + 1) }),
  });
  assert.equal(long.status, 400, "the maxLength in the contract is enforced at the edge");
});

test("POST /ai/polish refuses a tone that is not one of his three", async () => {
  // Pinned because the fallback in the route reads as though it tolerated one.
  // It does not: the generated zod enum rejects it at the edge, so the web
  // control can only ever send clear, professional or friendly.
  const res = await api("/ai/polish", admin.id, {
    method: "POST",
    body: JSON.stringify({ text: "hello", tone: "shouty" }),
  });
  assert.equal(res.status, 400);
});
