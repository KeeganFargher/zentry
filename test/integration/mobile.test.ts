import { describe, expect, it } from "vitest";

import { handleApi, Sessions } from "@/api/router";
import type {
  ApiDeviceList,
  ApiMe,
  ApiMonitor,
  ApiPaired,
  ApiPairing,
  Json,
  MonitorDetail,
} from "@/shared/contract";
import { DAY, MINUTE } from "@/shared/time";

import { api, apiDeps, claims, signToken, USER, verifier } from "./api-helpers";
import { createProject, NOW } from "./helpers";

const INGEST = "https://ingest.zentry.test";

type Call = { method?: string; body?: Json; token?: string; now?: number };

/** Calls the API on the ingest host, as the mobile app does. */
async function app(path: string, call: Call = {}): Promise<Response> {
  const headers = new Headers();

  if (call.token !== undefined) {
    headers.set("authorization", `Bearer ${call.token}`);
  }

  const init: RequestInit = { method: call.method ?? "GET", headers };

  if (call.body !== undefined) {
    init.body = JSON.stringify(call.body);
  }

  const now = call.now ?? NOW;

  return handleApi(
    new Request(`${INGEST}/api/0${path}`, init),
    apiDeps({ now: () => now }),
    new Sessions(),
  );
}

/** Shows a QR code in the web UI and returns the code inside it. */
async function pairingCode(): Promise<string> {
  const response = await api("/me/pairings/", { method: "POST" });

  expect(response.status).toBe(201);

  const { link } = await response.json<ApiPairing>();
  const url = new URL(link);

  expect(url.protocol).toBe("zentry:");
  expect(url.searchParams.get("url")).toBe(INGEST);

  return url.searchParams.get("code") ?? "";
}

async function pairedPhone(): Promise<ApiPaired> {
  const response = await app("/pair/", {
    method: "POST",
    body: { code: await pairingCode(), name: "Pixel 9" },
  });

  expect(response.status).toBe(201);

  return response.json<ApiPaired>();
}

describe("pairing a phone", () => {
  it("trades the QR code for a device token that signs the app in", async () => {
    const paired = await pairedPhone();

    expect(paired.email).toBe(USER);
    expect(paired.token).toMatch(/^zt_[0-9a-f]{64}$/);
    expect(paired.device).toMatchObject({ name: "Pixel 9", push: false, current: true });

    const me = await app("/me/", { token: paired.token });

    expect(me.status).toBe(200);
    expect((await me.json<ApiMe>()).email).toBe(USER);
  });

  it("refuses a code twice, and after it expires", async () => {
    const code = await pairingCode();

    const first = await app("/pair/", { method: "POST", body: { code, name: "a" } });
    const again = await app("/pair/", { method: "POST", body: { code, name: "b" } });

    expect(first.status).toBe(201);
    expect(again.status).toBe(403);

    const late = await app("/pair/", {
      method: "POST",
      body: { code: await pairingCode(), name: "c" },
      now: NOW + 11 * MINUTE,
    });

    expect(late.status).toBe(403);
  });

  it("refuses a code that is not one, without looking it up", async () => {
    const response = await app("/pair/", { method: "POST", body: { code: "nope", name: "x" } });

    expect(response.status).toBe(400);
  });

  it("does not let a phone make more pairing codes", async () => {
    const { token } = await pairedPhone();

    expect((await app("/me/pairings/", { method: "POST", token })).status).toBe(403);
  });
});

describe("device tokens", () => {
  it("are the only way in on the ingest host, where a valid Access token is refused", async () => {
    const accessToken = await signToken(claims());
    const viaAccess = { headers: { "cf-access-jwt-assertion": accessToken } };
    const deps = apiDeps();

    // The same Access token signs in on the UI host, so the refusal is the host rule.
    expect(
      (
        await handleApi(
          new Request("https://zentry.test/api/0/me/", viaAccess),
          deps,
          new Sessions(),
        )
      ).status,
    ).toBe(200);
    expect(
      (await handleApi(new Request(`${INGEST}/api/0/me/`, viaAccess), deps, new Sessions())).status,
    ).toBe(401);

    expect((await app("/me/")).status).toBe(401);
    expect((await app("/me/", { token: "zt_not-a-real-token" })).status).toBe(401);

    const malformed = new Request(`${INGEST}/api/0/me/`, {
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });

    expect((await handleApi(malformed, apiDeps(), new Sessions())).status).toBe(401);
  });

  it("win over the development email on localhost, so a bad one fails there too", async () => {
    const local = "http://localhost:8787/api/0/me/";
    const deps = apiDeps({ access: verifier("local@example.com") });
    const bad = new Request(local, { headers: { authorization: "Bearer zt_wrong" } });

    // Without the header the development email signs the request in.
    expect((await handleApi(new Request(local), deps, new Sessions())).status).toBe(200);
    expect((await handleApi(bad, deps, new Sessions())).status).toBe(401);
  });

  it("stop working after 30 days unused, and the phone is signed out", async () => {
    const { token, device } = await pairedPhone();

    expect((await app("/me/", { token, now: NOW + 29 * DAY })).status).toBe(200);
    // Used on day 29, so the idle clock restarted then.
    expect((await app("/me/", { token, now: NOW + 58 * DAY })).status).toBe(200);
    expect((await app("/me/", { token, now: NOW + 89 * DAY })).status).toBe(401);

    const { devices } = await (await api("/me/devices/")).json<ApiDeviceList>();

    expect(devices.map((entry) => entry.id)).not.toContain(device.id);
  });

  it("reach what the app needs and nothing that changes projects or keys", async () => {
    const { token } = await pairedPhone();

    expect((await app("/organizations/default/projects/", { token })).status).toBe(200);
    expect((await app("/organizations/default/issues/", { token })).status).toBe(200);
    expect((await app("/organizations/default/notifications/", { token })).status).toBe(200);
    expect((await app("/organizations/default/monitors/", { token })).status).toBe(200);

    const create = await app("/organizations/default/projects/", {
      method: "POST",
      token,
      body: { name: "from a phone" },
    });

    expect(create.status).toBe(403);

    const project = "/projects/default/anything";
    const monitor = "/organizations/default/monitors/00000000-0000-4000-8000-000000000000";

    const webOnly: [method: string, path: string, body?: Json][] = [
      ["PUT", `${project}/`, { name: "x" }],
      ["DELETE", `${project}/`],
      ["GET", `${project}/keys/`],
      ["POST", `${project}/keys/`, { label: "x" }],
      ["PUT", `${project}/keys/1/`, { status: "revoked" }],
      ["GET", "/organizations/default/limits/"],
      ["PUT", "/organizations/default/limits/", { maxEventsPerMonth: 1 }],
      ["DELETE", "/organizations/default/issues/1/"],
      ["POST", "/me/pairings/"],
      // Monitors are read-only on the phone.
      ["POST", "/organizations/default/monitors/", { type: "cron" }],
      ["PUT", `${monitor}/`, { version: 1 }],
      ["PUT", `${monitor}/status/`, { status: "paused" }],
      ["PUT", `${monitor}/mute/`, { minutes: 60 }],
      ["GET", "/organizations/default/monitor-alert-rules/"],
      ["GET", "/organizations/default/monitor-members/"],
      ["GET", "/organizations/default/monitors/unrecognized-check-ins/"],
      ["GET", `${monitor}/observations/`],
      ["POST", "/organizations/default/monitor-previews/", { type: "cron" }],
    ];

    for (const [method, path, body] of webOnly) {
      const call: Call = body === undefined ? { method, token } : { method, token, body };

      expect([method, path, (await app(path, call)).status]).toEqual([method, path, 403]);
    }
  });

  it("read a monitor, its timeline and who created it, without the member list", async () => {
    const { token } = await pairedPhone();
    const { id: projectId } = await createProject();

    const created = await api("/organizations/default/monitors/", {
      method: "POST",
      body: {
        projectId,
        type: "cron",
        name: "Phone-visible",
        config: {
          slug: `phone-${crypto.randomUUID().slice(0, 8)}`,
          schedule: { type: "crontab", crontab: "0 * * * *" },
        },
      },
    });

    expect(created.status).toBe(201);

    const monitor = `/organizations/default/monitors/${(await created.json<ApiMonitor>()).id}`;
    const detail = await app(`${monitor}/`, { token });

    expect(detail.status).toBe(200);
    // The phone names the creator from the detail, as it cannot list members.
    expect((await detail.json<MonitorDetail>()).creatorEmail).toBe(USER);

    const window = `since=${NOW - DAY}&until=${NOW}&buckets=48`;

    expect((await app(`${monitor}/timeline/?${window}`, { token })).status).toBe(200);
  });

  it("stop working the moment the phone is signed out", async () => {
    const { token, device } = await pairedPhone();

    const listed = await api("/me/devices/");
    const { devices } = await listed.json<ApiDeviceList>();

    expect(devices.map((entry) => entry.id)).toContain(device.id);
    // Seen from the web UI, no device is the caller's own.
    expect(devices.every((entry) => !entry.current)).toBe(true);

    expect((await api(`/me/devices/${device.id}/`, { method: "DELETE" })).status).toBe(204);
    expect((await app("/me/", { token })).status).toBe(401);
    expect((await api(`/me/devices/${device.id}/`, { method: "DELETE" })).status).toBe(404);
  });

  it("let a phone sign out only itself", async () => {
    const thief = await pairedPhone();
    const owner = await pairedPhone();
    const signOutOwner = { method: "DELETE", token: thief.token };

    expect((await app(`/me/devices/${owner.device.id}/`, signOutOwner)).status).toBe(403);
    expect((await app("/me/", { token: owner.token })).status).toBe(200);
  });

  it("do not let one user sign out another's phone", async () => {
    const { token, device } = await pairedPhone();

    const other = await api(`/me/devices/${device.id}/`, {
      method: "DELETE",
      email: "someone-else@example.com",
    });

    expect(other.status).toBe(404);
    expect((await app("/me/", { token })).status).toBe(200);
  });

  it("let the app sign itself out", async () => {
    const { token, device } = await pairedPhone();

    expect((await app(`/me/devices/${device.id}/`, { method: "DELETE", token })).status).toBe(204);
    expect((await app("/me/", { token })).status).toBe(401);
  });
});

describe("push registration", () => {
  const PUSH_TOKEN = "ExponentPushToken[abc123-XYZ]";

  it("stores the phone's push token and clears it again", async () => {
    const { token } = await pairedPhone();

    const register = await app("/me/device/", {
      method: "PUT",
      token,
      body: { pushToken: PUSH_TOKEN },
    });

    expect(register.status).toBe(204);

    const { devices } = await (await app("/me/devices/", { token })).json<ApiDeviceList>();
    const current = devices.find((entry) => entry.current);

    expect(current?.push).toBe(true);

    await app("/me/device/", { method: "PUT", token, body: { pushToken: null } });

    const after = await (await app("/me/devices/", { token })).json<ApiDeviceList>();

    expect(after.devices.find((entry) => entry.current)?.push).toBe(false);
  });

  it("moves a push token to the newest sign-in of the same phone", async () => {
    const first = await pairedPhone();
    const second = await pairedPhone();
    const body = { pushToken: "ExponentPushToken[same-phone]" };

    await app("/me/device/", { method: "PUT", token: first.token, body });
    await app("/me/device/", { method: "PUT", token: second.token, body });

    const { devices } = await (await api("/me/devices/")).json<ApiDeviceList>();

    expect(devices.find((entry) => entry.id === first.device.id)?.push).toBe(false);
    expect(devices.find((entry) => entry.id === second.device.id)?.push).toBe(true);
  });

  it("refuses what is not an Expo token, and the web UI registering", async () => {
    const { token } = await pairedPhone();

    const bad = await app("/me/device/", { method: "PUT", token, body: { pushToken: "fcm:123" } });

    expect(bad.status).toBe(400);

    const web = await api("/me/device/", { method: "PUT", body: { pushToken: PUSH_TOKEN } });

    expect(web.status).toBe(403);
  });
});
