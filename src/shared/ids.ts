const HEX_32 = /^[0-9a-f]{32}$/;

function randomHex(byteCount: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function newEventId(): string {
  return randomHex(16);
}

export function newPublicKey(): string {
  return randomHex(16);
}

/** Lower-cases and strips dashes; null when the result is not 32 hex characters. */
export function normalizeEventId(raw: string): string | null {
  const id = raw.replaceAll("-", "").toLowerCase();

  return HEX_32.test(id) ? id : null;
}

export function isPublicKey(text: string): boolean {
  return HEX_32.test(text);
}

/** Parses a decimal id such as a project id; null when it is not a positive integer. */
export function parseId(text: string): number | null {
  if (!/^[0-9]{1,15}$/.test(text)) {
    return null;
  }

  const id = Number(text);

  return id > 0 ? id : null;
}

/** A device token for the mobile app: 256 random bits, prefixed so it is recognisable in a leak scan. */
export function newDeviceToken(): string {
  return `zt_${randomHex(32)}`;
}

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * A sentry-cli auth token in the shape of Sentry's organization tokens:
 * `sntrys_` + padded base64 of `{iat, url, org}` + `_` + unpadded base64 of
 * 256 random bits. sentry-cli parses exactly this (src/utils/auth_token/
 * org_auth_token.rs, which splits on `_` and wants 32 secret bytes) and then
 * calls `url` for `org` with no other configuration, so the token alone is
 * the whole setup. Standard base64 never contains `_`, which keeps the split
 * unambiguous. The payload is not secret: the CLI reads it, and so can anyone
 * who sees the token; only the random part is the credential.
 */
/** sentry-cli's organization-token prefix; the router tells CLI tokens from device tokens by it. */
export const CLI_TOKEN_PREFIX = "sntrys_";

export function newCliToken(payload: { url: string; org: string; issuedAt: number }): string {
  const claims = JSON.stringify({
    iat: payload.issuedAt / 1000,
    url: payload.url,
    org: payload.org,
  });

  const secret = base64(crypto.getRandomValues(new Uint8Array(32))).replaceAll("=", "");

  return `${CLI_TOKEN_PREFIX}${base64(new TextEncoder().encode(claims))}_${secret}`;
}

/** A pairing code: 128 random bits, too many to guess in the ten minutes it works. */
export function newPairingCode(): string {
  return randomHex(16);
}

/** SHA-256 of the text, as hex. Device tokens and pairing codes are stored this way. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
