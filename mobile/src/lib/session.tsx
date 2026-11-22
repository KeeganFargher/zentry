// Who this phone is signed in as. Pairing stores the API origin and the device
// token in the Android keystore (expo-secure-store); signing out, here or from
// the web UI, removes them. DESIGN.md §19.

import * as SecureStore from "expo-secure-store";
import { createContext, use, useCallback, useEffect, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";

import { Api } from "./api";

export type Session = {
  apiUrl: string;
  token: string;
  email: string;
  deviceId: number;
};

// One key per field: SecureStore holds strings, and parsing JSON back out of
// it would need a schema for what this app wrote itself.
const KEYS = {
  apiUrl: "zentry.apiUrl",
  token: "zentry.token",
  email: "zentry.email",
  deviceId: "zentry.deviceId",
} as const;

/** The stored session; also read by the background tasks, which have no provider. */
export async function loadSession(): Promise<Session | null> {
  const [apiUrl, token, email, deviceId] = await Promise.all([
    SecureStore.getItemAsync(KEYS.apiUrl),
    SecureStore.getItemAsync(KEYS.token),
    SecureStore.getItemAsync(KEYS.email),
    SecureStore.getItemAsync(KEYS.deviceId),
  ]);

  if (apiUrl === null || token === null || email === null || deviceId === null) {
    return null;
  }

  const id = Number(deviceId);

  // Written by save() below from a number; anything else is a corrupt keystore.
  if (!Number.isInteger(id)) {
    throw new Error(`stored device id is not a number: ${deviceId}`);
  }

  return { apiUrl, token, email, deviceId: id };
}

async function save(session: Session): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(KEYS.apiUrl, session.apiUrl),
    SecureStore.setItemAsync(KEYS.token, session.token),
    SecureStore.setItemAsync(KEYS.email, session.email),
    SecureStore.setItemAsync(KEYS.deviceId, String(session.deviceId)),
  ]);
}

async function forget(): Promise<void> {
  await Promise.all(Object.values(KEYS).map((key) => SecureStore.deleteItemAsync(key)));
}

/** Why the phone is on the sign-in screen, when it was not the user's choice. */
export type SignedOutReason = "revoked" | null;

type SessionState = {
  /** False until the keystore has been read. */
  ready: boolean;
  session: Session | null;
  api: Api | null;
  signedOutReason: SignedOutReason;
  signIn: (session: Session) => Promise<void>;
  /** Forgets the token on this phone. The server side is the caller's job. */
  signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }): JSX.Element {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [signedOutReason, setSignedOutReason] = useState<SignedOutReason>(null);

  useEffect(() => {
    const restore = async (): Promise<void> => {
      setSession(await loadSession());
      setReady(true);
    };

    void restore();
  }, []);

  const signIn = useCallback(async (next: Session) => {
    await save(next);
    setSignedOutReason(null);
    setSession(next);
  }, []);

  const signOut = useCallback(async () => {
    await forget();
    setSession(null);
  }, []);

  // A 401 means the token is gone on the server (signed out from the web UI),
  // so this phone forgets it too and says why.
  const api = useMemo(
    () =>
      session === null
        ? null
        : new Api(session, () => {
            setSignedOutReason("revoked");
            void forget().then(() => setSession(null));
          }),
    [session],
  );

  const value = useMemo(
    () => ({ ready, session, api, signedOutReason, signIn, signOut }),
    [ready, session, api, signedOutReason, signIn, signOut],
  );

  return <SessionContext value={value}>{children}</SessionContext>;
}

export function useSession(): SessionState {
  const state = use(SessionContext);

  if (state === null) {
    throw new Error("useSession outside SessionProvider");
  }

  return state;
}

/** The API client of a signed-in screen. Only screens behind the sign-in gate call this. */
export function useApi(): Api {
  const { api } = useSession();

  if (api === null) {
    throw new Error("useApi on a screen that is not behind the sign-in gate");
  }

  return api;
}
