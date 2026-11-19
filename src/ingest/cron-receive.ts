import { firstReport, laterReport, toWrite } from "@/core/cron-checkins";
import { withCronIssues } from "@/core/monitor-issues";
import type { CronMonitor, CronStore, UnrecognizedReason } from "@/db/cron-store";
import type { CronWrite, StoredCheckIn } from "@/shared/cron";
import { provisionedConfig } from "@/shared/monitors";
import type { MonitorCheckIn } from "@/shared/monitors";

// Sentry creates an environment for any name an SDK sends. A public DSN can
// send any name, so each monitor keeps at most this many.
const MAX_ENVIRONMENTS_PER_MONITOR = 20;

type Found =
  | { kind: "found"; monitor: CronMonitor }
  | { kind: "unrecognized"; reason: UnrecognizedReason };

type Receipt = { projectId: number; checkIn: MonitorCheckIn; now: number };

/**
 * Records one SDK check-in. Like Relay, Zentry accepts every well-formed
 * check-in; one it cannot apply is counted under cron_unrecognized, which the
 * API lists, instead of being refused with an error the SDK only logs.
 */
export async function receiveCheckIn(store: CronStore, receipt: Receipt): Promise<void> {
  const { projectId, checkIn, now } = receipt;
  const found = await monitorFor(store, receipt);
  const note = { projectId, slug: checkIn.slug, environment: checkIn.environment };

  if (found.kind === "unrecognized") {
    await store.unrecognized({ ...note, reason: found.reason }, now);

    return;
  }

  if (found.monitor.status !== "active") {
    await store.unrecognized({ ...note, reason: "inactive" }, now);

    return;
  }

  const { monitor } = found;
  let overLimit = false;

  await store.update(
    { monitorId: monitor.id, environment: checkIn.environment, now },
    async (read) => {
      overLimit =
        !read.exists && (await store.environmentCount(monitor.id)) >= MAX_ENVIRONMENTS_PER_MONITOR;

      if (overLimit) {
        return null;
      }

      const write = await plan(store, { monitor, checkIn, now, state: read.state });

      return write === null ? null : withCronIssues(write, read.issue, now);
    },
  );

  if (overLimit) {
    await store.unrecognized({ ...note, reason: "environment_limit" }, now);
  }
}

async function monitorFor(store: CronStore, receipt: Receipt): Promise<Found> {
  const { projectId, checkIn, now } = receipt;
  const existing = await store.find(projectId, checkIn.slug);

  if (existing !== null) {
    return { kind: "found", monitor: existing };
  }

  if (checkIn.monitorConfig === undefined) {
    return { kind: "unrecognized", reason: "unknown_slug" };
  }

  // Sentry upserts from monitor_config on every check-in. Zentry creates the
  // monitor from it once; after that the monitor's settings belong to the UI.
  const config =
    checkIn.monitorConfig === "invalid"
      ? null
      : provisionedConfig(checkIn.slug, checkIn.monitorConfig);

  if (config === null) {
    return { kind: "unrecognized", reason: "invalid_config" };
  }

  await store.provision(projectId, config, now);
  const created = await store.find(projectId, checkIn.slug);

  return created === null
    ? { kind: "unrecognized", reason: "monitor_limit" }
    : { kind: "found", monitor: created };
}

type Planning = {
  monitor: CronMonitor;
  checkIn: MonitorCheckIn;
  now: number;
  state: CronWrite["state"];
};

async function plan(store: CronStore, planning: Planning): Promise<CronWrite | null> {
  const { monitor, checkIn, now, state } = planning;
  const stored = await reportedRun(store, monitor.id, checkIn);

  if (stored !== null && stored.environment !== checkIn.environment) {
    // The same check-in ID reported from a second environment is a client
    // bug; the first environment's run stays as it was.
    return null;
  }

  const report = { status: checkIn.status, durationMs: checkIn.durationMs, now };

  const change =
    stored === null
      ? firstReport(monitor.config, state, {
          ...report,
          checkInId: checkIn.checkInId ?? crypto.randomUUID().replaceAll("-", ""),
        })
      : laterReport(monitor.config, state, { ...report, row: stored });

  return toWrite({ change, stored });
}

/** The run a check-in reports on: by ID, or the latest open run for the all-zero ID. */
async function reportedRun(
  store: CronStore,
  monitorId: string,
  checkIn: MonitorCheckIn,
): Promise<StoredCheckIn | null> {
  return checkIn.checkInId === null
    ? store.latestOpen(monitorId, checkIn.environment)
    : store.checkIn(monitorId, checkIn.checkInId);
}
