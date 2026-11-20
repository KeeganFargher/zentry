// The other outbox kinds: workflow, quota, spike protection and the weekly
// report. DESIGN.md §18.3, §18.7 and §19.

import { renderEmail } from "@/core/email-layout";
import type { EmailContent } from "@/core/email-layout";
import {
  clip,
  quotaEmail,
  settingsUrl,
  spikeEmail,
  weeklyReportEmail,
  workflowEmail,
} from "@/core/email-messages";
import type { MailLinks } from "@/core/email-messages";
import { quotaPush, spikePush, workflowPush } from "@/core/push-messages";
import type { UnsubscribeTarget } from "@/core/unsubscribe";
import type { NotificationProvider, NotificationType } from "@/shared/contract";
import type { IssueNotice, MonitorDelivery, OutboxItem, Recipient } from "@/shared/notify";
import type { PushContent } from "@/shared/push";
import { nextMonthBucket } from "@/shared/time";

import { withMail } from "./deps";
import type { MailDeps, NotifyDeps } from "./deps";
import { deliver, unsubscribeUrl } from "./mailer";
import { routeTransitions } from "./monitor-routing";
import { eachProvider, SendDeferred } from "./providers";
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
          { key: fanout.key, compose: async () => content },
        );
      },
    ]);
  }

  await eachProvider(deps, sends);
}

async function monitorRecipients(
  deps: NotifyDeps,
  job: MonitorDelivery,
  issue: IssueNotice,
): Promise<Recipient[]> {
  const audience = {
    type: "alerts" as const,
    organizationId: issue.project.organization.id,
    projectId: issue.project.id,
  };

  const allowed = await recipients(deps, audience, job.channel);

  const previous =
    job.transition === "recovery" ? await deps.store.monitorRecoveryAudience(job) : null;

  const selected = job.audience;

  return allowed.filter(
    ({ userId }) =>
      (previous === null || previous.has(userId)) &&
      (selected.kind === "project" ||
        (selected.kind === "owner" ? job.ownerId === userId : selected.userIds.includes(userId))),
  );
}

function renderMonitorAlert(input: {
  job: MonitorDelivery;
  issue: IssueNotice;
  subject: string;
  links: MailLinks;
}): EmailContent {
  const { job, issue, subject, links } = input;
  const { project } = issue;
  const organization = project.organization.slug;

  return renderEmail({
    subject,
    blocks: [
      { kind: "heading", text: subject },
      {
        kind: "paragraph",
        text: job.environment === "" ? issue.title : `${issue.title} · ${job.environment}`,
      },
      {
        kind: "button",
        label: "View monitor",
        url: `${links.appUrl}/${organization}/monitors/${job.monitorId}/`,
      },
      {
        kind: "button",
        label: "View issue",
        url: `${links.appUrl}/${organization}/issues/${issue.id}/`,
      },
    ],
    footer: {
      reason: "A linked alert rule sent this monitor update.",
      settingsUrl: settingsUrl(links.appUrl, project.organization),
      unsubscribeUrl: links.unsubscribeUrl,
    },
  });
}

/**
 * Routes the transition (src/notify/monitor-routing.ts), then sends each of
 * its deliveries that was not suppressed. Both are safe to repeat when the
 * row retries.
 */
export async function handleMonitorAlert(deps: NotifyDeps, item: Job<"monitor">): Promise<void> {
  const routing = deps.store.monitorRouting;

  await routeTransitions(routing, item.transitionId, deps.now());

  if (deps.monitorAlertsPaused) {
    await routing.suppressAll(item.transitionId, "delivery_paused");

    return;
  }

  // One row carries every delivery of the transition, so each is attempted
  // even when another fails, as eachProvider does for providers: a deferred
  // email must not hold back the push. Sends are keyed by delivery, so the
  // retry this rethrow causes repeats none that went out.
  const errors: unknown[] = [];

  for (const deliveryId of await routing.deliveries(item.transitionId)) {
    try {
      await sendMonitorDelivery(deps, deliveryId);
    } catch (cause) {
      errors.push(cause);
    }
  }

  const failure = errors.find((cause) => !(cause instanceof SendDeferred)) ?? errors[0];

  if (failure !== undefined) {
    throw failure;
  }
}

/** One routed delivery, checked again against the monitor and rule as they are now. */
async function sendMonitorDelivery(deps: NotifyDeps, deliveryId: number): Promise<void> {
  const job = await deps.store.monitorDelivery(deliveryId, deps.now());

  if (job === null) {
    await deps.store.suppressMonitorDelivery(deliveryId, "changed_before_dispatch");

    return;
  }

  if (job.belowCount === 1 && !deps.monitorBelowCountPaging) {
    await deps.store.suppressMonitorDelivery(job.id, "below_count_paging_disabled");

    return;
  }

  const [issue] = await deps.store.issues([job.groupId]);

  if (issue === undefined) {
    return;
  }

  const targets = await monitorRecipients(deps, job, issue);

  if (targets.length === 0) {
    await deps.store.suppressMonitorDelivery(deliveryId, "recipient_preferences");

    return;
  }

  const { project } = issue;
  const organization = project.organization.slug;
  const subject = `${issue.shortId} · Monitor ${job.transition}`;

  await fanOut(deps, async (provider) => (provider === job.channel ? targets : []), {
    kind: "alerts",
    key: `monitor:${job.id}`,
    groupId: issue.id,
    scope: { type: "alerts", scope: "project", scopeId: project.id },
    render: (links) => renderMonitorAlert({ job, issue, subject, links }),
    push:
      job.channel === "push"
        ? {
            title: subject,
            body: clip(issue.title, 240),
            channel: "alerts",
            data: { kind: "issue", organization, issueId: issue.id },
          }
        : null,
  });
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
