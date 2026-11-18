// Signing phones in to the mobile app, listing and revoking them, and their
// push tokens. DESIGN.md §19.
//
// The web UI (behind Access) asks for a pairing code and shows it as a QR
// code. The app scans it and trades the code for a device token at
// `POST /api/0/pair/`, which needs no sign-in: holding the code is the proof.
// The code is single-use, works for ten minutes and has 128 random bits, so
// guessing one is hopeless; that is why the exchange has no rate limit.

import { z } from "zod";

import type { DeviceRecord } from "@/db/devices";
import type { ApiDevice, ApiDeviceList, ApiPaired, ApiPairing } from "@/shared/contract";
import { newDeviceToken, newPairingCode, sha256Hex } from "@/shared/ids";

import type { ApiDeps, UserHandler } from "./context";
import { forbidden, IdParam, noContent, notFound, readBody, readParams } from "./http";

const PairBody = z.object({
  code: z.string().regex(/^[0-9a-f]{32}$/, "must be a pairing code"),
  name: z.string().trim().min(1).max(100),
});

// Expo's token format. Anything else would be refused by Expo at send time;
// refusing it here says so to the app, which can show it.
const PushBody = z.object({
  pushToken: z
    .string()
    .regex(/^Expo(nent)?PushToken\[[\w-]+\]$/, "must be an Expo push token")
    .nullable(),
});

function toApiDevice(device: DeviceRecord, current: boolean): ApiDevice {
  return {
    id: device.id,
    name: device.name,
    push: device.pushToken !== null,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    current,
  };
}

/** The QR code's content: where the app should call, and the code to trade. */
function pairingLink(mobileApiUrl: string, code: string): string {
  const query = new URLSearchParams({ url: mobileApiUrl, code });

  return `zentry://pair?${query.toString()}`;
}

/**
 * Web only (the router refuses device tokens here): a signed-in phone must
 * not be able to mint more sign-ins.
 */
export const createPairing: UserHandler = async (context) => {
  const code = newPairingCode();
  const codeHash = await sha256Hex(code);

  const expiresAt = await context.deps.devices.createPairing(
    context.user.id,
    codeHash,
    context.now,
  );

  return Response.json(
    { link: pairingLink(context.deps.mobileApiUrl, code), expiresAt } satisfies ApiPairing,
    { status: 201 },
  );
};

/** `POST /api/0/pair/`: the one API route that takes no sign-in. */
export async function redeemPairing(request: Request, deps: ApiDeps): Promise<Response> {
  const body = await readBody(request, PairBody);
  const now = deps.now();
  const userId = await deps.devices.redeemPairing(await sha256Hex(body.code), now);
  const user = userId === null ? null : await deps.tenancy.user(userId);

  if (user === null) {
    return forbidden("this code has expired or was already used; show a new one");
  }

  const token = newDeviceToken();

  const device = await deps.devices.create(
    { userId: user.id, tokenHash: await sha256Hex(token), name: body.name },
    now,
  );

  return Response.json(
    { token, device: toApiDevice(device, true), email: user.email } satisfies ApiPaired,
    { status: 201 },
  );
}

export const listDevices: UserHandler = async (context) => {
  const devices = await context.deps.devices.list(context.user.id);

  return Response.json({
    devices: devices.map((device) => toApiDevice(device, device.id === context.device?.id)),
  } satisfies ApiDeviceList);
};

/**
 * Signs a phone out: any of the user's phones from the web UI, or the app
 * signing itself out. A phone may not sign out the others: a stolen token
 * must not be able to lock the owner's real phones out.
 */
export const removeDevice: UserHandler = async (context, args) => {
  const [deviceId] = readParams(args, z.tuple([IdParam]));

  if (context.device !== null && context.device.id !== deviceId) {
    return forbidden("a phone can sign out only itself; use the web UI for the others");
  }

  return (await context.deps.devices.remove(context.user.id, deviceId)) ? noContent() : notFound();
};

/** Device only: the calling phone's push token, or null to stop pushes to it. */
export const updatePushToken: UserHandler = async (context) => {
  const { device } = context;

  if (device === null) {
    return forbidden("only the mobile app registers for push notifications");
  }

  const { pushToken } = await readBody(context.request, PushBody);

  await (pushToken === null
    ? context.deps.devices.clearPushToken(device.id)
    : context.deps.devices.setPushToken(device.id, pushToken));

  return noContent();
};
