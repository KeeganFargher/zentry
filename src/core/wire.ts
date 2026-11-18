// The event an SDK sends, as one schema. This is the only place that knows the
// wire's loose shapes (an exception list may arrive bare, wrapped in
// `{values}`, or as a single object; tags as an object or as pairs). Parsing
// with it yields a `WireEvent` whose every field is already the right type, so
// normalization only trims, scrubs and maps.
//
// Fields are lenient (see shared/schema.ts): a malformed field is dropped and
// the event is kept, as Relay does. Only a payload that is not a JSON object
// fails to parse.

import { z } from "zod";

import type { Level, Pair } from "@/shared/contract";
import { JsonRecord, JsonValue } from "@/shared/json";
import { Flag, Label, lenient, lenientList, listOf, Text } from "@/shared/schema";
import { parseIsoMs, SECOND } from "@/shared/time";

import { cut, MAX_LINE, MAX_STRING } from "./trim";

/** A non-empty string, cut to `max` characters; null when absent or not a string. */
function label(
  max: number,
): z.ZodCatch<z.ZodNullable<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>>> {
  return lenient(Label.transform((text) => cut(text, max)));
}

/** Lines of source context, each cut to a line's length. */
const ContextLines = lenientList(Text.transform((line) => cut(line, MAX_LINE)));

// ── Scalars with more than one wire form ─────────────────────────────────

const LEVEL_NAMES = new Map<string, Level>([
  ["fatal", "fatal"],
  ["critical", "fatal"],
  ["error", "error"],
  ["warning", "warning"],
  ["warn", "warning"],
  ["info", "info"],
  ["log", "info"],
  ["debug", "debug"],
]);

// Python's logging numbers, which some SDKs send as they are.
const LEVEL_NUMBERS: [from: number, level: Level][] = [
  [50, "fatal"],
  [40, "error"],
  [30, "warning"],
  [20, "info"],
  [0, "debug"],
];

function levelOfNumber(number: number): Level {
  return LEVEL_NUMBERS.find(([from]) => number >= from)?.[1] ?? "error";
}

function levelOfText(text: string): Level {
  const trimmed = text.trim();
  const number = trimmed === "" ? Number.NaN : Number(trimmed);

  return Number.isFinite(number)
    ? levelOfNumber(number)
    : (LEVEL_NAMES.get(trimmed.toLowerCase()) ?? "error");
}

/** A level name (any case, with Sentry's aliases) or a Python logging number. */
const WireLevel = z
  .union([z.number().transform(levelOfNumber), z.string().transform(levelOfText)])
  .catch("error");

/** Epoch seconds (number) or ISO 8601 (string), as epoch milliseconds. */
const Timestamp = lenient(
  z.union([
    z.number().transform((seconds) => Math.round(seconds * SECOND)),
    z.string().transform(parseIsoMs),
  ]),
);

// ── Key/value pairs: an object, or a list of `[key, value]` ──────────────

const PairList = z.union([
  z
    .record(z.string(), lenient(Text))
    .transform((entries) =>
      Object.entries(entries).flatMap(([key, value]): Pair[] =>
        value === null ? [] : [[key, value]],
      ),
    ),
  listOf(z.tuple([Text, Text], JsonValue).transform(([key, value]): Pair => [key, value])),
]);

const Pairs = PairList.catch([]);

// ── Stack traces and exceptions ──────────────────────────────────────────

const Frame = z.object({
  filename: label(MAX_STRING),
  abs_path: label(MAX_STRING),
  module: label(MAX_STRING),
  function: label(MAX_STRING),
  package: label(MAX_STRING),
  lineno: lenient(z.number()),
  colno: lenient(z.number()),
  in_app: lenient(z.boolean()),
  context_line: label(MAX_LINE),
  pre_context: ContextLines,
  post_context: ContextLines,
  vars: lenient(JsonRecord),
});

const Stacktrace = z.object({ frames: lenientList(Frame) });

const Mechanism = z.object({
  type: label(200),
  handled: lenient(z.boolean()),
  synthetic: Flag,
  is_exception_group: Flag,
});

const Exception = z.object({
  type: label(200),
  value: label(MAX_STRING),
  module: label(200),
  mechanism: lenient(Mechanism),
  stacktrace: lenient(Stacktrace),
});

/** A list, `{values: [...]}`, or a single exception object. */
const Exceptions = z
  .union([
    listOf(Exception),
    z.object({ values: listOf(Exception) }).transform(({ values }) => values),
    Exception.transform((exception) => [exception]),
  ])
  .catch([]);

const Thread = z.object({ stacktrace: lenient(Stacktrace), crashed: Flag, current: Flag });

const Threads = z
  .union([listOf(Thread), z.object({ values: listOf(Thread) }).transform(({ values }) => values)])
  .catch([]);

// ── Message, breadcrumbs, request, user, contexts ────────────────────────

const LogEntry = z.object({
  message: label(MAX_STRING),
  formatted: label(MAX_STRING),
  // Positional or named; split here so the template filler need not inspect them.
  params: lenient(
    z.union([
      z.array(JsonValue).transform((list) => ({ list, named: {} })),
      JsonRecord.transform((named) => ({ list: [], named })),
    ]),
  ),
});

export type WireLogEntry = z.output<typeof LogEntry>;

// A plain `message` string means the same as a log entry with only `formatted`
// set, so it becomes one here and later code handles a single shape.
const PlainMessage = Label.transform((text): WireLogEntry => ({
  message: null,
  formatted: cut(text, MAX_STRING),
  params: null,
}));

const Breadcrumb = z.object({
  timestamp: Timestamp,
  type: label(100),
  category: label(200),
  level: label(20),
  message: label(MAX_STRING),
  data: lenient(JsonRecord),
});

/** A list or `{values: [...]}`. */
const Breadcrumbs = z
  .union([
    listOf(Breadcrumb),
    z.object({ values: listOf(Breadcrumb) }).transform(({ values }) => values),
  ])
  .catch([]);

const HttpRequest = z.object({
  url: lenient(Label),
  method: label(20),
  // A string, or pairs joined into one; empty either way means "not sent".
  query_string: lenient(
    z.union([
      Label,
      PairList.transform((pairs) => pairs.map(([key, value]) => `${key}=${value}`).join("&")).pipe(
        Label,
      ),
    ]),
  ),
  headers: Pairs,
  data: JsonValue.catch(null),
});

/** Text that is not empty once rendered. */
const FilledText = Text.pipe(Label);

/** The fields of `user` that tags and labels are built from. */
const UserFields = z.object({
  id: lenient(FilledText),
  email: lenient(FilledText),
  username: lenient(FilledText),
  ip_address: lenient(z.string()),
});

// The whole object is kept for display; the named fields are pulled out once
// here so later code never has to look inside free-form JSON for them.
const User = JsonRecord.transform((fields) => ({ fields, ...UserFields.parse(fields) }));

// An absent user and an empty one mean the same; both still get the client IP
// filled in for browser events, so absence is not modelled separately.
const NO_USER: z.output<typeof User> = {
  fields: {},
  id: null,
  email: null,
  username: null,
  ip_address: null,
};

/** The fields of a context that tags are built from. */
const ContextFields = z.object({
  name: lenient(FilledText),
  version: lenient(FilledText),
  model: lenient(FilledText),
  family: lenient(FilledText),
});

export type WireContextFields = z.output<typeof ContextFields>;

const Contexts = z
  .record(z.string(), lenient(JsonRecord))
  .catch({})
  .transform((entries) => {
    const all = Object.fromEntries(
      Object.entries(entries).flatMap(([name, context]) =>
        context === null ? [] : [[name, context]],
      ),
    );

    const fieldsOf = (name: string): WireContextFields | null =>
      all[name] === undefined ? null : ContextFields.parse(all[name]);

    return {
      all,
      browser: fieldsOf("browser"),
      os: fieldsOf("os"),
      runtime: fieldsOf("runtime"),
      device: fieldsOf("device"),
    };
  });

const Sdk = z.object({
  name: label(200),
  version: label(200),
  settings: lenient(z.object({ infer_ip: lenient(Label) })),
});

// ── The event ────────────────────────────────────────────────────────────

export const WireEvent = z.object({
  platform: label(200),
  timestamp: Timestamp,
  level: WireLevel,
  exception: Exceptions,
  stacktrace: lenient(Stacktrace),
  threads: Threads,
  message: lenient(z.union([PlainMessage, LogEntry])),
  logentry: lenient(LogEntry),
  breadcrumbs: Breadcrumbs,
  tags: Pairs,
  user: User.catch(NO_USER),
  request: lenient(HttpRequest),
  contexts: Contexts,
  extra: JsonRecord.catch({}),
  sdk: lenient(Sdk),
  release: label(200),
  environment: label(200),
  server_name: label(200),
  logger: label(200),
  transaction: label(200),
  fingerprint: lenientList(Text.transform((part) => cut(part, 500))),
});

export type WireEvent = z.output<typeof WireEvent>;

export type WireFrame = z.output<typeof Frame>;

export type WireStacktrace = z.output<typeof Stacktrace>;

export type WireException = z.output<typeof Exception>;

export type WireMechanism = z.output<typeof Mechanism>;

export type WireThread = z.output<typeof Thread>;

export type WireBreadcrumb = z.output<typeof Breadcrumb>;

export type WireRequest = z.output<typeof HttpRequest>;

export type WireUser = z.output<typeof User>;

export type WireContexts = z.output<typeof Contexts>;

export type WireSdk = z.output<typeof Sdk>;
