// The organization's spend settings: its monthly event cap.

import { z } from "zod";

import type { ApiOrganizationLimits } from "@/shared/contract";
import { monthBucket } from "@/shared/time";

import type { ApiContext, Handler } from "./context";
import { forbidden, readBody } from "./http";

const UpdateLimitsBody = z.object({ maxEventsPerMonth: z.int().min(1) });

async function limitsOf(context: ApiContext): Promise<ApiOrganizationLimits> {
  const month = monthBucket(context.now);
  const limits = await context.deps.organizations.limits(context.organizationId, month);

  return {
    maxEventsPerMonth: limits.maxEventsPerMonth,
    monthReceived: limits.monthReceived,
    month,
    canEdit: context.role === "owner",
  };
}

export const getLimits: Handler = async (context) => Response.json(await limitsOf(context));

/**
 * Owners only: the cap is the ceiling on the bill, so raising it is a billing
 * decision, as in Sentry, where quotas belong to owner and billing roles.
 */
export const updateLimits: Handler = async (context) => {
  if (context.role !== "owner") {
    return forbidden("only an owner can change the monthly cap");
  }

  const { maxEventsPerMonth } = await readBody(context.request, UpdateLimitsBody);

  await context.deps.organizations.setMaxEventsPerMonth(context.organizationId, maxEventsPerMonth);

  return Response.json(await limitsOf(context));
};
