// The Contexts section: one card per context the SDK sent, in Sentry's order,
// with known keys given names and known values formatted.

import type { Json, JsonObject, StoredEvent } from "@contract";
import type { JSX, ReactNode } from "react";

import { JsonValue, words } from "~/components/json-view";
import { Section } from "~/components/section";
import { bytes, duration } from "~/lib/format";
import { describeJson, getText } from "~/lib/json";

const TITLES = new Map([
  ["user", "User"],
  ["browser", "Browser"],
  ["runtime", "Runtime"],
  ["os", "Operating System"],
  ["client_os", "Client Operating System"],
  ["device", "Device"],
  ["app", "App"],
  ["gpu", "Graphics Processing Unit"],
  ["trace", "Trace Details"],
  ["state", "Application State"],
  ["cloud_resource", "Cloud Resource"],
  ["culture", "Culture"],
  ["memory_info", "Memory Info"],
  ["threadpool_info", "Thread Pool Info"],
  ["react_native_context", "React Native"],
  ["response", "Response"],
]);

const FIRST = ["response", "user", "browser", "runtime", "os"];

const BYTE_KEYS = new Set([
  "memory_size",
  "free_memory",
  "usable_memory",
  "storage_size",
  "free_storage",
  "external_storage_size",
  "external_free_storage",
  "app_memory",
  "total_available_memory",
  "heap_size",
  "allocated_bytes",
]);

const YES_NO = new Set([
  "charging",
  "online",
  "simulator",
  "rooted",
  "low_memory",
  "in_foreground",
]);

const TIME_KEYS = new Set(["boot_time", "app_start_time"]);

type Row = [label: string, value: ReactNode];

function numberOf(value: Json): number | null {
  const node = describeJson(value);

  return node.kind === "scalar" && !node.quoted && Number.isFinite(Number(node.text))
    ? Number(node.text)
    : null;
}

/** Sizes in bytes and battery percentages. */
function numeric(key: string, value: Json): string | null {
  const amount = numberOf(value);

  if (amount === null) {
    return null;
  }

  if (BYTE_KEYS.has(key)) {
    return bytes(amount);
  }

  return key === "battery_level" ? `${Math.round(amount)}%` : null;
}

/** Start times with how long before the event they were, and email links. */
function textual(key: string, text: string, eventTime: number): ReactNode {
  const at = TIME_KEYS.has(key) ? Date.parse(text) : Number.NaN;

  if (!Number.isNaN(at)) {
    return `${text} (${duration(eventTime - at)} before this event)`;
  }

  return key === "email" ? <a href={`mailto:${text}`}>{text}</a> : null;
}

function formatted(key: string, value: Json, eventTime: number): ReactNode {
  if (YES_NO.has(key) && (value === true || value === false)) {
    return value ? "yes" : "no";
  }

  const text = getText({ value }, "value");

  return (
    numeric(key, value) ??
    (text === null ? null : textual(key, text, eventTime)) ?? <JsonValue value={value} />
  );
}

/** Sorted rows, without the `type` field every context carries. */
function rowsOf(name: string, data: JsonObject, eventTime: number): Row[] {
  const known = TITLES.has(name);

  return Object.entries(data)
    .filter(([key, value]) => key !== "type" && value !== null)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, value]): Row => [known ? words(key) : key, formatted(key, value, eventTime)]);
}

export function RowsTable({ rows }: { rows: Row[] }): JSX.Element {
  return (
    <table className="kv">
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <td title={label}>{label}</td>
            <td className="json">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type Card = { name: string; data: JsonObject };

function cardsOf(event: StoredEvent): Card[] {
  const cards: Card[] = event.user === null ? [] : [{ name: "user", data: event.user }];

  for (const [name, value] of Object.entries(event.contexts)) {
    const node = describeJson(value);

    if (
      node.kind === "map" &&
      node.entries.some(([key, item]) => key !== "type" && item !== null)
    ) {
      cards.push({ name, data: Object.fromEntries(node.entries) });
    }
  }

  const rank = (card: Card): number => {
    const position = FIRST.indexOf(card.name);

    return position === -1 ? FIRST.length : position;
  };

  return cards.toSorted((left, right) => rank(left) - rank(right));
}

export function ContextsSection({ event }: { event: StoredEvent }): JSX.Element | null {
  const cards = cardsOf(event);

  if (cards.length === 0) {
    return null;
  }

  return (
    <Section id="contexts" title="Contexts">
      <div className="masonry">
        {cards.map(({ name, data }) => (
          <div key={name} className="context-card">
            <h3>{TITLES.get(name) ?? name}</h3>
            <RowsTable rows={rowsOf(name, data, event.timestamp)} />
          </div>
        ))}
      </div>
    </Section>
  );
}
