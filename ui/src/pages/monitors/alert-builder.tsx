// The alert form's Alert Builder section, as Sentry's automation builder:
// one WHEN / IF / THEN block, then the action throttle and the enabled switch.

import type { ApiMonitorRule } from "@contract";
import type { JSX } from "react";

import { Icon } from "~/components/icons";

import { FormSection } from "./parts";
import type { MonitorContext } from "./parts";

export type Draft = Omit<ApiMonitorRule, "id" | "version" | "lastTriggered">;

type DraftProps = { draft: Draft; set: (draft: Draft) => void };

const TRIGGERS: [ApiMonitorRule["triggers"][number], string][] = [
  ["failure", "A new issue is created, or a resolved issue regresses"],
  ["recovery", "An issue is resolved"],
  ["escalation", "An issue escalates"],
];

const THROTTLES: [seconds: number, label: string][] = [
  [0, "Get notified on every trigger"],
  [300, "Once every 5 minutes"],
  [1800, "Once every 30 minutes"],
  [3600, "Once every hour"],
  [86_400, "Once every day"],
];

const CHANNELS: ApiMonitorRule["channels"] = ["email", "push"];

function toggled<T>(list: T[], value: T, on: boolean): T[] {
  return on ? [...list, value] : list.filter((entry) => entry !== value);
}

function Triggers({ draft, set }: DraftProps): JSX.Element {
  return (
    <>
      <div>
        <span className="keyword">WHEN</span> <strong>any</strong> of the following occur
      </div>
      {TRIGGERS.map(([trigger, label]) => (
        <label key={trigger} className="builder-row">
          <input
            type="checkbox"
            checked={draft.triggers.includes(trigger)}
            onChange={(event) =>
              set({ ...draft, triggers: toggled(draft.triggers, trigger, event.target.checked) })
            }
          />
          {label}
        </label>
      ))}
    </>
  );
}

function Filters({ draft, set }: DraftProps): JSX.Element {
  return (
    <>
      <div>
        <span className="keyword">IF</span> these filters match
      </div>
      <select
        className="builder-select"
        value={draft.priority ?? ""}
        onChange={(event) =>
          set({ ...draft, priority: event.target.value === "high" ? "high" : undefined })
        }
      >
        <option value="">Any issue</option>
        <option value="high">The issue is high priority</option>
      </select>
    </>
  );
}

/** A select value for the audience: one named member is "member:<id>". */
function audienceValue(audience: Draft["audience"]): string {
  return audience.kind === "members" ? `member:${audience.userIds[0] ?? ""}` : audience.kind;
}

function audienceOf(value: string): Draft["audience"] {
  if (value.startsWith("member:")) {
    return { kind: "members", userIds: [Number(value.slice("member:".length))] };
  }

  return { kind: value === "project" ? "project" : "owner" };
}

function Actions({ draft, set, context }: DraftProps & { context: MonitorContext }): JSX.Element {
  return (
    <>
      <div>
        <span className="keyword">THEN</span> perform these actions
      </div>
      <div className="builder-row">
        {CHANNELS.map((channel) => (
          <label key={channel} className="check-label">
            <input
              type="checkbox"
              checked={draft.channels.includes(channel)}
              onChange={(event) =>
                set({ ...draft, channels: toggled(draft.channels, channel, event.target.checked) })
              }
            />
            <Icon name={channel === "email" ? "mail" : "mobile"} size={14} />{" "}
            {channel === "email" ? "Send an email" : "Send a mobile push"}
          </label>
        ))}
        <select
          aria-label="Recipients"
          value={audienceValue(draft.audience)}
          onChange={(event) => set({ ...draft, audience: audienceOf(event.target.value) })}
        >
          <option value="owner">to the monitor&apos;s assignee</option>
          <option value="project">to members following the project</option>
          {context.members.map((member) => (
            <option key={member.userId} value={`member:${member.userId}`}>
              to {member.email}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}

export function Builder({
  draft,
  set,
  context,
}: DraftProps & { context: MonitorContext }): JSX.Element {
  return (
    <FormSection title="Alert Builder">
      <div className="builder-block">
        <Triggers draft={draft} set={set} />
        <Filters draft={draft} set={set} />
        <Actions draft={draft} set={set} context={context} />
      </div>
      <label className="form-field-inline">
        Action Throttle
        <select
          value={draft.throttleSeconds}
          onChange={(event) => set({ ...draft, throttleSeconds: Number(event.target.value) })}
        >
          {THROTTLES.map(([seconds, label]) => (
            <option key={seconds} value={seconds}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="check-label">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => set({ ...draft, enabled: event.target.checked })}
        />{" "}
        Enabled
      </label>
    </FormSection>
  );
}
