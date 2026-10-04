/**
 * The bit of emphasis he asked for in text he types himself.
 *
 * "In description of services can we make works bold or emphasized somehow?
 * Same case for documents and other inputed typed information."
 *
 * Deliberately not a rich-text editor. He writes his service descriptions by
 * feeding his notes to ChatGPT and pasting the result back — "I've entered in
 * my data into chat GPT and then it highlights" — and what that produces is
 * `**bold**`, `*italic*` and `- bullets`. Supporting exactly those markers
 * means his existing text starts rendering properly without him learning
 * anything or us shipping a toolbar.
 *
 * Markers are read AFTER escaping, so nothing a customer or the office types
 * can inject markup into an email.
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** A stretch of text that reads the same the whole way through. */
export type TextRun = { text: string; bold: boolean; italic: boolean };

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/;

/**
 * Break one line into bold / italic runs, for a renderer that switches fonts
 * rather than emitting tags — the estimate PDF, mainly.
 *
 * `**` is matched before `*` so "**bold**" never reads as two italics with an
 * empty middle.
 */
export function textRuns(line: string): TextRun[] {
  const runs: TextRun[] = [];
  let rest = line;
  const pattern = /\*\*(.+?)\*\*|\*(.+?)\*/;
  for (;;) {
    const match = pattern.exec(rest);
    if (!match) break;
    if (match.index > 0) runs.push({ text: rest.slice(0, match.index), bold: false, italic: false });
    if (match[1] != null) runs.push({ text: match[1], bold: true, italic: false });
    else runs.push({ text: match[2]!, bold: false, italic: true });
    rest = rest.slice(match.index + match[0].length);
  }
  if (rest) runs.push({ text: rest, bold: false, italic: false });
  return runs.length ? runs : [{ text: "", bold: false, italic: false }];
}

/** One line as HTML: escaped first, then the markers applied. */
export function inlineHtml(line: string): string {
  return textRuns(line)
    .map((run) => {
      const text = escapeHtml(run.text);
      if (run.bold) return `<strong>${text}</strong>`;
      if (run.italic) return `<em>${text}</em>`;
      return text;
    })
    .join("");
}

/** Whether a line is a bullet, and the text after its marker. */
export function bulletText(line: string): string | null {
  const match = BULLET.exec(line);
  return match ? match[1] : null;
}

/**
 * A whole body as HTML: blank lines separate paragraphs, runs of bulleted
 * lines become a list, and single newlines inside a paragraph stay as breaks
 * because that is how his addresses and sign-offs are written.
 */
export function richTextHtml(body: string, opts: { paragraphStyle?: string; listStyle?: string } = {}): string {
  const paragraphStyle = opts.paragraphStyle ?? "margin:0 0 16px;line-height:1.65";
  const listStyle = opts.listStyle ?? "margin:0 0 16px;padding-left:22px;line-height:1.65";
  const out: string[] = [];

  for (const block of body.trim().split(/\n\s*\n/)) {
    const lines = block.split(/\r?\n/);
    let bullets: string[] = [];
    let plain: string[] = [];
    const flushBullets = () => {
      if (!bullets.length) return;
      out.push(`<ul style="${listStyle}">${bullets.map((b) => `<li>${inlineHtml(b)}</li>`).join("")}</ul>`);
      bullets = [];
    };
    const flushPlain = () => {
      if (!plain.length) return;
      out.push(`<p style="${paragraphStyle}">${plain.map(inlineHtml).join("<br />")}</p>`);
      plain = [];
    };
    for (const line of lines) {
      const bullet = bulletText(line);
      if (bullet != null) {
        flushPlain();
        bullets.push(bullet);
      } else {
        flushBullets();
        if (line.trim()) plain.push(line);
      }
    }
    flushBullets();
    flushPlain();
  }
  return out.join("");
}

/**
 * The same text with the markers taken out, for the plain-text half of an
 * email and anywhere else that cannot show emphasis. A reader whose mail
 * client shows the text part should not be looking at asterisks.
 */
export function stripMarkers(body: string): string {
  return body
    .split(/\r?\n/)
    .map((line) => {
      const bullet = bulletText(line);
      const text = bullet ?? line;
      const flat = textRuns(text)
        .map((run) => run.text)
        .join("");
      return bullet != null ? `• ${flat}` : flat;
    })
    .join("\n");
}

/** Whether a body uses any of the markers, so a preview can say so. */
export function hasFormatting(body: string): boolean {
  return body.split(/\r?\n/).some((line) => bulletText(line) != null || /\*\*(.+?)\*\*|\*(.+?)\*/.test(line));
}
