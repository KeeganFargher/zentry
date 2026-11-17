// The HTTP Request section: method and address, then query, body and
// headers, or the same request as a curl command.

import type { StoredRequest } from "@contract";
import { useState } from "react";
import type { JSX } from "react";

import { JsonValue } from "~/components/json-view";
import { CopyButton } from "~/components/overlays";
import { Section, Segmented } from "~/components/section";
import { jsonText } from "~/lib/json";

import { RowsTable } from "./event-contexts";

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

function Formatted({ request }: { request: StoredRequest }): JSX.Element {
  const query = [...new URLSearchParams(request.queryString ?? "")];

  return (
    <>
      {query.length > 0 && (
        <div className="sub-table">
          <h4>Query String</h4>
          <RowsTable rows={query.map(([key, value]) => [key, value])} />
        </div>
      )}
      {request.data !== null && (
        <div className="sub-table">
          <h4>Body</h4>
          <div className="kv-block json">
            <JsonValue value={request.data} />
          </div>
        </div>
      )}
      {request.headers.length > 0 && (
        <div className="sub-table">
          <h4>Headers</h4>
          <RowsTable rows={request.headers.map(([name, value]) => [name, value])} />
        </div>
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
  const url = request.url === null ? null : URL.parse(request.url);
  const command = curl(request);

  const actions = (
    <>
      <Segmented label="Request view" options={VIEWS} value={view} onChange={setView} />
      <CopyButton text={fullUrl(request)} message="Copied the URL" label="Copy full URL" />
    </>
  );

  return (
    <Section id="request" title="HTTP Request" actions={actions}>
      <div className="request-line">
        <strong>{request.method ?? "GET"}</strong>
        {url === null ? (
          <span>{request.url}</span>
        ) : (
          <>
            <a href={url.href} target="_blank" rel="noreferrer">
              {url.pathname}
            </a>
            <span className="muted">{url.host}</span>
          </>
        )}
      </div>
      {view === "curl" ? (
        <pre className="raw-trace">{command}</pre>
      ) : (
        <Formatted request={request} />
      )}
    </Section>
  );
}
