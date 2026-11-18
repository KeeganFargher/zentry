// Email bodies, built once as blocks and rendered twice: an HTML part and a
// plain-text part with the same content, so the text part is never empty.
// DESIGN.md §18.5. Styles are inline and layout is tables, because mail
// clients drop <style> and many ignore flex and grid.

export type EmailBlock =
  | { kind: "heading"; text: string }
  | { kind: "note"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "label"; text: string }
  | { kind: "section"; text: string }
  | { kind: "issue"; title: string; url: string; detail: string | null; meta: string[] }
  | { kind: "code"; text: string }
  | { kind: "button"; label: string; url: string }
  | { kind: "facts"; rows: [label: string, value: string][] }
  | { kind: "tags"; pairs: [key: string, value: string][] }
  | { kind: "links"; items: { label: string; url: string; detail: string }[] };

export type EmailFooter = {
  /** Why the reader got this email, in a sentence. */
  reason: string;
  settingsUrl: string;
  unsubscribeUrl: string | null;
};

export type EmailContent = { subject: string; text: string; html: string };

// Mail clients fall back to Arial or Helvetica, where 500 renders as 400, so
// emails keep bold (600/700) for emphasis where the UI uses Sentry's 500.
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

// Sentry's light tokens, as the web UI and app use (ui/src/styles.css).
const INK = "#302e36";
const MUTED = "#6a6772";
const ACCENT = "#7553ff";
const ACCENT_EDGE = "#5827d6";
const LINK = "#653de9";
const LINE = "#e6e6e9";
const SHADE = "#f8f8f9";

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function factsHtml(rows: [string, string][]): string {
  const cells = rows.map(
    ([label, value]) =>
      `<tr><td style="padding:8px 16px 8px 8px;color:${MUTED};white-space:nowrap;vertical-align:top">` +
      `${escapeHtml(label)}</td><td style="padding:8px 12px;background:${SHADE};` +
      `border-radius:4px;word-break:break-word">${escapeHtml(value)}</td></tr>`,
  );

  return (
    `<table role="presentation" width="100%" style="border-collapse:separate;border-spacing:0 6px;` +
    `margin:0 0 16px">${cells.join("")}</table>`
  );
}

function tagsHtml(pairs: [string, string][]): string {
  const pills = pairs.map(
    ([key, value]) =>
      `<span style="display:inline-block;background:${SHADE};border-radius:4px;padding:6px 10px;` +
      `margin:0 6px 6px 0;word-break:break-word"><span style="color:${MUTED}">${escapeHtml(key)} = </span>` +
      `<span style="color:${LINK}">${escapeHtml(value)}</span></span>`,
  );

  return `<div style="margin:0 0 16px">${pills.join("")}</div>`;
}

function linksHtml(items: { label: string; url: string; detail: string }[]): string {
  const rows = items.map(
    (item) =>
      `<li style="margin:0 0 8px"><a href="${escapeHtml(item.url)}" style="color:${LINK}">` +
      `${escapeHtml(item.label)}</a><br><span style="color:${MUTED}">${escapeHtml(item.detail)}</span></li>`,
  );

  return `<ul style="padding-left:20px;margin:0 0 16px">${rows.join("")}</ul>`;
}

function buttonHtml(label: string, url: string): string {
  return (
    `<a href="${escapeHtml(url)}" style="background:${ACCENT};color:#fff;padding:8px 16px;` +
    `border-radius:8px;border-bottom:2px solid ${ACCENT_EDGE};text-decoration:none;display:inline-block;font-weight:600">` +
    `${escapeHtml(label)}</a>`
  );
}

function issueHtml(block: Extract<EmailBlock, { kind: "issue" }>): string {
  const detail =
    block.detail === null
      ? ""
      : `<p style="margin:4px 0 0;color:${MUTED};word-break:break-word">${escapeHtml(block.detail)}</p>`;

  const meta = block.meta.map(
    (item, index) =>
      `<td style="padding:16px 0 0;color:${MUTED};${index > 0 ? "text-align:right" : ""}">` +
      `${escapeHtml(item)}</td>`,
  );

  return (
    `<div style="margin:0 0 16px"><a href="${escapeHtml(block.url)}" style="color:${LINK};` +
    `font-size:17px;font-weight:600;text-decoration:none;word-break:break-word">` +
    `${escapeHtml(block.title)}</a>${detail}` +
    `<table role="presentation" width="100%" style="border-collapse:collapse"><tr>${meta.join("")}</tr></table></div>`
  );
}

function codeHtml(text: string): string {
  return (
    `<pre style="background:${SHADE};padding:16px;border-radius:4px;white-space:pre-wrap;` +
    `word-break:break-word;margin:0 0 16px;font-family:${MONO};font-size:12px;line-height:1.6">` +
    `${escapeHtml(text)}</pre>`
  );
}

/** Blocks of running text. */
function textHtml(block: EmailBlock): string | null {
  if (block.kind === "heading") {
    return `<h1 style="font-size:24px;margin:0 0 6px">${escapeHtml(block.text)}</h1>`;
  }

  if (block.kind === "note") {
    return `<p style="margin:0 0 24px;color:${MUTED}">${escapeHtml(block.text)}</p>`;
  }

  if (block.kind === "paragraph") {
    return `<p style="margin:0 0 16px">${escapeHtml(block.text)}</p>`;
  }

  if (block.kind === "label") {
    return (
      `<p style="margin:0 0 12px;padding-bottom:8px;border-bottom:2px solid ${LINE};color:${MUTED};` +
      `font-size:12px;font-weight:700;letter-spacing:0.5px">${escapeHtml(block.text.toUpperCase())}</p>`
    );
  }

  return block.kind === "section"
    ? `<h2 style="font-size:18px;margin:28px 0 10px">${escapeHtml(block.text)}</h2>`
    : null;
}

function blockHtml(block: EmailBlock): string {
  const text = textHtml(block);

  if (text !== null) {
    return text;
  }

  if (block.kind === "issue") {
    return issueHtml(block);
  }

  if (block.kind === "code") {
    return codeHtml(block.text);
  }

  if (block.kind === "button") {
    return `<p style="margin:0 0 16px">${buttonHtml(block.label, block.url)}</p>`;
  }

  if (block.kind === "facts") {
    return factsHtml(block.rows);
  }

  if (block.kind === "tags") {
    return tagsHtml(block.pairs);
  }

  return block.kind === "links" ? linksHtml(block.items) : "";
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

function richText(block: EmailBlock): string {
  if (block.kind === "issue") {
    return [block.title, block.detail, block.meta.join(" · "), block.url]
      .filter((line) => line !== null && line !== "")
      .join("\n");
  }

  if (block.kind === "code") {
    return indent(block.text);
  }

  if (block.kind === "button") {
    return `${block.label}: ${block.url}`;
  }

  if (block.kind === "facts") {
    return block.rows.map(([label, value]) => `${label}: ${value}`).join("\n");
  }

  if (block.kind === "tags") {
    return block.pairs.map(([key, value]) => `${key} = ${value}`).join("\n");
  }

  return block.kind === "links"
    ? block.items.map((item) => `* ${item.label}\n  ${item.detail}\n  ${item.url}`).join("\n")
    : "";
}

function blockText(block: EmailBlock): string {
  if (block.kind === "label") {
    return block.text.toUpperCase();
  }

  if (block.kind === "section") {
    return `${block.text}\n${"-".repeat(block.text.length)}`;
  }

  return block.kind === "heading" || block.kind === "note" || block.kind === "paragraph"
    ? block.text
    : richText(block);
}

function footerHtml(footer: EmailFooter): string {
  const links = [
    `<a href="${escapeHtml(footer.settingsUrl)}" style="color:${MUTED}">Notification settings</a>`,
  ];

  if (footer.unsubscribeUrl !== null) {
    links.push(
      `<a href="${escapeHtml(footer.unsubscribeUrl)}" style="color:${MUTED}">Unsubscribe</a>`,
    );
  }

  return (
    `<p style="margin:24px 0 0;padding-top:12px;border-top:1px solid ${LINE};color:${MUTED};` +
    `font-size:12px">${escapeHtml(footer.reason)}<br>${links.join(" · ")}</p>`
  );
}

function footerText(footer: EmailFooter): string {
  const lines = ["--", footer.reason, `Notification settings: ${footer.settingsUrl}`];

  if (footer.unsubscribeUrl !== null) {
    lines.push(`Unsubscribe: ${footer.unsubscribeUrl}`);
  }

  return lines.join("\n");
}

/** The header's button, beside the wordmark. */
export type EmailAction = { label: string; url: string };

export type EmailDraft = {
  subject: string;
  action?: EmailAction;
  blocks: EmailBlock[];
  footer: EmailFooter;
};

function headerHtml(draft: EmailDraft): string {
  const button =
    draft.action === undefined
      ? ""
      : `<td style="text-align:right">${buttonHtml(draft.action.label, draft.action.url)}</td>`;

  return (
    `<table role="presentation" width="100%" style="border-collapse:collapse;border-bottom:1px solid ${LINE}">` +
    `<tr><td style="padding:20px 32px"><table role="presentation" width="100%" style="border-collapse:collapse">` +
    `<tr><td style="font-size:18px;font-weight:700;letter-spacing:2px;color:${INK}">ZENTRY</td>${button}</tr>` +
    `</table></td></tr></table>`
  );
}

export function renderEmail(draft: EmailDraft): EmailContent {
  const body = draft.blocks.map(blockHtml).join("");

  const html =
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `</head><body style="margin:0;padding:24px 8px;background:${SHADE}">` +
    `<div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid ${LINE};` +
    `border-radius:6px;font-family:${FONT};font-size:14px;line-height:1.5;color:${INK}">` +
    `${headerHtml(draft)}<div style="padding:28px 32px">${body}${footerHtml(draft.footer)}</div>` +
    `</div></body></html>`;

  const text = [...draft.blocks.map(blockText), footerText(draft.footer)].join("\n\n");

  return { subject: draft.subject, text, html };
}
