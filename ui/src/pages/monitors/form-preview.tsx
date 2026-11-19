// The sticky preview at the top of the form, as Sentry's schedulePreview:
// sample check-ins on the configured schedule, the failures that open an
// issue and the successes that resolve it. For metrics, the last minutes of
// real counts against the thresholds.

import type { MonitorPreview, NewMonitor } from "@contract";
import { useEffect, useState } from "react";
import type { JSX } from "react";

import { api } from "~/lib/api";
import { useNow } from "~/lib/clock";
import { minuteTime, shortDate } from "~/lib/format";
import { pluralize } from "~/lib/monitor-text";
import { useResource } from "~/lib/resource";
import type { Resource } from "~/lib/resource";

import { bodyOf } from "./form-state";
import type { CronDraft, MetricDraft, UptimeDraft } from "./form-state";

const TICKS = 20;
const MINUTE = 60_000;

type Sample = "ok" | "ok-sub" | "fail-sub" | "fail";

/** Four good runs, failures up to the threshold and past it, then recovery. */
function samples(failures: number, recoveries: number): Sample[] {
  const lead = Math.max(1, Math.min(4, TICKS - failures - recoveries - 4));
  const failing = Math.max(failures, TICKS - lead - recoveries - 3);
  const pattern: Sample[] = [];

  for (let index = 0; index < TICKS; index += 1) {
    const sinceFailing = index - lead;
    const sinceRecovering = sinceFailing - failing;

    if (sinceFailing < 0) {
      pattern.push("ok");
    } else if (sinceRecovering < 0) {
      pattern.push(sinceFailing < failures - 1 ? "fail-sub" : "fail");
    } else {
      pattern.push(sinceRecovering < recoveries - 1 ? "ok-sub" : "ok");
    }
  }

  return pattern;
}

/**
 * `value`, once it has stopped changing for `ms`. Previews wait for typing to
 * pause, as Sentry's do, so a crontab is not one request per key.
 */
function useSettled(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);

    return () => clearTimeout(timer);
  }, [value, ms]);

  return settled;
}

/**
 * The server's preview of the draft. The resource key is the settled JSON
 * body, so a new request goes out only when the settings have paused.
 */
function usePreview(org: string, draft: NewMonitor): Resource<MonitorPreview> {
  const body = useSettled(JSON.stringify(bodyOf(draft)), 300);

  return useResource(`monitor-preview:${org}:${body}`, () =>
    api.previewMonitor(org, bodyOf(draft)),
  );
}

/** Every interval from this minute: uptime checks run on a fixed cadence. */
function uptimeTimes(now: number, intervalMinutes: number): number[] {
  const start = Math.floor(now / MINUTE) * MINUTE;

  return Array.from({ length: TICKS }, (_, index) => start + index * intervalMinutes * MINUTE);
}

function CronPreview({ org, draft }: { org: string; draft: CronDraft }): JSX.Element {
  const preview = usePreview(org, draft);

  // The box keeps its height while the first preview loads, so the form below does not jump.
  if (preview.loading && preview.data === null) {
    return <div className="schedule-preview" aria-busy="true" />;
  }

  if (preview.data?.type !== "cron") {
    return <InvalidPreview />;
  }

  return <SampleTicks times={preview.data.occurrences} config={draft.config} />;
}

function UptimePreview({ draft }: { draft: UptimeDraft }): JSX.Element {
  const now = useNow();

  return (
    <SampleTicks times={uptimeTimes(now, draft.config.intervalMinutes)} config={draft.config} />
  );
}

function InvalidPreview(): JSX.Element {
  return (
    <div className="schedule-preview invalid">
      No preview available. The provided schedule is invalid, or the thresholds are incompatible
      with it.
    </div>
  );
}

export function SchedulePreview({
  org,
  draft,
}: {
  org: string;
  draft: CronDraft | UptimeDraft;
}): JSX.Element {
  return draft.type === "cron" ? (
    <CronPreview org={org} draft={draft} />
  ) : (
    <UptimePreview draft={draft} />
  );
}

type Thresholds = { failureThreshold: number; recoveryThreshold: number };

function SampleTicks({ times, config }: { times: number[]; config: Thresholds }): JSX.Element {
  const { failureThreshold, recoveryThreshold } = config;

  if (times.length < TICKS) {
    return <InvalidPreview />;
  }

  const pattern = samples(failureThreshold, recoveryThreshold);
  const opens = pattern.indexOf("fail");
  const closes = pattern.indexOf("ok", opens);
  const left = (index: number): string => `${((index + 0.5) / TICKS) * 100}%`;

  return (
    <div className="schedule-preview" aria-label="Sample check-ins">
      <div className="preview-labels">
        {times.map((time, index) =>
          index % 5 === 0 ? (
            <span key={time} style={{ left: left(index) }}>
              {/* The date where the day changes, so a daily schedule's labels differ. */}
              {index === 0 || shortDate(time) !== shortDate(times[index - 5] ?? time)
                ? `${shortDate(time)}, `
                : ""}
              {minuteTime(time)}
            </span>
          ) : null,
        )}
      </div>
      <div className="preview-ticks">
        {pattern.map((sample, index) => (
          <span
            key={times[index]}
            className={`preview-tick ${sample}`}
            style={{ left: left(index) }}
          />
        ))}
      </div>
      <div
        className="open-period"
        style={{ left: left(opens), width: `${((closes - opens) / TICKS) * 100}%` }}
      >
        Issue Open Period
      </div>
      <div className="preview-notes muted small">
        <span style={{ left: left(opens) }}>
          {pluralize(failureThreshold, "1 failed check-in", "failed check-ins")}
        </span>
        <span style={{ left: left(closes) }}>
          {pluralize(recoveryThreshold, "1 success check-in", "success check-ins")}
        </span>
      </div>
    </div>
  );
}

const HEIGHT = 120;

/** The window's count over the last twenty minutes, against the thresholds. */
export function MetricPreview({ org, draft }: { org: string; draft: MetricDraft }): JSX.Element {
  const preview = usePreview(org, draft);
  const points = preview.data?.type === "metric" ? preview.data.points : [];

  if (preview.loading && preview.data === null) {
    return <div className="metric-preview" aria-busy="true" />;
  }

  if (points.length === 0) {
    return (
      <div className="schedule-preview invalid">No preview available for this project yet.</div>
    );
  }

  const { threshold, warningThreshold } = draft.config;

  const peak =
    Math.max(threshold, warningThreshold ?? 0, ...points.map(({ count }) => count), 1) * 1.15;

  const y = (value: number): number => HEIGHT - (value / peak) * HEIGHT;

  const line = points
    .map(({ count }, index) => `${(index / (points.length - 1)) * 1000},${y(count)}`)
    .join(" ");

  const first = points[0];
  const last = points.at(-1);

  return (
    <div className="metric-preview">
      <svg
        viewBox={`0 0 1000 ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Recent error counts"
      >
        <polygon className="area" points={`0,${HEIGHT} ${line} 1000,${HEIGHT}`} />
        <polyline className="line" points={line} />
        <line className="threshold high" x1="0" x2="1000" y1={y(threshold)} y2={y(threshold)} />
        {warningThreshold !== undefined && (
          <line
            className="threshold medium"
            x1="0"
            x2="1000"
            y1={y(warningThreshold)}
            y2={y(warningThreshold)}
          />
        )}
      </svg>
      <div className="preview-axis muted small">
        <span>{first === undefined ? "" : minuteTime(first.time)}</span>
        <span>{last === undefined ? "" : minuteTime(last.time)}</span>
      </div>
    </div>
  );
}
