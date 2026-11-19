import type { ApiMonitor, MonitorDetail } from "@contract";
import { useState } from "react";
import type { JSX } from "react";

import { Link } from "~/components/basics";
import { useNow } from "~/lib/clock";

import { Coverage, HEALTH } from "./monitor-history";

type Props = {
  detail: MonitorDetail;
  org: string;
  editing: boolean;
  edit: () => void;
  update: (status: ApiMonitor["status"]) => Promise<void>;
  mute: (until: number | null) => Promise<void>;
};

function CronInstructions({ detail, org }: Pick<Props, "detail" | "org">): JSX.Element {
  const { monitor } = detail;

  if (monitor.type !== "cron") {
    return <></>;
  }

  const slug = monitor.config.slug;

  return (
    <>
      <p>Use your project DSN and send the first check-in to arm each environment.</p>
      <Link to={`/${org}/projects/`}>Find project DSNs</Link>
      <ul>
        {detail.scopes.map(({ environment, health, nextAt, issueId }) => (
          <li key={environment}>
            {environment} · {HEALTH[health]} ·{" "}
            {nextAt === null
              ? "Awaiting first check-in"
              : `Next ${new Date(nextAt).toLocaleString()}`}
            {issueId !== null && (
              <>
                {" "}
                · <Link to={`/${org}/issues/${issueId}/`}>View issue</Link>
              </>
            )}
          </li>
        ))}
      </ul>
      <details>
        <summary>JavaScript SDK check-ins</summary>
        <pre>{`// One-shot heartbeat
Sentry.captureCheckIn({ monitorSlug: "${slug}", status: "ok" });

// Pair the start and finish
const checkInId = Sentry.captureCheckIn({ monitorSlug: "${slug}", status: "in_progress" });
Sentry.captureCheckIn({ monitorSlug: "${slug}", checkInId, status: "ok" });`}</pre>
      </details>
      <details>
        <summary>Python SDK check-ins</summary>
        <pre>{`# One-shot heartbeat
sentry_sdk.capture_checkin(monitor_slug="${slug}", status="ok")

# Report a monitored run
with sentry_sdk.monitor(monitor_slug="${slug}"):
    run_job()`}</pre>
      </details>
    </>
  );
}

function SignalSummary({ detail, org }: Pick<Props, "detail" | "org">): JSX.Element {
  const { monitor } = detail;

  if (monitor.type === "cron") {
    return <CronInstructions detail={detail} org={org} />;
  }

  if (monitor.type === "uptime") {
    return (
      <>
        <p>
          <code>
            {monitor.config.method} {monitor.config.url}
          </code>
          {monitor.config.environment === undefined ? "" : ` · ${monitor.config.environment}`}
        </p>
        {detail.coverage !== null && <Coverage coverage={detail.coverage} />}
      </>
    );
  }

  const { config } = monitor;
  const compare = { gt: "above ", lt: "below ", lte: "at or below ", gte: "" };

  return (
    <p>
      Open an issue at {compare[config.comparator]}
      {config.threshold} errors within {config.windowSeconds / 60} minutes.
    </p>
  );
}

function MuteControls({
  monitor,
  mute,
}: {
  monitor: ApiMonitor;
  mute: Props["mute"];
}): JSX.Element {
  const [minutes, setMinutes] = useState(60);
  const now = useNow();

  if (monitor.mutedUntil !== null && monitor.mutedUntil > now) {
    return (
      <>
        <p>Muted until {new Date(monitor.mutedUntil).toLocaleString()}</p>
        <button type="button" onClick={() => void mute(null)}>
          Unmute alerts
        </button>
      </>
    );
  }

  return (
    <div className="form-row">
      <label>
        Mute duration
        <select value={minutes} onChange={(event) => setMinutes(Number(event.currentTarget.value))}>
          <option value={60}>1 hour</option>
          <option value={1440}>1 day</option>
          <option value={10079}>7 days</option>
        </select>
      </label>
      <button type="button" onClick={() => void mute(Date.now() + minutes * 60_000)}>
        Mute alerts
      </button>
    </div>
  );
}

export function MonitorControls({ detail, org, editing, edit, update, mute }: Props): JSX.Element {
  const { monitor } = detail;
  const paused = monitor.status === "paused";

  return (
    <section className="panel padded">
      <h2>Signal and settings</h2>
      {monitor.description !== "" && <p>{monitor.description}</p>}
      <SignalSummary detail={detail} org={org} />
      {monitor.status !== "archived" && (
        <>
          <div className="form-row">
            <button type="button" onClick={() => void update(paused ? "active" : "paused")}>
              {paused ? "Resume monitor" : "Pause monitor"}
            </button>
            <button type="button" onClick={edit}>
              {editing ? "Close settings" : "Edit monitor"}
            </button>
            {paused && (
              <button type="button" onClick={() => void update("archived")}>
                Archive monitor
              </button>
            )}
          </div>
          <MuteControls monitor={monitor} mute={mute} />
        </>
      )}
    </section>
  );
}
