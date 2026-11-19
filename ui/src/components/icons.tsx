// The handful of line icons the UI needs, drawn on a 16-pixel grid.

import type { JSX } from "react";

const PATHS = {
  issues: "M2.5 3.5h11v9h-11zM2.5 8h3l1 1.5h3L10.5 8h3",
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
  sort: "M5 3v10M5 13l-2.5-2.5M5 13l2.5-2.5M11 13V3M11 3L8.5 5.5M11 3l2.5 2.5",
  monitor:
    "M4 12.5V8.5a4 4 0 0 1 8 0v4M2.5 12.5h11M8 2.5V1M3.5 4.5l-1-1M12.5 4.5l1-1M6 8.5a2 2 0 0 1 2-2",
  add: "M8 3v10M3 8h10",
  edit: "M10.5 2.5l3 3-8 8h-3v-3z",
  check: "M3 8.5l3 3 7-7",
  timer: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM8 5v3l2 1.5",
  mail: "M2.5 3.5h11v9h-11zM2.5 4l5.5 4.5L13.5 4",
  mobile: "M5 1.5h6v13H5zM7.5 12.5h1",
  fire: "M8 14c-2.5 0-4.5-1.8-4.5-4.3C3.5 6.5 7 5.5 7 2c2.5 1.5 3 3.5 2.7 5 1-.4 1.5-1.4 1.6-2.2 1.2 1.2 2.2 2.8 2.2 4.9C13.5 12.2 11 14 8 14z",
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "more" ? 2.4 : 1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
