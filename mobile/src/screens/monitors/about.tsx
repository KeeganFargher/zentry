// What a monitor watches and how it decides, as the right-hand column of
// Sentry's detector detail: Detect (what opens and resolves an issue), the
// schedule or check settings, and who created it when.

import type { ApiMonitor, MonitorDetail } from "@contract";
import type { JSX } from "react";

import { Fact, Panel } from "~/components/basics";
import { SectionTitle, Text } from "~/components/text";
import { dateTime } from "~/lib/format";
import { COMPARATOR_TEXT, everyMinutes, metricResolveText, scheduleText } from "~/lib/monitor-text";

type Row = [label: string, value: string];

function times(count: number, one: string, many: string): string {
  return count === 1 ? one : `${count} consecutive ${many}`;
}

type MetricMonitor = Extract<ApiMonitor, { type: "metric" }>;

function metricRows(monitor: MetricMonitor): Row[] {
  const { comparator, threshold, warningThreshold, windowSeconds, level, environment } =
    monitor.config;

  const direction = COMPARATOR_TEXT[comparator];

  const rows: Row[] = [
    ["Dataset", `Errors${level === undefined ? "" : ` (level ${level})`}`],
    ["Query", `count()${environment === undefined ? "" : ` in ${environment}`}`],
    ["Interval", `${windowSeconds / 60} minutes`],
    ["High", `${direction} ${threshold}`],
  ];

  if (warningThreshold !== undefined) {
    rows.push(["Medium", `${direction} ${warningThreshold}`]);
  }

  rows.push(["Resolves", metricResolveText(monitor.config)]);

  return rows;
}

/** What opens an issue and what resolves it, in Sentry's words. */
function detectRows(monitor: ApiMonitor): Row[] {
  if (monitor.type === "cron") {
    const { failureThreshold, recoveryThreshold } = monitor.config;

    return [
      ["Opens an issue after", times(failureThreshold, "One failed check-in", "failed check-ins")],
      ["Resolves after", times(recoveryThreshold, "One good check-in", "good check-ins")],
    ];
  }

  if (monitor.type === "uptime") {
    const { failureThreshold, recoveryThreshold } = monitor.config;

    return [
      ["Opens an issue after", times(failureThreshold, "One failed check", "failed checks")],
      ["Resolves after", times(recoveryThreshold, "One good check", "good checks")],
    ];
  }

  return metricRows(monitor);
}

/** The settings only one type has. */
function settingRows(monitor: ApiMonitor): Row[] {
  if (monitor.type === "cron") {
    const { slug, schedule, timezone, graceMinutes, maxRuntimeMinutes } = monitor.config;

    return [
      ["Monitor slug", slug],
      ["Schedule", scheduleText(schedule)],
      ["Timezone", timezone],
      ["Grace period", `${graceMinutes} min`],
      ["Max runtime", `${maxRuntimeMinutes} min`],
    ];
  }

  const environment: Row = ["Environment", monitor.config.environment ?? "All environments"];

  if (monitor.type === "uptime") {
    const { url, method, intervalMinutes, timeoutMs } = monitor.config;

    return [
      ["Request", `${method} ${url}`],
      ["Interval", everyMinutes(intervalMinutes)],
      ["Timeout", `After ${timeoutMs / 1000} seconds`],
      environment,
    ];
  }

  return [environment];
}

/** Who created it: a member by email, an SDK check-in, or a member who has left. */
function creatorText(detail: MonitorDetail): string {
  if (detail.monitor.creator.kind === "sdk") {
    return "SDK check-in";
  }

  // The Worker names a member it still has; one who has left has no email.
  return detail.creatorEmail ?? "A former member";
}

export function About({ detail }: { detail: MonitorDetail }): JSX.Element {
  const { monitor } = detail;

  const rows: Row[] = [
    ...settingRows(monitor),
    ["Date created", dateTime(monitor.createdAt)],
    ["Created by", creatorText(detail)],
  ];

  return (
    <>
      <Panel>
        <SectionTitle>Detect</SectionTitle>
        {detectRows(monitor).map(([label, value]) => (
          <Fact key={label} label={label} value={value} />
        ))}
      </Panel>
      <Panel>
        <SectionTitle>Details</SectionTitle>
        {rows.map(([label, value]) => (
          <Fact key={label} label={label} value={value} />
        ))}
        {monitor.description !== "" && (
          <Text size={13} tone="muted" selectable>
            {monitor.description}
          </Text>
        )}
      </Panel>
    </>
  );
}
