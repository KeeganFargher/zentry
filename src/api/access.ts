// Cloudflare Access: verifies the JWT that Access attaches to every request
// for the UI hostname. DESIGN.md §10.

import { z } from "zod";

import { jsonText } from "@/shared/json";
import { logError } from "@/shared/log";
import { listOf } from "@/shared/schema";
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

/** An RSA public key from the team's JWKS document. */
const SigningKey = z.object({ kid: z.string(), n: z.string(), e: z.string() });

export type SigningKey = z.output<typeof SigningKey>;

// A key we cannot use (another key type) is skipped rather than failing the
// whole set, so one unexpected key cannot lock everyone out.
const KeySet = jsonText(z.object({ keys: listOf(SigningKey) }));

/** Fetches the team's signing keys (the `keys` array of the JWKS document). */
export type KeyLoader = (teamDomain: string) => Promise<SigningKey[]>;

const TokenHeader = z.object({ alg: z.literal("RS256"), kid: z.string() });

// `email` is required: a token without one cannot sign anyone in.
const Claims = z.object({
  aud: z.union([z.string().transform((audience) => [audience]), z.array(z.string())]),
  iss: z.string(),
  exp: z.number(),
  email: z.string(),
});

type Claims = z.output<typeof Claims>;

const ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

const Base64Url = z.string().transform((text, context): Uint8Array => {
  try {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));

    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    context.addIssue({ code: "custom", message: "not valid base64url" });

    return z.NEVER;
  }
});

/** A JWT segment: base64url of JSON matching `schema`. */
function segment<T extends z.ZodType>(schema: T): z.ZodType<z.output<T>, string> {
  return Base64Url.transform((bytes) => new TextDecoder().decode(bytes)).pipe(jsonText(schema));
}

/** `header.claims.signature`, each part decoded and validated. */
const Jwt = z
  .string()
  .transform((jwt) => jwt.split("."))
  .pipe(z.tuple([segment(TokenHeader), segment(Claims), Base64Url]))
  .transform(([header, claims, signature]) => ({ header, claims, signature }));

type Token = z.output<typeof Jwt>;

export async function fetchAccessKeys(teamDomain: string): Promise<SigningKey[]> {
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);

  if (!response.ok) {
    logError("could not fetch Access signing keys", { status: response.status });

    return [];
  }

  const parsed = KeySet.safeParse(await response.text());

  if (!parsed.success) {
    logError("Access signing keys did not match the JWKS shape", {
      error: z.prettifyError(parsed.error),
    });

    return [];
  }

  return parsed.data.keys;
}

export class AccessVerifier {
  readonly #config: AccessConfig;
  readonly #loadKeys: KeyLoader;
  #keys: SigningKey[] = [];
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

    const assertion = request.headers.get("cf-access-jwt-assertion") ?? "";
    const parsed = Jwt.safeParse(assertion);

    if (!parsed.success || !this.#claimsHold(parsed.data.claims, now)) {
      return null;
    }

    // The signature covers the first two segments exactly as they were sent.
    const signed = new TextEncoder().encode(assertion.slice(0, assertion.lastIndexOf(".")));
    const token = parsed.data;

    return (await this.#signatureHolds(token, signed, now)) ? token.claims.email : null;
  }

  #claimsHold(claims: Claims, now: number): boolean {
    const { audience, teamDomain } = this.#config;

    return (
      audience !== "" &&
      claims.aud.includes(audience) &&
      claims.iss === `https://${teamDomain}` &&
      claims.exp * SECOND > now
    );
  }

  async #signingKey(keyId: string, now: number): Promise<SigningKey | null> {
    const known = (): SigningKey | null => this.#keys.find((key) => key.kid === keyId) ?? null;

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

  async #signatureHolds(token: Token, signed: Uint8Array, now: number): Promise<boolean> {
    const key = await this.#signingKey(token.header.kid, now);

    if (key === null) {
      return false;
    }

    const publicKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: key.n, e: key.e, alg: "RS256", ext: true },
      ALGORITHM,
      false,
      ["verify"],
    );

    return crypto.subtle.verify(ALGORITHM, publicKey, token.signature, signed);
  }
}
