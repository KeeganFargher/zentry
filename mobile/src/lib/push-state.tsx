// Registers this phone for pushes once signed in, keeps how that went for the
// Settings screen, and opens what a tapped push points at.

import type { PushData } from "@contract";
import { useQueryClient } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";

import { usePreferences } from "./preferences";
import { registerForPush, tappedPush } from "./push";
import type { PushState } from "./push";
import { useApi } from "./session";

type PushContextValue = {
  /** Null while registering. */
  state: PushState | null;
  retry: () => void;
};

const PushContext = createContext<PushContextValue | null>(null);

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Registration failed";
}

/** Opens a tapped push: the issue, a project's issues, or the settings. */
function useOpenPush(): (data: PushData) => void {
  const router = useRouter();
  const { setOrganization } = usePreferences();
  const queries = useQueryClient();

  return useCallback(
    (data: PushData) => {
      setOrganization(data.organization);
      // The push says something changed; what is cached is older than that.
      void queries.invalidateQueries();

      if (data.kind === "issue") {
        router.push({ pathname: "/issues/[id]", params: { id: String(data.issueId) } });
      } else if (data.kind === "issues") {
        router.navigate({
          pathname: "/",
          params: { project: String(data.projectId), at: String(Date.now()) },
        });
      } else {
        router.navigate("/settings");
      }
    },
    [router, setOrganization, queries],
  );
}

/** How registering went, for the attempt it answers. */
type Outcome = { attempt: number; state: PushState };

export function PushProvider({ children }: { children: ReactNode }): JSX.Element {
  const api = useApi();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [attempt, setAttempt] = useState(0);
  const open = useOpenPush();
  const last = Notifications.useLastNotificationResponse();
  const opened = useRef<string | null>(null);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  // A retry is registering again until its own outcome arrives.
  const state = outcome?.attempt === attempt ? outcome.state : null;

  useEffect(() => {
    let current = true;

    const register = async (): Promise<void> => {
      let result: PushState;

      try {
        result = await registerForPush(api);
      } catch (cause) {
        result = { status: "failed", error: errorText(cause) };
      }

      if (current) {
        setOutcome({ attempt, state: result });
      }
    };

    void register();

    return () => {
      current = false;
    };
  }, [api, attempt]);

  // The last response survives re-renders, app restarts and signing in
  // again, so each is opened once and then cleared: a push from before a
  // sign-out must not open after the next sign-in.
  useEffect(() => {
    const id = last?.notification.request.identifier ?? null;
    const data = last === null || last === undefined ? null : tappedPush(last);

    if (id !== null && opened.current !== id) {
      opened.current = id;
      Notifications.clearLastNotificationResponse();

      if (data !== null) {
        open(data);
      }
    }
  }, [last, open]);

  // FCM can rotate this install's token while the app runs; the Worker must
  // learn the new one, or pushes stop until the next start. The listener also
  // fires whenever registering fetches the token, with the same value, so only
  // a token different from the last one seen counts: retrying on every event
  // re-registered forever and left Settings on "Registering…". The first
  // event comes from the start-up registration itself, so it is only noted.
  const seenToken = useRef<string | null>(null);

  useEffect(() => {
    const subscription = Notifications.addPushTokenListener((token) => {
      const data = String(token.data);
      const rotated = seenToken.current !== null && seenToken.current !== data;

      seenToken.current = data;

      if (rotated) {
        retry();
      }
    });

    return () => subscription.remove();
  }, [retry]);

  const value = useMemo(() => ({ state, retry }), [state, retry]);

  return <PushContext value={value}>{children}</PushContext>;
}

export function usePush(): PushContextValue {
  const value = use(PushContext);

  if (value === null) {
    throw new Error("usePush outside PushProvider");
  }

  return value;
}
