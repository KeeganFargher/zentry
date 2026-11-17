// Project and DSN key endpoints.

import { z } from "zod";

import type { KeyRecord, ProjectHour, ProjectRecord } from "@/db/projects";
import type { ApiKey, ApiProject } from "@/shared/contract";
import { newPublicKey } from "@/shared/ids";

import type { ApiContext, Handler } from "./context";
import { badRequest, IdParam, isLocal, noContent, notFound, readBody, readParams } from "./http";
import { fillSeries, LAST_24_HOURS, windowStart } from "./series";

const SLUG = /^[a-z0-9][a-z0-9-]{0,49}$/;
const SLUG_RULE = "a slug may use only a-z, 0-9 and dashes, and start with a letter or digit";

const Name = z.string().trim().min(1).max(100);

const CreateProjectBody = z.object({
  name: Name,
  slug: z.string().regex(SLUG, SLUG_RULE).optional(),
  platform: z.string().min(1).nullable().default(null),
});

/** Absent fields keep their value. `maxEventsPerHour: null` removes the quota. */
const UpdateProjectBody = z.object({
  name: Name.optional(),
  maxEventsPerHour: z.int().min(0).nullable().optional(),
});

const CreateKeyBody = z.object({ label: Name.default("Default") });

const UpdateKeyBody = z.object({
  label: Name.optional(),
  status: z.enum(["active", "revoked"]).optional(),
});

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

// Every project route starts with the slug; the key routes add a key id.
const ProjectParams = z.tuple([z.string()], z.string());

/** The project named by the route's first parameter. */
async function projectOf(context: ApiContext, args: string[]): Promise<ProjectRecord | null> {
  const [slug] = readParams(args, ProjectParams);

  return context.deps.projects.findBySlug(context.organizationId, slug);
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
  const { name, slug: requested, platform } = await readBody(context.request, CreateProjectBody);
  const slug = requested ?? slugify(name);

  // A name can be valid yet have no letters or digits to make a slug from.
  if (!SLUG.test(slug)) {
    return badRequest(`could not make a slug from this name; ${SLUG_RULE}`);
  }

  const created = await context.deps.projects.create({
    organizationId: context.organizationId,
    slug,
    name,
    platform,
    publicKey: newPublicKey(),
    now: context.now,
  });

  return created === null
    ? badRequest(`a project with the slug "${slug}" already exists`)
    : Response.json(toApiProject(created, [], context.now), { status: 201 });
};

export const getProject: Handler = async (context, args) => {
  const project = await projectOf(context, args);

  return project === null
    ? notFound()
    : Response.json(toApiProject(project, await recentCounts(context), context.now));
};

export const updateProject: Handler = async (context, args) => {
  const project = await projectOf(context, args);

  if (project === null) {
    return notFound();
  }

  const body = await readBody(context.request, UpdateProjectBody);
  const name = body.name ?? project.name;

  const maxEventsPerHour =
    body.maxEventsPerHour === undefined ? project.maxEventsPerHour : body.maxEventsPerHour;

  await context.deps.projects.update(project.id, { name, maxEventsPerHour });

  return Response.json(
    toApiProject({ ...project, name, maxEventsPerHour }, await recentCounts(context), context.now),
  );
};

export const deleteProject: Handler = async (context, args) => {
  const project = await projectOf(context, args);

  if (project === null) {
    return notFound();
  }

  await context.deps.projects.delete(project.id);

  return noContent();
};

export const listKeys: Handler = async (context, args) => {
  const project = await projectOf(context, args);

  if (project === null) {
    return notFound();
  }

  const keys = await context.deps.projects.listKeys(project.id);

  return Response.json(keys.map((key) => toApiKey(context, project.id, key)));
};

export const createKey: Handler = async (context, args) => {
  const project = await projectOf(context, args);

  if (project === null) {
    return notFound();
  }

  const { label } = await readBody(context.request, CreateKeyBody);

  await context.deps.projects.createKey({
    projectId: project.id,
    label,
    publicKey: newPublicKey(),
    now: context.now,
  });

  const keys = await context.deps.projects.listKeys(project.id);

  return Response.json(
    keys.map((key) => toApiKey(context, project.id, key)),
    { status: 201 },
  );
};

export const updateKey: Handler = async (context, args) => {
  const [, keyId] = readParams(args, z.tuple([z.string(), IdParam]));
  const project = await projectOf(context, args);
  const keys = project === null ? [] : await context.deps.projects.listKeys(project.id);
  const key = keys.find((candidate) => candidate.id === keyId);

  if (project === null || key === undefined) {
    return notFound();
  }

  const body = await readBody(context.request, UpdateKeyBody);
  const label = body.label ?? key.label;
  const status = body.status ?? key.status;

  await context.deps.projects.updateKey({ projectId: project.id, keyId: key.id, label, status });

  return Response.json(toApiKey(context, project.id, { ...key, label, status }));
};
