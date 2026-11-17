// The one place the UI talks to the Worker. Responses are trusted to match
// the shared contract, which both sides compile against.

import type {
  ApiActivity,
  ApiEventDetail,
  ApiEventList,
  ApiIssue,
  ApiIssueList,
  ApiIssueStats,
  ApiKey,
  ApiMe,
  ApiProject,
  ApiTag,
  IssueStatus,
  Json,
} from "@contract";

export class ApiFailure extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
  }
}

async function failure(response: Response): Promise<ApiFailure> {
  const text = await response.text();
  const detail = /"detail"\s*:\s*"([^"]*)"/.exec(text)?.[1];

  return new ApiFailure(response.status, detail ?? `Request failed (${response.status})`);
}

async function send(method: string, path: string, body?: Json): Promise<Response> {
  const init: RequestInit = { method };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }

  const response = await fetch(`/api/0${path}`, init);

  if (!response.ok) {
    throw await failure(response);
  }

  return response;
}

async function read<T>(response: Response): Promise<T> {
  // SAFETY: the Worker builds every response from the same contract types.
  return (await response.json()) as T;
}

async function get<T>(path: string): Promise<T> {
  return read<T>(await send("GET", path));
}

export const eventJsonUrl = (org: string, issueId: string, eventId: string): string =>
  `/api/0/organizations/${org}/issues/${issueId}/events/${eventId}/`;

export const api = {
  me: (): Promise<ApiMe> => get("/me/"),

  projects: (org: string): Promise<ApiProject[]> => get(`/organizations/${org}/projects/`),

  project: (org: string, slug: string): Promise<ApiProject> => get(`/projects/${org}/${slug}/`),

  createProject: async (org: string, name: string, platform: string): Promise<ApiProject> =>
    read(await send("POST", `/organizations/${org}/projects/`, { name, platform })),

  updateProject: async (org: string, slug: string, changes: Json): Promise<ApiProject> =>
    read(await send("PUT", `/projects/${org}/${slug}/`, changes)),

  deleteProject: async (org: string, slug: string): Promise<void> => {
    await send("DELETE", `/projects/${org}/${slug}/`);
  },

  keys: (org: string, slug: string): Promise<ApiKey[]> => get(`/projects/${org}/${slug}/keys/`),

  createKey: async (org: string, slug: string, label: string): Promise<ApiKey[]> =>
    read(await send("POST", `/projects/${org}/${slug}/keys/`, { label })),

  revokeKey: async (org: string, slug: string, keyId: number): Promise<ApiKey> =>
    read(await send("PUT", `/projects/${org}/${slug}/keys/${keyId}/`, { status: "revoked" })),

  issues: (org: string, query: URLSearchParams): Promise<ApiIssueList> =>
    get(`/organizations/${org}/issues/?${query.toString()}`),

  issue: (org: string, issueId: string): Promise<ApiIssue> =>
    get(`/organizations/${org}/issues/${issueId}/`),

  setStatus: async (org: string, issueIds: number[], status: IssueStatus): Promise<void> => {
    const ids = issueIds.map((id) => `id=${id}`).join("&");

    await send("PUT", `/organizations/${org}/issues/?${ids}`, { status });
  },

  markSeen: async (org: string, issueId: string): Promise<void> => {
    await send("PUT", `/organizations/${org}/issues/${issueId}/`, { hasSeen: true });
  },

  deleteIssue: async (org: string, issueId: string): Promise<void> => {
    await send("DELETE", `/organizations/${org}/issues/${issueId}/`);
  },

  tags: (org: string, issueId: string): Promise<ApiTag[]> =>
    get(`/organizations/${org}/issues/${issueId}/tags/`),

  stats: (org: string, issueId: string): Promise<ApiIssueStats> =>
    get(`/organizations/${org}/issues/${issueId}/stats/?period=30d`),

  activity: (org: string, issueId: string): Promise<ApiActivity[]> =>
    get(`/organizations/${org}/issues/${issueId}/activity/`),

  events: (org: string, issueId: string, cursor: string | null): Promise<ApiEventList> =>
    get(
      `/organizations/${org}/issues/${issueId}/events/${cursor === null ? "" : `?cursor=${cursor}`}`,
    ),

  event: (org: string, issueId: string, which: string): Promise<ApiEventDetail> =>
    get(`/organizations/${org}/issues/${issueId}/events/${which}/`),
};
