// Signed unsubscribe links. DESIGN.md §18.6. The token names the user and what
// to turn off, with an HMAC so it cannot be forged or edited. It does not
// expire: an unsubscribe link in a year-old email should still work, and all
// it can do is turn an email off.

import type { NotificationType } from "@/shared/contract";

import { NOTIFICATION_TYPES } from "./notify-settings";

/** `issue` unfollows one issue; the others set the type to `never` there. */
export type UnsubscribeScope = "user" | "organization" | "project" | "issue";

export type UnsubscribeTarget = {
  userId: number;
  type: NotificationType;
  scope: UnsubscribeScope;
  scopeId: number;
};

const SCOPES: UnsubscribeScope[] = ["user", "organization", "project", "issue"];
const TOKEN = /^(\d{1,15})\.(\w+)\.(\w+)\.(\d{1,15})\.([\w-]+)$/;
const ALGORITHM = { name: "HMAC", hash: "SHA-256" };

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));

    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), ALGORITHM, false, [
    "sign",
    "verify",
  ]);
}

function payloadOf(target: UnsubscribeTarget): string {
  return `${target.userId}.${target.type}.${target.scope}.${target.scopeId}`;
}

export async function signUnsubscribe(target: UnsubscribeTarget, secret: string): Promise<string> {
  const payload = payloadOf(target);
  const key = await importKey(secret);
  const signature = await crypto.subtle.sign(ALGORITHM, key, new TextEncoder().encode(payload));

  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

function parseToken(token: string): { target: UnsubscribeTarget; signature: string } | null {
  const [, user, typeText, scopeText, id, signature] = TOKEN.exec(token) ?? [];
  const type = NOTIFICATION_TYPES.find((candidate) => candidate === typeText);
  const scope = SCOPES.find((candidate) => candidate === scopeText);

  if (user === undefined || id === undefined || signature === undefined) {
    return null;
  }

  return type === undefined || scope === undefined
    ? null
    : { target: { userId: Number(user), type, scope, scopeId: Number(id) }, signature };
}

/** The target, or null when the token is malformed or its signature does not match. */
export async function verifyUnsubscribe(
  token: string,
  secret: string,
): Promise<UnsubscribeTarget | null> {
  const parsed = parseToken(token);
  const signature = parsed === null ? null : fromBase64Url(parsed.signature);

  if (parsed === null || signature === null) {
    return null;
  }

  const key = await importKey(secret);
  const payload = new TextEncoder().encode(payloadOf(parsed.target));

  // `verify` compares in constant time.
  return (await crypto.subtle.verify(ALGORITHM, key, signature, payload)) ? parsed.target : null;
}
