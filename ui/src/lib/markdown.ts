// "Copy as Markdown": one event as a self-contained report, for pasting into
// a ticket, a pull request or an AI assistant. Everything someone needs to
// start on the bug without opening Zentry: what, where, how often, the full
// exception and trace, the source around the app's own frames, what led up
// to it, the request, contexts, extra data and the tags. The user's IP
// address and the request headers (cookies, auth tokens) are left out,
// since the text is meant to travel.
//
// The app keeps a copy in mobile/src/lib/markdown.ts: Metro cannot import
// from ui/, so a change here is made there too.

import type {
  ApiIssue,
  Json,
  JsonObject,
  StoredBreadcrumb,
  StoredEvent,
  StoredFrame,
} from "@contract";

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

/** A frame with its source line, which is all `sourceSection` shows. */
type SourceFrame = StoredFrame & { lineno: number; contextLine: string };

function hasSource(frame: StoredFrame): frame is SourceFrame {
  return frame.inApp && frame.lineno !== null && frame.contextLine !== null;
}

/** Lines around a frame's line, numbered, with the line itself marked. */
function sourceLines(frame: SourceFrame): string {
  const at = frame.lineno;
  const start = at - frame.preContext.length;
  const lines = [...frame.preContext, frame.contextLine, ...frame.postContext];

  return lines
    .map((line, index) => {
      const number = start + index;

      return `${number === at ? ">" : " "} ${String(number).padStart(5)} | ${line}`;
    })
    .join("\n");
}

function frameBlock(frame: SourceFrame): string {
  const where = frame.absPath ?? frame.filename ?? frame.module ?? "<unknown>";

  const lines = [
    `### ${code(frame.function ?? "<unknown>")} in ${code(where)}`,
    "",
    fenced(sourceLines(frame)),
  ];

  if (frame.vars !== null) {
    lines.push("", "Locals:", "", fenced(JSON.stringify(frame.vars, null, 2), "json"));
  }

  return lines.join("\n");
}

/**
 * The source around the app's own frames, innermost first: the trace says
 * where, this says what the code there does, which is what a fix starts
 * from. Library frames are left out: they are rarely where the fix goes,
 * and they would bury the app's frames in a long report.
 */
function sourceSection(event: StoredEvent): string[] {
  const frames = event.exceptions
    .toReversed()
    .flatMap((exception) => exception.frames.toReversed())
    .filter(hasSource);

  return frames.length === 0
    ? []
    : ["## Source (in-app frames, innermost first)", "", frames.map(frameBlock).join("\n\n")];
}

/** The request without its headers, which carry cookies and tokens. */
function requestSection(event: StoredEvent): string[] {
  const { request } = event;

  if (request === null) {
    return [];
  }

  const parts = [
    ...(request.queryString === null || request.queryString === ""
      ? []
      : [`Query: ${code(request.queryString)}`, ""]),
    ...(request.data === null
      ? []
      : ["Body:", "", fenced(JSON.stringify(request.data, null, 2), "json")]),
  ];

  return parts.length === 0 ? [] : ["## Request", "", ...parts];
}

function jsonSection(heading: string, value: JsonObject): string[] {
  return Object.keys(value).length === 0
    ? []
    : [`## ${heading}`, "", fenced(JSON.stringify(value, null, 2), "json")];
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
    sourceSection(event),
    breadcrumbSection(event),
    requestSection(event),
    tagSection(event),
    jsonSection("Contexts", event.contexts),
    jsonSection("Extra", event.extra),
  ];

  return sections
    .flatMap((section) => (section.length === 0 ? [] : [section.join("\n")]))
    .join("\n\n");
}
