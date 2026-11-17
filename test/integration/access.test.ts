import { describe, expect, it } from "vitest";

import { AccessVerifier } from "@/api/access";
import type { SigningKey } from "@/api/access";
import { handleApi, Sessions } from "@/api/router";
import { HOUR, MINUTE, SECOND } from "@/shared/time";

import {
  apiDeps,
  AUDIENCE,
  claims,
  signingKeys,
  signToken,
  TEAM,
  USER,
  verifier,
} from "./api-helpers";
import { NOW } from "./helpers";

const ME = "https://zentry.test/api/0/me/";

function request(token: string, url = ME): Request {
  return new Request(url, { headers: { "cf-access-jwt-assertion": token } });
}

/** A request with no Access token at all. */
function anonymous(url = ME): Request {
  return new Request(url);
}

describe("Access verification", () => {
  it("accepts a valid token and returns its email", async () => {
    const token = await signToken(claims());

    expect(await verifier().email(request(token), NOW)).toBe(USER);
  });

  it("refuses a missing or malformed token", async () => {
    expect(await verifier().email(anonymous(), NOW)).toBeNull();
    expect(await verifier().email(request("a.b.c"), NOW)).toBeNull();
  });

  it("refuses the wrong audience, the wrong issuer and an expired token", async () => {
    const wrongAudience = await signToken(claims({ aud: ["someone-else"] }));
    const wrongIssuer = await signToken(claims({ iss: "https://evil.cloudflareaccess.com" }));
    const expired = await signToken(claims({ exp: Math.floor(NOW / 1000) - 1 }));

    expect(await verifier().email(request(wrongAudience), NOW)).toBeNull();
    expect(await verifier().email(request(wrongIssuer), NOW)).toBeNull();
    expect(await verifier().email(request(expired), NOW)).toBeNull();
  });

  it("refuses a token whose payload was altered after signing", async () => {
    const [head = "", , signature = ""] = (await signToken(claims())).split(".");

    const forged = btoa(JSON.stringify(claims({ email: "attacker@example.com" }))).replaceAll(
      "=",
      "",
    );

    expect(await verifier().email(request(`${head}.${forged}.${signature}`), NOW)).toBeNull();
  });

  it("honours the development user on localhost only", async () => {
    const dev = verifier("local@example.com");

    expect(await dev.email(anonymous("http://localhost:8787/api/0/me/"), NOW)).toBe(
      "local@example.com",
    );
    expect(await dev.email(anonymous(), NOW)).toBeNull();
  });

  it("answers 401 from the API without a token", async () => {
    const response = await handleApi(anonymous(), apiDeps(), new Sessions());

    expect(response.status).toBe(401);
  });

  it("keeps its signing keys when a later fetch of them fails", async () => {
    const [key] = await signingKeys();
    let healthy = true;

    const access = new AccessVerifier(
      { teamDomain: TEAM, audience: AUDIENCE, devEmail: "" },
      async () => (healthy && key !== undefined ? [key] : []),
    );

    const later = NOW + HOUR + MINUTE;
    const lateToken = await signToken(claims({ exp: Math.floor(later / 1000) + 600 }));

    expect(await access.email(request(await signToken(claims())), NOW)).toBe(USER);

    // Past the hourly refresh, with the certs endpoint down.
    healthy = false;

    expect(await access.email(request(lateToken), later)).toBe(USER);
  });

  it("fetches keys again for an unknown key id, at most once a minute", async () => {
    const [key] = await signingKeys();
    let published: SigningKey[] = [];
    let fetches = 0;

    const access = new AccessVerifier(
      { teamDomain: TEAM, audience: AUDIENCE, devEmail: "" },
      async () => {
        fetches += 1;

        return published;
      },
    );

    const token = await signToken(claims());

    // The key is not published yet: refused, and not refetched within the minute.
    expect(await access.email(request(token), NOW)).toBeNull();
    expect(await access.email(request(token), NOW + SECOND)).toBeNull();
    expect(fetches).toBe(1);

    // After a rotation publishes it, the next attempt a minute later succeeds.
    published = key === undefined ? [] : [key];
    expect(await access.email(request(token), NOW + MINUTE)).toBe(USER);
    expect(fetches).toBe(2);
  });
});
