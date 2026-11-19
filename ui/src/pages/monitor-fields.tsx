import type { ApiMonitor } from "@contract";
import type { JSX } from "react";

type FieldsProps = { initial: ApiMonitor | undefined };

const WINDOWS = [300, 900, 3600];
const INTERVALS = [1, 5, 10, 20, 30, 60];

function MetricWindow({ value }: { value: number }): JSX.Element {
  return (
    <label>
      Evaluation window
      <select name="window" defaultValue={value}>
        {WINDOWS.map((seconds) => (
          <option key={seconds} value={seconds}>
            {seconds / 60} minutes
          </option>
        ))}
      </select>
    </label>
  );
}

function MetricFields({ initial }: FieldsProps): JSX.Element {
  const {
    environment,
    windowSeconds = 300,
    threshold,
    recoveryThreshold,
    comparator = "gte",
    level = "",
    warningThreshold,
  } = initial?.type === "metric" ? initial.config : {};

  return (
    <>
      <label>
        Environment{" "}
        <input name="environment" defaultValue={environment} placeholder="All environments" />
      </label>
      <MetricWindow value={windowSeconds} />
      <label>
        Error count threshold{" "}
        <input name="threshold" type="number" min="0" required defaultValue={threshold} />
      </label>
      <label>
        Recovery threshold{" "}
        <input
          name="recovery"
          type="number"
          min="0"
          defaultValue={recoveryThreshold}
          placeholder="On the healthy side of the threshold"
        />
      </label>
      <label>
        Comparison
        <select name="comparator" defaultValue={comparator}>
          <option value="gte">At or above</option>
          <option value="gt">Above</option>
          <option value="lte">At or below</option>
          <option value="lt">Below</option>
        </select>
      </label>
      <label>
        Event level
        <select name="level" defaultValue={level}>
          <option value="">Error and fatal</option>
          <option value="error">Error</option>
          <option value="fatal">Fatal</option>
        </select>
      </label>
      <label>
        Medium threshold{" "}
        <input type="number" min="0" name="warning" defaultValue={warningThreshold} />
      </label>
    </>
  );
}

function NumberField({
  label,
  name,
  min,
  max,
  value,
}: {
  label: string;
  name: string;
  min: number;
  max: number;
  value: number;
}): JSX.Element {
  return (
    <label>
      {label}
      <input name={name} type="number" min={min} max={max} defaultValue={value} required />
    </label>
  );
}

function StreakFields({
  settings,
  max,
}: {
  settings: { failureThreshold: number; recoveryThreshold: number };
  max: number;
}): JSX.Element {
  return (
    <>
      <NumberField
        label="Failures to open"
        name="failures"
        min={1}
        max={max}
        value={settings.failureThreshold}
      />
      <NumberField
        label="Successes to recover"
        name="recoveries"
        min={1}
        max={max}
        value={settings.recoveryThreshold}
      />
    </>
  );
}

const INTERVAL_UNITS = ["minute", "hour", "day", "week", "month", "year"] as const;

type CronSchedule = Extract<ApiMonitor, { type: "cron" }>["config"]["schedule"];

function CronScheduleFields({ schedule }: { schedule: CronSchedule }): JSX.Element {
  const crontab = schedule.type === "crontab" ? schedule.crontab : "0 0 * * *";
  const interval = schedule.type === "interval" ? schedule : { count: 1, unit: "day" };

  return (
    <>
      <label>
        Schedule type
        <select name="scheduleType" defaultValue={schedule.type}>
          <option value="crontab">Crontab</option>
          <option value="interval">Interval</option>
        </select>
      </label>
      <label>
        Crontab <input name="crontab" defaultValue={crontab} />
      </label>
      <NumberField label="Every" name="intervalCount" min={1} max={1000} value={interval.count} />
      <label>
        Interval unit
        <select name="intervalUnit" defaultValue={interval.unit}>
          {INTERVAL_UNITS.map((unit) => (
            <option key={unit} value={unit}>
              {unit}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

const CRON_DEFAULTS = {
  slug: "",
  schedule: { type: "crontab", crontab: "0 0 * * *" },
  timezone: "UTC",
  graceMinutes: 1,
  maxRuntimeMinutes: 30,
  failureThreshold: 1,
  recoveryThreshold: 1,
} satisfies Extract<ApiMonitor, { type: "cron" }>["config"];

function CronFields({ initial }: FieldsProps): JSX.Element {
  const config = initial?.type === "cron" ? initial.config : CRON_DEFAULTS;

  return (
    <>
      <label>
        SDK monitor slug{" "}
        <input name="slug" required defaultValue={config.slug} readOnly={initial !== undefined} />
      </label>
      <CronScheduleFields schedule={config.schedule} />
      <label>
        Timezone <input name="timezone" defaultValue={config.timezone} />
      </label>
      <NumberField
        label="Grace period (minutes)"
        name="grace"
        min={1}
        max={40320}
        value={config.graceMinutes}
      />
      <NumberField
        label="Maximum runtime (minutes)"
        name="runtime"
        min={1}
        max={10080}
        value={config.maxRuntimeMinutes}
      />
      <StreakFields settings={config} max={720} />
    </>
  );
}

function UptimeHttpFields({
  method,
  intervalMinutes,
}: {
  method: "GET" | "HEAD";
  intervalMinutes: number;
}): JSX.Element {
  return (
    <>
      {" "}
      <label>
        HTTP method
        <select name="method" defaultValue={method}>
          <option>GET</option>
          <option>HEAD</option>
        </select>
      </label>
      <label>
        Probe interval
        <select name="interval" defaultValue={intervalMinutes}>
          {INTERVALS.map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes} min
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

function UptimeFields({ initial }: FieldsProps): JSX.Element {
  const {
    environment,
    successCodes,
    url = "",
    method = "GET",
    intervalMinutes = 1,
    timeoutMs = 5000,
    failureThreshold = 3,
    recoveryThreshold = 1,
  } = initial?.type === "uptime" ? initial.config : {};

  return (
    <>
      <label>
        Approved endpoint{" "}
        <input
          name="url"
          type="url"
          placeholder="https://example.com/health"
          required
          defaultValue={url}
        />
      </label>
      <UptimeHttpFields method={method} intervalMinutes={intervalMinutes} />
      <label>
        Environment label <input name="environment" defaultValue={environment} />
      </label>
      <label>
        Success status codes{" "}
        <input
          name="success-codes"
          placeholder="Default: 200–299"
          defaultValue={successCodes?.join(", ")}
        />
      </label>
      <NumberField
        label="Timeout (milliseconds)"
        name="timeout"
        min={1000}
        max={15000}
        value={timeoutMs}
      />
      <NumberField
        label="Failures to open"
        name="failures"
        min={1}
        max={10}
        value={failureThreshold}
      />
      <NumberField
        label="Successes to recover"
        name="recoveries"
        min={1}
        max={10}
        value={recoveryThreshold}
      />
    </>
  );
}

export const FIELDS = { metric: MetricFields, cron: CronFields, uptime: UptimeFields };
