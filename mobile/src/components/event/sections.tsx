// The smaller sections of an event, ported from ui/src/pages/event-sections.tsx:
// the message, highlights (handled, level, release, environment…), extra
// data, SDK and grouping.

import type { JsonObject, StoredEvent, StoredSdk } from "@contract";
import { useState } from "react";
import type { JSX } from "react";

import { Segmented } from "~/components/segmented";
import { Text } from "~/components/text";

import { CopyButton } from "./copy";
import { KeyValueTable } from "./json-view";
import { CodeBlock, EventSection } from "./parts";

export function messageOf(event: StoredEvent): string | null {
  return event.message?.formatted ?? event.message?.message ?? null;
}

export function MessageSection({ message }: { message: string }): JSX.Element {
  return (
    <EventSection title="Message">
      <Text mono size={13} selectable>
        {message}
      </Text>
    </EventSection>
  );
}

function handledText(event: StoredEvent): string | null {
  const handled = event.exceptions.at(-1)?.mechanism?.handled ?? null;

  if (handled === null) {
    return null;
  }

  return handled ? "yes" : "no";
}

export function Highlights({ event }: { event: StoredEvent }): JSX.Element {
  const data: JsonObject = {};

  data["handled"] = handledText(event);
  data["level"] = event.level;
  data["transaction"] = event.transaction;
  data["url"] = event.request?.url ?? null;
  data["release"] = event.release;
  data["environment"] = event.environment;

  return (
    <EventSection title="Highlights">
      <KeyValueTable data={data} />
    </EventSection>
  );
}

function sorted(data: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(data).sort(([left], [right]) => left.localeCompare(right)),
  );
}

const EXTRA_VIEWS = [
  ["formatted", "Formatted"],
  ["raw", "Raw"],
] as const;

export function ExtraData({ extra }: { extra: JsonObject }): JSX.Element {
  const [view, setView] = useState<"formatted" | "raw">("formatted");
  const raw = JSON.stringify(sorted(extra), null, 2);

  const actions = (
    <>
      <Segmented
        label="Additional data view"
        options={EXTRA_VIEWS}
        value={view}
        onChange={setView}
      />
      <CopyButton text={raw} label="Copy additional data" />
    </>
  );

  return (
    <EventSection title="Additional Data" actions={actions}>
      {view === "raw" ? <CodeBlock text={raw} /> : <KeyValueTable data={sorted(extra)} />}
    </EventSection>
  );
}

export function Sdk({ sdk }: { sdk: StoredSdk }): JSX.Element {
  const data: JsonObject = {};

  data["Name"] = sdk.name;
  data["Version"] = sdk.version;

  return (
    <EventSection title="SDK" folded>
      <KeyValueTable data={data} />
    </EventSection>
  );
}

function groupingBasis(event: StoredEvent): string {
  const custom =
    event.fingerprint !== null &&
    event.fingerprint.some((part) => !/^\{\{\s*default\s*\}\}$/.test(part));

  if (custom) {
    return "custom fingerprint";
  }

  if (event.exceptions.some((exception) => exception.frames.length > 0)) {
    return "stack trace (default grouping)";
  }

  return event.exceptions.length > 0
    ? "exception (default grouping)"
    : "message (default grouping)";
}

export function Grouping({ event }: { event: StoredEvent }): JSX.Element {
  return (
    <EventSection title="Event Grouping Information" folded>
      <Text size={13}>
        Grouped by:{" "}
        <Text size={13} weight="medium">
          {groupingBasis(event)}
        </Text>
      </Text>
      {event.fingerprint !== null && (
        <Text size={12} mono selectable>
          {event.fingerprint.map((part) => JSON.stringify(part)).join(", ")}
        </Text>
      )}
    </EventSection>
  );
}
