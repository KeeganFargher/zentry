// The frames of one stack trace, ported from ui/src/pages/frames.tsx. In
// "Most Relevant" view each run of library frames is reduced to the one
// nearest the crash, which carries a toggle for the rest of its run.

import { useState } from "react";
import type { JSX } from "react";
import { View } from "react-native";

import { usePalette } from "~/lib/preferences";
import { RADIUS } from "~/lib/theme";

import { Frame } from "./frame";
import type { RunControl } from "./frame";
import { runsOf } from "./frame-model";
import type { Shown } from "./frame-model";

type FramesProps = { frames: Shown[]; platform: string; full: boolean; expandFirst: boolean };

/** One frame as listed: its hint and run toggle when it leads a library run. */
type Item = { shown: Shown; hint: string | null; run: RunControl | null };

type Opened = { has: (key: number) => boolean; toggle: (key: number) => void };

function foldedItems(frames: Shown[], opened: Opened): Item[] {
  const items: Item[] = [];

  for (const [index, { lead, rest }] of runsOf(frames).entries()) {
    const open = opened.has(lead.key);
    const hint = lead.frame.inApp ? null : index === 0 ? "Crashed in non-app:" : "Called from:";

    const run =
      rest.length === 0
        ? null
        : { count: rest.length, open, onToggle: () => opened.toggle(lead.key) };

    items.push({ shown: lead, hint, run });

    if (open) {
      items.push(...rest.map((shown): Item => ({ shown, hint: null, run: null })));
    }
  }

  return items;
}

/**
 * `frames` are already in display order. Both views render the same flat
 * list of `Frame`s keyed by frame, so switching Most Relevant and Full keeps
 * each frame's open state, as the web's sibling frames do.
 */
export function Frames({ frames, platform, full, expandFirst }: FramesProps): JSX.Element {
  const palette = usePalette();
  const [opened, setOpened] = useState(new Set<number>());
  // Folding only helps when there is app code to fold the libraries around.
  const fold = !full && frames.some((shown) => shown.frame.inApp);
  const target = frames.find((shown) => shown.frame.inApp) ?? frames[0];

  const toggle = (key: number): void => {
    const next = new Set(opened);

    if (!next.delete(key)) {
      next.add(key);
    }

    setOpened(next);
  };

  const items = fold
    ? foldedItems(frames, { has: (key) => opened.has(key), toggle })
    : frames.map((shown): Item => ({ shown, hint: null, run: null }));

  // One bordered box, each frame a grey header row in it, as on Sentry.
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: palette.border,
        borderRadius: RADIUS.md,
        overflow: "hidden",
      }}
    >
      {items.map(({ shown, hint, run }) => (
        <Frame
          key={shown.key}
          shown={shown}
          platform={platform}
          initiallyOpen={expandFirst && shown.key === target?.key}
          hint={hint}
          run={run}
        />
      ))}
    </View>
  );
}
