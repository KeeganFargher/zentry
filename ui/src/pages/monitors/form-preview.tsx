// The sticky preview at the top of the form, as Sentry's schedulePreview:
// sample check-ins on the configured schedule, the failures that open an
// issue and the successes that resolve it. For metrics, the last minutes of
// real counts against the thresholds.

import type { MonitorPreview, NewMonitor } from "@contract";
import { useEffect, useState } from "react";
import type { JSX } from "react";

import { api, ApiFailure } from "~/lib/api";
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

// Twenty ticks cannot show 720 failures. Past these counts the run is drawn
// shortened and the notes say so, so the sample always shows the issue
// opening and resolving, as Sentry's preview does.
const SHOWN_FAILURES = 8;
const SHOWN_RECOVERIES = 4;
const LEAD = 4;

type Pattern = { samples: Sample[]; opens: number; closes: number };

/** Four good runs, failures up to the threshold and past it, then recovery. */
function samples(failures: number, recoveries: number): Pattern {
  const shownFailures = Math.min(failures, SHOWN_FAILURES);
  const shownRecoveries = Math.min(recoveries, SHOWN_RECOVERIES);
  // Two good runs after recovery, so the resolved state is visible.
  const failing = Math.max(shownFailures, TICKS - LEAD - shownRecoveries - 2);
  const pattern: Sample[] = [];

  for (let index = 0; index < TICKS; index += 1) {
    const sinceFailing = index - LEAD;
    const sinceRecovering = sinceFailing - failing;

    if (sinceFailing < 0) {
      pattern.push("ok");
    } else if (sinceRecovering < 0) {
      pattern.push(sinceFailing < shownFailures - 1 ? "fail-sub" : "fail");
    } else {
      pattern.push(sinceRecovering < shownRecoveries - 1 ? "ok-sub" : "ok");
    }
  }

  // Both exist by construction: the failing run ends in "fail" and the
  // recovery run in "ok", inside the twenty ticks.
  return {
    samples: pattern,
    opens: LEAD + shownFailures - 1,
    closes: LEAD + failing + shownRecoveries - 1,
  };
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
type Outcome = { kind: "preview"; preview: MonitorPreview } | { kind: "invalid"; detail: string };

/**
 * A 400 is the server saying the settings are invalid, which is a preview
 * outcome to show; anything else is a failure and stays an error.
 */
async function previewOf(org: string, draft: NewMonitor): Promise<Outcome> {
  try {
    return { kind: "preview", preview: await api.previewMonitor(org, bodyOf(draft)) };
  } catch (cause) {
    if (cause instanceof ApiFailure && cause.status === 400) {
      return { kind: "invalid", detail: cause.message };
    }

    throw cause;
  }
}

function usePreview(org: string, draft: NewMonitor): Resource<Outcome> {
  const body = useSettled(JSON.stringify(bodyOf(draft)), 300);

  return useResource(`monitor-preview:${org}:${body}`, () => previewOf(org, draft));
}

/** Loading, a failed request, or the server's reason the settings cannot preview. */
function PreviewState(props: { preview: Resource<Outcome>; className: string }): JSX.Element {
  const { preview, className } = props;

  if (preview.error !== null) {
    return (
      <div className={`${className} invalid`} role="alert">
        The preview could not load: {preview.error}{" "}
        <button type="button" className="small" onClick={preview.reload}>
          Retry
        </button>
      </div>
    );
  }

  if (preview.data?.kind === "invalid") {
    return <InvalidPreview detail={preview.data.detail} />;
  }

  // The box keeps its height while the preview loads, so the form below does not jump.
  return <div className={className} aria-busy="true" />;
}

/** Every interval from this minute: uptime checks run on a fixed cadence. */
function uptimeTimes(now: number, intervalMinutes: number): number[] {
  const start = Math.floor(now / MINUTE) * MINUTE;

  return Array.from({ length: TICKS }, (_, index) => start + index * intervalMinutes * MINUTE);
}

function CronPreview({ org, draft }: { org: string; draft: CronDraft }): JSX.Element {
  const preview = usePreview(org, draft);
  const outcome = preview.data;

  if (outcome?.kind !== "preview") {
    return <PreviewState preview={preview} className="schedule-preview" />;
  }

  if (outcome.preview.type !== "cron") {
    throw new Error(`A cron draft previewed as ${outcome.preview.type}`);
  }

  return <SampleTicks times={outcome.preview.occurrences} config={draft.config} />;
}

function UptimePreview({ draft }: { draft: UptimeDraft }): JSX.Element {
  const now = useNow();

  return (
    <SampleTicks times={uptimeTimes(now, draft.config.intervalMinutes)} config={draft.config} />
  );
}

function InvalidPreview({ detail }: { detail: string }): JSX.Element {
  return (
    <div className="schedule-preview invalid">
      No preview available. The provided schedule is invalid, or the thresholds are incompatible
      with it. <span className="muted small">{detail}</span>
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

  // The server returns twenty occurrences and uptime computes twenty; fewer is a bug.
  if (times.length < TICKS) {
    throw new Error(`The sample preview needs ${TICKS} times, got ${times.length}`);
  }

  const { samples: pattern, opens, closes } = samples(failureThreshold, recoveryThreshold);
  const shortened = failureThreshold > SHOWN_FAILURES || recoveryThreshold > SHOWN_RECOVERIES;
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
          {shortened ? " (not to scale)" : ""}
        </span>
      </div>
    </div>
  );
}

const HEIGHT = 120;

/** The window's count over the last twenty minutes, against the thresholds. */
export function MetricPreview({ org, draft }: { org: string; draft: MetricDraft }): JSX.Element {
  const preview = usePreview(org, draft);
  const outcome = preview.data;

  if (outcome?.kind !== "preview") {
    return <PreviewState preview={preview} className="metric-preview" />;
  }

  if (outcome.preview.type !== "metric") {
    throw new Error(`A metric draft previewed as ${outcome.preview.type}`);
  }

  return <MetricChart points={outcome.preview.points} config={draft.config} />;
}

type Point = { time: number; count: number };

/** x across the chart; a single point is drawn as a flat line instead (see below). */
function xOf(index: number, total: number): number {
  return total === 1 ? 0 : (index / (total - 1)) * 1000;
}

function MetricChart(props: { points: Point[]; config: MetricDraft["config"] }): JSX.Element {
  const { points, config } = props;

  if (points.length === 0) {
    return (
      <div className="schedule-preview invalid">No preview available for this project yet.</div>
    );
  }

  const { threshold, warningThreshold } = config;

  const peak =
    Math.max(threshold, warningThreshold ?? 0, ...points.map(({ count }) => count), 1) * 1.15;

  const y = (value: number): number => HEIGHT - (value / peak) * HEIGHT;

  const only = points[0];

  // One point is a flat line across the chart, not a dot at its left edge.
  const line =
    points.length === 1 && only !== undefined
      ? `0,${y(only.count)} 1000,${y(only.count)}`
      : points.map(({ count }, index) => `${xOf(index, points.length)},${y(count)}`).join(" ");

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
