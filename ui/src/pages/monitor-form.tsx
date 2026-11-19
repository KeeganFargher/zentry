import type {
  ApiMonitor,
  ApiMonitorRule,
  ApiProject,
  Json,
  MonitorMember,
  MonitorPreview,
} from "@contract";
import { useState } from "react";
import type { FormEvent, JSX } from "react";

import { FIELDS } from "./monitor-fields";
import { PreviewResult } from "./monitor-preview";

type Props = {
  projects: ApiProject[];
  rules: ApiMonitorRule[];
  members: MonitorMember[];
  save: (data: Json) => Promise<void>;
  preview: (data: Json) => Promise<MonitorPreview>;
  initial?: ApiMonitor | undefined;
};

function field(data: FormData, name: string): string {
  const value = data.get(name);

  return value === null || value instanceof File ? "" : value.trim();
}

function cronSettings(data: FormData): Json {
  const expression = field(data, "expression");

  const scope = {
    slug: field(data, "slug"),
    environments: field(data, "environments")
      .split(",")
      .map((name) => name.trim()),
    graceMinutes: Number(field(data, "grace")),
    failureThreshold: Number(field(data, "failures")),
    recoveryThreshold: Number(field(data, "recoveries")),
    maxRuntimeMinutes: Number(field(data, "runtime")),
  };

  return expression === ""
    ? { ...scope, intervalMinutes: Number(field(data, "interval")) }
    : { ...scope, expression, timezone: field(data, "timezone") };
}

function signal(data: FormData, type: ApiMonitor["type"]): Json {
  if (type === "metric") {
    const config = {
      windowSeconds: Number(field(data, "window")),
      threshold: Number(field(data, "threshold")),
      comparator: field(data, "comparator"),
    };

    const environment = field(data, "environment");

    const recovery = field(data, "recovery");
    const warning = field(data, "warning");
    const level = field(data, "level");

    return Object.assign(
      config,
      environment === "" ? {} : { environment },
      recovery === "" ? {} : { recoveryThreshold: Number(recovery) },
      warning === "" ? {} : { warningThreshold: Number(warning) },
      level === "" ? {} : { level },
    );
  }

  if (type === "cron") {
    return cronSettings(data);
  }

  const statuses = field(data, "success-codes");
  const environment = field(data, "environment");

  return Object.assign(
    {
      url: field(data, "url"),
      method: field(data, "method"),
      intervalMinutes: Number(field(data, "interval")),
      timeoutMs: Number(field(data, "timeout")),
      failureThreshold: Number(field(data, "failures")),
      recoveryThreshold: Number(field(data, "recoveries")),
    },
    statuses === "" ? {} : { successCodes: statuses.split(",").map(Number) },
    environment === "" ? {} : { environment },
  );
}

type CommonProps = Pick<Props, "initial" | "projects"> & {
  type: ApiMonitor["type"];
  changeType: (type: ApiMonitor["type"]) => void;
};

function CommonFields({ initial, projects, type, changeType }: CommonProps): JSX.Element {
  return (
    <>
      <label>
        Project
        <select
          name="project"
          required
          defaultValue={initial?.projectId}
          disabled={initial !== undefined}
        >
          <option value="">Select a project</option>
          {projects.map(({ id, name }) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Monitor type
        <select
          value={type}
          disabled={initial !== undefined}
          onChange={({ currentTarget }) => {
            const next = currentTarget.value;

            if (next === "metric" || next === "cron" || next === "uptime") {
              changeType(next);
            }
          }}
        >
          <option value="metric">Metric</option>
          <option value="cron">Cron</option>
          <option value="uptime">Uptime</option>
        </select>
      </label>
      <label>
        Monitor name <input name="name" maxLength={100} required defaultValue={initial?.name} />
      </label>
    </>
  );
}

function RoutingFields({
  initial,
  rules,
  members,
}: Pick<Props, "initial" | "rules" | "members">): JSX.Element {
  return (
    <div className="monitor-form-fields">
      <label>
        Description{" "}
        <textarea name="description" maxLength={2000} defaultValue={initial?.description} />
      </label>
      <label>
        Monitor owner
        <select name="owner" aria-label="Monitor owner" defaultValue={initial?.ownerId ?? ""}>
          <option value="">Unassigned</option>
          {members.map(({ userId, email }) => (
            <option key={userId} value={userId}>
              {email}
            </option>
          ))}
        </select>
      </label>
      <label>
        Linked alert rules
        <select
          name="rules"
          aria-label="Linked alert rules"
          multiple
          defaultValue={initial?.alertRuleIds ?? []}
        >
          {rules.map(({ id, name }) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <input name="notify" type="checkbox" defaultChecked={initial?.notify ?? true} /> Enable
        linked alerts
      </label>
    </div>
  );
}

function monitorBody(data: FormData, type: ApiMonitor["type"], projectId: number) {
  return {
    projectId: projectId,
    name: field(data, "name"),
    type,
    config: signal(data, type),
    notify: data.has("notify"),
    description: field(data, "description"),
    ownerId: Number(field(data, "owner")) || null,
    alertRuleIds: data.getAll("rules").flatMap((value) => (value instanceof File ? [] : [value])),
  };
}

export function MonitorForm({
  initial,
  projects,
  rules,
  members,
  save,
  preview,
}: Props): JSX.Element {
  const [type, setType] = useState<ApiMonitor["type"]>(initial?.type ?? "metric");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const Fields = FIELDS[type];
  const [result, setResult] = useState<MonitorPreview | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);

    try {
      const body = monitorBody(data, type, initial?.projectId ?? Number(field(data, "project")));

      const submitter = event.nativeEvent;

      if (
        submitter instanceof SubmitEvent &&
        submitter.submitter?.getAttribute("name") === "preview"
      ) {
        setResult(await preview(body));

        return;
      }

      await save(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save monitor");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel padded monitor-form" onSubmit={(event) => void submit(event)}>
      <h2>{initial === undefined ? "New monitor" : "Edit settings"}</h2>
      <div className="monitor-form-fields">
        <CommonFields initial={initial} projects={projects} type={type} changeType={setType} />
        <Fields initial={initial} />
      </div>
      <RoutingFields initial={initial} members={members} rules={rules} />
      {error !== "" && (
        <p className="notice failed" role="alert">
          {error}
        </p>
      )}
      {result !== null && <PreviewResult result={result} />}
      <button type="submit" name="preview" disabled={busy}>
        Preview
      </button>
      <button type="submit" className="primary" disabled={busy}>
        {initial === undefined ? "Create monitor" : "Save settings"}
      </button>
    </form>
  );
}
