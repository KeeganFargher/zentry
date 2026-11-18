// Who gets an email. DESIGN.md §18.3. Every organization member is a
// candidate, as Zentry has no teams or ownership rules; each one's own
// setting then decides.

import { resolveSetting, wantsWorkflow } from "@/core/notify-settings";
import type { NotificationType } from "@/shared/contract";
import type { IssueNotice, Recipient } from "@/shared/notify";

import type { NotifyDeps } from "./deps";

export type Audience = { type: NotificationType; organizationId: number; projectId: number | null };

/** Members whose setting for the type is `always` where the email comes from. */
export async function recipients(deps: NotifyDeps, audience: Audience): Promise<Recipient[]> {
  const [members, rows] = await Promise.all([
    deps.settings.members(audience.organizationId),
    deps.settings.ofMembers(audience.organizationId, audience.type),
  ]);

  return members.filter(
    (member) => resolveSetting(rows, { ...audience, userId: member.userId }) === "always",
  );
}

/**
 * Members who follow the issue, or get workflow emails for every issue,
 * less the person who made the change.
 */
export async function workflowRecipients(
  deps: NotifyDeps,
  change: { issue: IssueNotice; actorId: number | null },
): Promise<Recipient[]> {
  const { issue, actorId } = change;
  const organizationId = issue.project.organization.id;

  const [members, rows, subscribers] = await Promise.all([
    deps.settings.members(organizationId),
    deps.settings.ofMembers(organizationId, "workflow"),
    deps.settings.subscribers(issue.id),
  ]);

  const following = new Map(subscribers.map((row) => [row.userId, row.active]));

  return members.filter((member) => {
    const value = resolveSetting(rows, {
      userId: member.userId,
      type: "workflow",
      organizationId,
      projectId: issue.project.id,
    });

    const active = following.get(member.userId);
    const subscription = active === undefined ? "none" : active ? "subscribed" : "unsubscribed";

    return member.userId !== actorId && wantsWorkflow(value, subscription);
  });
}
