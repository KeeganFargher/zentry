// Light and dark themes. index.html sets the starting theme before first
// paint (the saved choice, else the system's); this switches and saves it.

import { useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "zentry:theme";

function currentTheme(): Theme {
  return document.documentElement.dataset["theme"] === "dark" ? "dark" : "light";
}

function save(theme: Theme): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Private windows can refuse storage; the choice then lasts for this page only.
  }
}

/** The active theme and a function that flips it. */
export function useTheme(): [theme: Theme, toggle: () => void] {
  const [theme, setTheme] = useState(currentTheme);

  const toggle = (): void => {
    const next = theme === "dark" ? "light" : "dark";

    document.documentElement.dataset["theme"] = next;
    save(next);
    setTheme(next);
  };

  return [theme, toggle];
}
