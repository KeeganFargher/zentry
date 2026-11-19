// What every read-API handler receives.

import type { EventBlobs } from "@/blobs/events";
import type { DeviceRecord, DeviceStore } from "@/db/devices";
import type { EventStore } from "@/db/events";
import type { IssueStore } from "@/db/issues";
import type { MonitorPreviews } from "@/db/monitor-previews";
import type { MonitorRuleStore } from "@/db/monitor-rules";
import type { MonitorStore } from "@/db/monitors";
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
  monitors: MonitorStore;
  monitorRules: MonitorRuleStore;
  events: EventStore;
  blobs: EventBlobs;
  notificationSettings: NotificationSettingsStore;
  devices: DeviceStore;
  /** Wakes the notify consumer after a change that queued notifications. */
  notify: () => Promise<void>;
  /** False while no sender address is configured, so nothing is emailed. */
  emailEnabled: boolean;
  /**
   * Hostname SDKs send to; used to build DSNs. Cloudflare Access does not
   * guard it, so the API there accepts device tokens only (DESIGN.md §19).
   */
  ingestHost: string;
  /** The origin the mobile app calls, put in the pairing QR code. */
  mobileApiUrl: string;
  uptimeOrigins: string;
  /** The e2e shop's plain-HTTP origin; empty outside the end-to-end suite. */
  uptimeFixtureOrigin: string;
  allowMonitorPreview: (key: string) => Promise<boolean>;
  monitorPreviews: MonitorPreviews;
  enqueueMonitorPreview: (id: string) => Promise<void>;
  now: () => number;
};

/** A signed-in caller, before any organization is resolved. */
export type UserContext = {
  request: Request;
  url: URL;
  deps: ApiDeps;
  user: UserRecord;
  /** The phone making the request; null when signed in through Access. */
  device: DeviceRecord | null;
  now: number;
};

export type ApiContext = UserContext & {
  /** The organization named in the path, already checked for membership. */
  organizationId: number;
  /** The caller's role in that organization. */
  role: Membership["role"];
};

/** `args` are the path parameters after the organization slug. */
export type Handler = (context: ApiContext, args: string[]) => Promise<Response>;

/** A route about the caller themselves, outside any organization. */
export type UserHandler = (context: UserContext, args: string[]) => Promise<Response>;
