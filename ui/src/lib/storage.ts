// Per-browser preferences (sort order, folded sections, live updates).
// Storage can be refused in private windows, so every access is guarded and
// a missing value falls back to the default.

import { useState } from "react";

const PREFIX = "zentry:";

export function readSetting(key: string): string | null {
  try {
    return window.localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function writeSetting(key: string, value: string | null): void {
  try {
    if (value === null) {
      window.localStorage.removeItem(PREFIX + key);
    } else {
      window.localStorage.setItem(PREFIX + key, value);
    }
  } catch {
    // The setting then lasts until the page is reloaded.
  }
}

/** A remembered on/off switch. */
export function useFlag(key: string, initial: boolean): [on: boolean, set: (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    const saved = readSetting(key);

    return saved === null ? initial : saved === "1";
  });

  const set = (next: boolean): void => {
    writeSetting(key, next ? "1" : "0");
    setOn(next);
  };

  return [on, set];
}

/** A remembered choice from a fixed set of values. */
export function useChoice<T extends string>(
  key: string,
  choices: readonly [T, ...T[]],
): [value: T, set: (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const saved = readSetting(key);

    return choices.find((choice) => choice === saved) ?? choices[0];
  });

  const set = (next: T): void => {
    writeSetting(key, next);
    setValue(next);
  };

  return [value, set];
}
