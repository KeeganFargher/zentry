// Fills a log message's placeholders from its `params`, as Relay does when an
// SDK sends `{message: "user %s failed", params: ["ana"]}` with no `formatted`.
// Supports `%s`-style and `{}`-style, positional and named.

import type { Json, JsonObject } from "@/shared/contract";
import { asArray, asObject, asText } from "@/shared/json";

// %%, %(name)s, %s, {name}, {0}, {}
const PLACEHOLDER = /%%|%\((\w+)\)[sdifr]|%[sdifr]|\{(\w*)\}/g;

function show(value: Json | undefined): string | null {
  const text = asText(value);

  if (text !== null) {
    return text;
  }

  return value === undefined ? null : JSON.stringify(value);
}

function lookup(name: string, list: Json[] | null, named: JsonObject | null): Json | undefined {
  if (named !== null && Object.hasOwn(named, name)) {
    return named[name];
  }

  return list?.[Number(name)];
}

/** The template unchanged when `params` is missing or holds neither a list nor an object. */
export function fillTemplate(template: string | null, params: Json | undefined): string | null {
  const list = asArray(params);
  const named = asObject(params);

  if (template === null || (list === null && named === null)) {
    return template;
  }

  let next = 0;

  return template.replace(PLACEHOLDER, (match, percentName?: string, braceName?: string) => {
    const name = percentName ?? braceName ?? "";

    if (match === "%%") {
      return "%";
    }

    const value = name === "" ? list?.[next++] : lookup(name, list, named);

    return show(value) ?? match;
  });
}
