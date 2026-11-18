// Sentry's "chonky" buttons: a surface raised 2px above a solid edge, which
// drops onto it when pressed, alone or joined into a bar.

import type { JSX, ReactNode } from "react";
import { Pressable, View } from "react-native";
import type { ViewStyle } from "react-native";

import { usePalette } from "~/lib/preferences";
import { CONTROL, RADIUS, SPACE } from "~/lib/theme";
import type { Palette } from "~/lib/theme";

import { Icon } from "./icons";
import type { IconName } from "./icons";
import { Text } from "./text";
import type { Tone } from "./text";

type ButtonKind = "default" | "primary" | "danger";

/** Where a button sits in a joined bar; its outer corners stay round. */
export type Join = "alone" | "first" | "middle" | "last";

type ButtonProps = {
  /** Shown, or for an icon-only button, read out by TalkBack. */
  label: string;
  onPress: () => void;
  kind?: ButtonKind;
  icon?: IconName;
  /** Draws the icon alone, as a square button. */
  iconOnly?: boolean;
  /** Trails the label, for buttons that open a menu. */
  chevron?: boolean;
  disabled?: boolean;
  /** Shows the button pressed in, for the chosen option of a segmented bar. */
  selected?: boolean;
  /** Takes the free width of its row. */
  grow?: boolean;
  join?: Join;
  height?: number;
  /**
   * An option of a segmented control: regular weight, and secondary text
   * until chosen, as Sentry's segmented control draws its options.
   */
  segment?: boolean;
};

type Colors = { fill: string; edge: string; tone: Tone };

const KIND_COLORS: Record<ButtonKind, (palette: Palette) => Colors> = {
  primary: (palette) => ({ fill: palette.accent, edge: palette.accentEdge, tone: "onAccent" }),
  danger: (palette) => ({ fill: palette.bg, edge: palette.border, tone: "danger" }),
  default: (palette) => ({ fill: palette.bg, edge: palette.border, tone: "heading" }),
};

function buttonColors(palette: Palette, kind: ButtonKind, selected: boolean): Colors {
  return selected
    ? { fill: palette.accentSoft, edge: palette.accentLine, tone: "link" }
    : KIND_COLORS[kind](palette);
}

function rounding(join: Join): ViewStyle {
  const left = join === "alone" || join === "first" ? RADIUS.md : 0;
  const right = join === "alone" || join === "last" ? RADIUS.md : 0;

  return {
    borderTopLeftRadius: left,
    borderBottomLeftRadius: left,
    borderTopRightRadius: right,
    borderBottomRightRadius: right,
  };
}

/** Sentry's buttons sit 2px above their edge and drop onto it when pressed. */
const LIFT = 2;

type Resolved = Required<Omit<ButtonProps, "icon">> & Pick<ButtonProps, "icon">;

function withDefaults(props: ButtonProps): Resolved {
  return {
    kind: "default",
    iconOnly: false,
    chevron: false,
    disabled: false,
    selected: false,
    grow: false,
    join: "alone",
    height: CONTROL.touch,
    segment: false,
    ...props,
  };
}

type FaceProps = { button: Resolved; colors: Colors; sunk: boolean };

/** The raised surface, with the icon and label on it. */
function Face({ button, colors, sunk }: FaceProps): JSX.Element {
  const palette = usePalette();
  const tone = button.segment && !button.selected ? "muted" : colors.tone;
  const ink = palette[tone];

  return (
    <View
      style={[
        rounding(button.join),
        {
          height: button.height - LIFT,
          marginTop: sunk ? LIFT : 0,
          // Dark mode's selected fill is translucent; lay it over the page, not the edge.
          backgroundColor: palette.bg,
        },
      ]}
    >
      <View
        style={[
          rounding(button.join),
          {
            flex: 1,
            borderWidth: 1,
            borderColor: colors.edge,
            backgroundColor: colors.fill,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            paddingHorizontal: button.iconOnly ? 0 : SPACE.md,
          },
        ]}
      >
        {button.icon !== undefined && <Icon name={button.icon} color={ink} />}
        {!button.iconOnly && (
          <Text
            weight={button.segment ? "regular" : "medium"}
            tone={tone}
            lines={1}
            style={{ flexShrink: 1 }}
          >
            {button.label}
          </Text>
        )}
        {button.chevron && <Icon name="chevron" size={14} color={ink} />}
      </View>
    </View>
  );
}

/**
 * Two views rather than a box shadow: an edge in the chonk colour behind the
 * bottom of the face, and the face lifted 2px off it. Only the edge's lowest
 * 2px show; pressed, the face drops onto it and nothing shows above. A
 * zero-blur shadow does not render the same on every Android version; views do.
 */
export function Button(props: ButtonProps): JSX.Element {
  const palette = usePalette();
  const button = withDefaults(props);
  const colors = buttonColors(palette, button.kind, button.selected);
  // A short segmented button still takes a 44-point tap. Android only honours
  // slop inside the parent's bounds, so its parent must be 44 high (Segmented is).
  const slop = (CONTROL.touch - button.height) / 2;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={button.label}
      accessibilityState={{ disabled: button.disabled, selected: button.selected }}
      onPress={button.onPress}
      disabled={button.disabled}
      hitSlop={{ top: slop, bottom: slop }}
      style={[
        rounding(button.join),
        {
          height: button.height,
          flexGrow: button.grow ? 1 : 0,
          flexBasis: button.grow ? 0 : "auto",
          minWidth: button.iconOnly ? button.height : undefined,
          marginLeft: button.join === "middle" || button.join === "last" ? -1 : 0,
          opacity: button.disabled ? 0.6 : 1,
        },
      ]}
    >
      {({ pressed }) => (
        <>
          <View
            style={[
              rounding(button.join),
              {
                position: "absolute",
                left: 0,
                right: 0,
                top: LIFT,
                bottom: 0,
                backgroundColor: colors.edge,
              },
            ]}
          />
          <Face button={button} colors={colors} sunk={pressed || button.selected} />
        </>
      )}
    </Pressable>
  );
}

/** Joined buttons, as Sentry's button bars and dropdown groups. */
export function ButtonBar({ children }: { children: ReactNode }): JSX.Element {
  return <View style={{ flexDirection: "row" }}>{children}</View>;
}

/** Which button of `count` sits at `index` in a joined bar. */
export function joinAt(index: number, count: number): Join {
  if (count === 1) {
    return "alone";
  }

  if (index === 0) {
    return "first";
  }

  return index === count - 1 ? "last" : "middle";
}
