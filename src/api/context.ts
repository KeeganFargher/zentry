// What every read-API handler receives.

import type { EventBlobs } from "@/blobs/events";
import type { EventStore } from "@/db/events";
import type { IssueStore } from "@/db/issues";
import type { NotificationSettingsStore } from "@/db/notify-settings";
import type { OrganizationStore } from "@/db/organizations";
import type { ProjectStore } from "@/db/projects";
import type { Membership, TenancyStore, UserRecord } from "@/db/tenancy";

import type { AccessVerifier } from "./access";

export type ApiDeps = {
  access: AccessVerifier;
  tenancy: TenancyStore;
  organizations: OrganizationStore;
  projects: ProjectStore;
  issues: IssueStore;
  events: EventStore;
  blobs: EventBlobs;
  notificationSettings: NotificationSettingsStore;
  /** Wakes the notify consumer after a change that queued notifications. */
  notify: () => Promise<void>;
  /** False while no sender address is configured, so nothing is emailed. */
  emailEnabled: boolean;
  /** Hostname SDKs send to; used to build DSNs. */
  ingestHost: string;
  now: () => number;
};

export type ApiContext = {
  request: Request;
  url: URL;
  deps: ApiDeps;
  user: UserRecord;
  /** The organization named in the path, already checked for membership. */
  organizationId: number;
  /** The caller's role in that organization. */
  role: Membership["role"];
  now: number;
};

/** `args` are the path parameters after the organization slug. */
export type Handler = (context: ApiContext, args: string[]) => Promise<Response>;
