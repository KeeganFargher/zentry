// The HTTP Request section, ported from ui/src/pages/event-request.tsx:
// method and address, then query, body and headers, or the same request as
// a curl command.

import type { StoredRequest } from "@contract";
import { useState } from "react";
import type { JSX } from "react";
import { View } from "react-native";

import { Segmented } from "~/components/segmented";
import { SectionTitle, Text } from "~/components/text";

import { CopyButton } from "./copy";
import { jsonText } from "./json";
import { JsonValue, Rows } from "./json-view";
import type { Row } from "./json-view";
import { CodeBlock, EventSection } from "./parts";

function fullUrl(request: StoredRequest): string {
  const base = request.url ?? "";
  const query = request.queryString ?? "";

  return query === "" || base.includes("?") ? base : `${base}?${query}`;
}

const quote = (text: string): string => `'${text.replaceAll("'", String.raw`'\''`)}'`;

/** The request as a command that can be pasted into a terminal. */
function curl(request: StoredRequest): string {
  const lines = ["curl"];

  if (request.method !== null && request.method !== "GET") {
    lines.push(`-X ${request.method}`);
  }

  for (const [name, value] of request.headers) {
    lines.push(`-H ${quote(`${name}: ${value}`)}`);
  }

  if (request.data !== null) {
    lines.push(`--data ${quote(jsonText(request.data))}`);
  }

  lines.push(quote(fullUrl(request)));

  return lines.join(" \\\n  ");
}

/**
 * A query component as a browser's URLSearchParams reads it. That never
 * throws on a stray "%" or broken UTF-8, but decodeURIComponent (and React
 * Native's URLSearchParams, built on it) does; the SDK sent the query
 * verbatim, so text that can't be decoded is shown exactly as sent.
 */
function decoded(component: string): string {
  const text = component.replaceAll("+", " ");

  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function queryRows(query: string): Row[] {
  return query
    .replace(/^\?/, "")
    .split("&")
    .flatMap((pair): Row[] => {
      if (pair === "") {
        return [];
      }

      const equals = pair.indexOf("=");
      const key = decoded(equals === -1 ? pair : pair.slice(0, equals));
      const value = equals === -1 ? "" : decoded(pair.slice(equals + 1));

      return [[key, value]];
    });
}

function Block({ title, children }: { title: string; children: JSX.Element }): JSX.Element {
  return (
    <View>
      <SectionTitle>{title}</SectionTitle>
      {children}
    </View>
  );
}

function Formatted({ request }: { request: StoredRequest }): JSX.Element {
  const query = queryRows(request.queryString ?? "");

  const headers = request.headers.map(([name, value]): Row => [name, value]);

  return (
    <>
      {query.length > 0 && (
        <Block title="Query String">
          <Rows rows={query} />
        </Block>
      )}
      {request.data !== null && (
        <Block title="Body">
          <JsonValue value={request.data} depth={0} />
        </Block>
      )}
      {headers.length > 0 && (
        <Block title="Headers">
          <Rows rows={headers} />
        </Block>
      )}
    </>
  );
}

const VIEWS = [
  ["formatted", "Formatted"],
  ["curl", "curl"],
] as const;

export function RequestSection({ request }: { request: StoredRequest }): JSX.Element {
  const [view, setView] = useState<"formatted" | "curl">("formatted");

  const actions = (
    <>
      <Segmented label="Request view" options={VIEWS} value={view} onChange={setView} />
      <CopyButton text={fullUrl(request)} label="Copy URL" />
    </>
  );

  return (
    <EventSection title="HTTP Request" actions={actions}>
      <Text size={13} selectable>
        <Text size={13} weight="medium">
          {request.method ?? "GET"}
        </Text>{" "}
        {request.url ?? ""}
      </Text>
      {view === "curl" ? <CodeBlock text={curl(request)} /> : <Formatted request={request} />}
    </EventSection>
  );
}
