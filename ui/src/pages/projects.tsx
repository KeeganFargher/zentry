// Project cards with 24-hour charts, and the new-project form.

import type { ApiProject } from "@contract";
import { useState } from "react";
import type { FormEvent, JSX } from "react";

import { Link, Notice } from "~/components/basics";
import { BarChart } from "~/components/chart";
import { api } from "~/lib/api";
import { compact } from "~/lib/format";
import { useResource } from "~/lib/resource";
import { navigate } from "~/lib/router";

const PLATFORMS = ["javascript", "node", "python", "php", "ruby", "go", "java", "other"];

function ProjectCard({ org, project }: { org: string; project: ApiProject }): JSX.Element {
  return (
    <div className="panel padded">
      <div className="card-title">
        <strong>
          <Link to={`/${org}/issues/?project=${project.id}`}>{project.name}</Link>
        </strong>
        <Link to={`/${org}/settings/projects/${project.slug}/`}>Settings</Link>
      </div>
      <BarChart points={project.stats} height={40} />
      <div className="muted small" style={{ marginTop: 8 }}>
        {compact(project.events24h)} events in 24 hours · {project.platform ?? "no platform"}
        {project.firstEventAt === null && " · waiting for first event"}
      </div>
    </div>
  );
}

function NewProject({ org }: { org: string }): JSX.Element {
  const [name, setName] = useState("");
  const [platform, setPlatform] = useState("javascript");
  const [error, setError] = useState<string | null>(null);

  const create = async (event: FormEvent): Promise<void> => {
    event.preventDefault();

    try {
      const project = await api.createProject(org, name, platform);

      navigate(`/${org}/settings/projects/${project.slug}/`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the project");
    }
  };

  return (
    <form className="panel padded" onSubmit={(event) => void create(event)}>
      <h2>New project</h2>
      <div className="form-row">
        <input
          type="text"
          placeholder="Name, for example API"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <select
          aria-label="Platform"
          value={platform}
          onChange={(event) => setPlatform(event.target.value)}
        >
          {PLATFORMS.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
        <button type="submit" className="primary" disabled={name.trim() === ""}>
          Create project
        </button>
      </div>
      {error !== null && <div className="notice failed">{error}</div>}
    </form>
  );
}

export function Projects({ org }: { org: string }): JSX.Element {
  const projects = useResource(`projects:${org}`, () => api.projects(org));
  const list = projects.data ?? [];

  return (
    <>
      <header className="topbar">
        <h1>Projects</h1>
      </header>
      <div className="content">
        <div className="cards">
          {list.map((project) => (
            <ProjectCard key={project.id} org={org} project={project} />
          ))}
        </div>
        <Notice
          loading={projects.loading}
          error={projects.error}
          empty={list.length === 0 ? "No projects yet. Create one below to get a DSN." : null}
        />
        <NewProject org={org} />
      </div>
    </>
  );
}
