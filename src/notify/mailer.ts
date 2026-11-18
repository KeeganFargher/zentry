// Sends one email to one recipient, at most once. DESIGN.md §18.5.

import { signUnsubscribe } from "@/core/unsubscribe";
import type { UnsubscribeTarget } from "@/core/unsubscribe";
import { errorText, logError } from "@/shared/log";
import type { OutgoingEmail } from "@/shared/notify";
import { DAY } from "@/shared/time";

import type { MailDeps } from "./deps";

/** Cloudflare's codes worth retrying; anything else will fail the same way again. */
const RETRYABLE = new Set([
  "E_RATE_LIMIT_EXCEEDED",
  "E_DAILY_LIMIT_EXCEEDED",
  "E_INTERNAL_SERVER_ERROR",
  "E_EMAIL_SENDING_NOT_READY",
  "E_DELIVERY_FAILED",
]);

/**
 * Thrown when Cloudflare asks to try later (rate or daily limit, an outage).
 * The drain stops and retries the whole message later, without counting it
 * against the row: a busy hour must not use up its attempts.
 */
export class SendDeferred extends Error {}

/** Cloudflare keeps a hard bounce suppressed for 7 days; so does Zentry. */
const SUPPRESSED_FOR = 7 * DAY;

function codeOf(cause: unknown): string {
  return cause instanceof Error && "code" in cause ? String(cause.code) : "";
}

function bracketed(messageId: string): string {
  return messageId.startsWith("<") ? messageId : `<${messageId}>`;
}

export async function unsubscribeUrl(deps: MailDeps, target: UnsubscribeTarget): Promise<string> {
  const token = await signUnsubscribe(target, deps.config.signingKey);

  return `${deps.config.unsubscribeUrl}?t=${encodeURIComponent(token)}`;
}

/** The headers Zentry sets; Cloudflare adds Message-ID, Date and the rest. */
type MailHeaders = {
  "Auto-Submitted": "auto-generated";
  "X-Zentry-Kind": string;
  "List-Unsubscribe"?: string;
  "List-Unsubscribe-Post"?: "List-Unsubscribe=One-Click";
  "In-Reply-To"?: string;
  References?: string;
};

function headersFor(email: OutgoingEmail, thread: { messageId: string | null }): MailHeaders {
  const headers: MailHeaders = { "Auto-Submitted": "auto-generated", "X-Zentry-Kind": email.kind };

  // RFC 8058 one-click unsubscribe, which Gmail and Yahoo expect.
  if (email.unsubscribeUrl !== null) {
    headers["List-Unsubscribe"] = `<${email.unsubscribeUrl}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  if (thread.messageId !== null) {
    headers["In-Reply-To"] = thread.messageId;
    headers.References = thread.messageId;
  }

  return headers;
}

async function threadOf(deps: MailDeps, email: OutgoingEmail): Promise<string | null> {
  return email.groupId === null ? null : deps.mail.thread(email.recipient.email, email.groupId);
}

/** Records a send that failed. Throws when a later delivery could succeed. */
async function failed(deps: MailDeps, email: OutgoingEmail, cause: unknown): Promise<void> {
  const code = codeOf(cause);
  const error = `${code} ${errorText(cause)}`.trim();

  if (RETRYABLE.has(code)) {
    throw new SendDeferred(error);
  }

  if (code === "E_RECIPIENT_SUPPRESSED") {
    const now = deps.now();

    await deps.mail.suppress(email.recipient.email, now + SUPPRESSED_FOR, now);
    await deps.mail.settle(email.key, { status: "suppressed", error });

    return;
  }

  logError("email not sent", { key: email.key, kind: email.kind, error });
  await deps.mail.settle(email.key, { status: "failed", error });
}

export async function deliver(deps: MailDeps, email: OutgoingEmail): Promise<void> {
  const now = deps.now();
  const address = email.recipient.email;

  if (await deps.mail.isSuppressed(address, now)) {
    return;
  }

  const record = {
    key: email.key,
    userId: email.recipient.userId,
    kind: email.kind,
    groupId: email.groupId,
  };

  if ((await deps.mail.claim(record, now)) === "done") {
    return;
  }

  const thread = await threadOf(deps, email);
  let messageId: string;

  try {
    const result = await deps.send({
      from: deps.config.from,
      to: address,
      subject: email.subject,
      text: email.text,
      html: email.html,
      headers: headersFor(email, { messageId: thread }),
    });

    messageId = bracketed(result.messageId);
  } catch (cause) {
    await failed(deps, email, cause);

    return;
  }

  await deps.mail.settle(email.key, { status: "sent", messageId });

  if (email.groupId !== null && thread === null) {
    await deps.mail.startThread({ address, groupId: email.groupId, messageId }, now);
  }
}
