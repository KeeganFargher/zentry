// "Copy as Markdown": one event as a self-contained report, for pasting into
// a ticket, a pull request or an AI assistant. Everything someone needs to
// start on the bug without opening Zentry: what, where, how often, the full
// exception and trace, what led up to it, and the tags. The user's IP
// address is left out, since the text is meant to travel.

import type { ApiIssue, Json, StoredBreadcrumb, StoredEvent } from "@contract";

import { dateTime } from "./format";
import { getText } from "./json";
import { rawTrace } from "./raw-trace";

/** Breadcrumbs shown: the last ones, nearest the error. */
const BREADCRUMBS = 15;

/** A code fence longer than any run of backticks in `text`, so the text cannot close it. */
function fenced(text: string, language = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(longest + 1);

  return `${fence}${language}\n${text}\n${fence}`;
}

/** Inline code that survives backticks inside it. */
function code(text: string): string {
  return text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``;
}

function contextText(event: StoredEvent, name: string, fields: string[]): string | null {
  const value: Json | undefined = event.contexts[name];

  if (value === undefined) {
    return null;
  }

  const parts = fields.flatMap((field) => getText(value, field) ?? []);

  return parts.length === 0 ? null : parts.join(" ");
}

function userText(event: StoredEvent): string | null {
  const { user } = event;

  if (user === null) {
    return null;
  }

  const parts = [
    ["id", getText(user, "id")],
    ["email", getText(user, "email")],
    ["username", getText(user, "username")],
  ].flatMap(([label, value]) => (value === null ? [] : [`${label} ${value}`]));

  return parts.length === 0 ? null : parts.join(", ");
}

function handledText(event: StoredEvent): string | null {
  const mechanism = event.exceptions.at(-1)?.mechanism ?? null;

  if (mechanism === null || mechanism.handled === null) {
    return null;
  }

  const how = mechanism.type === null ? "" : ` (${mechanism.type})`;

  return `${mechanism.handled ? "yes" : "no"}${how}`;
}

function requestText(event: StoredEvent): string | null {
  const { request } = event;

  if (request === null || request.url === null) {
    return null;
  }

  return request.method === null ? request.url : `${request.method} ${request.url}`;
}

/** The facts table: each row only when the event has it. */
function details(issue: ApiIssue, event: StoredEvent): string {
  const rows: [string, string | null][] = [
    ["Culprit", issue.culprit === "" ? null : code(issue.culprit)],
    ["Event", `${code(event.eventId)} at ${dateTime(event.timestamp)}`],
    ["Release", event.release],
    ["Environment", event.environment === "" ? null : event.environment],
    ["Handled", handledText(event)],
    ["Logger", event.logger ?? null],
    ["Transaction", event.transaction],
    ["Request", requestText(event)],
    ["Runtime", contextText(event, "runtime", ["name", "version"])],
    [
      "OS",
      contextText(event, "os", ["name", "version"]) ??
        contextText(event, "os", ["raw_description"]),
    ],
    ["Browser", contextText(event, "browser", ["name", "version"])],
    ["Server", event.serverName],
    ["User", userText(event)],
    ["SDK", event.sdk === null ? null : `${event.sdk.name} ${event.sdk.version}`],
  ];

  const lines = rows.flatMap(([label, value]) =>
    value === null ? [] : [`| ${label} | ${value.replaceAll("|", "\\|")} |`],
  );

  return ["| | |", "|---|---|", ...lines].join("\n");
}

function messageSection(issue: ApiIssue, event: StoredEvent): string[] {
  const text = event.message?.formatted ?? event.message?.message ?? null;

  // A message event's title is its message; repeating it adds nothing.
  if (text === null || issue.title === text) {
    return [];
  }

  return ["## Message", "", fenced(text)];
}

function crumbLine(crumb: StoredBreadcrumb): string {
  const time =
    crumb.timestamp === null ? "" : new Date(crumb.timestamp).toISOString().slice(11, 23);

  const parts = [time, crumb.level, crumb.category, crumb.message].filter(
    (part) => part !== null && part !== "",
  );

  return parts.join("  ");
}

function breadcrumbSection(event: StoredEvent): string[] {
  const { breadcrumbs } = event;

  if (breadcrumbs.length === 0) {
    return [];
  }

  const shown = breadcrumbs.slice(-BREADCRUMBS);

  const heading =
    shown.length === breadcrumbs.length
      ? "## Breadcrumbs"
      : `## Breadcrumbs (last ${shown.length} of ${breadcrumbs.length})`;

  return [heading, "", fenced(shown.map(crumbLine).join("\n"))];
}

function tagSection(event: StoredEvent): string[] {
  return event.tags.length === 0
    ? []
    : ["## Tags", "", ...event.tags.map(([key, value]) => `- ${code(key)}: ${value}`)];
}

export function issueMarkdown(link: string, issue: ApiIssue, event: StoredEvent): string {
  const counts = [
    `[${issue.shortId}](${link})`,
    issue.level,
    issue.status,
    `${issue.timesSeen.toLocaleString()} ${issue.timesSeen === 1 ? "event" : "events"}`,
    `first seen ${dateTime(issue.firstSeen)}`,
    `last seen ${dateTime(issue.lastSeen)}`,
  ];

  const trace =
    event.exceptions.length === 0
      ? []
      : ["## Exception", "", fenced(rawTrace(event.exceptions, event.platform))];

  const sections = [
    [`# ${issue.title}`, "", counts.join(" · ")],
    [details(issue, event)],
    messageSection(issue, event),
    trace,
    breadcrumbSection(event),
    tagSection(event),
  ];

  return sections
    .flatMap((section) => (section.length === 0 ? [] : [section.join("\n")]))
    .join("\n\n");
}
