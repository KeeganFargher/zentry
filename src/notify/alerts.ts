// Issue alerts and digests. DESIGN.md §18.4. A new or regressed issue alerts
// at most once per interval. The first alert for a project goes out at once;
// later ones wait for the project's digest window and go out together.

import { extendWindow, intervalPassed, openWindow, secondsUntil } from "@/core/digest";
import { alertEmail } from "@/core/email-alert";
import type { AlertNotice } from "@/core/email-alert";
import { digestEmail } from "@/core/email-messages";
import type { DigestItem, DigestNotice } from "@/core/email-messages";
import type { UnsubscribeTarget } from "@/core/unsubscribe";
import type { AlertReason, IssueNotice, ProjectNotice } from "@/shared/notify";

import { withMail } from "./deps";
import type { MailDeps, NotifyDeps } from "./deps";
import { deliver, unsubscribeUrl } from "./mailer";
import { eachProvider } from "./providers";
import type { ProviderSend } from "./providers";
import { pushTo } from "./push";
import { recipients } from "./recipients";
import type { Audience } from "./recipients";
import { alertPushContent, digestPushContent, eventForEmail, eventReader } from "./summaries";

export type AlertJob = { id: number; kind: AlertReason; groupId: number };

function alertAudience(project: ProjectNotice): Audience {
  return { type: "alerts", organizationId: project.organization.id, projectId: project.id };
}

function unsubscribeTarget(userId: number, project: ProjectNotice): UnsubscribeTarget {
  return { userId, type: "alerts", scope: "project", scopeId: project.id };
}

async function emailAlert(deps: MailDeps, notice: AlertNotice, key: string): Promise<void> {
  const { project } = notice.issue;

  for (const recipient of await recipients(deps, alertAudience(project), "email")) {
    const link = await unsubscribeUrl(deps, unsubscribeTarget(recipient.userId, project));

    const content = alertEmail(notice, { appUrl: deps.config.appUrl, unsubscribeUrl: link });

    await deliver(deps, {
      ...content,
      key: `${key}:${recipient.userId}`,
      kind: "alerts",
      recipient,
      groupId: notice.issue.id,
      unsubscribeUrl: link,
    });
  }
}

async function emailDigest(deps: MailDeps, digest: DigestNotice): Promise<void> {
  const { project } = digest;

  for (const recipient of await recipients(deps, alertAudience(project), "email")) {
    const link = await unsubscribeUrl(deps, unsubscribeTarget(recipient.userId, project));
    const links = { appUrl: deps.config.appUrl, unsubscribeUrl: link };

    await deliver(deps, {
      ...digestEmail(digest, links),
      key: `digest:${project.id}:${digest.since}:${recipient.userId}`,
      kind: "alerts",
      recipient,
      groupId: null,
      unsubscribeUrl: link,
    });
  }
}

async function pushRecipients(deps: NotifyDeps, project: ProjectNotice): Promise<number[]> {
  const pushed = await recipients(deps, alertAudience(project), "push");

  return pushed.map((recipient) => recipient.userId);
}

/** One issue's alert to everyone who wants it, by email and push. `key` makes each send unique. */
async function sendAlert(deps: NotifyDeps, item: DigestItem, key: string): Promise<void> {
  const mail = withMail(deps);
  // Read when first needed and then shared: the email shows it, and the push
  // summary is written from it. Nothing reads it when neither wants it.
  const read = eventReader(deps, item.issue);

  // The summary is written inside the push provider, so a Workers AI problem
  // can never hold back the email.
  const push: ProviderSend = [
    "push",
    async () =>
      pushTo(deps, await pushRecipients(deps, item.issue.project), {
        key,
        compose: () => alertPushContent(deps, item, read),
      }),
  ];

  const email = async (mailDeps: MailDeps): Promise<void> =>
    emailAlert(mailDeps, { ...item, event: await eventForEmail(read, item.issue) }, key);

  await eachProvider(deps, mail === null ? [push] : [["email", () => email(mail)], push]);
}

async function sendDigest(deps: NotifyDeps, digest: DigestNotice): Promise<void> {
  const mail = withMail(deps);

  const push: ProviderSend = [
    "push",
    async () =>
      pushTo(deps, await pushRecipients(deps, digest.project), {
        key: `digest:${digest.project.id}:${digest.since}`,
        compose: () => digestPushContent(deps, digest.items),
      }),
  ];

  await eachProvider(
    deps,
    mail === null ? [push] : [["email", () => emailDigest(mail, digest)], push],
  );
}

/** An issue resolved or archived since the alert was raised no longer alerts. */
function isOpen(issue: IssueNotice): boolean {
  return issue.status === "unresolved";
}

export async function handleAlert(deps: NotifyDeps, job: AlertJob): Promise<void> {
  const now = deps.now();
  const [issue] = await deps.store.issues([job.groupId]);
  const last = await deps.store.lastAlert(job.groupId, job.kind);

  if (issue === undefined || !isOpen(issue) || (last !== null && !intervalPassed(last, now))) {
    return;
  }

  const projectId = issue.project.id;
  const window = await deps.store.digestWindow(projectId);

  if (window !== null) {
    await deps.store.holdAlert(projectId, { groupId: issue.id, reason: job.kind, addedAt: now });
    await deps.store.saveDigestWindow(projectId, extendWindow(window, now));
    await deps.store.recordAlert(issue.id, job.kind, now);

    // A window past due has lost its flush message (it went to the dead
    // letter queue); ask again rather than hold alerts until the sweep.
    if (now >= window.dueAt) {
      await deps.scheduleDigest(projectId, 1);
    }

    return;
  }

  // Each step after the send makes a retry end sooner: once the alert is
  // recorded, a redelivery stops at the interval check above instead of
  // holding an issue that was already emailed.
  await sendAlert(deps, { issue, reason: job.kind }, `outbox:${job.id}`);
  await deps.store.recordAlert(issue.id, job.kind, now);

  const opened = openWindow(now);

  await deps.scheduleDigest(projectId, secondsUntil(opened.dueAt, now));
  await deps.store.saveDigestWindow(projectId, opened);
}

/** Sends what the project's window held, once it is due. */
export async function flushDigest(deps: NotifyDeps, projectId: number): Promise<void> {
  const now = deps.now();
  const window = await deps.store.digestWindow(projectId);

  if (window === null) {
    return;
  }

  if (now < window.dueAt) {
    await deps.scheduleDigest(projectId, secondsUntil(window.dueAt, now));

    return;
  }

  const held = await deps.store.heldAlerts(projectId);

  const issues = new Map(
    (await deps.store.issues(held.map((row) => row.groupId))).map((issue) => [issue.id, issue]),
  );

  const items = held.flatMap((row): DigestItem[] => {
    const issue = issues.get(row.groupId);

    return issue !== undefined && isOpen(issue) ? [{ issue, reason: row.reason }] : [];
  });

  const [first] = items;

  if (first === undefined) {
    await deps.store.closeDigest(projectId);

    return;
  }

  await (items.length === 1
    ? sendAlert(deps, first, `digest:${projectId}:${window.startedAt}`)
    : sendDigest(deps, { project: first.issue.project, items, since: window.startedAt }));

  const next = openWindow(now);

  await deps.store.restartDigest(projectId, next);
  await deps.scheduleDigest(projectId, secondsUntil(next.dueAt, now));
}
