import type { ApiMonitor } from "./monitors";
// Types shared between the Worker and the UI. This file has no imports so
// that the UI can depend on it without pulling in Worker code.

export type Json = null | boolean | number | string | Json[] | JsonObject;

export type JsonObject = { [key: string]: Json };

export type Pair = [key: string, value: string];

export type Level = "fatal" | "error" | "warning" | "info" | "debug";

export type IssueStatus = "unresolved" | "resolved" | "ignored";

/** Why ingest refuses a project's events, in Relay's reason codes. */
export type RateLimitReason = "project_quota" | "spike_protection";

// ── Stored event (the JSON object kept in R2) ────────────────────────────

export type StoredFrame = {
  filename: string | null;
  absPath: string | null;
  module: string | null;
  function: string | null;
  /** The binary or assembly the code is in. Absent on events stored before this field existed. */
  package?: string | null;
  lineno: number | null;
  colno: number | null;
  inApp: boolean;
  contextLine: string | null;
  preContext: string[];
  postContext: string[];
  vars: JsonObject | null;
};

export type StoredMechanism = {
  type: string | null;
  handled: boolean | null;
  synthetic: boolean;
  /** The SDK marked this as an exception group (`AggregateException`, `ExceptionGroup`). */
  exceptionGroup: boolean;
};

export type StoredException = {
  type: string | null;
  value: string | null;
  module: string | null;
  mechanism: StoredMechanism | null;
  frames: StoredFrame[];
};

export type StoredBreadcrumb = {
  timestamp: number | null;
  type: string | null;
  category: string | null;
  level: string | null;
  message: string | null;
  data: JsonObject | null;
};

export type StoredMessage = {
  message: string | null;
  formatted: string | null;
};

export type StoredRequest = {
  url: string | null;
  method: string | null;
  queryString: string | null;
  headers: Pair[];
  data: Json;
};

export type StoredSdk = {
  name: string | null;
  version: string | null;
};

export type StoredEvent = {
  eventId: string;
  projectId: number;
  timestamp: number;
  receivedAt: number;
  level: Level;
  platform: string;
  title: string;
  culprit: string;
  message: StoredMessage | null;
  exceptions: StoredException[];
  breadcrumbs: StoredBreadcrumb[];
  tags: Pair[];
  user: JsonObject | null;
  request: StoredRequest | null;
  contexts: JsonObject;
  extra: JsonObject;
  sdk: StoredSdk | null;
  release: string | null;
  environment: string;
  serverName: string | null;
  /** Absent on events stored before this field existed. */
  logger?: string | null;
  transaction: string | null;
  fingerprint: string[] | null;
};

// ── API responses ────────────────────────────────────────────────────────

export type IssueMetadata = {
  type: string | null;
  value: string | null;
  filename: string | null;
  function: string | null;
  logger: string | null;
};

export type StatPoint = [bucket: number, count: number];

export type ApiOrganization = { id: number; slug: string; name: string };

export type ApiMe = {
  id: number;
  email: string;
  organizations: ApiOrganization[];
};

export type ApiProject = {
  id: number;
  slug: string;
  name: string;
  platform: string | null;
  maxEventsPerHour: number | null;
  /** Null while not limited. */
  rateLimit: { until: number; reason: RateLimitReason } | null;
  spikeProtection: boolean;
  /** The current hourly spike threshold, recomputed every hour; enforced only while protected. */
  spikeLimitPerHour: number;
  firstEventAt: number | null;
  createdAt: number;
  events24h: number;
  stats: StatPoint[];
};

/** An organization's monthly cap and what its projects have used of it. */
export type ApiOrganizationLimits = {
  maxEventsPerMonth: number;
  /** Events accepted this UTC month, all of the organization's projects together. */
  monthReceived: number;
  /** Start of the current UTC month, ms. */
  month: number;
  /** Only owners may change the cap. */
  canEdit: boolean;
};

export type ApiKey = {
  id: number;
  label: string;
  publicKey: string;
  status: "active" | "revoked";
  createdAt: number;
  dsn: string;
};

export type ApiIssue = {
  monitorId?: string;
  id: number;
  shortId: string;
  projectId: number;
  projectSlug: string;
  title: string;
  culprit: string;
  level: Level;
  platform: string | null;
  metadata: IssueMetadata;
  status: IssueStatus;
  substatus: "regressed" | null;
  timesSeen: number;
  firstSeen: number;
  lastSeen: number;
  resolvedAt: number | null;
  lastEventId: string | null;
  firstRelease: string | null;
  /** Whether the signed-in user has opened the issue since it last became active. */
  hasSeen: boolean;
  stats: StatPoint[];
};

export type { ApiMonitor, NewMonitor } from "./monitors";

export type MonitorObservation = {
  id: number;
  time: number;
  health: ApiMonitor["health"];
  evidence: Json;
};

export type MonitorPreview =
  | { type: "metric"; count: number; windowEnd: number }
  | { type: "cron"; occurrences: number[] }
  | {
      type: "uptime";
      outcome: "ok" | "failed" | "unknown";
      httpStatus?: number | undefined;
      durationMs?: number | undefined;
    };

export type MonitorDetail = {
  monitor: ApiMonitor;
  observations: MonitorObservation[];
};

export type ApiIssueList = { issues: ApiIssue[]; nextCursor: string | null };

export type ApiEventRow = {
  eventId: string;
  timestamp: number;
  level: string | null;
  release: string | null;
  environment: string | null;
  user: string | null;
  title: string | null;
};

export type ApiEventList = { events: ApiEventRow[]; nextCursor: string | null };

export type ApiEventDetail = {
  event: StoredEvent;
  previousEventId: string | null;
  nextEventId: string | null;
};

export type ApiTagValue = { value: string; count: number };

export type ApiTag = { key: string; total: number; values: ApiTagValue[] };

export type ApiIssueStats = { points: StatPoint[]; stored: number; total: number };

export type ApiActivity = {
  id: number;
  type: string;
  userEmail: string | null;
  createdAt: number;
};

export type ApiError = { detail: string };

// ── Notifications (DESIGN.md §18) ────────────────────────────────────────

export type NotificationType = "alerts" | "workflow" | "quota" | "spikeProtection" | "reports";

/** `subscribe_only` is for `workflow` alone: only the issues you follow. */
export type NotificationValue = "always" | "never" | "subscribe_only";

/** The most specific scope wins: project, then organization, then user. */
export type NotificationScope = "user" | "organization" | "project";

/** Where a notification goes. Push reaches the phones signed in to the mobile app. */
export type NotificationProvider = "email" | "push";

export type ApiNotificationSetting = {
  provider: NotificationProvider;
  type: NotificationType;
  scope: NotificationScope;
  scopeId: number;
  value: NotificationValue;
};

export type ApiNotificationSettings = {
  defaults: { [type in NotificationType]: NotificationValue };
  /** The caller's own rows: user-wide, and for this organization and its projects. */
  settings: ApiNotificationSetting[];
  /** The caller's user id: the scope id of a user-wide row. */
  userId: number;
  /** False while the deployment has no sender address, so nothing is emailed. */
  emailEnabled: boolean;
  /** How many of the caller's phones can receive pushes. */
  pushDevices: number;
};

export type ApiIssueSubscription = { subscribed: boolean };

// ── Mobile app (DESIGN.md §19) ───────────────────────────────────────────

/** A code the web UI shows as a QR code; the app trades it for a device token. */
export type ApiPairing = {
  /** What the QR code holds: `zentry://pair?url=…&code=…`. */
  link: string;
  expiresAt: number;
};

/** A phone signed in to the mobile app. */
export type ApiDevice = {
  id: number;
  name: string;
  /** True once the app has registered for push notifications. */
  push: boolean;
  createdAt: number;
  lastSeenAt: number;
  /** True for the device making the request. */
  current: boolean;
};

export type ApiDeviceList = { devices: ApiDevice[] };

/** The app's reply from the pairing exchange. The token is shown only once. */
export type ApiPaired = { token: string; device: ApiDevice; email: string };

/**
 * The Android notification channel a push arrives on: one per type, so each
 * can be muted in the phone's settings. The weekly report is email only.
 */
export type PushChannel = Exclude<NotificationType, "reports">;

/**
 * What a push notification carries for the app to open on a tap. Expo
 * delivers it as the notification's `data`.
 */
export type PushData =
  | { kind: "issue"; organization: string; issueId: number }
  | { kind: "issues"; organization: string; projectId: number }
  | { kind: "settings"; organization: string };
