// Instrumentation snippets for a cron monitor, after Sentry's
// MonitorQuickStartGuide. Only transports Zentry's ingest accepts are shown:
// the SDKs' check-in envelopes, and the same envelope sent with cURL.

import type { ApiKey, ApiMonitor } from "@contract";
import { useState } from "react";
import type { JSX } from "react";

import { CopyButton } from "~/components/overlays";
import type { Resource } from "~/lib/resource";

type CronConfig = Extract<ApiMonitor, { type: "cron" }>["config"];

type GuideInput = { slug: string; config: CronConfig; dsn: string };

/**
 * The DSN the snippets embed. Loading and a failed key request are their own
 * states, so neither reads as "this project has no key".
 */
export type DsnState =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "none" }
  | { status: "ready"; dsn: string };

export function dsnStateOf(keys: Resource<ApiKey[]>): DsnState {
  if (keys.error !== null) {
    return { status: "failed", message: keys.error };
  }

  if (keys.data === null) {
    return { status: "loading" };
  }

  const active = keys.data.find(({ status }) => status === "active");

  return active === undefined ? { status: "none" } : { status: "ready", dsn: active.dsn };
}

/** The SDK's monitor_config for this schedule, in each SDK's own spelling. */
function scheduleOf(config: CronConfig): { crontab: string } | { count: number; unit: string } {
  return config.schedule.type === "crontab"
    ? { crontab: config.schedule.crontab }
    : { count: config.schedule.count, unit: config.schedule.unit };
}

function node({ slug, config }: GuideInput): string {
  const schedule = scheduleOf(config);

  const value =
    "crontab" in schedule
      ? `{ type: "crontab", value: "${schedule.crontab}" }`
      : `{ type: "interval", value: ${schedule.count}, unit: "${schedule.unit}" }`;

  return `import * as Sentry from "@sentry/node";

// Creates the monitor on its first check-in if it does not exist yet.
const monitorConfig = {
  schedule: ${value},
  checkinMargin: ${config.graceMinutes},
  maxRuntime: ${config.maxRuntimeMinutes},
  timezone: "${config.timezone}",
};

await Sentry.withMonitor("${slug}", async () => {
  // Execute your scheduled task here...
}, monitorConfig);`;
}

function python({ slug, config }: GuideInput): string {
  const schedule = scheduleOf(config);

  const value =
    "crontab" in schedule
      ? `{"type": "crontab", "value": "${schedule.crontab}"}`
      : `{"type": "interval", "value": ${schedule.count}, "unit": "${schedule.unit}"}`;

  return `from sentry_sdk.crons import monitor

monitor_config = {
    "schedule": ${value},
    "checkin_margin": ${config.graceMinutes},
    "max_runtime": ${config.maxRuntimeMinutes},
    "timezone": "${config.timezone}",
}

@monitor(monitor_slug="${slug}", monitor_config=monitor_config)
def job():
    # Execute your scheduled task here...
    ...`;
}

function dotnet({ slug, config }: GuideInput): string {
  const schedule = scheduleOf(config);

  const interval =
    "crontab" in schedule
      ? `options.Interval("${schedule.crontab}");`
      : `options.Interval(${schedule.count}, SentryMonitorInterval.${schedule.unit[0]?.toUpperCase()}${schedule.unit.slice(1)});`;

  return `// 🟡 Notify Zentry your job is running:
var checkInId = SentrySdk.CaptureCheckIn(
    "${slug}",
    CheckInStatus.InProgress,
    configureMonitorOptions: options =>
    {
        ${interval}
        options.CheckInMargin = TimeSpan.FromMinutes(${config.graceMinutes});
        options.MaxRuntime = TimeSpan.FromMinutes(${config.maxRuntimeMinutes});
        options.TimeZone = "${config.timezone}";
    });

// Execute your scheduled task here...

// 🟢 Notify Zentry your job has completed successfully:
SentrySdk.CaptureCheckIn("${slug}", CheckInStatus.Ok, checkInId);`;
}

/** The SDK wire format sent by hand: one envelope per report. */
function curl({ slug, dsn }: GuideInput): string {
  const url = new URL(dsn);
  const endpoint = `${url.origin}/api${url.pathname}/envelope/?sentry_key=${url.username}`;

  return `ZENTRY_ENVELOPE="${endpoint}"
CHECK_IN_ID=$(uuidgen | tr -d -)

check_in() {
  printf '{}\\n{"type":"check_in"}\\n{"check_in_id":"%s","monitor_slug":"${slug}","status":"%s"}' \\
    "$CHECK_IN_ID" "$1" | curl -s -X POST "$ZENTRY_ENVELOPE" --data-binary @-
}

# 🟡 Notify Zentry your job is running:
check_in in_progress
# Execute your scheduled task here...
# 🟢 Notify Zentry your job has completed successfully:
check_in ok
# 🔴 Or, if it failed:
check_in error`;
}

const GUIDES = [
  ["node", "Node.js", node],
  ["python", "Python", python],
  ["dotnet", ".NET", dotnet],
  ["curl", "HTTP (cURL)", curl],
] as const;

type Guide = (typeof GUIDES)[number];

/** The guide a select option names; the options are built from GUIDES, so a miss is a bug. */
function guideOf(key: string): Guide {
  const guide = GUIDES.find(([id]) => id === key);

  if (guide === undefined) {
    throw new Error(`No instrumentation guide named ${key}`);
  }

  return guide;
}

export function SdkGuide({
  slug,
  config,
  dsn,
}: {
  slug: string;
  config: CronConfig;
  dsn: DsnState;
}): JSX.Element {
  const [guide, setGuide] = useState<Guide>(GUIDES[0]);

  if (dsn.status === "loading") {
    return <p className="muted">Loading this project&apos;s client keys…</p>;
  }

  if (dsn.status === "failed") {
    return (
      <p className="alert-banner danger">
        The project&apos;s client keys could not load: {dsn.message}
      </p>
    );
  }

  if (dsn.status === "none") {
    return <p className="muted">Create a client key for this project to send check-ins.</p>;
  }

  const code = guide[2]({ slug, config, dsn: dsn.dsn });

  return (
    <div className="sdk-guide">
      <p className="muted">
        Select an integration method. The SDKs create the monitor from <code>monitor_config</code>{" "}
        the first time its slug checks in; after that, its settings are edited here.
      </p>
      <div className="sdk-guide-head">
        <select
          aria-label="Integration"
          value={guide[0]}
          onChange={(event) => setGuide(guideOf(event.target.value))}
        >
          {GUIDES.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        <CopyButton text={code} message="Copied the instructions" label="Copy instructions" />
      </div>
      <pre className="snippet">{code}</pre>
    </div>
  );
}
