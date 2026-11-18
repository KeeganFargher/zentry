// The one place the UI talks to the Worker. Responses are trusted to match
// the shared contract, which both sides compile against.

import type {
  ApiActivity,
  ApiDeviceList,
  ApiEventDetail,
  ApiEventList,
  ApiIssue,
  ApiIssueList,
  ApiIssueSubscription,
  ApiIssueStats,
  ApiKey,
  ApiMonitor,
  ApiMe,
  ApiNotificationSettings,
  ApiOrganizationLimits,
  ApiPairing,
  ApiProject,
  ApiTag,
  IssueStatus,
  Json,
  MonitorDetail,
  MonitorPreview,
  NotificationProvider,
  NotificationScope,
  NotificationType,
} from "@contract";

export type NotificationChange = {
  provider: NotificationProvider;
  type: NotificationType;
  scope: NotificationScope;
  scopeId: number;
  /** Null removes the row, so the next scope out decides. */
  value: string | null;
};

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

async function send(method: string, path: string): Promise<Response> {
  return request(path, { method });
}

async function sendJson(method: string, path: string, body: Json): Promise<Response> {
  return request(path, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

async function request(path: string, init: RequestInit): Promise<Response> {
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

  createPairing: async (): Promise<ApiPairing> => read(await send("POST", "/me/pairings/")),

  devices: (): Promise<ApiDeviceList> => get("/me/devices/"),

  removeDevice: async (deviceId: number): Promise<void> => {
    await send("DELETE", `/me/devices/${deviceId}/`);
  },

  limits: (org: string): Promise<ApiOrganizationLimits> => get(`/organizations/${org}/limits/`),

  updateLimits: async (org: string, maxEventsPerMonth: number): Promise<ApiOrganizationLimits> =>
    read(await sendJson("PUT", `/organizations/${org}/limits/`, { maxEventsPerMonth })),

  notifications: (org: string): Promise<ApiNotificationSettings> =>
    get(`/organizations/${org}/notifications/`),

  updateNotification: async (
    org: string,
    change: NotificationChange,
  ): Promise<ApiNotificationSettings> =>
    read(await sendJson("PUT", `/organizations/${org}/notifications/`, change)),

  subscription: (org: string, issueId: string): Promise<ApiIssueSubscription> =>
    get(`/organizations/${org}/issues/${issueId}/subscription/`),

  setSubscription: async (
    org: string,
    issueId: string,
    subscribed: boolean,
  ): Promise<ApiIssueSubscription> =>
    read(
      await sendJson("PUT", `/organizations/${org}/issues/${issueId}/subscription/`, {
        subscribed,
      }),
    ),

  previewMonitor: async (org: string, body: Json): Promise<MonitorPreview> =>
    read(await sendJson("POST", `/organizations/${org}/monitor-previews/`, body)),
  monitors: (org: string): Promise<ApiMonitor[]> => get(`/organizations/${org}/monitors/`),
  monitor: (org: string, id: string): Promise<MonitorDetail> =>
    get(`/organizations/${org}/monitors/${id}/`),
  createMonitor: async (org: string, body: Json): Promise<ApiMonitor> =>
    read(await sendJson("POST", `/organizations/${org}/monitors/`, body)),
  editMonitor: async (org: string, monitor: ApiMonitor, body: Json): Promise<ApiMonitor> =>
    read(
      await sendJson("PUT", `/organizations/${org}/monitors/${monitor.id}/`, {
        version: monitor.version,
        monitor: body,
      }),
    ),
  setMonitorStatus: async (
    org: string,
    monitor: ApiMonitor,
    status: ApiMonitor["status"],
  ): Promise<ApiMonitor> =>
    read(
      await sendJson("PUT", `/organizations/${org}/monitors/${monitor.id}/status/`, {
        version: monitor.version,
        status,
      }),
    ),
  projects: (org: string): Promise<ApiProject[]> => get(`/organizations/${org}/projects/`),

  project: (org: string, slug: string): Promise<ApiProject> => get(`/projects/${org}/${slug}/`),

  createProject: async (org: string, name: string, platform: string): Promise<ApiProject> =>
    read(await sendJson("POST", `/organizations/${org}/projects/`, { name, platform })),

  updateProject: async (org: string, slug: string, changes: Json): Promise<ApiProject> =>
    read(await sendJson("PUT", `/projects/${org}/${slug}/`, changes)),

  deleteProject: async (org: string, slug: string): Promise<void> => {
    await send("DELETE", `/projects/${org}/${slug}/`);
  },

  keys: (org: string, slug: string): Promise<ApiKey[]> => get(`/projects/${org}/${slug}/keys/`),

  createKey: async (org: string, slug: string, label: string): Promise<ApiKey[]> =>
    read(await sendJson("POST", `/projects/${org}/${slug}/keys/`, { label })),

  revokeKey: async (org: string, slug: string, keyId: number): Promise<ApiKey> =>
    read(await sendJson("PUT", `/projects/${org}/${slug}/keys/${keyId}/`, { status: "revoked" })),

  issues: (org: string, query: URLSearchParams): Promise<ApiIssueList> =>
    get(`/organizations/${org}/issues/?${query.toString()}`),

  issue: (org: string, issueId: string): Promise<ApiIssue> =>
    get(`/organizations/${org}/issues/${issueId}/`),

  setStatus: async (org: string, issueIds: number[], status: IssueStatus): Promise<void> => {
    const ids = issueIds.map((id) => `id=${id}`).join("&");

    await sendJson("PUT", `/organizations/${org}/issues/?${ids}`, { status });
  },

  markSeen: async (org: string, issueId: string): Promise<void> => {
    await sendJson("PUT", `/organizations/${org}/issues/${issueId}/`, { hasSeen: true });
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

  events: (org: string, issueId: string): Promise<ApiEventList> =>
    get(`/organizations/${org}/issues/${issueId}/events/`),

  eventsAfter: (org: string, issueId: string, cursor: string): Promise<ApiEventList> =>
    get(`/organizations/${org}/issues/${issueId}/events/?cursor=${cursor}`),

  event: (org: string, issueId: string, which: string): Promise<ApiEventDetail> =>
    get(`/organizations/${org}/issues/${issueId}/events/${which}/`),
};
