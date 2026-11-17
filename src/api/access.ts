// Cloudflare Access: verifies the JWT that Access attaches to every request
// for the UI hostname. DESIGN.md §10.

import type { JsonObject } from "@/shared/contract";
import {
  asArray,
  asObject,
  asString,
  getNumber,
  getString,
  objectsIn,
  parseJson,
} from "@/shared/json";
import { HOUR, MINUTE, SECOND } from "@/shared/time";

import { isLocal } from "./http";

export type AccessConfig = {
  /** For example `acme.cloudflareaccess.com`. */
  teamDomain: string;
  /** The Access application's audience tag. */
  audience: string;
  /** Local development only: used instead of a JWT on localhost. */
  devEmail: string;
};

/** Fetches the team's signing keys (the `keys` array of the JWKS document). */
export type KeyLoader = (teamDomain: string) => Promise<JsonObject[]>;

type Token = { header: JsonObject; payload: JsonObject; signed: Uint8Array; signature: Uint8Array };

const ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

function decodeBase64Url(text: string): Uint8Array | null {
  try {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));

    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function decodeSegment(segment: string): JsonObject | null {
  const bytes = decodeBase64Url(segment);

  return bytes === null ? null : asObject(parseJson(new TextDecoder().decode(bytes)));
}

function parseToken(jwt: string): Token | null {
  const [head = "", body = "", tail = ""] = jwt.split(".");
  const header = decodeSegment(head);
  const payload = decodeSegment(body);
  const signature = decodeBase64Url(tail);

  if (header === null || payload === null || signature === null) {
    return null;
  }

  return { header, payload, signature, signed: new TextEncoder().encode(`${head}.${body}`) };
}

function audiences(payload: JsonObject): string[] {
  const single = asString(payload["aud"]);

  return single === null
    ? (asArray(payload["aud"]) ?? []).flatMap((value) => asString(value) ?? [])
    : [single];
}

export async function fetchAccessKeys(teamDomain: string): Promise<JsonObject[]> {
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  const document = response.ok ? asObject(parseJson(await response.text())) : null;

  return document === null ? [] : objectsIn(asArray(document["keys"]));
}

export class AccessVerifier {
  readonly #config: AccessConfig;
  readonly #loadKeys: KeyLoader;
  #keys: JsonObject[] = [];
  #keysExpireAt = 0;
  #nextFetchAt = 0;

  constructor(config: AccessConfig, loadKeys: KeyLoader) {
    this.#config = config;
    this.#loadKeys = loadKeys;
  }

  /** The signed-in user's email, or null when the request is not authenticated. */
  async email(request: Request, now: number): Promise<string | null> {
    const { devEmail } = this.#config;

    if (devEmail !== "" && isLocal(new URL(request.url))) {
      return devEmail;
    }

    const token = parseToken(request.headers.get("cf-access-jwt-assertion") ?? "");

    if (token === null || !this.#claimsHold(token.payload, now)) {
      return null;
    }

    return (await this.#signatureHolds(token, now)) ? getString(token.payload, "email") : null;
  }

  #claimsHold(payload: JsonObject, now: number): boolean {
    const { audience, teamDomain } = this.#config;
    const expiresAt = (getNumber(payload, "exp") ?? 0) * SECOND;

    return (
      audience !== "" &&
      audiences(payload).includes(audience) &&
      getString(payload, "iss") === `https://${teamDomain}` &&
      expiresAt > now
    );
  }

  async #signingKey(keyId: string, now: number): Promise<JsonObject | null> {
    const known = (): JsonObject | null =>
      this.#keys.find((key) => getString(key, "kid") === keyId) ?? null;

    // Refetch hourly, and also for a key id not seen before (a rotation), but
    // never more than once a minute.
    const stale = now >= this.#keysExpireAt || known() === null;

    if (stale && now >= this.#nextFetchAt) {
      const fresh = await this.#loadKeys(this.#config.teamDomain);

      this.#nextFetchAt = now + MINUTE;

      // A failed fetch keeps the keys already held instead of locking everyone out.
      if (fresh.length > 0) {
        this.#keys = fresh;
        this.#keysExpireAt = now + HOUR;
      }
    }

    return known();
  }

  async #signatureHolds(token: Token, now: number): Promise<boolean> {
    const key = await this.#signingKey(getString(token.header, "kid") ?? "", now);
    const modulus = key === null ? null : getString(key, "n");
    const exponent = key === null ? null : getString(key, "e");

    if (getString(token.header, "alg") !== "RS256" || modulus === null || exponent === null) {
      return false;
    }

    const publicKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: modulus, e: exponent, alg: "RS256", ext: true },
      ALGORITHM,
      false,
      ["verify"],
    );

    return crypto.subtle.verify(ALGORITHM, publicKey, token.signature, token.signed);
  }
}
