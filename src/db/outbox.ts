// Outbox rows as the notify consumer reads them. DESIGN.md §18.1.

import { z } from "zod";

import { jsonText } from "@/shared/json";
import type { OutboxItem } from "@/shared/notify";

export type OutboxEntry = { item: OutboxItem; attempts: number };

export type OutboxRow = {
  id: number;
  kind: string;
  organization_id: number | null;
  project_id: number | null;
  group_id: number | null;
  actor_id: number | null;
  data: string;
  attempts: number;
};

const Id = z.int().positive();

// Each kind's row, as the statements that write it shape it: the ids it sets
// and the JSON its `data` column holds. A row that does not match is a bug in
// one of those statements, and the parse throws rather than guess.
const OutboxRecord = z.discriminatedUnion("kind", [
  z.object({ id: Id, kind: z.enum(["new_issue", "regression"]), group_id: Id }),
  z.object({
    id: Id,
    kind: z.literal("status"),
    group_id: Id,
    actor_id: Id.nullable(),
    data: jsonText(
      z.union([
        z.object({ monitorDeliveryId: Id }),
        z.object({ status: z.enum(["unresolved", "resolved", "ignored"]) }),
      ]),
    ),
  }),
  z.object({
    id: Id,
    kind: z.literal("quota"),
    organization_id: Id,
    data: jsonText(z.object({ percent: z.int(), month: z.int(), limit: z.int() })),
  }),
  z.object({
    id: Id,
    kind: z.literal("spike"),
    project_id: Id,
    data: jsonText(z.object({ until: z.int(), limit: z.int() })),
  }),
  z.object({
    id: Id,
    kind: z.literal("weekly_report"),
    organization_id: Id,
    data: jsonText(z.object({ start: z.int(), end: z.int() })),
  }),
]);

export function toOutboxItem(row: OutboxRow): OutboxItem {
  const record = OutboxRecord.parse(row);

  switch (record.kind) {
    case "new_issue":
    case "regression": {
      return { id: record.id, kind: record.kind, groupId: record.group_id };
    }

    case "status": {
      if ("monitorDeliveryId" in record.data) {
        return { id: record.id, kind: "monitor", deliveryId: record.data.monitorDeliveryId };
      }

      const { status } = record.data;

      return {
        id: record.id,
        kind: "status",
        groupId: record.group_id,
        actorId: record.actor_id,
        status,
      };
    }

    case "quota": {
      return {
        id: record.id,
        kind: "quota",
        organizationId: record.organization_id,
        ...record.data,
      };
    }

    case "spike": {
      return { id: record.id, kind: "spike", projectId: record.project_id, ...record.data };
    }

    case "weekly_report": {
      break;
    }
  }

  return {
    id: record.id,
    kind: "weekly_report",
    organizationId: record.organization_id,
    ...record.data,
  };
}
