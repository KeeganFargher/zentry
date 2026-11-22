// Keeps the cache fresh while the app is not on screen, so opening it shows
// what is true now rather than what was true when it was last closed. Two
// things wake it:
//
// - Every push. Expo sends Android pushes as FCM data messages, which reach
//   the app's own handler even when it is closed (expo-notifications draws
//   the notification itself), so the notification task runs for each one,
//   whatever state the app is in. A push means something just changed.
// - WorkManager, about hourly (expo-background-task), for the changes no push
//   announces: someone resolving issues on the web, a monitor recovering.
//
// Both fetch what the app opens on (the default issue list, projects,
// monitors) into the shared cache (cache.ts) and write it to disk. The JS
// runtime may have been started just for the task, with no React tree, so
// nothing here reaches for a provider: the session and the organization come
// from the keystore, as on a cold start.
//
// The tasks are defined when this module loads, and it loads first (index.ts):
// a task the runtime is started for must exist before anything else runs.

import type { ApiOrganization, PushData } from "@contract";
import * as BackgroundTask from "expo-background-task";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";

import { DEFAULT_FILTERS, filterQuery } from "~/screens/issues/filters";

import { Api } from "./api";
import { queryClient, restoreCache, saveCache } from "./cache";
import { pickOrganization } from "./organization";
import { storedOrganization } from "./preferences";
import { receivedPush } from "./push";
import {
  eventQuery,
  issueListQuery,
  issueQuery,
  meQuery,
  monitorsQuery,
  projectsQuery,
} from "./queries";
import { loadSession } from "./session";

const PUSH_TASK = "zentry.refresh-on-push";
const SCHEDULED_TASK = "zentry.refresh-hourly";

/**
 * Anything fetched this recently is not fetched again. Alerts come in bursts
 * (a deploy can open a dozen issues), and a paired phone has one rate limit
 * (120 requests a minute) shared with the screens; without this, every push
 * of a burst would refetch the same lists.
 */
const FRESH = { staleTime: 10_000 };

/** Why a refresh runs: a push from the Worker, or routine (the hourly schedule, or a push it cannot read). */
type Reason = { kind: "push"; push: PushData } | { kind: "routine" };

/**
 * A push names its organization, and opening it switches to that one; the
 * schedule refreshes the one in view, which is the first until one is chosen.
 */
async function organizationFor(
  reason: Reason,
  all: ApiOrganization[],
): Promise<ApiOrganization | null> {
  const chosen = reason.kind === "push" ? reason.push.organization : await storedOrganization();

  return chosen === null ? (all[0] ?? null) : pickOrganization(all, chosen);
}

/** What the app opens on, and for an issue push the issue and its latest event. */
function prefetch(api: Api, org: string, reason: Reason): Promise<unknown>[] {
  const fetches: Promise<unknown>[] = [
    queryClient.fetchInfiniteQuery({
      ...issueListQuery(api, org, filterQuery(DEFAULT_FILTERS)),
      ...FRESH,
    }),
    queryClient.fetchQuery({ ...projectsQuery(api, org), ...FRESH }),
    queryClient.fetchQuery({ ...monitorsQuery(api, org), ...FRESH }),
  ];

  // Tapping the push opens this issue on its latest event, so both are ready
  // by then. The event stays in memory only (queries.ts), which still counts:
  // a notification is usually tapped while the runtime it woke is alive.
  if (reason.kind === "push" && reason.push.kind === "issue") {
    const issue = { org, issueId: reason.push.issueId };

    fetches.push(
      queryClient.fetchQuery({ ...issueQuery(api, issue), ...FRESH }),
      queryClient.fetchQuery({ ...eventQuery(api, issue, "latest"), ...FRESH }),
    );
  }

  return fetches;
}

async function refresh(reason: Reason): Promise<void> {
  const session = await loadSession();

  // Signed out since the tasks were registered: there is no one to fetch for.
  if (session === null) {
    return;
  }

  // A 401 here signs nothing out. The UI's next request gets the same answer
  // and signs out there, where it can say why.
  const api = new Api(session, () => {});

  // The runtime may have been started for this task, with an empty client.
  // With the UI up, this hydrates nothing newer than what it already holds.
  await restoreCache();

  const me = await queryClient.fetchQuery({ ...meQuery(api), ...FRESH });
  const organization = await organizationFor(reason, me.organizations);

  if (organization === null) {
    return;
  }

  await Promise.all(prefetch(api, organization.slug, reason));
  // The UI's provider saves on every change too, but with no UI up nothing
  // else would, and the runtime may stop as soon as the task returns.
  await saveCache();
}

TaskManager.defineTask<Notifications.NotificationTaskPayload>(
  PUSH_TASK,
  async ({ data, error }) => {
    if (error !== null) {
      throw new Error(`push task: ${error.message}`);
    }

    // On Android the task also runs for a tap on the notification. The UI
    // opens taps (push-state.tsx), and the push behind it already refreshed.
    if ("actionIdentifier" in data) {
      return;
    }

    // The Worker's data, as Expo carries it in the FCM message: JSON text.
    const text = data.data.dataString;
    const push = text === undefined ? null : receivedPush(text);

    // A push this app did not send still says something may have changed.
    await refresh(push === null ? { kind: "routine" } : { kind: "push", push });
  },
);

TaskManager.defineTask(SCHEDULED_TASK, async ({ error }) => {
  if (error !== null) {
    throw new Error(`scheduled refresh: ${error.message}`);
  }

  await refresh({ kind: "routine" });

  return BackgroundTask.BackgroundTaskResult.Success;
});

/**
 * Starts both tasks for a signed-in phone. Registrations outlive the app, so
 * this is idempotent, and signing out needs no matching call: the tasks find
 * no session and stop there.
 */
export async function startBackgroundRefresh(): Promise<void> {
  await Notifications.registerTaskAsync(PUSH_TASK);
  // WorkManager's floor is 15 minutes. Hourly keeps the list current enough
  // to open on, for a few requests an hour and little battery.
  await BackgroundTask.registerTaskAsync(SCHEDULED_TASK, { minimumInterval: 60 });
}
