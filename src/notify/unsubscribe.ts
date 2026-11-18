// The unsubscribe link in every optional email. DESIGN.md §18.6. It is served
// on the ingest host, which Cloudflare Access does not guard, because mail
// providers POST to it without signing in (RFC 8058 one-click). The signed
// token is the only authority. GET only asks, since link scanners fetch every
// URL in a message; POST, from the page's button or from the mail provider,
// does it.

import { escapeHtml } from "@/core/email-layout";
import { verifyUnsubscribe } from "@/core/unsubscribe";
import type { UnsubscribeTarget } from "@/core/unsubscribe";
import type { NotifyStore } from "@/db/notify";
import type { NotificationSettingsStore } from "@/db/notify-settings";
import type { NotificationType } from "@/shared/contract";

export const UNSUBSCRIBE_PATH = "/notifications/unsubscribe";

export type UnsubscribeDeps = {
  store: NotifyStore;
  settings: NotificationSettingsStore;
  /** Empty when email is not configured; every link is then refused. */
  signingKey: string;
  now: () => number;
};

const LABELS = {
  alerts: "issue alerts",
  workflow: "workflow emails",
  quota: "quota emails",
  spikeProtection: "spike protection emails",
  reports: "weekly reports",
} satisfies { [type in NotificationType]: string };

function page(status: number, title: string, body: string): Response {
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(title)}</title></head>` +
    `<body style="font-family:system-ui,sans-serif;max-width:480px;margin:48px auto;padding:0 16px;` +
    `line-height:1.5;color:#302e36"><h1 style="font-size:20px">${escapeHtml(title)}</h1>${body}</body></html>`;

  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    },
  });
}

/** "issue alerts for api", "workflow emails about API-12". */
async function describe(target: UnsubscribeTarget, deps: UnsubscribeDeps): Promise<string> {
  const label = LABELS[target.type];

  if (target.scope === "project") {
    const project = await deps.store.project(target.scopeId);

    return project === null ? label : `${label} for ${project.slug}`;
  }

  if (target.scope === "issue") {
    const [issue] = await deps.store.issues([target.scopeId]);

    return issue === undefined ? label : `${label} about ${issue.shortId}`;
  }

  if (target.scope === "organization") {
    const organization = await deps.store.organization(target.scopeId);

    return organization === null ? label : `${label} for ${organization.name}`;
  }

  return label;
}

async function apply(target: UnsubscribeTarget, deps: UnsubscribeDeps): Promise<void> {
  const now = deps.now();

  if (target.scope === "issue") {
    await deps.settings.setSubscription(
      { userId: target.userId, active: false },
      target.scopeId,
      now,
    );

    return;
  }

  // An unsubscribe link is in an email, so it turns off email alone.
  await deps.settings.set(
    { ...target, provider: "email", scope: target.scope, value: "never" },
    now,
  );
}

async function targetOf(url: URL, deps: UnsubscribeDeps): Promise<UnsubscribeTarget | null> {
  const token = url.searchParams.get("t") ?? "";

  return token === "" || deps.signingKey === "" ? null : verifyUnsubscribe(token, deps.signingKey);
}

export async function handleUnsubscribe(
  request: Request,
  deps: UnsubscribeDeps,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: { allow: "GET, POST" } });
  }

  const target = await targetOf(url, deps);

  if (target === null) {
    return page(
      400,
      "This link does not work",
      "<p>The unsubscribe link is incomplete or was changed.</p>",
    );
  }

  const what = escapeHtml(await describe(target, deps));

  if (request.method === "POST") {
    await apply(target, deps);

    return page(
      200,
      "Unsubscribed",
      `<p>You will no longer get ${what}. You can turn them back on in Zentry's notification settings.</p>`,
    );
  }

  const action = escapeHtml(`${UNSUBSCRIBE_PATH}${url.search}`);

  return page(
    200,
    "Unsubscribe?",
    `<p>Stop getting ${what}?</p><form method="post" action="${action}">` +
      `<button type="submit" style="font:inherit;padding:6px 16px">Unsubscribe</button></form>`,
  );
}
