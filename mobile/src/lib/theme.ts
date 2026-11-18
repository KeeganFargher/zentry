// Sentry's design tokens, from its open-source component library
// (getsentry/sentry, static/packages/scraps/src/theme/{light,dark}.tsx and
// tokens/color.tsx), as values React Native can use. The web UI uses the same
// values (ui/src/styles.css, :root and [data-theme=dark]); keep the two in step.

export type Palette = {
  /** background.primary: screens, rows, cards. */
  bg: string;
  /** background.secondary: table headers, code, the page behind cards. */
  surface: string;
  /** background.tertiary: stack-frame headers, pressed rows, meter tracks. */
  raised: string;
  /** background.overlay: toasts, floating over the page; lighter in dark mode. */
  overlay: string;
  /** border.primary: controls and cards. */
  border: string;
  /** border.secondary: dividers between rows. */
  borderSoft: string;
  /** content.primary: body text. */
  text: string;
  /** content.headings: titles and weight-500 labels. */
  heading: string;
  /** content.secondary: supporting text. */
  muted: string;
  /**
   * content.disabled. Under 4.5:1 on the background, so only for placeholders,
   * disabled controls and line numbers, never for text someone has to read.
   */
  faint: string;
  /** background.accent.vibrant: the primary button and chart marks. */
  accent: string;
  /** The primary button's raised edge ("chonk"). */
  accentEdge: string;
  /** A selected control's fill, and the accent tag's tint. */
  accentSoft: string;
  /** A selected control's border, and the focused tab pill's edge. */
  accentLine: string;
  /** content.accent: links and selected labels. */
  link: string;
  fatal: string;
  error: string;
  warning: string;
  info: string;
  debug: string;
  /** content.success. */
  ok: string;
  /** green opaque900, Sentry's success graphic colour: the resolve swipe. */
  okFill: string;
  /** content.danger. */
  danger: string;
  /** The danger tag's tint. */
  dangerSoft: string;
  /** The warning tag's tint and text. */
  warningSoft: string;
  warningText: string;
  /** The success tag's tint. */
  okSoft: string;
  /** syntax.property: numbers and keywords in code and JSON. */
  literal: string;
  /** Text on an accent, success or danger fill. */
  onAccent: string;
};

export const LIGHT: Palette = {
  bg: "#FFFFFF",
  surface: "#F8F8F9",
  raised: "#F0F0F2",
  overlay: "#FFFFFF",
  border: "#DAD9DE",
  borderSoft: "#E6E6E9",
  text: "#302E36",
  heading: "#181225",
  muted: "#6A6772",
  faint: "#878490",
  accent: "#7553FF",
  accentEdge: "#5827D6",
  accentSoft: "#EDEEFF",
  accentLine: "#D4D3FF",
  link: "#653DE9",
  fatal: "#F42132",
  error: "#FF9838",
  warning: "#FFCE00",
  info: "#7553FF",
  debug: "#878490",
  ok: "#008900",
  okFill: "#00A71A",
  danger: "#D50000",
  dangerSoft: "#FFE7E4",
  warningSoft: "#FAF0D2",
  warningText: "#A45200",
  okSoft: "#E2F7E3",
  literal: "#653DE9",
  onAccent: "#FFFFFF",
};

// Sentry's dark borders are darker than its backgrounds: edges read as
// grooves, not outlines. That is their value, not a mistake here.
export const DARK: Palette = {
  bg: "#2E2936",
  surface: "#24202B",
  raised: "#1B1821",
  overlay: "#393442",
  border: "#141119",
  borderSoft: "#1B1821",
  text: "#E7E5EA",
  heading: "#FFFFFF",
  muted: "#B5B0BD",
  faint: "#958E9F",
  accent: "#7553FF",
  accentEdge: "#120539",
  accentSoft: "#4828B894",
  accentLine: "#4C39A5",
  link: "#ABA8F8",
  fatal: "#FF002B",
  error: "#FF9838",
  warning: "#FFCE00",
  info: "#7553FF",
  debug: "#958E9F",
  ok: "#5ECE73",
  okFill: "#00A719",
  danger: "#F6938C",
  dangerSoft: "#F8000033",
  warningSoft: "#E8380029",
  warningText: "#FFCE00",
  okSoft: "#00F8001F",
  literal: "#ABA8F8",
  onAccent: "#FFFFFF",
};

/** Sentry sets text in Rubik at two weights only: 400 and 500. */
export const FONTS = {
  regular: "Rubik_400Regular",
  medium: "Rubik_500Medium",
} as const;

export type Weight = keyof typeof FONTS;

/** Sentry's code face, Roboto Mono, at the same two weights. */
export const MONO = {
  regular: "RobotoMono_400Regular",
  medium: "RobotoMono_500Medium",
} as const;

/** Sentry's radii: 4 for tags, 8 for buttons, fields and cards. */
export const RADIUS = { sm: 4, md: 8, lg: 12 } as const;

export const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

/** Sentry's form heights, raised to the 44-point touch target where tapped. */
export const CONTROL = { touch: 44, compact: 36 } as const;

/** A string, not just a Level: breadcrumbs carry whatever level the SDK sent. */
export function levelColor(palette: Palette, level: string): string {
  switch (level) {
    case "fatal": {
      return palette.fatal;
    }

    case "error": {
      return palette.error;
    }

    case "warning": {
      return palette.warning;
    }

    case "info": {
      return palette.info;
    }

    default: {
      return palette.debug;
    }
  }
}
