// Push notifications on this phone. DESIGN.md §19.
//
// The Worker sends through Expo's push service, which hands Android pushes to
// FCM. That needs two things in the build, both from the Expo and Firebase
// projects that own this app (mobile/README.md, Push): the Expo project id in
// app.json (`extra.eas.projectId`) and android/google-services.json. Without
// them registering fails, and the reason is shown in Settings rather than
// hidden: a phone that silently gets no alerts is worse than one that says so.

import type { PushChannel, PushData } from "@contract";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { z } from "zod";

import type { Api } from "./api";

/** One Android channel per type, so each can be muted in the phone's own settings. */
const CHANNELS: [PushChannel, string, string, Notifications.AndroidImportance][] = [
  ["alerts", "Issue alerts", "New issues and regressions", Notifications.AndroidImportance.HIGH],
  [
    "workflow",
    "Workflow",
    "Issues resolved, archived or reopened",
    Notifications.AndroidImportance.DEFAULT,
  ],
  [
    "spikeProtection",
    "Spike protection",
    "A project's events refused after a burst",
    Notifications.AndroidImportance.HIGH,
  ],
  ["quota", "Quota", "The monthly event cap", Notifications.AndroidImportance.DEFAULT],
];

/** Shows pushes that arrive while the app is open, too: they are what the user asked for. */
export function showPushesInForeground(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

async function createChannels(): Promise<void> {
  for (const [id, name, description, importance] of CHANNELS) {
    await Notifications.setNotificationChannelAsync(id, { name, description, importance });
  }
}

export type PushState =
  | { status: "on" }
  | { status: "denied" }
  | { status: "failed"; error: string };

/**
 * From the app config every build embeds, not `Constants.easConfig`: only
 * standalone and EAS Update manifests fill that, so a development build
 * reported "no project id" though app.json has one.
 */
const EasConfig = z.object({ eas: z.object({ projectId: z.string() }) });

function projectId(): string | null {
  const parsed = EasConfig.safeParse(Constants.expoConfig?.extra);

  return parsed.success ? parsed.data.eas.projectId : null;
}

async function permitted(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();

  if (current.granted) {
    return true;
  }

  // Android 13 and later ask; older versions grant at install.
  return (await Notifications.requestPermissionsAsync()).granted;
}

/**
 * Asks for permission, gets this install's Expo push token, and gives it to
 * the Worker. Runs on every sign-in and app start: a token can change, and
 * the Worker moves it to the newest device row.
 */
export async function registerForPush(api: Api): Promise<PushState> {
  await createChannels();

  if (!(await permitted())) {
    await api.clearPushToken();

    return { status: "denied" };
  }

  const id = projectId();

  if (id === null) {
    return {
      status: "failed",
      error:
        "This build has no Expo project id (app.json, extra.eas.projectId). See mobile/README.md.",
    };
  }

  try {
    const { data } = await Notifications.getExpoPushTokenAsync({ projectId: id });

    await api.setPushToken(data);

    return { status: "on" };
  } catch (cause) {
    return {
      status: "failed",
      error: cause instanceof Error ? cause.message : "Registration failed",
    };
  }
}

// A push's `data` is JSON that crossed Expo and FCM, so it is parsed here,
// where it enters the app, against the contract the Worker built it from.
const PushDataSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("issue"), organization: z.string(), issueId: z.number() }),
  z.object({ kind: z.literal("issues"), organization: z.string(), projectId: z.number() }),
  z.object({ kind: z.literal("settings"), organization: z.string() }),
]) satisfies z.ZodType<PushData>;

/** What a tapped push should open; null for one this app did not send. */
export function tappedPush(response: Notifications.NotificationResponse): PushData | null {
  const parsed = PushDataSchema.safeParse(response.notification.request.content.data);

  return parsed.success ? parsed.data : null;
}
