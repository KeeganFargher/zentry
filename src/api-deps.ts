// The read API's part of the composition root (src/worker.ts): its stores and
// settings, built from the Worker's bindings. Split out of worker.ts only to
// keep that file within its size limit; nothing else may read bindings.

import { AccessVerifier, fetchAccessKeys } from "@/api/access";
import type { ApiDeps } from "@/api/context";
import { EventBlobs } from "@/blobs/events";
import { CliTokenStore } from "@/db/cli-tokens";
import { DeviceStore } from "@/db/devices";
import { EventStore } from "@/db/events";
import { IssueStore } from "@/db/issues";
import { MonitorPreviews } from "@/db/monitor-previews";
import { MonitorRuleStore } from "@/db/monitor-rules";
import { MonitorStore } from "@/db/monitors";
import { NotificationSettingsStore } from "@/db/notify-settings";
import { OrganizationStore } from "@/db/organizations";
import { ProjectStore } from "@/db/projects";
import { TenancyStore } from "@/db/tenancy";

// Per-isolate: the verifier caches Access's signing keys across requests.
let accessVerifier: AccessVerifier | undefined;

/** What the API shares with the notify side, which worker.ts owns. */
export type NotifyHooks = Pick<ApiDeps, "notify" | "emailEnabled">;

export function apiDeps(env: Env, hooks: NotifyHooks): ApiDeps {
  accessVerifier ??= new AccessVerifier(
    { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD, devEmail: env.DEV_USER_EMAIL },
    fetchAccessKeys,
  );

  return {
    ...hooks,
    access: accessVerifier,
    tenancy: new TenancyStore(env.DB),
    organizations: new OrganizationStore(env.DB),
    projects: new ProjectStore(env.DB),
    monitors: new MonitorStore(env.DB),
    monitorRules: new MonitorRuleStore(env.DB),
    issues: new IssueStore(env.DB),
    events: new EventStore(env.DB),
    blobs: new EventBlobs(env.BLOBS),
    notificationSettings: new NotificationSettingsStore(env.DB),
    devices: new DeviceStore(env.DB),
    cliTokens: new CliTokenStore(env.DB),
    uptimeFixtureOrigin: env.UPTIME_FIXTURE_ORIGIN,
    allowMonitorPreview: async (key) => (await env.MONITOR_PREVIEW_RL.limit({ key })).success,
    monitorPreviews: new MonitorPreviews(env.DB),
    enqueueMonitorPreview: (previewId) => env.UPTIME_Q.send({ previewId }).then(() => undefined),
    ingestHost: env.INGEST_HOST,
    mobileApiUrl: env.MOBILE_API_URL.replace(/\/+$/, ""),
    now: () => Date.now(),
  };
}
