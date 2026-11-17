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
  /** The current hourly spike threshold; null until the hourly cron has computed one. */
  spikeLimitPerHour: number | null;
  firstEventAt: number | null;
  createdAt: number;
  events24h: number;
  stats: StatPoint[];
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
