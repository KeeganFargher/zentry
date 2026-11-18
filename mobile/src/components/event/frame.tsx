// One stack frame: a grey header row naming where it is, as Sentry draws
// them, which opens to show its source and variables. Library frames are
// dimmed, as on the web.

import type { StoredFrame } from "@contract";
import { useState } from "react";
import type { JSX } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { AccessibilityProps } from "react-native";

import { Tag } from "~/components/basics";
import { Icon } from "~/components/icons";
import { Text } from "~/components/text";
import { usePalette } from "~/lib/preferences";
import { SPACE } from "~/lib/theme";

import { fileName, fullPath, isExpandable, position } from "./frame-model";
import type { Shown } from "./frame-model";
import { FrameBody } from "./frame-source";
import { plural } from "./lists";
import { LinkButton } from "./parts";

const styles = StyleSheet.create({
  frame: { borderTopWidth: 1, marginTop: -1 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.sm,
    minHeight: 44,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  main: { flex: 1, gap: 2 },
  badges: { alignItems: "flex-end", gap: SPACE.xs },
  library: { opacity: 0.72 },
});

export type RunControl = { count: number; open: boolean; onToggle: () => void };

/**
 * The binary or module a frame lives in, unless it's already the frame's
 * name. Not on the web, which has room for neither; asked for on the phone.
 */
function origin(frame: StoredFrame, platform: string): string | null {
  const module = platform === "java" || frame.filename === null ? null : frame.module;

  return frame.package ?? module ?? null;
}

function Title({ frame, platform }: { frame: StoredFrame; platform: string }): JSX.Element {
  const at = position(frame);
  const from = origin(frame, platform);

  return (
    <>
      {/* Not selectable: on Android selectable text eats the row's tap. */}
      <Text size={12} mono>
        <Text size={12} mono weight="medium">
          {fileName(frame, platform)}
        </Text>
        {frame.function !== null && (
          <Text size={12} mono tone="muted">
            {" "}
            in{" "}
          </Text>
        )}
        {frame.function !== null && (
          <Text size={12} mono weight="medium">
            {frame.function}
          </Text>
        )}
        {at !== null && (
          <Text size={12} mono tone="muted">
            {" "}
            at line{" "}
          </Text>
        )}
        {at !== null && (
          <Text size={12} mono weight="medium">
            {at}
          </Text>
        )}
      </Text>
      {from !== null && (
        <Text size={12} tone="muted" mono lines={1}>
          {from}
        </Text>
      )}
    </>
  );
}

function Badges({ shown }: { shown: Shown }): JSX.Element | null {
  if (shown.repeats <= 1 && !shown.frame.inApp) {
    return null;
  }

  return (
    <View style={styles.badges}>
      {shown.repeats > 1 && <Tag label={`Repeated ${shown.repeats} times`} tone="neutral" />}
      {shown.frame.inApp && <Tag label="In App" tone="accent" />}
    </View>
  );
}

/** A frame with something to show is a button; one without is plain text. */
function rowAccessibility(expandable: boolean, open: boolean): AccessibilityProps {
  return expandable
    ? { accessibilityRole: "button", accessibilityState: { expanded: open } }
    : { accessibilityRole: "none" };
}

type SummaryProps = { shown: Shown; platform: string; hint: string | null };

function Summary({ shown, platform, hint }: SummaryProps): JSX.Element {
  return (
    <View style={styles.main}>
      {hint !== null && (
        <Text size={12} tone="muted">
          {hint}
        </Text>
      )}
      <Title frame={shown.frame} platform={platform} />
    </View>
  );
}

type FrameProps = {
  shown: Shown;
  platform: string;
  initiallyOpen: boolean;
  /** "Crashed in non-app:" or "Called from:", over the lead of a library run. */
  hint: string | null;
  /** The toggle for the rest of a library run, on its lead frame only. */
  run: RunControl | null;
};

export function Frame({ shown, platform, initiallyOpen, hint, run }: FrameProps): JSX.Element {
  const palette = usePalette();
  const { frame } = shown;
  // The web shows the full path in a hover tooltip on every frame; with no
  // hover, a frame that has one opens to show it.
  const expandable = isExpandable(frame) || fullPath(frame) !== null;
  const [open, setOpen] = useState(initiallyOpen && expandable);

  return (
    <View style={[styles.frame, { borderTopColor: palette.border }]}>
      <Pressable
        {...rowAccessibility(expandable, open)}
        disabled={!expandable}
        onPress={() => setOpen(!open)}
        style={[
          styles.row,
          { backgroundColor: palette.raised },
          frame.inApp ? undefined : styles.library,
        ]}
      >
        <Summary shown={shown} platform={platform} hint={hint} />
        {/* Tags on the right of the header row, as Sentry's "In App". */}
        <Badges shown={shown} />
        {expandable && <Icon name={open ? "chevron" : "next"} size={14} />}
      </Pressable>
      {run !== null && (
        <LinkButton
          label={`${run.open ? "Hide" : "Show"} ${plural(run.count, "more frame")}`}
          onPress={run.onToggle}
        />
      )}
      {open && <FrameBody frame={frame} />}
    </View>
  );
}
