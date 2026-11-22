// What this phone remembers about how to show things: the theme and the
// organization in view. Both are this device's choice, so they stay on it.

import * as SecureStore from "expo-secure-store";
import { createContext, use, useCallback, useEffect, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";
import { useColorScheme } from "react-native";

import { DARK, LIGHT } from "./theme";
import type { Palette } from "./theme";

export type ThemeChoice = "system" | "light" | "dark";

const THEME_KEY = "zentry.theme";
const ORG_KEY = "zentry.organization";

const THEMES: ThemeChoice[] = ["system", "light", "dark"];

/** The organization last viewed, for the background tasks, which have no provider. */
export function storedOrganization(): Promise<string | null> {
  return SecureStore.getItemAsync(ORG_KEY);
}

type Preferences = {
  ready: boolean;
  theme: ThemeChoice;
  setTheme: (theme: ThemeChoice) => void;
  /** The organization slug last viewed; null until one is chosen. */
  organization: string | null;
  setOrganization: (slug: string) => void;
  palette: Palette;
  dark: boolean;
};

const PreferencesContext = createContext<Preferences | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }): JSX.Element {
  const scheme = useColorScheme();
  const [ready, setReady] = useState(false);
  const [theme, setThemeState] = useState<ThemeChoice>("system");
  const [organization, setOrganizationState] = useState<string | null>(null);

  useEffect(() => {
    const restore = async (): Promise<void> => {
      const [storedTheme, storedOrg] = await Promise.all([
        SecureStore.getItemAsync(THEME_KEY),
        storedOrganization(),
      ]);

      setThemeState(THEMES.find((choice) => choice === storedTheme) ?? "system");
      setOrganizationState(storedOrg);
      setReady(true);
    };

    void restore();
  }, []);

  const setTheme = useCallback((next: ThemeChoice) => {
    setThemeState(next);
    void SecureStore.setItemAsync(THEME_KEY, next);
  }, []);

  const setOrganization = useCallback((slug: string) => {
    setOrganizationState(slug);
    void SecureStore.setItemAsync(ORG_KEY, slug);
  }, []);

  const dark = theme === "system" ? scheme === "dark" : theme === "dark";

  const value = useMemo(
    () => ({
      ready,
      theme,
      setTheme,
      organization,
      setOrganization,
      palette: dark ? DARK : LIGHT,
      dark,
    }),
    [ready, theme, setTheme, organization, setOrganization, dark],
  );

  return <PreferencesContext value={value}>{children}</PreferencesContext>;
}

export function usePreferences(): Preferences {
  const preferences = use(PreferencesContext);

  if (preferences === null) {
    throw new Error("usePreferences outside PreferencesProvider");
  }

  return preferences;
}

export function usePalette(): Palette {
  return usePreferences().palette;
}
