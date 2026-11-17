// The Stack Trace section: every exception in the chain with its frames,
// and the toolbar that switches between relevant and full frames, newest
// and oldest first, and the platform's own raw text.

import type { StoredEvent, StoredException } from "@contract";
import { useState } from "react";
import type { JSX } from "react";

import { CopyButton } from "~/components/overlays";
import { Section, Segmented } from "~/components/section";
import { Linkified } from "~/components/text";
import { Tooltip } from "~/components/tooltip";
import { numbered } from "~/lib/lists";
import { rawTrace } from "~/lib/raw-trace";
import { useChoice } from "~/lib/storage";

import { collapseRepeats, Frames } from "./frames";

const ORDERS = ["newest", "oldest"] as const;
const DISPLAYS = ["formatted", "raw"] as const;

type Order = (typeof ORDERS)[number];

type View = { full: boolean; order: Order; platform: string };

/** Older exceptions in a long chain start folded, as on Sentry. */
const OPEN_CHAIN = 3;

type PanelProps = { exception: StoredException; view: View; newest: boolean };

function ExceptionBody({ exception, view, newest }: PanelProps): JSX.Element {
  const { mechanism } = exception;
  const ordered = view.order === "newest" ? exception.frames.toReversed() : exception.frames;

  return (
    <>
      {exception.value !== null && (
        <pre className="value">
          <Linkified text={exception.value} />
        </pre>
      )}
      {mechanism !== null && (
        <div className="mechanism">
          <span className="badge">mechanism: {mechanism.type ?? "unknown"}</span>
          {mechanism.handled !== null && (
            <span className={mechanism.handled ? "badge" : "badge unhandled"}>
              handled: {mechanism.handled ? "true" : "false"}
            </span>
          )}
        </div>
      )}
      {exception.frames.length === 0 ? (
        <div className="muted small">No stacktrace found.</div>
      ) : (
        <Frames
          frames={collapseRepeats(ordered)}
          platform={view.platform}
          full={view.full}
          expandFirst={newest}
        />
      )}
    </>
  );
}

function TypeName({ exception }: { exception: StoredException }): JSX.Element {
  // An event whose stack came from `threads` has no exception to name.
  const type = exception.type ?? (exception.value === null ? "Stack trace" : "Error");

  return exception.module === null ? (
    <span>{type}</span>
  ) : (
    <Tooltip content={`from ${exception.module}`} className="dotted">
      {type}
    </Tooltip>
  );
}

function ExceptionPanel(props: PanelProps & { folded: boolean }): JSX.Element {
  return (
    <details className="exception" open={!props.folded}>
      <summary className="type">
        <TypeName exception={props.exception} />
      </summary>
      <ExceptionBody {...props} />
    </details>
  );
}

type ToolbarProps = {
  view: View;
  onFull: (full: boolean) => void;
  onOrder: (order: Order) => void;
  display: (typeof DISPLAYS)[number];
  onDisplay: (display: (typeof DISPLAYS)[number]) => void;
  raw: string;
};

function Toolbar({ view, onFull, onOrder, display, onDisplay, raw }: ToolbarProps): JSX.Element {
  return (
    <>
      <Segmented
        label="Frames"
        options={[
          ["relevant", "Most Relevant"],
          ["full", "Full Stack Trace"],
        ]}
        value={view.full ? "full" : "relevant"}
        onChange={(value) => onFull(value === "full")}
      />
      <Segmented
        label="Order"
        options={[
          ["newest", "Newest"],
          ["oldest", "Oldest"],
        ]}
        value={view.order}
        onChange={onOrder}
      />
      <Segmented
        label="Display"
        options={[
          ["formatted", "Formatted"],
          ["raw", "Raw"],
        ]}
        value={display}
        onChange={onDisplay}
      />
      <CopyButton text={raw} message="Copied the stack trace" label="Copy stack trace as text" />
    </>
  );
}

export function StackTraceSection({ event }: { event: StoredEvent }): JSX.Element {
  const [full, setFull] = useState(false);
  const [order, setOrder] = useChoice("trace-order", ORDERS);
  const [display, setDisplay] = useChoice("trace-display", DISPLAYS);
  const view: View = { full, order, platform: event.platform };
  const { exceptions } = event;
  const raw = rawTrace(exceptions, event.platform);
  const chain = numbered(exceptions);
  const shown = order === "newest" ? chain.toReversed() : chain;

  return (
    <Section
      id="stack-trace"
      title="Stack Trace"
      actions={
        <Toolbar
          view={view}
          onFull={setFull}
          onOrder={setOrder}
          display={display}
          onDisplay={setDisplay}
          raw={raw}
        />
      }
    >
      {exceptions.length > 1 && (
        <div className="muted small chain-note">
          There are {exceptions.length} chained exceptions in this event.
        </div>
      )}
      {display === "raw" ? (
        <pre className="raw-trace">{raw}</pre>
      ) : (
        shown.map(([position, exception]) => (
          <ExceptionPanel
            key={position}
            exception={exception}
            view={view}
            newest={position === exceptions.length - 1}
            folded={position < exceptions.length - OPEN_CHAIN}
          />
        ))
      )}
    </Section>
  );
}
