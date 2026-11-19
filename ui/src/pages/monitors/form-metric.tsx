// Metric form sections, as Sentry's forms/metric, limited to what Zentry
// runs: error counts over a window, against static thresholds.

import type { JSX } from "react";

import { COMPARATOR_TEXT, defaultResolveText, resolveDirection } from "~/lib/monitor-text";

import type { SectionProps } from "./form-common";
import { WholeNumberInput } from "./form-inputs";
import type { MetricDraft } from "./form-state";
import { Field, FormSection, PriorityDot } from "./parts";

const WINDOWS = [300, 900, 3600] as const;

const COMPARATORS = ["gt", "gte", "lt", "lte"] as const;

type Comparator = (typeof COMPARATORS)[number];

// Counts are whole numbers; no window holds more than this many errors.
const MAX_COUNT = Number.MAX_SAFE_INTEGER;

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

function comparatorOf(value: string): Comparator {
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
  children,
}: {
  label: string;
  priority: "high" | "medium";
  comparator: Comparator;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div className="threshold-row">
      <span>
        <PriorityDot priority={priority} /> {label}
      </span>
      <span className="muted">{COMPARATOR_TEXT[comparator]}</span>
      {children}
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
          {COMPARATORS.map((comparator) => (
            <option key={comparator} value={comparator}>
              {COMPARATOR_TEXT[comparator]}
            </option>
          ))}
        </select>
      </Field>
      <Threshold label="High priority" priority="high" comparator={config.comparator}>
        <WholeNumberInput
          label="High priority threshold"
          min={0}
          max={MAX_COUNT}
          value={config.threshold}
          set={(threshold) => update({ threshold })}
        />
      </Threshold>
      <Threshold label="Medium priority" priority="medium" comparator={config.comparator}>
        <WholeNumberInput
          label="Medium priority threshold"
          optional
          min={0}
          max={MAX_COUNT}
          value={config.warningThreshold}
          set={(warningThreshold) => update({ warningThreshold })}
        />
      </Threshold>
      <MetricResolve config={config} update={update} />
    </FormSection>
  );
}

/**
 * The custom value that resolves where the default does, so choosing Custom
 * changes nothing until the number is edited. "Below 10" as an inclusive
 * value is 9, and "above 10" is 11; a count cannot go below 0.
 */
function equivalentRecovery(config: MetricConfig): number {
  const base = config.warningThreshold ?? config.threshold;

  const values: Record<Comparator, number> = {
    gt: base,
    gte: Math.max(0, base - 1),
    lt: base,
    lte: base + 1,
  };

  return values[config.comparator];
}

/** Resolve at the detection threshold by default, as Sentry's, or at a custom value. */
function MetricResolve({ config, update }: { config: MetricConfig; update: Update }): JSX.Element {
  return (
    <>
      <h5>Resolve</h5>
      <label className="check-label">
        <input
          type="radio"
          name="metric-resolve"
          checked={config.recoveryThreshold === undefined}
          onChange={() => update({ recoveryThreshold: undefined })}
        />{" "}
        Default
        <span className="muted small">
          {" "}
          Issue will be resolved when the query value is {defaultResolveText(config)}.
        </span>
      </label>
      <label className="check-label">
        <input
          type="radio"
          name="metric-resolve"
          checked={config.recoveryThreshold !== undefined}
          onChange={() => update({ recoveryThreshold: equivalentRecovery(config) })}
        />{" "}
        Custom
      </label>
      {config.recoveryThreshold !== undefined && (
        <div className="threshold-row">
          <span className="muted">Resolve when the query value is</span>
          <span className="muted">{resolveDirection(config)}</span>
          <WholeNumberInput
            label="Resolve threshold"
            min={0}
            max={MAX_COUNT}
            value={config.recoveryThreshold}
            set={(recoveryThreshold) => update({ recoveryThreshold })}
          />
        </div>
      )}
    </>
  );
}
