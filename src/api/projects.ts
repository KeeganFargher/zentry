// Project and DSN key endpoints.

import type { KeyRecord, ProjectHour, ProjectRecord } from "@/db/projects";
import type { ApiKey, ApiProject, JsonObject } from "@/shared/contract";
import { newPublicKey, parseId } from "@/shared/ids";
import { getNonEmpty, getNumber, getString } from "@/shared/json";

import type { ApiContext, Handler } from "./context";
import { badRequest, isLocal, noContent, notFound, readObject } from "./http";
import { fillSeries, LAST_24_HOURS, windowStart } from "./series";

const SLUG = /^[a-z0-9][a-z0-9-]{0,49}$/;
const MAX_NAME = 100;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 50);
}

function toApiProject(project: ProjectRecord, hours: ProjectHour[], now: number): ApiProject {
  const samples = hours
    .values()
    .filter((hour) => hour.projectId === project.id)
    .map((hour) => ({ bucket: hour.bucket, count: hour.received }))
    .toArray();

  const stats = fillSeries(samples, { ...LAST_24_HOURS, now });

  return { ...project, stats, events24h: stats.reduce((sum, [, count]) => sum + count, 0) };
}

function dsn(context: ApiContext, projectId: number, publicKey: string): string {
  const { url, deps } = context;

  return isLocal(url)
    ? `${url.protocol}//${publicKey}@${url.host}/${projectId}`
    : `https://${publicKey}@${deps.ingestHost}/${projectId}`;
}

function toApiKey(context: ApiContext, projectId: number, key: KeyRecord): ApiKey {
  return { ...key, dsn: dsn(context, projectId, key.publicKey) };
}

async function projectOf(
  context: ApiContext,
  slug: string | undefined,
): Promise<ProjectRecord | null> {
  return context.deps.projects.findBySlug(context.organizationId, slug ?? "");
}

async function recentCounts(context: ApiContext): Promise<ProjectHour[]> {
  const since = windowStart({ ...LAST_24_HOURS, now: context.now });

  return context.deps.projects.hourlyCounts(context.organizationId, since);
}

export const listProjects: Handler = async (context) => {
  const [projects, hours] = await Promise.all([
    context.deps.projects.list(context.organizationId),
    recentCounts(context),
  ]);

  return Response.json(projects.map((project) => toApiProject(project, hours, context.now)));
};

export const createProject: Handler = async (context) => {
  const body = (await readObject(context.request)) ?? {};
  const name = (getNonEmpty(body, "name") ?? "").trim().slice(0, MAX_NAME);
  const slug = getNonEmpty(body, "slug") ?? slugify(name);

  if (name === "" || !SLUG.test(slug)) {
    return badRequest("a name is required, and the slug may use only a-z, 0-9 and dashes");
  }

  const created = await context.deps.projects.create({
    organizationId: context.organizationId,
    slug,
    name,
    platform: getNonEmpty(body, "platform"),
    publicKey: newPublicKey(),
    now: context.now,
  });

  return created === null
    ? badRequest(`a project with the slug "${slug}" already exists`)
    : Response.json(toApiProject(created, [], context.now), { status: 201 });
};

export const getProject: Handler = async (context, [slug]) => {
  const project = await projectOf(context, slug);

  return project === null
    ? notFound()
    : Response.json(toApiProject(project, await recentCounts(context), context.now));
};

/** `maxEventsPerHour`: a number sets the quota, null removes it, absent keeps it. */
function nextQuota(body: JsonObject, current: number | null): number | null {
  if (!("maxEventsPerHour" in body)) {
    return current;
  }

  const quota = getNumber(body, "maxEventsPerHour");

  return quota === null ? null : Math.max(0, Math.floor(quota));
}

export const updateProject: Handler = async (context, [slug]) => {
  const project = await projectOf(context, slug);
  const body = (await readObject(context.request)) ?? {};

  if (project === null) {
    return notFound();
  }

  const name = (getNonEmpty(body, "name") ?? project.name).trim().slice(0, MAX_NAME);
  const maxEventsPerHour = nextQuota(body, project.maxEventsPerHour);

  await context.deps.projects.update(project.id, { name, maxEventsPerHour });

  return Response.json(
    toApiProject({ ...project, name, maxEventsPerHour }, await recentCounts(context), context.now),
  );
};

export const deleteProject: Handler = async (context, [slug]) => {
  const project = await projectOf(context, slug);

  if (project === null) {
    return notFound();
  }

  await context.deps.projects.delete(project.id);

  return noContent();
};

export const listKeys: Handler = async (context, [slug]) => {
  const project = await projectOf(context, slug);

  if (project === null) {
    return notFound();
  }

  const keys = await context.deps.projects.listKeys(project.id);

  return Response.json(keys.map((key) => toApiKey(context, project.id, key)));
};

export const createKey: Handler = async (context, [slug]) => {
  const project = await projectOf(context, slug);
  const body = (await readObject(context.request)) ?? {};

  if (project === null) {
    return notFound();
  }

  await context.deps.projects.createKey({
    projectId: project.id,
    label: (getNonEmpty(body, "label") ?? "Default").slice(0, MAX_NAME),
    publicKey: newPublicKey(),
    now: context.now,
  });

  const keys = await context.deps.projects.listKeys(project.id);

  return Response.json(
    keys.map((key) => toApiKey(context, project.id, key)),
    { status: 201 },
  );
};

function nextKeyStatus(
  requested: string | null,
  current: KeyRecord["status"],
): KeyRecord["status"] {
  if (requested === "revoked" || requested === "active") {
    return requested;
  }

  return current;
}

export const updateKey: Handler = async (context, [slug, keyIdText]) => {
  const project = await projectOf(context, slug);
  const keyId = parseId(keyIdText ?? "");
  const body = (await readObject(context.request)) ?? {};
  const keys = project === null ? [] : await context.deps.projects.listKeys(project.id);
  const key = keys.find((candidate) => candidate.id === keyId);

  if (project === null || key === undefined) {
    return notFound();
  }

  const label = (getNonEmpty(body, "label") ?? key.label).slice(0, MAX_NAME);
  const status = nextKeyStatus(getString(body, "status"), key.status);

  await context.deps.projects.updateKey({ projectId: project.id, keyId: key.id, label, status });

  return Response.json(toApiKey(context, project.id, { ...key, label, status }));
};
