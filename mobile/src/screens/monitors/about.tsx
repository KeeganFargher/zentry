// What a monitor watches and how it decides, as the right-hand column of
// Sentry's detector detail: Detect (what makes an issue), the schedule or
// check settings, and who created it when.

import type { ApiMonitor, MonitorMember } from "@contract";
import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import type { JSX } from "react";

import { Fact, Panel } from "~/components/basics";
import { SectionTitle, Text } from "~/components/text";
import { dateTime } from "~/lib/format";
import { COMPARATOR_TEXT, everyMinutes, scheduleText } from "~/lib/monitor-text";
import { useOrg } from "~/lib/organization";
import { useApi } from "~/lib/session";

type Row = [label: string, value: string];

function times(count: number, one: string, many: string): string {
  return count === 1 ? one : `${count} consecutive ${many}`;
}

/** What opens an issue, in Sentry's words. */
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

  return rows;
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

  if (monitor.type === "uptime") {
    const { url, method, intervalMinutes, timeoutMs, environment } = monitor.config;

    return [
      ["Request", `${method} ${url}`],
      ["Interval", everyMinutes(intervalMinutes)],
      ["Timeout", `After ${timeoutMs / 1000} seconds`],
      ["Environment", environment ?? "All environments"],
    ];
  }

  return [];
}

/** A member's email; a creator no longer in the organization reads as a former member. */
function creatorText(monitor: ApiMonitor, members: UseQueryResult<MonitorMember[]>): string {
  const { creator } = monitor;

  if (creator.kind === "sdk") {
    return "SDK check-in";
  }

  if (creator.kind === "former_member") {
    return "A former member";
  }

  if (members.error !== null) {
    return `Members did not load: ${members.error.message}`;
  }

  // Members load separately; until they have, say nothing wrong about who it was.
  if (members.data === undefined) {
    return "…";
  }

  return (
    members.data.find((member) => member.userId === creator.userId)?.email ?? "A former member"
  );
}

export function About({ monitor }: { monitor: ApiMonitor }): JSX.Element {
  const api = useApi();
  const org = useOrg();

  const members = useQuery({
    queryKey: ["monitor-members", org],
    queryFn: () => api.monitorMembers(org),
  });

  const rows: Row[] = [
    ...settingRows(monitor),
    ["Date created", dateTime(monitor.createdAt)],
    ["Created by", creatorText(monitor, members)],
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
