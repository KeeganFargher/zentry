// The frames of one stack trace. In "Most Relevant" view, each run of
// library frames is reduced to the one nearest the crash, which carries a
// toggle for the rest of its run, as on Sentry.

import type { StoredFrame } from "@contract";
import { useState } from "react";
import type { HTMLAttributes, JSX } from "react";

import { Icon } from "~/components/icons";
import { KeyValueTable } from "~/components/json-view";
import { Tooltip } from "~/components/tooltip";
import { highlight } from "~/lib/highlight";
import { numbered } from "~/lib/lists";

/** A frame with how many times it repeats in a row (recursion). */
export type Shown = { frame: StoredFrame; repeats: number; key: number };

type Run = { lead: Shown; rest: Shown[] };

const MAX_PATH = 100;

function sameFrame(left: StoredFrame, right: StoredFrame): boolean {
  return (
    left.filename === right.filename &&
    left.function === right.function &&
    left.lineno === right.lineno &&
    left.module === right.module
  );
}

/** Folds identical consecutive frames into one with a repeat count. */
export function collapseRepeats(frames: StoredFrame[]): Shown[] {
  const shown: Shown[] = [];

  for (const [key, frame] of frames.entries()) {
    const last = shown.at(-1);

    if (last !== undefined && sameFrame(last.frame, frame)) {
      last.repeats += 1;
    } else {
      shown.push({ frame, repeats: 1, key });
    }
  }

  return shown;
}

/** In-app frames stand alone; consecutive library frames become one run. */
function runsOf(frames: Shown[]): Run[] {
  const runs: Run[] = [];

  for (const shown of frames) {
    const last = runs.at(-1);

    if (!shown.frame.inApp && last !== undefined && !last.lead.frame.inApp) {
      last.rest.push(shown);
    } else {
      runs.push({ lead: shown, rest: [] });
    }
  }

  return runs;
}

export function isExpandable(frame: StoredFrame): boolean {
  return frame.contextLine !== null || (frame.vars !== null && Object.keys(frame.vars).length > 0);
}

function Source({ frame }: { frame: StoredFrame }): JSX.Element | null {
  if (frame.contextLine === null) {
    return null;
  }

  const first = (frame.lineno ?? 0) - frame.preContext.length;
  const lines = [...frame.preContext, frame.contextLine, ...frame.postContext];

  return (
    <pre className="source">
      {numbered(lines).map(([position, line]) => (
        <div
          key={position}
          className={position === frame.preContext.length ? "current" : undefined}
        >
          <span className="lineno">{frame.lineno === null ? "" : first + position}</span>
          <code>
            {numbered(highlight(line, frame.filename ?? "")).map(([index, [kind, text]]) => (
              <span key={index} className={`tok-${kind}`}>
                {text}
              </span>
            ))}
          </code>
        </div>
      ))}
    </pre>
  );
}

/** Long paths keep their end, which is the part that tells files apart. */
function shortPath(path: string): string {
  return path.length > MAX_PATH ? `…${path.slice(-MAX_PATH)}` : path;
}

function FileName({ frame, platform }: { frame: StoredFrame; platform: string }): JSX.Element {
  const name =
    platform === "java" ? (frame.module ?? frame.filename) : (frame.filename ?? frame.module);

  const path = name ?? frame.absPath ?? "<unknown>";
  const full = frame.absPath ?? path;

  return (
    <Tooltip content={full} className="frame-file">
      {shortPath(path)}
    </Tooltip>
  );
}

function FrameTitle({ frame, platform }: { frame: StoredFrame; platform: string }): JSX.Element {
  return (
    <span className="frame-title">
      <FileName frame={frame} platform={platform} />
      {frame.function !== null && (
        <>
          <span className="dim"> in </span>
          <strong>{frame.function}</strong>
        </>
      )}
      {frame.lineno !== null && (
        <>
          <span className="dim"> at line </span>
          <strong>
            {frame.lineno}
            {frame.colno === null ? "" : `:${frame.colno}`}
          </strong>
        </>
      )}
    </span>
  );
}

function FrameBody({ frame }: { frame: StoredFrame }): JSX.Element {
  const vars = frame.vars !== null && Object.keys(frame.vars).length > 0 ? frame.vars : null;

  return (
    <>
      <Source frame={frame} />
      {vars !== null && (
        <div className="frame-vars">
          <KeyValueTable data={vars} />
        </div>
      )}
    </>
  );
}

type FrameProps = {
  shown: Shown;
  platform: string;
  initiallyOpen: boolean;
  hint?: string | null;
  run?: { count: number; open: boolean; onToggle: () => void } | null;
};

type RunToggleProps = { count: number; open: boolean; onToggle: () => void };

function RunToggle({ count, open, onToggle }: RunToggleProps): JSX.Element {
  return (
    <button
      type="button"
      className="plain run-toggle"
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      {open ? "Hide" : "Show"} {count} more {count === 1 ? "frame" : "frames"}
    </button>
  );
}

function Badges({
  shown,
  expandable,
  open,
}: {
  shown: Shown;
  expandable: boolean;
  open: boolean;
}): JSX.Element {
  return (
    <>
      {shown.repeats > 1 && <span className="badge">Repeated {shown.repeats} times</span>}
      {shown.frame.inApp && <span className="badge in-app">In App</span>}
      {expandable && (
        <span className="chevron" aria-hidden="true" data-open={open}>
          <Icon name="chevron" size={14} />
        </span>
      )}
    </>
  );
}

/** A frame with something to show is a button; one without is plain text. */
function rowProps(
  expandable: boolean,
  open: boolean,
  toggle: () => void,
): HTMLAttributes<HTMLDivElement> {
  if (!expandable) {
    return { className: "frame-row" };
  }

  return {
    className: "frame-row expandable",
    role: "button",
    tabIndex: 0,
    "aria-expanded": open,
    onClick: toggle,
    onKeyDown: (event) => {
      if (event.key === "Enter") {
        toggle();
      }
    },
  };
}

export function Frame({
  shown,
  platform,
  initiallyOpen,
  hint = null,
  run = null,
}: FrameProps): JSX.Element {
  const { frame } = shown;
  const expandable = isExpandable(frame);
  const [open, setOpen] = useState(initiallyOpen && expandable);

  return (
    <div className={frame.inApp ? "frame" : "frame library"}>
      <div {...rowProps(expandable, open, () => setOpen(!open))}>
        {hint !== null && <span className="lead-hint">{hint}</span>}
        <FrameTitle frame={frame} platform={platform} />
        {run !== null && <RunToggle {...run} />}
        <span className="spacer" />
        <Badges shown={shown} expandable={expandable} open={open} />
      </div>
      {open && <FrameBody frame={frame} />}
    </div>
  );
}

type FramesProps = { frames: Shown[]; platform: string; full: boolean; expandFirst: boolean };

/** `frames` are already in display order. */
export function Frames({ frames, platform, full, expandFirst }: FramesProps): JSX.Element {
  const [opened, setOpened] = useState(new Set<number>());
  const fold = !full && frames.some((shown) => shown.frame.inApp);
  const target = frames.find((shown) => shown.frame.inApp) ?? frames[0];
  const isOpen = (shown: Shown): boolean => expandFirst && shown.key === target?.key;

  const toggleRun = (key: number): void => {
    const next = new Set(opened);

    if (!next.delete(key)) {
      next.add(key);
    }

    setOpened(next);
  };

  if (!fold) {
    return (
      <div className="frames">
        {frames.map((shown) => (
          <Frame key={shown.key} shown={shown} platform={platform} initiallyOpen={isOpen(shown)} />
        ))}
      </div>
    );
  }

  const items: JSX.Element[] = [];

  for (const [index, { lead, rest }] of runsOf(frames).entries()) {
    const runOpen = opened.has(lead.key);
    const hint = lead.frame.inApp ? null : index === 0 ? "Crashed in non-app:" : "Called from:";

    const run =
      rest.length === 0
        ? null
        : { count: rest.length, open: runOpen, onToggle: () => toggleRun(lead.key) };

    items.push(
      <Frame
        key={lead.key}
        shown={lead}
        platform={platform}
        initiallyOpen={isOpen(lead)}
        hint={hint}
        run={run}
      />,
    );

    if (runOpen) {
      for (const shown of rest) {
        items.push(
          <Frame key={shown.key} shown={shown} platform={platform} initiallyOpen={false} />,
        );
      }
    }
  }

  return <div className="frames">{items}</div>;
}
