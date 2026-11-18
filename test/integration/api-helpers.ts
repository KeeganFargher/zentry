import { env } from "cloudflare:workers";

import { AccessVerifier } from "@/api/access";
import type { SigningKey } from "@/api/access";
import type { ApiDeps } from "@/api/context";
import { handleApi, Sessions } from "@/api/router";
import { EventBlobs } from "@/blobs/events";
import { DeviceStore } from "@/db/devices";
import { EventStore } from "@/db/events";
import { IssueStore } from "@/db/issues";
import { MonitorStore } from "@/db/monitors";
import { NotificationSettingsStore } from "@/db/notify-settings";
import { OrganizationStore } from "@/db/organizations";
import { ProjectStore } from "@/db/projects";
import { TenancyStore } from "@/db/tenancy";
import type { Json } from "@/shared/contract";

import { NOW } from "./helpers";

export const TEAM = "team.cloudflareaccess.com";
export const AUDIENCE = "aud-tag-123";
export const USER = "dev@example.com";

const ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
const KEY_ID = "test-key";

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

const generated = await crypto.subtle.generateKey(
  { ...ALGORITHM, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
  true,
  ["sign", "verify"],
);

if (!("privateKey" in generated)) {
  throw new Error("expected an RSA key pair");
}

const keyPair = generated;

async function publicJwk(): Promise<SigningKey> {
  const exported = await crypto.subtle.exportKey("jwk", keyPair.publicKey);

  if (exported instanceof ArrayBuffer || exported.n === undefined || exported.e === undefined) {
    throw new Error("expected an RSA public key as a JWK");
  }

  return { kid: KEY_ID, n: exported.n, e: exported.e };
}

export type Claims = { aud: string[]; iss: string; exp: number; email: string };

export function claims(overrides: Partial<Claims> = {}): Claims {
  return {
    aud: [AUDIENCE],
    iss: `https://${TEAM}`,
    exp: Math.floor(NOW / 1000) + 600,
    email: USER,
    ...overrides,
  };
}

export async function signToken(payload: Claims): Promise<string> {
  const encoder = new TextEncoder();
  const head = base64Url(encoder.encode(JSON.stringify({ alg: "RS256", kid: KEY_ID, typ: "JWT" })));
  const body = base64Url(encoder.encode(JSON.stringify(payload)));

  const signature = await crypto.subtle.sign(
    ALGORITHM,
    keyPair.privateKey,
    encoder.encode(`${head}.${body}`),
  );

  return `${head}.${body}.${base64Url(new Uint8Array(signature))}`;
}

/** What the Access certs endpoint would publish. */
export async function signingKeys(): Promise<SigningKey[]> {
  return [await publicJwk()];
}

export function verifier(devEmail = ""): AccessVerifier {
  return new AccessVerifier({ teamDomain: TEAM, audience: AUDIENCE, devEmail }, async () => [
    await publicJwk(),
  ]);
}

export function apiDeps(overrides: Partial<ApiDeps> = {}): ApiDeps {
  return {
    access: verifier(),
    tenancy: new TenancyStore(env.DB),
    organizations: new OrganizationStore(env.DB),
    projects: new ProjectStore(env.DB),
    uptimeOrigins: "",
    allowMonitorPreview: async () => true,
    previewUptime: async () => ({ outcome: "unknown" }),
    monitors: new MonitorStore(env.DB),
    issues: new IssueStore(env.DB),
    events: new EventStore(env.DB),
    blobs: new EventBlobs(env.BLOBS),
    notificationSettings: new NotificationSettingsStore(env.DB),
    devices: new DeviceStore(env.DB),
    notify: async () => {},
    emailEnabled: true,
    ingestHost: "ingest.zentry.test",
    mobileApiUrl: "https://ingest.zentry.test",
    now: () => NOW,
    ...overrides,
  };
}

const sessions = new Sessions();

type Call = { method?: string; body?: Json; email?: string };

/** Calls the read API as a signed-in user. `path` is relative to /api/0. */
export async function api(path: string, call: Call = {}): Promise<Response> {
  const token = await signToken(claims({ email: call.email ?? USER }));

  const init: RequestInit = {
    method: call.method ?? "GET",
    headers: { "cf-access-jwt-assertion": token },
  };

  if (call.body !== undefined) {
    init.body = JSON.stringify(call.body);
  }

  return handleApi(new Request(`https://zentry.test/api/0${path}`, init), apiDeps(), sessions);
}
