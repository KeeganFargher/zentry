// The web UI's line icons (ui/src/components/icons.tsx), drawn with
// react-native-svg on the same 16-pixel grid, plus the few the app adds.

import type { JSX } from "react";
import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";

import { usePalette } from "~/lib/preferences";

const PATHS = {
  issues: "M2.5 3.5h11v9h-11zM2.5 8h3l1 1.5h3L10.5 8h3",
  // Sentry's IconTimer stand-in for Monitors: a pulse line across a heartbeat.
  monitors: "M1.5 8.5h3l1.5-4 3 8 1.5-4h4",
  projects: "M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z",
  search: "M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM10.6 10.6L14 14",
  user: "M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2.5 14c.6-2.6 2.8-4 5.5-4s4.9 1.4 5.5 4",
  release: "M2.5 5.5L8 2.5l5.5 3v5L8 13.5l-5.5-3zM2.5 5.5L8 8.5l5.5-3M8 8.5v5",
  environment: "M2.5 3.5h11v7h-11zM6 13.5h4M8 10.5v3",
  globe: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12",
  previous: "M10 3L5 8l5 5",
  next: "M6 3l5 5-5 5",
  sun: "M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1",
  moon: "M13 9.5A5.5 5.5 0 0 1 6.5 3 5.5 5.5 0 1 0 13 9.5z",
  copy: "M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3",
  play: "M5 3l8 5-8 5z",
  pause: "M5 3v10M11 3v10",
  more: "M3.5 8h.01M8 8h.01M12.5 8h.01",
  chevron: "M4 6l4 4 4-4",
  menu: "M2.5 4h11M2.5 8h11M2.5 12h11",
  http: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM5.5 8h5M8.5 6l2 2-2 2",
  console: "M2.5 3.5h11v9h-11zM5 7l2 1.5L5 10M8.5 10.5h2.5",
  cursor: "M4 2.5l8 4.5-3.5 1L7 12z",
  navigation: "M2.5 8h11M9.5 4l4 4-4 4",
  error: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM6 6l4 4M10 6l-4 4",
  warning: "M8 2.5l6 10.5H2zM8 6.5v3M8 11.5h.01",
  info: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM8 7.5v3.5M8 5h.01",
  query:
    "M8 5c3 0 5.5-.9 5.5-2S11 1 8 1 2.5 1.9 2.5 3 5 5 8 5zM2.5 3v10c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V3M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2",
  device: "M4.5 1.5h7v13h-7zM7 12.5h2",
  os: "M2 3.5h12v8H2zM5.5 14h5",
  code: "M5.5 4L1.5 8l4 4M10.5 4l4 4-4 4",
  sortDown: "M8 3v10M4 9l4 4 4-4",
  first: "M4 3v10M12 3L7 8l5 5",
  last: "M12 3v10M4 3l5 5-5 5",
  sort: "M5 3v10M5 13l-2.5-2.5M5 13l2.5-2.5M11 13V3M11 3L8.5 5.5M11 3l2.5 2.5",
  settings:
    "M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4",
  bell: "M4 11V7a4 4 0 0 1 8 0v4l1.5 1.5h-11zM6.5 14h3",
  check: "M3 8.5l3 3 7-7",
  archive: "M2 3.5h12v3H2zM3 6.5v7h10v-7M6.5 9h3",
  close: "M4 4l8 8M12 4l-8 8",
  scan: "M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3M4.5 8h7",
};

export type IconName = keyof typeof PATHS;

type IconProps = { name: IconName; size?: number; color?: ColorValue };

export function Icon({ name, size = 16, color }: IconProps): JSX.Element {
  const palette = usePalette();

  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <Path
        d={PATHS[name]}
        stroke={color ?? palette.muted}
        strokeWidth={name === "more" ? 2.4 : 1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
