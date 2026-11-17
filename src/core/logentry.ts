// Fills a log message's placeholders from its `params`, as Relay does when an
// SDK sends `{message: "user %s failed", params: ["ana"]}` with no `formatted`.
// Supports `%s`-style and `{}`-style, positional and named.

import type { Json, JsonObject } from "@/shared/contract";
import { jsonKind } from "@/shared/json";

// %%, %(name)s, %s, {name}, {0}, {}
const PLACEHOLDER = /%%|%\((\w+)\)[sdifr]|%[sdifr]|\{(\w*)\}/g;

/** An SDK sends either a list or an object; the other side is empty. */
export type TemplateParams = { list: Json[]; named: JsonObject };

function show(value: Json): string {
  const kind = jsonKind(value);

  if (kind.kind === "string") {
    return kind.value;
  }

  return kind.kind === "scalar" && kind.value !== null ? String(kind.value) : JSON.stringify(value);
}

export function fillTemplate(template: string, params: TemplateParams): string {
  const { list, named } = params;
  let next = 0;

  return template.replace(PLACEHOLDER, (match, percentName?: string, braceName?: string) => {
    const name = percentName ?? braceName ?? "";

    if (match === "%%") {
      return "%";
    }

    const value =
      name === "" ? list[next++] : Object.hasOwn(named, name) ? named[name] : list[Number(name)];

    return value === undefined ? match : show(value);
  });
}
