import type { ApiMonitor, ApiProject, Json, MonitorPreview } from "@contract";
import { useState } from "react";
import type { FormEvent, JSX } from "react";

import { FIELDS } from "./monitor-fields";

type Props = {
  projects: ApiProject[];
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
    environment: field(data, "environment"),
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
    };

    const environment = field(data, "environment");

    const recovery = field(data, "recovery");

    return Object.assign(
      config,
      environment === "" ? {} : { environment },
      recovery === "" ? {} : { recoveryThreshold: Number(recovery) },
    );
  }

  if (type === "cron") {
    return cronSettings(data);
  }

  return {
    url: field(data, "url"),
    method: field(data, "method"),
    intervalMinutes: Number(field(data, "interval")),
    timeoutMs: Number(field(data, "timeout")),
    failureThreshold: Number(field(data, "failures")),
    recoveryThreshold: Number(field(data, "recoveries")),
  };
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

export function MonitorForm({ initial, projects, save, preview }: Props): JSX.Element {
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
      const body = {
        projectId: initial?.projectId ?? Number(field(data, "project")),
        name: field(data, "name"),
        type,
        config: signal(data, type),
        notify: data.has("notify"),
      };

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
      <label className="monitor-notify">
        <input name="notify" type="checkbox" defaultChecked={initial?.notify} /> Notify using
        project alert preferences
      </label>
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

function PreviewResult({ result }: { result: MonitorPreview }): JSX.Element {
  if (result.type === "cron") {
    return (
      <ol aria-label="Next scheduled runs">
        {result.occurrences.map((time) => (
          <li key={time}>{new Date(time).toLocaleString()}</li>
        ))}
      </ol>
    );
  }

  if (result.type === "metric") {
    return (
      <p>
        Processed errors in the window ending {new Date(result.windowEnd).toLocaleString()}:{" "}
        {result.count}
      </p>
    );
  }

  return (
    <p>
      Probe result: {result.outcome}{" "}
      {result.httpStatus !== undefined && `(HTTP ${result.httpStatus})`}
    </p>
  );
}
