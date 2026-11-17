// Renders free-form JSON (extra data, contexts, local variables).

import type { Json, JsonObject } from "@contract";
import type { JSX } from "react";

import { describeJson } from "~/lib/json";

/** Nesting deeper than this starts folded. */
const OPEN_DEPTH = 2;

type ValueProps = { value: Json; depth?: number };

export function JsonValue({ value, depth = 0 }: ValueProps): JSX.Element {
  const node = describeJson(value);

  if (value === null) {
    return <span className="muted">--</span>;
  }

  if (node.kind === "scalar") {
    // Text reads as text; numbers and booleans stand out, as on Sentry.
    return <span className={node.quoted ? undefined : "literal"}>{node.text}</span>;
  }

  const entries =
    node.kind === "list"
      ? node.items.map((item, index): [string, Json] => [String(index), item])
      : node.entries;

  if (entries.length === 0) {
    return <span className="muted">{node.kind === "list" ? "[]" : "{}"}</span>;
  }

  const rows = (
    <div className="nested">
      {entries.map(([key, item]) => (
        <div key={key}>
          <span className="key">{key}: </span>
          <JsonValue value={item} depth={depth + 1} />
        </div>
      ))}
    </div>
  );

  if (depth < OPEN_DEPTH) {
    return rows;
  }

  return (
    <details className="folded">
      <summary>
        {entries.length} {node.kind === "list" ? "items" : "keys"}
      </summary>
      {rows}
    </details>
  );
}

const ACRONYMS = new Set(["id", "ip", "url", "sdk", "os", "cpu", "gpu", "api"]);

/** "raw_description" → "Raw Description", "cloud.region" → "Cloud Region". */
export function words(key: string): string {
  return key
    .split(/[_.\s]+/)
    .filter((word) => word !== "")
    .map((word) =>
      ACRONYMS.has(word.toLowerCase())
        ? word.toUpperCase()
        : `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`,
    )
    .join(" ");
}

type TableProps = { data: JsonObject; readable?: boolean };

/**
 * A two-column table of an object's top-level keys. The key column is as
 * wide as its longest key and never wraps; values wrap only between words
 * where they can. `readable` shows keys as words instead of identifiers.
 */
export function KeyValueTable({ data, readable = false }: TableProps): JSX.Element {
  return (
    <table className="kv">
      <tbody>
        {Object.entries(data).map(([key, value]) => (
          <tr key={key}>
            <td title={key}>{readable ? words(key) : key}</td>
            <td className="json">
              <JsonValue value={value} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
