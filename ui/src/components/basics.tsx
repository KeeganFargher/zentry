// Small building blocks used on every page.

import type { StatPoint } from "@contract";
import type { JSX, MouseEvent, ReactNode } from "react";

import { BarChart } from "~/components/chart";
import { Tooltip } from "~/components/tooltip";
import { useNow } from "~/lib/clock";
import { age, compact, dateTime, longAgo, timeAgo, utcDateTime } from "~/lib/format";
import { levelLabel } from "~/lib/issue";
import { navigate } from "~/lib/router";

type LinkProps = { to: string; className?: string; children: ReactNode };

export function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** An in-app link: navigates without a page load, but still opens in a new tab on request. */
export function Link({ to, className, children }: LinkProps): JSX.Element {
  const follow = (event: MouseEvent): void => {
    if (isPlainClick(event)) {
      event.preventDefault();
      navigate(to);
    }
  };

  return (
    <a href={to} className={className} onClick={follow}>
      {children}
    </a>
  );
}

type NoticeProps = {
  loading: boolean;
  error: string | null;
  empty?: ReactNode;
  onRetry?: () => void;
};

/** Loading, error or empty state. Renders nothing when there is data to show. */
export function Notice({ loading, error, empty = null, onRetry }: NoticeProps): JSX.Element | null {
  if (error !== null) {
    return (
      <div className="notice failed">
        <div>{error}</div>
        {onRetry !== undefined && (
          <button type="button" className="small" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    );
  }

  if (loading) {
    return <Skeleton lines={3} />;
  }

  return empty === null ? null : <div className="notice">{empty}</div>;
}

/** Grey placeholder bars in the shape of the content that is on its way. */
export function Skeleton({ lines, height = 14 }: { lines: number; height?: number }): JSX.Element {
  return (
    <div className="skeleton" aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, line) => (
        <span key={line} style={{ height, width: `${90 - ((line * 23) % 40)}%` }} />
      ))}
    </div>
  );
}

/** The small per-row chart on the issue list, with its peak and the issue's status under it. */
export function Trend({ points, status }: { points: StatPoint[]; status: string }): JSX.Element {
  const peak = Math.max(0, ...points.map(([, count]) => count));

  return (
    <div className="trend">
      <BarChart points={points} height={26} />
      <span className="peak">{compact(peak)}</span>
      <span className={`trend-status ${status.toLowerCase()}`}>{status}</span>
    </div>
  );
}

type TimeProps = { at: number; label: string };

/** The hover card behind every relative time: local and UTC. */
function TimeCard({ at, label }: TimeProps): JSX.Element {
  return (
    <div className="time-card">
      <strong>{label}</strong>
      <div>{dateTime(at)}</div>
      <div className="muted">{utcDateTime(at)}</div>
    </div>
  );
}

/** "5min ago", for lists. Moves on by itself once a minute. */
export function Ago({ at, label }: TimeProps): JSX.Element {
  const now = useNow();

  return (
    <Tooltip content={<TimeCard at={at} label={label} />} className="dotted">
      {timeAgo(at, now)}
    </Tooltip>
  );
}

/** Time since `at` without the "ago", for the Age column. */
export function Age({ at, label }: TimeProps): JSX.Element {
  const now = useNow();

  return (
    <Tooltip content={<TimeCard at={at} label={label} />} className="dotted">
      {age(at, now)}
    </Tooltip>
  );
}

/** "5 minutes ago", for the issue page. */
export function TimeSince({ at, label }: TimeProps): JSX.Element {
  const now = useNow();

  return (
    <Tooltip content={<TimeCard at={at} label={label} />} className="dotted">
      {longAgo(at, now)}
    </Tooltip>
  );
}

/** "1.2K", with the exact number on hover. */
export function Count({ value }: { value: number }): JSX.Element {
  return (
    <span className="count-value" title={value.toLocaleString()}>
      {compact(value)}
    </span>
  );
}

/** The thin coloured bar before an issue's message. */
export function LevelBar({ level }: { level: string }): JSX.Element {
  return (
    <Tooltip content={`Level: ${levelLabel(level)}`} className={`level-bar level-${level}`}>
      {null}
    </Tooltip>
  );
}

/** The small square that stands for a project's platform, e.g. "JS" or "PY". */
export function Platform({ name }: { name: string | null }): JSX.Element {
  return <span className="platform">{PLATFORM_CODES.get(name ?? "") ?? "··"}</span>;
}

const PLATFORM_CODES = new Map([
  ["javascript", "JS"],
  ["node", "JS"],
  ["python", "PY"],
  ["php", "PHP"],
  ["ruby", "RB"],
  ["go", "GO"],
  ["java", "JV"],
  ["csharp", ".NET"],
  ["cocoa", "iOS"],
]);
