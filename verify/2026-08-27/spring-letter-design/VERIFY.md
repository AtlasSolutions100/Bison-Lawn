# Spring letter: designed email, and a preview that tells the truth

Date: 2026-08-27 · https://bisonlawncare.workoptional.tech/spring-letters

## What was wrong

The preview was a bare `<pre>`. It was ugly — but it was *accurate*: the letter
really did go out as plain text, so the itemised season pricing arrived as
name-and-amount pairs that drift apart at whatever width the customer's mail
client happens to use. Prettifying the preview alone would have made the office
approve something the customer never receives.

## What changed

The letter itself is now an HTML email using the same shell as the estimate and
customer-update mails: wordmark, `#215343` header band, cream footer with the
emblem, and the services as a real table with the total set apart.

`sendClientEmailViaGmail` takes `html` as optional, so every other caller is
unchanged. The `text/plain` part is still sent — it is what text-only clients,
screen readers and notification previews show, and HTML-only mail is a spam
signal, so the designed version accompanies the plain one rather than replacing
it.

The preview renders that exact HTML in an iframe with `sandbox=""` — no scripts,
no forms, no same-origin. That isolation is also what makes it honest: the app's
own stylesheet cannot leak in and flatter the result. A **Plain text** tab shows
the other half of the same message.

## Verified live

Read out of the rendered `srcdoc` on the deployed host:

- wordmark present, emblem present, `#215343` used 3 times
- services rendered as `<table>`, total row present
- **no unsubstituted `{{tokens}}`** — nothing like `{{clientFirstName}}` can
  reach a customer
- no `<script>` in the generated markup; iframe `sandbox` attribute is `""`
- sign-off, company block and footer all render: "Your Friendly Bison," →
  Bison Lawn Care LLC → contact line → "Thank you for your business!" → PO Box
  7156, Kalispell MT 59904

Arithmetic checked against a multi-service customer rather than a single-line
one, where a line item and the total are indistinguishable:

    Sarah Thompson — Aeration $60.00 + Weekly Mowing $45.00 = Total $105.00

Sum of line items equals the stated total, and exactly one "Total" label appears.

## A defect this caught

The first version printed the total **twice**: the table added its own total row
while the template's own `Total: {{total}}` line still rendered. Every letter
would have quoted the customer's season price twice, which invites the reply
"which one is it?".

The table now totals only when the author has not placed the total themselves,
keyed on the presence of the `{{total}}` token rather than the wording around
it — so rephrasing the line cannot bring the duplicate back. An author's own
total line is given the weight the table row would have had.

Found in the live preview. No test covered it, and the first screenshot looked
fine until the text was read end to end.
