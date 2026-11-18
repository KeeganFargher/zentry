// The Stack Trace section, ported from ui/src/pages/stack-trace.tsx: every
// exception in the chain with its frames, and switches between relevant and
// full frames, newest and oldest first, and the platform's own raw text.

import type { StoredEvent, StoredException } from "@contract";
import { useState } from "react";
import type { JSX } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Tag } from "~/components/basics";
import { Segmented } from "~/components/segmented";
import { Text } from "~/components/text";
import { SPACE } from "~/lib/theme";

import { CopyButton } from "./copy";
import { collapseRepeats } from "./frame-model";
import { Frames } from "./frames";
import { numbered } from "./lists";
import { CodeBlock, EventSection } from "./parts";
import { rawTrace } from "./raw-trace";

type Order = "newest" | "oldest";

type TraceView = { full: boolean; order: Order; platform: string };

/** Older exceptions in a long chain start folded, as on Sentry. */
const OPEN_CHAIN = 3;

const FRAME_VIEWS = [
  ["relevant", "Most Relevant"],
  ["full", "Full"],
] as const;

const ORDERS = [
  ["newest", "Newest"],
  ["oldest", "Oldest"],
] as const;

const DISPLAYS = [
  ["formatted", "Formatted"],
  ["raw", "Raw"],
] as const;

const styles = StyleSheet.create({
  exception: { gap: SPACE.sm, paddingTop: SPACE.sm },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: SPACE.xs },
});

function Mechanism({ exception }: { exception: StoredException }): JSX.Element | null {
  const { mechanism } = exception;

  if (mechanism === null) {
    return null;
  }

  return (
    <View style={styles.badges}>
      <Tag label={`mechanism: ${mechanism.type ?? "unknown"}`} tone="neutral" />
      {mechanism.handled !== null && (
        <Tag
          label={`handled: ${mechanism.handled ? "true" : "false"}`}
          tone={mechanism.handled ? "neutral" : "danger"}
        />
      )}
    </View>
  );
}

/** An event whose stack came from `threads` has no exception to name. */
function typeName(exception: StoredException): string {
  return exception.type ?? (exception.value === null ? "Stack trace" : "Error");
}

type BodyProps = { exception: StoredException; view: TraceView; newest: boolean };

function ExceptionBody({ exception, view, newest }: BodyProps): JSX.Element {
  // Collapse in stored order so each frame keeps its key (and its open
  // state) when the order flips; only the display order is reversed.
  const collapsed = collapseRepeats(exception.frames);
  const ordered = view.order === "newest" ? collapsed.toReversed() : collapsed;

  return (
    <>
      {exception.value !== null && (
        <Text mono size={13} selectable>
          {exception.value}
        </Text>
      )}
      <Mechanism exception={exception} />
      {exception.frames.length === 0 ? (
        <Text size={13} tone="muted">
          No stacktrace found.
        </Text>
      ) : (
        <Frames frames={ordered} platform={view.platform} full={view.full} expandFirst={newest} />
      )}
    </>
  );
}

type PanelProps = BodyProps & { folded: boolean };

function ExceptionPanel({ exception, view, newest, folded }: PanelProps): JSX.Element {
  const [open, setOpen] = useState(!folded);

  return (
    <View style={styles.exception}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
      >
        <Text size={14} weight="medium" tone="heading">
          {open ? "▾" : "▸"} {typeName(exception)}
        </Text>
        {exception.module !== null && (
          <Text size={12} tone="muted" mono>
            from {exception.module}
          </Text>
        )}
      </Pressable>
      {open && <ExceptionBody exception={exception} view={view} newest={newest} />}
    </View>
  );
}

export function StackTraceSection({ event }: { event: StoredEvent }): JSX.Element {
  const [full, setFull] = useState(false);
  const [order, setOrder] = useState<Order>("newest");
  const [display, setDisplay] = useState<"formatted" | "raw">("formatted");
  const view: TraceView = { full, order, platform: event.platform };
  const { exceptions } = event;
  const raw = rawTrace(exceptions, event.platform);
  const chain = numbered(exceptions);
  const shown = order === "newest" ? chain.toReversed() : chain;

  const actions = (
    <>
      <Segmented
        label="Frames"
        options={FRAME_VIEWS}
        value={full ? "full" : "relevant"}
        onChange={(value) => setFull(value === "full")}
      />
      <Segmented label="Frame order" options={ORDERS} value={order} onChange={setOrder} />
      <Segmented
        label="Stack trace display"
        options={DISPLAYS}
        value={display}
        onChange={setDisplay}
      />
      <CopyButton text={raw} label="Copy stack trace" />
    </>
  );

  return (
    <EventSection title="Stack Trace" actions={actions}>
      {exceptions.length > 1 && (
        <Text size={13} tone="muted">
          There are {exceptions.length} chained exceptions in this event.
        </Text>
      )}
      {display === "raw" && <CodeBlock text={raw} />}
      {display === "formatted" &&
        shown.map(([index, exception]) => (
          <ExceptionPanel
            key={index}
            exception={exception}
            view={view}
            newest={index === exceptions.length - 1}
            folded={index < exceptions.length - OPEN_CHAIN}
          />
        ))}
    </EventSection>
  );
}
