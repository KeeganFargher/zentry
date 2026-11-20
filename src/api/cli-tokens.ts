// Making, listing and revoking sentry-cli tokens in the web UI. DESIGN.md §20.
//
// All three routes are web-only: a token, like a phone, must not be able to
// mint more of itself. A member sees and revokes only their own tokens, as
// each token acts as the member who made it.

import { z } from "zod";

import type { ApiCliTokenCreated, ApiCliTokenList } from "@/shared/contract";
import { newCliToken, sha256Hex } from "@/shared/ids";

import type { Handler } from "./context";
import { IdParam, ingestOrigin, noContent, notFound, readBody, readParams } from "./http";

const HINT_LENGTH = 4;

const CreateBody = z.object({ name: z.string().trim().min(1).max(100) });

export const createCliToken: Handler = async (context) => {
  const { name } = await readBody(context.request, CreateBody);
  const url = ingestOrigin(context.url, context.deps.ingestHost);
  const token = newCliToken({ url, org: context.organizationSlug, issuedAt: context.now });

  const cliToken = await context.deps.cliTokens.create(
    {
      userId: context.user.id,
      organizationId: context.organizationId,
      name,
      tokenHash: await sha256Hex(token),
      hint: token.slice(-HINT_LENGTH),
    },
    context.now,
  );

  return Response.json({ token, url, cliToken } satisfies ApiCliTokenCreated, { status: 201 });
};

export const listCliTokens: Handler = async (context) => {
  const tokens = await context.deps.cliTokens.list(context.user.id, context.organizationId);

  return Response.json({ tokens } satisfies ApiCliTokenList);
};

export const revokeCliToken: Handler = async (context, args) => {
  const [tokenId] = readParams(args, z.tuple([IdParam]));

  const revoked = await context.deps.cliTokens.revoke(
    context.user.id,
    context.organizationId,
    tokenId,
  );

  return revoked ? noContent() : notFound();
};
