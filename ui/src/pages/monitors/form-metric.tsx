// Metric form sections, as Sentry's forms/metric, limited to what Zentry
// runs: error counts over a window, against static thresholds.

import type { JSX } from "react";

import { intOf } from "./form-common";
import type { SectionProps } from "./form-common";
import type { MetricDraft } from "./form-state";
import { Field, FormSection, PriorityDot } from "./parts";

const WINDOWS = [300, 900, 3600] as const;

const COMPARATORS = ["gt", "lt"] as const;

type MetricConfig = MetricDraft["config"];

type Update = (next: Partial<MetricConfig>) => void;

// Select options are built from these lists, so a value outside them is a bug
// worth failing on rather than quietly saving some other setting.

function windowOf(value: string): MetricConfig["windowSeconds"] {
  const seconds = WINDOWS.find((entry) => entry === Number(value));

  if (seconds === undefined) {
    throw new Error(`Unknown metric window ${value}`);
  }

  return seconds;
}

function comparatorOf(value: string): (typeof COMPARATORS)[number] {
  const comparator = COMPARATORS.find((entry) => entry === value);

  if (comparator === undefined) {
    throw new Error(`Unknown comparator ${value}`);
  }

  return comparator;
}

/** "" is the all-levels option, which the API spells as no level. */
function levelOf(value: string): MetricConfig["level"] {
  if (value === "") {
    return undefined;
  }

  if (value !== "error" && value !== "fatal") {
    throw new Error(`Unknown level ${value}`);
  }

  return value;
}

function metricUpdate(props: SectionProps<MetricDraft>): Update {
  return (next) => props.set({ ...props.draft, config: { ...props.draft.config, ...next } });
}

export function MetricChoice(props: SectionProps<MetricDraft> & { step: number }): JSX.Element {
  const { config } = props.draft;
  const update = metricUpdate(props);

  return (
    <>
      <FormSection step={props.step} title="Choose Your Metric">
        <select disabled value="errors" aria-label="Metric">
          <option value="errors">Number of Errors</option>
        </select>
      </FormSection>
      <FormSection step={props.step + 1} title="Customize Metric">
        <div className="field-row">
          <label>
            Level
            <select
              value={config.level ?? ""}
              onChange={(event) => update({ level: levelOf(event.target.value) })}
            >
              <option value="">Errors and fatal</option>
              <option value="error">Error</option>
              <option value="fatal">Fatal</option>
            </select>
          </label>
          <label>
            Interval
            <select
              value={config.windowSeconds}
              onChange={(event) => update({ windowSeconds: windowOf(event.target.value) })}
            >
              <option value={300}>5 minutes</option>
              <option value={900}>15 minutes</option>
              <option value={3600}>1 hour</option>
            </select>
          </label>
          <label>
            Visualize
            <select disabled value="count" aria-label="Visualize">
              <option value="count">count</option>
            </select>
          </label>
        </div>
      </FormSection>
    </>
  );
}

function Threshold({
  label,
  priority,
  comparator,
  value,
  set,
}: {
  label: string;
  priority: "high" | "medium";
  comparator: MetricConfig["comparator"];
  value: number | undefined;
  set: (value: number | undefined) => void;
}): JSX.Element {
  return (
    <div className="threshold-row">
      <span>
        <PriorityDot priority={priority} /> {label}
      </span>
      <span className="muted">{comparator.startsWith("gt") ? "Above" : "Below"}</span>
      <input
        type="number"
        min={0}
        aria-label={`${label} threshold`}
        value={value ?? ""}
        onChange={(event) => set(event.target.value === "" ? undefined : intOf(event.target.value))}
      />
    </div>
  );
}

export function MetricDetection(props: SectionProps<MetricDraft> & { step: number }): JSX.Element {
  const { config } = props.draft;
  const update = metricUpdate(props);

  return (
    <FormSection
      step={props.step}
      title="Issue Detection"
      description="This determines the conditions that lead to the creation of an issue."
    >
      <div className="choice-cards">
        <div className="choice-card selected">
          <strong>Threshold</strong>
          <span className="muted small">Absolute-valued thresholds, for non-seasonal data.</span>
        </div>
      </div>
      <h5>Define threshold &amp; set priority</h5>
      <p className="muted">An issue will be created when query value is:</p>
      <Field label="Direction">
        <select
          value={config.comparator}
          onChange={(event) => update({ comparator: comparatorOf(event.target.value) })}
        >
          <option value="gt">Above</option>
          <option value="lt">Below</option>
        </select>
      </Field>
      <Threshold
        label="High priority"
        priority="high"
        comparator={config.comparator}
        value={config.threshold}
        set={(threshold) => update({ threshold: threshold ?? 0 })}
      />
      <Threshold
        label="Medium priority"
        priority="medium"
        comparator={config.comparator}
        value={config.warningThreshold}
        set={(warningThreshold) => update({ warningThreshold })}
      />
      <MetricResolve config={config} update={update} />
    </FormSection>
  );
}

/** Resolve at the detection threshold by default, as Sentry's, or at a custom value. */
function MetricResolve({ config, update }: { config: MetricConfig; update: Update }): JSX.Element {
  const above = config.comparator.startsWith("gt");

  return (
    <>
      <h5>Resolve</h5>
      <label className="check-label">
        <input
          type="radio"
          checked={config.recoveryThreshold === undefined}
          onChange={() => update({ recoveryThreshold: undefined })}
        />{" "}
        Default
        <span className="muted small">
          {" "}
          Issue will be resolved when the query value is{" "}
          {above ? "below or equal to" : "above or equal to"}{" "}
          {config.warningThreshold ?? config.threshold}.
        </span>
      </label>
      <label className="check-label">
        <input
          type="radio"
          checked={config.recoveryThreshold !== undefined}
          onChange={() =>
            update({ recoveryThreshold: config.warningThreshold ?? config.threshold })
          }
        />{" "}
        Custom
        {config.recoveryThreshold !== undefined && (
          <input
            type="number"
            min={0}
            aria-label="Resolve threshold"
            value={config.recoveryThreshold}
            onChange={(event) => update({ recoveryThreshold: intOf(event.target.value) })}
          />
        )}
      </label>
    </>
  );
}
