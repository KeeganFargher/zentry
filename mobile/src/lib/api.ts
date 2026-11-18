// The one place the app talks to the Worker. Every call carries the device
// token from pairing; responses are trusted to match the shared contract,
// which both sides compile against (src/shared/contract.ts).

import type {
  ApiActivity,
  ApiEventDetail,
  ApiEventList,
  ApiIssue,
  ApiIssueList,
  ApiIssueStats,
  ApiIssueSubscription,
  ApiMe,
  ApiNotificationSettings,
  ApiPaired,
  ApiProject,
  ApiTag,
  IssueStatus,
  Json,
  NotificationProvider,
  NotificationScope,
  NotificationType,
  NotificationValue,
} from "@contract";

export type NotificationChange = {
  provider: NotificationProvider;
  type: NotificationType;
  scope: NotificationScope;
  scopeId: number;
  /** Null removes the row, so the next scope out decides. */
  value: NotificationValue | null;
};

export type StatsPeriod = "24h" | "14d" | "30d";

export class ApiFailure extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
  }
}

/** Where the app calls and who it is: what pairing gave it. */
export type Credentials = { apiUrl: string; token: string };

async function failure(response: Response): Promise<ApiFailure> {
  const text = await response.text();
  const detail = /"detail"\s*:\s*"([^"]*)"/.exec(text)?.[1];

  return new ApiFailure(response.status, detail ?? `Request failed (${response.status})`);
}

async function read<T>(response: Response): Promise<T> {
  // SAFETY: the Worker builds every response from the same contract types.
  return (await response.json()) as T;
}

/** A reachable server that did not answer is a different problem from no network at all. */
async function reach(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (cause) {
    // Keep Android's own reason: "CLEARTEXT communication not permitted" is
    // not a connection problem, and saying so would send the user astray.
    const reason = cause instanceof Error ? cause.message : String(cause);

    throw new ApiFailure(0, `Could not reach ${new URL(url).host}: ${reason}`);
  }
}

/** Trades a pairing code from the web UI's QR code for this phone's device token. */
export async function pair(apiUrl: string, code: string, name: string): Promise<ApiPaired> {
  const response = await reach(`${apiUrl}/api/0/pair/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name }),
  });

  if (!response.ok) {
    throw await failure(response);
  }

  return read<ApiPaired>(response);
}

export class Api {
  readonly #credentials: Credentials;
  readonly #onSignedOut: () => void;

  /** `onSignedOut` runs when the server no longer knows the token: the phone was signed out. */
  constructor(credentials: Credentials, onSignedOut: () => void) {
    this.#credentials = credentials;
    this.#onSignedOut = onSignedOut;
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);

    headers.set("authorization", `Bearer ${this.#credentials.token}`);

    const response = await reach(`${this.#credentials.apiUrl}/api/0${path}`, { ...init, headers });

    if (response.status === 401) {
      this.#onSignedOut();
    }

    if (!response.ok) {
      throw await failure(response);
    }

    return response;
  }

  #json(method: string, path: string, body: Json): Promise<Response> {
    return this.#request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async #get<T>(path: string): Promise<T> {
    return read<T>(await this.#request(path, { method: "GET" }));
  }

  async #send<T>(method: string, path: string, body: Json): Promise<T> {
    return read<T>(await this.#json(method, path, body));
  }

  async #run(method: string, path: string, body: Json): Promise<void> {
    await this.#json(method, path, body);
  }

  me(): Promise<ApiMe> {
    return this.#get("/me/");
  }

  async removeDevice(deviceId: number): Promise<void> {
    await this.#request(`/me/devices/${deviceId}/`, { method: "DELETE" });
  }

  /** Gives the Worker this phone's Expo push token. */
  setPushToken(pushToken: string): Promise<void> {
    return this.#run("PUT", "/me/device/", { pushToken });
  }

  /** Stops pushes to this phone, as when notifications are turned off. */
  clearPushToken(): Promise<void> {
    return this.#run("PUT", "/me/device/", { pushToken: null });
  }

  projects(org: string): Promise<ApiProject[]> {
    return this.#get(`/organizations/${org}/projects/`);
  }

  issues(org: string, query: URLSearchParams): Promise<ApiIssueList> {
    return this.#get(`/organizations/${org}/issues/?${query.toString()}`);
  }

  issue(org: string, issueId: number): Promise<ApiIssue> {
    return this.#get(`/organizations/${org}/issues/${issueId}/`);
  }

  setStatuses(org: string, issueIds: number[], status: IssueStatus): Promise<void> {
    const ids = issueIds.map((id) => `id=${id}`).join("&");

    return this.#run("PUT", `/organizations/${org}/issues/?${ids}`, { status });
  }

  markSeen(org: string, issueId: number): Promise<void> {
    return this.#run("PUT", `/organizations/${org}/issues/${issueId}/`, { hasSeen: true });
  }

  tags(org: string, issueId: number): Promise<ApiTag[]> {
    return this.#get(`/organizations/${org}/issues/${issueId}/tags/`);
  }

  stats(org: string, issueId: number, period: StatsPeriod): Promise<ApiIssueStats> {
    return this.#get(`/organizations/${org}/issues/${issueId}/stats/?period=${period}`);
  }

  activity(org: string, issueId: number): Promise<ApiActivity[]> {
    return this.#get(`/organizations/${org}/issues/${issueId}/activity/`);
  }

  events(org: string, issueId: number): Promise<ApiEventList> {
    return this.#get(`/organizations/${org}/issues/${issueId}/events/`);
  }

  eventsAfter(org: string, issueId: number, cursor: string): Promise<ApiEventList> {
    return this.#get(
      `/organizations/${org}/issues/${issueId}/events/?cursor=${encodeURIComponent(cursor)}`,
    );
  }

  /** `which` is `latest`, `oldest` or an event id. */
  event(org: string, issueId: number, which: string): Promise<ApiEventDetail> {
    return this.#get(`/organizations/${org}/issues/${issueId}/events/${which}/`);
  }

  subscription(org: string, issueId: number): Promise<ApiIssueSubscription> {
    return this.#get(`/organizations/${org}/issues/${issueId}/subscription/`);
  }

  setSubscription(
    org: string,
    issueId: number,
    subscribed: boolean,
  ): Promise<ApiIssueSubscription> {
    return this.#send("PUT", `/organizations/${org}/issues/${issueId}/subscription/`, {
      subscribed,
    });
  }

  notifications(org: string): Promise<ApiNotificationSettings> {
    return this.#get(`/organizations/${org}/notifications/`);
  }

  updateNotification(org: string, change: NotificationChange): Promise<ApiNotificationSettings> {
    return this.#send("PUT", `/organizations/${org}/notifications/`, change);
  }
}
