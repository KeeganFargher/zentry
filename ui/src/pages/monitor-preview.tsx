import type { MonitorPreview } from "@contract";
import type { JSX } from "react";

function MetricChart({
  result,
}: {
  result: Extract<MonitorPreview, { type: "metric" }>;
}): JSX.Element {
  const { points, threshold, windowEnd, warningThreshold } = result;

  const maximum = Math.max(
    1,
    threshold,
    warningThreshold ?? 0,
    ...points.map(({ count }) => count),
  );

  return (
    <figure className="monitor-preview">
      <figcaption>
        Processed errors in the window ending {new Date(windowEnd).toLocaleString()}: {result.count}
        . High threshold {threshold}
        {warningThreshold === undefined ? "" : `, medium threshold ${warningThreshold}`}.
      </figcaption>
      <div className="monitor-preview-bars" aria-label="Threshold replay" role="img">
        {points.map(({ count, time, covered }) => (
          <div
            key={time}
            data-covered={covered}
            style={{ height: `${(100 * count) / maximum}%` }}
            title={`${new Date(time).toLocaleTimeString()} · ${covered ? count : "incomplete input"}`}
          />
        ))}
        <span
          className="monitor-preview-line"
          style={{ bottom: `${(100 * threshold) / maximum}%` }}
        />
        {warningThreshold !== undefined && (
          <span
            className="monitor-preview-line medium"
            style={{ bottom: `${(100 * warningThreshold) / maximum}%` }}
          />
        )}
      </div>
      <p className="muted">Incomplete windows don’t change issue state.</p>
    </figure>
  );
}

export function PreviewResult({ result }: { result: MonitorPreview }): JSX.Element {
  if (result.type === "cron") {
    return (
      <ol aria-label="Next scheduled runs">
        {result.occurrences.map((time) => (
          <li key={time}>{new Date(time).toLocaleString()}</li>
        ))}
      </ol>
    );
  }

  if (result.type === "metric") {
    return <MetricChart result={result} />;
  }

  return (
    <p>
      Probe result: {result.outcome}{" "}
      {result.httpStatus !== undefined && `(HTTP ${result.httpStatus})`}
      {result.durationMs !== undefined && ` · ${result.durationMs} ms`}
      {result.reason !== undefined && ` · ${result.reason}`}
    </p>
  );
}
