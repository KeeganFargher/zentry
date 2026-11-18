// Text in Sentry's type: Rubik at 400 and 500, Roboto Mono for code, on a
// 1.4 line height; with its section headings and small uppercase labels.

import type { JSX, ReactNode } from "react";
import { Text as NativeText } from "react-native";
import type { StyleProp, TextStyle } from "react-native";

import { usePalette } from "~/lib/preferences";
import { FONTS, MONO } from "~/lib/theme";
import type { Weight } from "~/lib/theme";

export type Tone = "text" | "heading" | "muted" | "faint" | "link" | "danger" | "ok" | "onAccent";

type TextProps = {
  children: ReactNode;
  size?: number;
  weight?: Weight;
  tone?: Tone;
  mono?: boolean;
  lines?: number;
  selectable?: boolean;
  style?: StyleProp<TextStyle>;
};

export function Text(props: TextProps): JSX.Element {
  const palette = usePalette();
  const size = props.size ?? 14;

  const base: TextStyle = {
    color: palette[props.tone ?? "text"],
    fontSize: size,
    // Sentry's body line height.
    lineHeight: Math.round(size * 1.4),
    fontFamily: (props.mono === true ? MONO : FONTS)[props.weight ?? "regular"],
  };

  return (
    <NativeText
      style={[base, props.style]}
      numberOfLines={props.lines}
      selectable={props.selectable}
    >
      {props.children}
    </NativeText>
  );
}

/** A section's title, as Sentry's 16px medium headings. */
export function Heading({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Text size={16} weight="medium" tone="heading">
      {children}
    </Text>
  );
}

/** Sentry's small uppercase label, as on its table headers. */
export function SectionTitle({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Text
      size={12}
      weight="medium"
      tone="muted"
      style={{ textTransform: "uppercase", letterSpacing: 0.3 }}
    >
      {children}
    </Text>
  );
}
