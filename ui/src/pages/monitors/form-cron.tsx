// Cron form sections, as Sentry's forms/cron: instrumentation, Issue
// Detection (schedule, margins, thresholds) and Issue Resolution.

import type { JSX } from "react";

import { scheduleText } from "~/lib/monitor-text";

import type { SectionProps } from "./form-common";
import { WholeNumberInput } from "./form-inputs";
import type { CronDraft } from "./form-state";
import { Field, FormSection } from "./parts";
import { SdkGuide } from "./sdk-guide";
import type { DsnState } from "./sdk-guide";

const UNITS = ["minute", "hour", "day", "week", "month", "year"] as const;

type Config = CronDraft["config"];

function useConfig(props: SectionProps<CronDraft>): [Config, (config: Partial<Config>) => void] {
  return [
    props.draft.config,
    (config) => props.set({ ...props.draft, config: { ...props.draft.config, ...config } }),
  ];
}

type Schedule = Config["schedule"];

type Interval = Extract<Schedule, { type: "interval" }>;

type Update = (config: Partial<Config>) => void;

/** The unit a select option names; options come from UNITS, so a miss is a bug. */
function unitOf(value: string): Interval["unit"] {
  const unit = UNITS.find((entry) => entry === value);

  if (unit === undefined) {
    throw new Error(`Unknown interval unit ${value}`);
  }

  return unit;
}

function ScheduleKind({ schedule, update }: { schedule: Schedule; update: Update }): JSX.Element {
  return (
    <select
      aria-label="Schedule type"
      value={schedule.type}
      onChange={(event) =>
        update({
          // Switching kind starts from Sentry's default for that kind.
          schedule:
            event.target.value === "interval"
              ? { type: "interval", count: 1, unit: "day" }
              : { type: "crontab", crontab: "0 0 * * *" },
        })
      }
    >
      <option value="crontab">Crontab</option>
      <option value="interval">Interval</option>
    </select>
  );
}

function IntervalFields({ schedule, update }: { schedule: Interval; update: Update }): JSX.Element {
  return (
    <div className="schedule-grid interval">
      <ScheduleKind schedule={schedule} update={update} />
      <span>Every</span>
      <WholeNumberInput
        label="Interval"
        min={1}
        max={1000}
        placeholder="e.g. 1"
        value={schedule.count}
        set={(count) => update({ schedule: { ...schedule, count } })}
      />
      <select
        aria-label="Interval unit"
        value={schedule.unit}
        onChange={(event) =>
          update({ schedule: { ...schedule, unit: unitOf(event.target.value) } })
        }
      >
        {UNITS.map((unit) => (
          <option key={unit} value={unit}>
            {schedule.count === 1 ? unit : `${unit}s`}
          </option>
        ))}
      </select>
    </div>
  );
}

function ScheduleFields(props: SectionProps<CronDraft>): JSX.Element {
  const [config, update] = useConfig(props);
  const { schedule } = config;

  if (schedule.type === "interval") {
    return <IntervalFields schedule={schedule} update={update} />;
  }

  return (
    <>
      <div className="schedule-grid">
        <ScheduleKind schedule={schedule} update={update} />
        <input
          type="text"
          className="mono"
          aria-label="Crontab schedule"
          placeholder="* * * * *"
          value={schedule.crontab}
          onChange={(event) =>
            update({ schedule: { type: "crontab", crontab: event.target.value } })
          }
        />
        <input
          type="text"
          aria-label="Timezone"
          list="timezones"
          value={config.timezone}
          onChange={(event) => update({ timezone: event.target.value })}
        />
      </div>
      <span className="mono muted small">&quot;{scheduleText(schedule)}&quot;</span>
    </>
  );
}

function NumberField(props: {
  label: string;
  help: string;
  placeholder: string;
  value: number;
  max: number;
  set: (value: number) => void;
}): JSX.Element {
  return (
    <Field label={props.label} help={props.help}>
      <WholeNumberInput
        label={props.label}
        min={1}
        max={props.max}
        placeholder={props.placeholder}
        value={props.value}
        set={props.set}
      />
    </Field>
  );
}

export function CronDetection(props: SectionProps<CronDraft> & { step: number }): JSX.Element {
  const [config, update] = useConfig(props);

  return (
    <FormSection step={props.step} title="Issue Detection">
      <Field label="Schedule" help="You can use the crontab syntax or our interval schedule.">
        <ScheduleFields {...props} />
      </Field>
      <datalist id="timezones">
        {Intl.supportedValuesOf("timeZone").map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>
      <hr />
      <h5>Set margins</h5>
      <NumberField
        label="Grace Period"
        help="Number of minutes before a check-in is considered missed."
        placeholder="Defaults to 1 minute"
        value={config.graceMinutes}
        max={40320}
        set={(graceMinutes) => update({ graceMinutes })}
      />
      <NumberField
        label="Max Runtime"
        help="Number of minutes before an in-progress check-in is marked timed out. The maximum is 10080 minutes (7 days)."
        placeholder="Defaults to 30 minutes"
        value={config.maxRuntimeMinutes}
        max={10080}
        set={(maxRuntimeMinutes) => update({ maxRuntimeMinutes })}
      />
      <hr />
      <h5>Set thresholds</h5>
      <NumberField
        label="Failure Tolerance"
        help="Create a new issue when this many consecutive missed or error check-ins are processed."
        placeholder="Defaults to 1"
        value={config.failureThreshold}
        max={720}
        set={(failureThreshold) => update({ failureThreshold })}
      />
    </FormSection>
  );
}

export function CronResolution(props: SectionProps<CronDraft> & { step: number }): JSX.Element {
  const [config, update] = useConfig(props);

  return (
    <FormSection step={props.step} title="Issue Resolution">
      <NumberField
        label="Recovery Tolerance"
        help="Resolve the issue when this many consecutive healthy check-ins are processed."
        placeholder="Defaults to 1"
        value={config.recoveryThreshold}
        max={720}
        set={(recoveryThreshold) => update({ recoveryThreshold })}
      />
    </FormSection>
  );
}

/** For a new cron: the SDK can create the monitor itself, as Sentry suggests first. */
export function Instrumentation(props: {
  slug: string;
  config: Config;
  dsn: DsnState;
  guided: boolean;
  setGuided: (guided: boolean) => void;
}): JSX.Element {
  return (
    <FormSection
      title="Select Instrumentation Method"
      description="You may not need to create your Cron Monitors here! Your SDK can create a cron monitor from its first check-in."
    >
      <div className="instrument-choice">
        <button
          type="button"
          className={props.guided ? "small primary" : "small"}
          onClick={() => props.setGuided(true)}
        >
          Auto-Instrument with an SDK
        </button>
        <span className="muted">or</span>
        <button
          type="button"
          className={props.guided ? "small" : "small primary"}
          onClick={() => props.setGuided(false)}
        >
          Manually Create a Monitor
        </button>
      </div>
      {props.guided && (
        <SdkGuide
          slug={props.slug === "" ? "<monitor-slug>" : props.slug}
          config={props.config}
          dsn={props.dsn}
        />
      )}
    </FormSection>
  );
}
