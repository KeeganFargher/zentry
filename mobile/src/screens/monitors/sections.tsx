// The detail screen's sections, as Sentry's detector detail: ongoing issues,
// each environment's state and recent check-ins for cron, recent checks and
// the day's uptime for uptime, then how it detects and its details.

import type { MonitorDetail, TimelineStatus } from "@contract";
import { useRouter } from "expo-router";
import type { JSX } from "react";
import { Pressable, View } from "react-native";

import { Panel, Tag } from "~/components/basics";
import { getText } from "~/components/event/json";
import { SectionTitle, Text } from "~/components/text";
import { tickColor } from "~/components/tick-timeline";
import { useNow } from "~/lib/clock";
import { duration, shortDateTime, timeAgo } from "~/lib/format";
import { CHECK_IN_LABELS, HEALTH_LABELS } from "~/lib/monitor-text";
import { usePalette } from "~/lib/preferences";
import { SPACE } from "~/lib/theme";

import { HEALTH_TONES } from "./row";

/** A coloured dot and label, as Sentry's status text in its check-in tables. */
function Status({ status, label }: { status: TimelineStatus; label: string }): JSX.Element {
  const palette = usePalette();

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: tickColor(palette, status),
        }}
      />
      <Text size={13} weight="medium">
        {label}
      </Text>
    </View>
  );
}

/** Open incidents, each a link to its issue. Nothing when there are none. */
export function OngoingIssues({ detail }: { detail: MonitorDetail }): JSX.Element | null {
  const router = useRouter();
  const now = useNow();
  const open = detail.incidents.filter((incident) => incident.closedAt === null);

  if (open.length === 0) {
    return null;
  }

  return (
    <Panel>
      <SectionTitle>Ongoing Issues</SectionTitle>
      {open.map((incident) => (
        <Pressable
          key={incident.issueId}
          accessibilityRole="link"
          onPress={() =>
            router.push({ pathname: "/issues/[id]", params: { id: String(incident.issueId) } })
          }
        >
          <Text tone="link" weight="medium">
            {detail.monitor.name}
            {incident.scope === "" ? "" : ` (${incident.scope})`}
          </Text>
          <Text size={12} tone="muted">
            Opened {timeAgo(incident.openedAt, now)}
          </Text>
        </Pressable>
      ))}
    </Panel>
  );
}

/** Each environment's health, last check-in and the next one expected. */
export function Environments({ detail }: { detail: MonitorDetail }): JSX.Element {
  const now = useNow();
  const active = detail.monitor.status === "active";

  return (
    <Panel>
      <SectionTitle>Environments</SectionTitle>
      {detail.scopes.length === 0 && <Text tone="muted">No check-ins yet.</Text>}
      {detail.scopes.map((scope) => (
        <View key={scope.environment} style={{ gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
            <Text weight="medium" style={{ flex: 1 }}>
              {scope.environment}
            </Text>
            <Tag label={HEALTH_LABELS[scope.health]} tone={HEALTH_TONES[scope.health]} />
          </View>
          <Text size={12} tone="muted">
            Last check-in {scope.lastCheckIn === null ? "never" : timeAgo(scope.lastCheckIn, now)}
            {active && scope.nextAt !== null
              ? ` · next expected ${shortDateTime(scope.nextAt)}`
              : ""}
          </Text>
        </View>
      ))}
    </Panel>
  );
}

/** When it ran; a missed slot never started, so it shows when it was expected. */
function checkInTime(checkIn: MonitorDetail["checkIns"][number]): string {
  if (checkIn.startedAt !== null) {
    return shortDateTime(checkIn.startedAt);
  }

  return checkIn.expectedAt === null ? "—" : `expected ${shortDateTime(checkIn.expectedAt)}`;
}

export function RecentCheckIns({ detail }: { detail: MonitorDetail }): JSX.Element {
  return (
    <Panel>
      <SectionTitle>Recent Check-Ins</SectionTitle>
      {detail.checkIns.length === 0 && <Text tone="muted">No check-ins yet.</Text>}
      {detail.checkIns.slice(0, 20).map((checkIn) => (
        <View
          key={`${checkIn.checkInId}:${checkIn.startedAt}`}
          style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <Status status={checkIn.status} label={CHECK_IN_LABELS[checkIn.status]} />
            <Text size={12} tone="muted">
              {checkIn.environment} · {checkInTime(checkIn)}
            </Text>
          </View>
          <Text size={12} tone="muted">
            {checkIn.durationMs === null ? "—" : duration(checkIn.durationMs)}
          </Text>
        </View>
      ))}
    </Panel>
  );
}

/** The outcomes an uptime check records (src/shared/uptime.ts), as the web labels them. */
const UPTIME_OUTCOMES = new Map<string, readonly [TimelineStatus, string]>([
  ["ok", ["success", "Uptime"]],
  ["failed", ["failure", "Failure"]],
  ["unknown", ["unknown", "Unknown"]],
]);

/** A check's status and label; a check without a known outcome is a bug to hear about. */
function outcomeOf(
  evidence: MonitorDetail["observations"][number]["evidence"],
): readonly [TimelineStatus, string] {
  const outcome = getText(evidence, "outcome");
  const known = outcome === null ? undefined : UPTIME_OUTCOMES.get(outcome);

  if (known === undefined) {
    throw new Error(`An uptime check with an outcome this app does not know: ${String(outcome)}`);
  }

  return known;
}

/** Why a check failed: the HTTP status when that was the reason, as the web UI. */
function reasonText(evidence: MonitorDetail["observations"][number]["evidence"]): string {
  const reason = getText(evidence, "reason");
  const httpStatus = getText(evidence, "httpStatus");

  if (reason === null) {
    return "";
  }

  return reason === "status" && httpStatus !== null
    ? ` (HTTP ${httpStatus})`
    : ` (${reason.replaceAll("_", " ")})`;
}

export function RecentChecks({ detail }: { detail: MonitorDetail }): JSX.Element {
  return (
    <Panel>
      <SectionTitle>Recent Checks</SectionTitle>
      {detail.observations.length === 0 && <Text tone="muted">No uptime checks yet.</Text>}
      {detail.observations.slice(0, 20).map((observation) => {
        const [status, label] = outcomeOf(observation.evidence);
        const durationMs = getText(observation.evidence, "durationMs");

        return (
          <View key={observation.id} style={{ flexDirection: "row", gap: SPACE.sm }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Status status={status} label={`${label}${reasonText(observation.evidence)}`} />
              <Text size={12} tone="muted">
                {shortDateTime(observation.time)}
              </Text>
            </View>
            <Text size={12} tone="muted">
              {durationMs === null ? "—" : `${durationMs}ms`}
            </Text>
          </View>
        );
      })}
    </Panel>
  );
}

/** The share of the last day's checks that passed, as Sentry's uptime sidebar. */
export function Coverage({
  coverage,
}: {
  coverage: NonNullable<MonitorDetail["coverage"]>;
}): JSX.Element {
  // Checks that could not run are left out of the share, as on the web.
  const measured = coverage.successful + coverage.failed;

  return (
    <Panel>
      <SectionTitle>Uptime</SectionTitle>
      <Text size={24} weight="medium" tone="heading">
        {measured === 0 ? "—" : `${((coverage.successful / measured) * 100).toFixed(2)}%`}
      </Text>
      <Text size={12} tone="muted">
        Of {measured} measured checks in the last 24 hours. {coverage.unknown} could not run.
      </Text>
    </Panel>
  );
}
