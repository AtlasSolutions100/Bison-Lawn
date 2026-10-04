import { test } from "node:test";
import assert from "node:assert/strict";
import { bulletText, hasFormatting, inlineHtml, richTextHtml, stripMarkers, textRuns } from "../src/lib/richText";

test("bold wins over italic, so **word** is never read as two empty italics", () => {
  assert.deepEqual(textRuns("a **bold** b"), [
    { text: "a ", bold: false, italic: false },
    { text: "bold", bold: true, italic: false },
    { text: " b", bold: false, italic: false },
  ]);
  assert.deepEqual(textRuns("an *aside* here"), [
    { text: "an ", bold: false, italic: false },
    { text: "aside", bold: false, italic: true },
    { text: " here", bold: false, italic: false },
  ]);
  assert.equal(inlineHtml("**Bagging** is *extra*"), "<strong>Bagging</strong> is <em>extra</em>");
});

test("a customer cannot inject markup through a description", () => {
  const html = inlineHtml('<script>alert("x")</script> **safe**');
  assert.ok(!html.includes("<script>"), html);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("<strong>safe</strong>"));
});

test("his mowing description renders as a paragraph and a bullet list", () => {
  // Shortened from the real one he showed on the call.
  const body = [
    "Mowing Service Disclosure",
    "",
    "- Standard mowing service includes mulching of grass clippings.",
    "- **Bagging and removal of clippings are not included.** Bagging fees, if requested, are billed *per service*.",
  ].join("\n");
  const html = richTextHtml(body);
  assert.ok(html.startsWith("<p "), html.slice(0, 40));
  assert.ok(html.includes("Mowing Service Disclosure"));
  assert.equal((html.match(/<li>/g) ?? []).length, 2);
  assert.ok(html.includes("<strong>Bagging and removal of clippings are not included.</strong>"));
  assert.ok(html.includes("<em>per service</em>"));
  assert.ok(!html.includes("**"), "no markers survive into the HTML");
});

test("numbered and bulleted lines are both bullets, and a lone dash is not", () => {
  assert.equal(bulletText("- one"), "one");
  assert.equal(bulletText("• two"), "two");
  assert.equal(bulletText("3. three"), "three");
  assert.equal(bulletText("1) four"), "four");
  assert.equal(bulletText("a - b"), null);
  assert.equal(bulletText("plain line"), null);
});

test("the plain-text half of the email shows no asterisks", () => {
  const body = "- **Bagging** is *extra*\nPlain line";
  assert.equal(stripMarkers(body), "• Bagging is extra\nPlain line");
});

test("single newlines inside a paragraph stay as breaks, because that is how he writes an address", () => {
  const html = richTextHtml("Bison Lawn Care LLC\nPO Box 117\nPost Falls, ID");
  assert.equal((html.match(/<br \/>/g) ?? []).length, 2);
  assert.equal((html.match(/<p /g) ?? []).length, 1);
});

test("text with no markers is left exactly alone", () => {
  assert.equal(hasFormatting("Mow, trim, edge and blow."), false);
  assert.equal(richTextHtml("Mow, trim, edge and blow."), '<p style="margin:0 0 16px;line-height:1.65">Mow, trim, edge and blow.</p>');
  assert.equal(stripMarkers("Mow, trim, edge and blow."), "Mow, trim, edge and blow.");
});

test("an unclosed marker is left as typed rather than eating the rest of the line", () => {
  assert.equal(inlineHtml("2 * 3 = 6"), "2 * 3 = 6");
  assert.equal(inlineHtml("**unclosed bold"), "**unclosed bold");
});
