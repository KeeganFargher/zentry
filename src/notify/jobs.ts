// The other outbox kinds: workflow, quota, spike protection and the weekly
// report. DESIGN.md §18.3 and §18.7.

import type { EmailContent } from "@/core/email-layout";
import { quotaEmail, spikeEmail, weeklyReportEmail, workflowEmail } from "@/core/email-messages";
import type { MailLinks } from "@/core/email-messages";
import type { UnsubscribeTarget } from "@/core/unsubscribe";
import type { NotificationType } from "@/shared/contract";
import type { OutboxItem, Recipient } from "@/shared/notify";
import { nextMonthBucket } from "@/shared/time";

import type { MailDeps } from "./deps";
import { deliver, unsubscribeUrl } from "./mailer";
import { recipients, workflowRecipients } from "./recipients";

type Job<K extends OutboxItem["kind"]> = Extract<OutboxItem, { kind: K }>;

/** How to address one batch of identical emails, one per recipient. */
type Fanout = {
  kind: NotificationType;
  key: string;
  groupId: number | null;
  /** What the recipient's unsubscribe link turns off. */
  scope: Omit<UnsubscribeTarget, "userId">;
  render: (links: MailLinks) => EmailContent;
};

async function fanOut(deps: MailDeps, to: Recipient[], fanout: Fanout): Promise<void> {
  for (const recipient of to) {
    const link = await unsubscribeUrl(deps, { ...fanout.scope, userId: recipient.userId });
    const content = fanout.render({ appUrl: deps.config.appUrl, unsubscribeUrl: link });

    await deliver(deps, {
      ...content,
      key: `${fanout.key}:${recipient.userId}`,
      kind: fanout.kind,
      recipient,
      groupId: fanout.groupId,
      unsubscribeUrl: link,
    });
  }
}

export async function handleWorkflow(deps: MailDeps, job: Job<"status">): Promise<void> {
  const [issue] = await deps.store.issues([job.groupId]);

  if (issue === undefined) {
    return;
  }

  const actor = job.actorId === null ? null : await deps.store.userEmail(job.actorId);
  const change = { actor: actor ?? "Zentry", status: job.status };

  await fanOut(deps, await workflowRecipients(deps, { issue, actorId: job.actorId }), {
    kind: "workflow",
    key: `outbox:${job.id}`,
    groupId: issue.id,
    scope: { type: "workflow", scope: "issue", scopeId: issue.id },
    render: (links) => workflowEmail(issue, change, links),
  });
}

export async function handleQuota(deps: MailDeps, job: Job<"quota">): Promise<void> {
  const organization = await deps.store.organization(job.organizationId);

  if (organization === null) {
    return;
  }

  const notice = {
    organization,
    percent: job.percent,
    limit: job.limit,
    month: job.month,
    nextMonth: nextMonthBucket(job.month),
  };

  const audience = { type: "quota" as const, organizationId: organization.id, projectId: null };

  await fanOut(deps, await recipients(deps, audience), {
    kind: "quota",
    key: `quota:${organization.id}:${job.month}:${job.percent}`,
    groupId: null,
    scope: { type: "quota", scope: "organization", scopeId: organization.id },
    render: (links) => quotaEmail(notice, links),
  });
}

export async function handleSpike(deps: MailDeps, job: Job<"spike">): Promise<void> {
  const project = await deps.store.project(job.projectId);

  if (project === null) {
    return;
  }

  const notice = { project, limit: job.limit, until: job.until };

  const audience = {
    type: "spikeProtection" as const,
    organizationId: project.organization.id,
    projectId: project.id,
  };

  await fanOut(deps, await recipients(deps, audience), {
    kind: "spikeProtection",
    key: `spike:${project.id}:${job.until}`,
    groupId: null,
    scope: { type: "spikeProtection", scope: "project", scopeId: project.id },
    render: (links) => spikeEmail(notice, links),
  });
}

/** Skipped for an organization with nothing to report. */
export async function handleWeeklyReport(deps: MailDeps, job: Job<"weekly_report">): Promise<void> {
  const organization = await deps.store.organization(job.organizationId);

  if (organization === null) {
    return;
  }

  const numbers = await deps.reports.weekly(organization.id, job);

  if (numbers.totals.events === 0 && numbers.totals.newIssues === 0) {
    return;
  }

  const report = { organization, start: job.start, end: job.end, ...numbers };
  const audience = { type: "reports" as const, organizationId: organization.id, projectId: null };

  await fanOut(deps, await recipients(deps, audience), {
    kind: "reports",
    key: `report:${organization.id}:${job.start}`,
    groupId: null,
    scope: { type: "reports", scope: "organization", scopeId: organization.id },
    render: (links) => weeklyReportEmail(report, links),
  });
}
