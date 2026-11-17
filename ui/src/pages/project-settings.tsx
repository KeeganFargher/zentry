// One project's settings: name, hourly quota, DSN keys and an SDK snippet.

import type { ApiKey, ApiProject } from "@contract";
import { useState } from "react";
import type { FormEvent, JSX } from "react";

import { Link, Notice } from "~/components/basics";
import { api } from "~/lib/api";
import { useResource } from "~/lib/resource";
import { navigate } from "~/lib/router";

type Props = { org: string; project: string };

type GeneralProps = Props & { current: ApiProject; onSaved: () => void };

function General({ org, project, current, onSaved }: GeneralProps): JSX.Element {
  const [name, setName] = useState(current.name);
  const [quota, setQuota] = useState(String(current.maxEventsPerHour ?? ""));

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();

    await api.updateProject(org, project, {
      name,
      maxEventsPerHour: quota.trim() === "" ? null : Number(quota),
    });

    onSaved();
  };

  return (
    <form className="panel padded" onSubmit={(event) => void save(event)}>
      <h2>General</h2>
      <div className="form-row">
        <label htmlFor="project-name">Name</label>
        <input
          id="project-name"
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="form-row">
        <label htmlFor="project-quota">Max events per hour</label>
        <input
          id="project-quota"
          type="number"
          min={0}
          placeholder="Unlimited"
          value={quota}
          onChange={(event) => setQuota(event.target.value)}
        />
      </div>
      <button type="submit" className="primary">
        Save
      </button>
    </form>
  );
}

type KeysProps = Props & { keys: ApiKey[]; onChanged: () => void };

function KeyRow({
  org,
  project,
  entry,
  onChanged,
}: Omit<KeysProps, "keys"> & { entry: ApiKey }): JSX.Element {
  const revoke = async (): Promise<void> => {
    if (window.confirm("Revoke this key? Apps using it will stop reporting within a minute.")) {
      await api.revokeKey(org, project, entry.id);
      onChanged();
    }
  };

  return (
    <div className="dsn">
      <strong>{entry.label}</strong>
      <code>{entry.dsn}</code>
      {entry.status === "active" ? (
        <>
          <button type="button" onClick={() => void navigator.clipboard.writeText(entry.dsn)}>
            Copy
          </button>
          <button type="button" className="danger" onClick={() => void revoke()}>
            Revoke
          </button>
        </>
      ) : (
        <span className="badge ignored">revoked</span>
      )}
    </div>
  );
}

function Keys({ org, project, keys, onChanged }: KeysProps): JSX.Element {
  const add = async (): Promise<void> => {
    await api.createKey(org, project, `Key ${keys.length + 1}`);
    onChanged();
  };

  return (
    <div className="panel padded">
      <h2>Client keys (DSN)</h2>
      {keys.map((entry) => (
        <KeyRow key={entry.id} org={org} project={project} entry={entry} onChanged={onChanged} />
      ))}
      <div style={{ marginTop: 10 }}>
        <button type="button" onClick={() => void add()}>
          New key
        </button>
      </div>
    </div>
  );
}

function snippet(platform: string | null, dsn: string): string {
  if (platform === "python") {
    return `import sentry_sdk\n\nsentry_sdk.init(dsn="${dsn}")`;
  }

  const sdk = platform === "node" ? "@sentry/node" : "@sentry/browser";

  return `import * as Sentry from "${sdk}";\n\nSentry.init({ dsn: "${dsn}" });`;
}

function Danger({ org, project }: Props): JSX.Element {
  const remove = async (): Promise<void> => {
    if (window.confirm(`Delete the project "${project}" with all of its issues and events?`)) {
      await api.deleteProject(org, project);
      navigate(`/${org}/projects/`);
    }
  };

  return (
    <div className="panel padded">
      <h2>Delete project</h2>
      <button type="button" className="danger" onClick={() => void remove()}>
        Delete this project
      </button>
    </div>
  );
}

export function ProjectSettings({ org, project }: Props): JSX.Element {
  const current = useResource(`project:${org}:${project}`, () => api.project(org, project));
  const keys = useResource(`keys:${org}:${project}`, () => api.keys(org, project));
  const active = keys.data?.find((entry) => entry.status === "active");

  if (current.data === null) {
    return <Notice loading={current.loading} error={current.error} />;
  }

  return (
    <>
      <header className="topbar">
        <Link to={`/${org}/projects/`}>Projects</Link>
        <span className="sep">/</span>
        <h1>{current.data.name}</h1>
        <span className="spacer" />
        <Link to={`/${org}/issues/?project=${current.data.id}`}>View issues</Link>
      </header>
      <div className="content narrow">
        <General org={org} project={project} current={current.data} onSaved={current.reload} />
        <Keys org={org} project={project} keys={keys.data ?? []} onChanged={keys.reload} />
        {active !== undefined && (
          <div className="panel padded">
            <h2>Send your first event</h2>
            <pre className="snippet">{snippet(current.data.platform, active.dsn)}</pre>
          </div>
        )}
        <Danger org={org} project={project} />
      </div>
    </>
  );
}
