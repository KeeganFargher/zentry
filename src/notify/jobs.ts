// The other outbox kinds: workflow, quota, spike protection and the weekly
// report. DESIGN.md §18.3, §18.7 and §19.

import type { EmailContent } from "@/core/email-layout";
import { quotaEmail, spikeEmail, weeklyReportEmail, workflowEmail } from "@/core/email-messages";
import type { MailLinks } from "@/core/email-messages";
import { quotaPush, spikePush, workflowPush } from "@/core/push-messages";
import type { UnsubscribeTarget } from "@/core/unsubscribe";
import type { NotificationProvider, NotificationType } from "@/shared/contract";
import type { OutboxItem, Recipient } from "@/shared/notify";
import type { PushContent } from "@/shared/push";
import { nextMonthBucket } from "@/shared/time";

import { withMail } from "./deps";
import type { MailDeps, NotifyDeps } from "./deps";
import { deliver, unsubscribeUrl } from "./mailer";
import { eachProvider } from "./providers";
import type { ProviderSend } from "./providers";
import { pushTo } from "./push";
import { recipients, workflowRecipients } from "./recipients";

type Job<K extends OutboxItem["kind"]> = Extract<OutboxItem, { kind: K }>;

/** How to address one batch of identical notifications, one per recipient. */
type Fanout = {
  kind: NotificationType;
  key: string;
  groupId: number | null;
  /** What the recipient's unsubscribe link turns off. */
  scope: Omit<UnsubscribeTarget, "userId">;
  render: (links: MailLinks) => EmailContent;
  /** The push version; null for a notification that is email only. */
  push: PushContent | null;
};

/** Who gets the notification by one provider. */
type AudienceOf = (provider: NotificationProvider) => Promise<Recipient[]>;

async function emailEach(deps: MailDeps, to: Recipient[], fanout: Fanout): Promise<void> {
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

/** Emails (when email is configured) and pushes everyone who wants it by each. */
async function fanOut(deps: NotifyDeps, audienceOf: AudienceOf, fanout: Fanout): Promise<void> {
  const mail = withMail(deps);
  const content = fanout.push;
  const sends: ProviderSend[] = [];

  if (mail !== null) {
    sends.push(["email", async () => emailEach(mail, await audienceOf("email"), fanout)]);
  }

  if (content !== null) {
    sends.push([
      "push",
      async () => {
        const pushed = await audienceOf("push");

        await pushTo(
          deps,
          pushed.map((recipient) => recipient.userId),
          { key: fanout.key, content },
        );
      },
    ]);
  }

  await eachProvider(deps, sends);
}

export async function handleWorkflow(deps: NotifyDeps, job: Job<"status">): Promise<void> {
  const [issue] = await deps.store.issues([job.groupId]);

  if (issue === undefined) {
    return;
  }

  const actor = job.actorId === null ? null : await deps.store.userEmail(job.actorId);
  const change = { actor: actor ?? "Zentry", status: job.status };

  const audienceOf: AudienceOf = (provider) =>
    workflowRecipients(deps, { issue, actorId: job.actorId }, provider);

  await fanOut(deps, audienceOf, {
    kind: "workflow",
    key: `outbox:${job.id}`,
    groupId: issue.id,
    scope: { type: "workflow", scope: "issue", scopeId: issue.id },
    render: (links) => workflowEmail(issue, change, links),
    push: workflowPush(issue, change),
  });
}

export async function handleQuota(deps: NotifyDeps, job: Job<"quota">): Promise<void> {
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

  await fanOut(deps, (provider) => recipients(deps, audience, provider), {
    kind: "quota",
    key: `quota:${organization.id}:${job.month}:${job.percent}`,
    groupId: null,
    scope: { type: "quota", scope: "organization", scopeId: organization.id },
    render: (links) => quotaEmail(notice, links),
    push: quotaPush(notice),
  });
}

export async function handleSpike(deps: NotifyDeps, job: Job<"spike">): Promise<void> {
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

  await fanOut(deps, (provider) => recipients(deps, audience, provider), {
    kind: "spikeProtection",
    key: `spike:${project.id}:${job.until}`,
    groupId: null,
    scope: { type: "spikeProtection", scope: "project", scopeId: project.id },
    render: (links) => spikeEmail(notice, links),
    push: spikePush(notice),
  });
}

/** Email only (DESIGN.md §19). Skipped for an organization with nothing to report. */
export async function handleWeeklyReport(
  deps: NotifyDeps,
  job: Job<"weekly_report">,
): Promise<void> {
  const organization = await deps.store.organization(job.organizationId);

  // Without a sender there is nobody to build the report for.
  if (organization === null || deps.config === null) {
    return;
  }

  const numbers = await deps.reports.weekly(organization.id, job);

  if (numbers.totals.events === 0 && numbers.totals.newIssues === 0) {
    return;
  }

  const report = { organization, start: job.start, end: job.end, ...numbers };
  const audience = { type: "reports" as const, organizationId: organization.id, projectId: null };

  await fanOut(deps, (provider) => recipients(deps, audience, provider), {
    kind: "reports",
    key: `report:${organization.id}:${job.start}`,
    groupId: null,
    scope: { type: "reports", scope: "organization", scopeId: organization.id },
    render: (links) => weeklyReportEmail(report, links),
    push: null,
  });
}
