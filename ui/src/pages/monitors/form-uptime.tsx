// Uptime form sections, as Sentry's forms/uptime, limited to what Zentry
// runs: GET or HEAD, judged by status codes.

import type { JSX } from "react";

import type { SectionProps } from "./form-common";
import { useValidatedText, WholeNumberInput } from "./form-inputs";
import type { UptimeDraft } from "./form-state";
import { Field, FormSection } from "./parts";

const INTERVALS = [1, 5, 10, 20, 30, 60] as const;

const METHODS = ["GET", "HEAD"] as const;

type Config = UptimeDraft["config"];

// Select options are built from these lists, so a value outside them is a bug
// worth failing on rather than quietly saving some other setting.

function intervalOf(value: string): Config["intervalMinutes"] {
  const minutes = INTERVALS.find((entry) => entry === Number(value));

  if (minutes === undefined) {
    throw new Error(`Unknown uptime interval ${value}`);
  }

  return minutes;
}

function methodOf(value: string): Config["method"] {
  const method = METHODS.find((entry) => entry === value);

  if (method === undefined) {
    throw new Error(`Unknown uptime method ${value}`);
  }

  return method;
}

function IntervalField({
  minutes,
  set,
}: {
  minutes: number;
  set: (minutes: Config["intervalMinutes"]) => void;
}): JSX.Element {
  return (
    <Field label="Interval">
      <select value={minutes} onChange={(event) => set(intervalOf(event.target.value))}>
        {INTERVALS.map((entry) => (
          <option key={entry} value={entry}>
            Every {entry === 60 ? "1 hour" : `${entry} minute${entry === 1 ? "" : "s"}`}
          </option>
        ))}
      </select>
    </Field>
  );
}

function TimeoutField({ ms, set }: { ms: number; set: (ms: number) => void }): JSX.Element {
  return (
    <Field label="Timeout">
      <div className="slider">
        <output>{(ms / 1000).toFixed(2)}s</output>
        <input
          type="range"
          min={1000}
          max={15000}
          step={500}
          aria-label="Timeout"
          value={ms}
          onChange={(event) => set(Number(event.target.value))}
        />
        <span className="muted small slider-scale">
          <span>1.00s</span>
          <span>15.00s</span>
        </span>
      </div>
    </Field>
  );
}

export function UptimeDetection(props: SectionProps<UptimeDraft> & { step: number }): JSX.Element {
  const { config } = props.draft;

  const update = (next: Partial<Config>): void =>
    props.set({ ...props.draft, config: { ...config, ...next } });

  return (
    <FormSection step={props.step} title="Issue Detection">
      <IntervalField
        minutes={config.intervalMinutes}
        set={(intervalMinutes) => update({ intervalMinutes })}
      />
      <TimeoutField ms={config.timeoutMs} set={(timeoutMs) => update({ timeoutMs })} />
      <Field
        label="URL"
        help="Any public https:// URL. No credentials in it, and not Zentry itself."
      >
        <input
          type="url"
          className="mono"
          placeholder="The URL to monitor"
          value={config.url}
          onChange={(event) => update({ url: event.target.value })}
        />
      </Field>
      <Field label="Method">
        <select
          value={config.method}
          onChange={(event) => update({ method: methodOf(event.target.value) })}
        >
          <option value="GET">GET</option>
          <option value="HEAD">HEAD</option>
        </select>
      </Field>
      <Field
        label="Failure Threshold"
        help={`Issue created after ${config.failureThreshold} consecutive failures (after ${config.failureThreshold * config.intervalMinutes} minutes of downtime).`}
      >
        <WholeNumberInput
          label="Failure Threshold"
          min={1}
          max={10}
          placeholder="Defaults to 3"
          value={config.failureThreshold}
          set={(failureThreshold) => update({ failureThreshold })}
        />
      </Field>
    </FormSection>
  );
}

type Codes = number[] | undefined;

// The server's limits (src/shared/monitors.ts successCodes).
const MAX_CODES = 20;

/**
 * Every comma-separated token must be a status code: one typo blocks saving
 * with a message, rather than being dropped while the input still shows it.
 * Empty text means the default, any 2xx.
 */
function parseCodes(text: string): { ok: true; value: Codes } | { ok: false; problem: string } {
  const tokens = text
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "");

  if (tokens.length === 0) {
    return { ok: true, value: undefined };
  }

  const bad = tokens.find((token) => !/^[1-5]\d\d$/u.test(token));

  if (bad !== undefined) {
    return { ok: false, problem: `"${bad}" is not an HTTP status code (100–599).` };
  }

  if (tokens.length > MAX_CODES) {
    return { ok: false, problem: `List at most ${MAX_CODES} status codes.` };
  }

  return { ok: true, value: tokens.map(Number) };
}

export function UptimeVerification(
  props: SectionProps<UptimeDraft> & { step: number },
): JSX.Element {
  const { config } = props.draft;

  const { text, problem, change } = useValidatedText<Codes>({
    field: "Status Codes",
    value: config.successCodes,
    format: (codes) => codes?.join(", ") ?? "",
    parse: parseCodes,
    set: (successCodes) => props.set({ ...props.draft, config: { ...config, successCodes } }),
  });

  return (
    <FormSection step={props.step} title="Verification">
      <Field
        label="Status Codes"
        help="Responses with these status codes count as up. Redirects are not followed."
      >
        <input
          type="text"
          className="mono"
          placeholder="Default: 200–299"
          aria-invalid={problem !== null}
          value={text}
          onChange={(event) => change(event.target.value)}
        />
        {problem !== null && (
          <span className="field-error" role="alert">
            {problem}
          </span>
        )}
      </Field>
    </FormSection>
  );
}

export function UptimeResolution(props: SectionProps<UptimeDraft> & { step: number }): JSX.Element {
  const { config } = props.draft;

  return (
    <FormSection step={props.step} title="Issue Resolution">
      <Field
        label="Recovery Threshold"
        help={`Issue resolved after ${config.recoveryThreshold} consecutive successes (after ${config.recoveryThreshold * config.intervalMinutes} minutes of recovered uptime).`}
      >
        <WholeNumberInput
          label="Recovery Threshold"
          min={1}
          max={10}
          placeholder="Defaults to 1"
          value={config.recoveryThreshold}
          set={(recoveryThreshold) =>
            props.set({ ...props.draft, config: { ...config, recoveryThreshold } })
          }
        />
      </Field>
    </FormSection>
  );
}
