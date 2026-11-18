import type { ApiMonitor } from "@contract";
import type { JSX } from "react";

type FieldsProps = { initial: ApiMonitor | undefined };

const WINDOWS = [300, 900, 3600];
const INTERVALS = [1, 5, 10, 20, 30, 60];

function cronText(
  schedule: { intervalMinutes: number } | { expression: string; timezone: string },
): { expression: string; timezone: string } {
  return "expression" in schedule ? schedule : { expression: "", timezone: "UTC" };
}

function MetricFields({ initial }: FieldsProps): JSX.Element {
  const config = initial?.type === "metric" ? initial.config : undefined;

  return (
    <>
      <label>
        Environment{" "}
        <input
          name="environment"
          defaultValue={config?.environment}
          placeholder="All environments"
        />
      </label>
      <label>
        Evaluation window
        <select name="window" defaultValue={config?.windowSeconds ?? 300}>
          {WINDOWS.map((seconds) => (
            <option key={seconds} value={seconds}>
              {seconds / 60} minutes
            </option>
          ))}
        </select>
      </label>
      <label>
        Error count threshold{" "}
        <input name="threshold" type="number" min="1" required defaultValue={config?.threshold} />
      </label>
      <label>
        Recovery threshold{" "}
        <input
          name="recovery"
          type="number"
          min="0"
          defaultValue={config?.recoveryThreshold}
          placeholder="Below the breach threshold"
        />
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
}: {
  settings: { failureThreshold: number; recoveryThreshold: number };
}): JSX.Element {
  return (
    <>
      <NumberField
        label="Failures to open"
        name="failures"
        min={1}
        max={10}
        value={settings.failureThreshold}
      />
      <NumberField
        label="Successes to recover"
        name="recoveries"
        min={1}
        max={10}
        value={settings.recoveryThreshold}
      />
    </>
  );
}

function cronInterval(schedule: { intervalMinutes: number } | { expression: string }): number {
  return "intervalMinutes" in schedule ? schedule.intervalMinutes : 1440;
}

function CronFields({ initial }: FieldsProps): JSX.Element {
  const config = initial?.type === "cron" ? initial.config : undefined;

  const {
    slug = "",
    environment = "production",
    graceMinutes = 1,
    maxRuntimeMinutes = 30,
  } = config ?? {};

  const schedule = config ?? { intervalMinutes: 1440 };

  const { expression, timezone } = cronText(schedule);

  return (
    <>
      <label>
        SDK monitor slug <input name="slug" required defaultValue={slug} />
      </label>
      <label>
        Environment <input name="environment" required defaultValue={environment} />
      </label>
      <NumberField
        label="Interval (minutes)"
        name="interval"
        min={1}
        max={10080}
        value={cronInterval(schedule)}
      />
      <label>
        Crontab{" "}
        <input
          name="expression"
          defaultValue={expression}
          placeholder="Optional, overrides interval"
        />
      </label>
      <label>
        Crontab timezone <input name="timezone" defaultValue={timezone} />
      </label>
      <NumberField
        label="Start grace (minutes)"
        name="grace"
        min={1}
        max={1440}
        value={graceMinutes}
      />
      <NumberField
        label="Maximum runtime (minutes)"
        name="runtime"
        min={1}
        max={1440}
        value={maxRuntimeMinutes}
      />
      <StreakFields settings={config ?? { failureThreshold: 1, recoveryThreshold: 1 }} />
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
  const config = initial?.type === "uptime" ? initial.config : undefined;

  const {
    url = "",
    method = "GET",
    intervalMinutes = 1,
    timeoutMs = 5000,
    failureThreshold = 3,
    recoveryThreshold = 1,
  } = config ?? {};

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
