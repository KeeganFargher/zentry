// Sentry's segmented control: one choice of a few, as joined buttons with the
// chosen one pressed in.

import type { JSX } from "react";
import { View } from "react-native";

import { CONTROL } from "~/lib/theme";

import { Button, joinAt } from "./button";

type SegmentedProps<T extends string> = {
  options: readonly (readonly [value: T, label: string])[];
  value: T;
  onChange: (value: T) => void;
  /** What the choice is about, for TalkBack: "Frame order". */
  label: string;
  /** Shares the row's width out between the options. */
  fill?: boolean;
};

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  fill = false,
}: SegmentedProps<T>): JSX.Element {
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      // 44 high around 36-high buttons, so their hit slop has room on Android.
      style={{
        flexDirection: "row",
        alignItems: "center",
        minHeight: CONTROL.touch,
        alignSelf: fill ? "stretch" : "flex-start",
      }}
    >
      {options.map(([option, text], index) => (
        <Button
          key={option}
          label={text}
          selected={option === value}
          join={joinAt(index, options.length)}
          height={CONTROL.compact}
          segment
          grow={fill}
          onPress={() => onChange(option)}
        />
      ))}
    </View>
  );
}
