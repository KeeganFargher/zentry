import { z } from "zod";

import { MonitorRule } from "@/shared/monitor-alerts";
import type { NewMonitorRule } from "@/shared/monitor-alerts";

import type { ApiContext, Handler } from "./context";
import { badRequest, forbidden, readBody, readParams } from "./http";

const RuleId = z.tuple([z.uuid()]);
const Edit = z.strictObject({ version: z.int().positive(), rule: MonitorRule });

async function membersAreValid(context: ApiContext, rule: NewMonitorRule): Promise<boolean> {
  if (rule.audience.kind !== "members") {
    return true;
  }

  const members = await context.deps.notificationSettings.members(context.organizationId);
  const ids = new Set(members.map(({ userId }) => userId));

  return rule.audience.userIds.every((id) => ids.has(id));
}

export const listMonitorRules: Handler = async (context) =>
  Response.json(await context.deps.monitorRules.list(context.organizationId));

/**
 * The organization's members, which every member can see: the monitor pages
 * name each monitor's assignee. Only owners can change routing or ownership.
 */
export const listMonitorMembers: Handler = async (context) =>
  Response.json(await context.deps.notificationSettings.members(context.organizationId));

export const createMonitorRule: Handler = async (context) => {
  if (context.role !== "owner") {
    return forbidden("only an owner can create monitor alert rules");
  }

  const rule = await readBody(context.request, MonitorRule);

  if (!(await membersAreValid(context, rule))) {
    return badRequest("one or more recipients are outside the organization");
  }

  const result = await context.deps.monitorRules.create(context.organizationId, rule);

  return result === null
    ? Response.json({ detail: "alert rule limit reached" }, { status: 409 })
    : Response.json(result, { status: 201 });
};

export const updateMonitorRule: Handler = async (context, args) => {
  if (context.role !== "owner") {
    return forbidden("only an owner can edit monitor alert rules");
  }

  const [id] = readParams(args, RuleId);
  const { rule, version } = await readBody(context.request, Edit);

  if (!(await membersAreValid(context, rule))) {
    return badRequest("one or more recipients are outside the organization");
  }

  const result = await context.deps.monitorRules.update(context.organizationId, {
    id,
    version,
    rule,
  });

  return result === null
    ? Response.json({ detail: "rule is missing or changed" }, { status: 409 })
    : Response.json(result);
};
