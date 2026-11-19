import type { ApiMonitorRule, Json, MonitorMember } from "@contract";
import { useState } from "react";
import type { FormEvent, JSX } from "react";

type Props = {
  members: MonitorMember[];
  rule?: ApiMonitorRule;
  save: (body: Json) => Promise<void>;
};

function selected(data: FormData, key: string): string[] {
  return data.getAll(key).flatMap((value) => (value instanceof File ? [] : [value]));
}

function ruleBody(data: FormData): Json {
  const audience = data.get("audience");
  const environment = selected(data, "environment")[0]?.trim();

  const base = {
    name: selected(data, "rule-name")[0] ?? "",
    throttleSeconds: Number(selected(data, "throttle")[0]),
    channels: selected(data, "channels"),
    triggers: selected(data, "triggers"),
    enabled: data.has("enabled"),
  };

  return Object.assign(
    base,
    {
      audience:
        audience === "members"
          ? { kind: "members", userIds: selected(data, "recipients").map(Number) }
          : { kind: audience === "owner" ? "owner" : "project" },
    },
    environment && environment !== "" ? { environment } : {},
    data.has("high-only") ? { priority: "high" } : {},
  );
}

function Destinations({ members, rule }: Pick<Props, "members" | "rule">): JSX.Element {
  const [audience, setAudience] = useState(rule?.audience.kind ?? "project");

  return (
    <>
      <label>
        Recipients
        <select
          name="audience"
          value={audience}
          onChange={(event) => {
            const next = event.currentTarget.value;

            if (next === "project" || next === "owner" || next === "members") {
              setAudience(next);
            }
          }}
        >
          <option value="project">Project subscribers</option>
          <option value="owner">Monitor owner</option>
          <option value="members">Selected members</option>
        </select>
      </label>
      {audience === "members" && (
        <label>
          Selected members
          <select
            name="recipients"
            multiple
            required
            defaultValue={
              rule?.audience.kind === "members" ? rule.audience.userIds.map(String) : []
            }
          >
            {members.map(({ userId, email }) => (
              <option key={userId} value={userId}>
                {email}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  );
}

function RuleConditions({ rule }: { rule: ApiMonitorRule | undefined }): JSX.Element {
  return (
    <>
      <label>
        Throttle (seconds)
        <input
          type="number"
          name="throttle"
          min="0"
          max="86400"
          defaultValue={rule?.throttleSeconds ?? 300}
          required
        />
      </label>
      <label>
        Environment filter <input name="environment" defaultValue={rule?.environment} />
      </label>
      <label>
        <input type="checkbox" name="high-only" defaultChecked={rule?.priority === "high"} /> High
        priority only
      </label>
      <label>
        <input type="checkbox" name="enabled" defaultChecked={rule?.enabled ?? true} /> Rule enabled
      </label>
    </>
  );
}

function RuleChannels({ channels }: { channels: ApiMonitorRule["channels"] }): JSX.Element {
  return (
    <fieldset>
      <legend>Channels</legend>
      <label>
        <input
          type="checkbox"
          name="channels"
          value="email"
          defaultChecked={channels.includes("email")}
        />{" "}
        Email
      </label>
      <label>
        <input
          type="checkbox"
          name="channels"
          value="push"
          defaultChecked={channels.includes("push")}
        />{" "}
        Push
      </label>
    </fieldset>
  );
}

function RuleTransitions({ triggers }: { triggers: ApiMonitorRule["triggers"] }): JSX.Element {
  return (
    <fieldset>
      <legend>Transitions</legend>
      <label>
        <input
          type="checkbox"
          name="triggers"
          value="failure"
          defaultChecked={triggers.includes("failure")}
        />{" "}
        Failure
      </label>
      <label>
        <input
          type="checkbox"
          name="triggers"
          value="escalation"
          defaultChecked={triggers.includes("escalation")}
        />{" "}
        Escalation
      </label>
      <label>
        <input
          type="checkbox"
          name="triggers"
          value="recovery"
          defaultChecked={triggers.includes("recovery")}
        />{" "}
        Recovery
      </label>
    </fieldset>
  );
}

export function MonitorRuleForm({ members, rule, save }: Props): JSX.Element {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError("");

    try {
      await save(ruleBody(new FormData(event.currentTarget)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save rule");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="monitor-form" onSubmit={(event) => void submit(event)}>
      <div className="monitor-form-fields">
        <label>
          Rule name <input name="rule-name" defaultValue={rule?.name} required />
        </label>
        <Destinations members={members} {...(rule === undefined ? {} : { rule })} />
        <RuleChannels channels={rule?.channels ?? ["email"]} />
        <RuleTransitions triggers={rule?.triggers ?? ["failure", "escalation"]} />
        <RuleConditions rule={rule} />
      </div>
      {error !== "" && <p role="alert">{error}</p>}
      <button className="primary" type="submit" disabled={busy}>
        {rule === undefined ? "Create alert rule" : "Save alert rule"}
      </button>
    </form>
  );
}
