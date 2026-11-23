// Routing for sentry-cli tokens (DESIGN.md §20). The main router hands a
// request here once its bearer token has the CLI prefix; a token caller never
// reaches the web or app routes, and those routes never see a token.

import type { CliCaller } from "@/db/cli-tokens";
import { sha256Hex } from "@/shared/ids";

import * as cli from "./cli";
import * as debugFiles from "./cli-debug-files";
import type { ApiDeps, CliHandler } from "./context";
import { notFound } from "./http";
import { apiPattern, ORG, SLUG } from "./paths";

/**
 * `scoped` routes capture the organization slug first, which must be the
 * token's own; the others (auth info, the organization list) take none.
 */
type CliRoute = { method: string; pattern: RegExp; handler: CliHandler; scoped: boolean };

function scoped(method: string, path: string, handler: CliHandler): CliRoute {
  return { method, pattern: apiPattern(path), handler, scoped: true };
}

function unscoped(method: string, path: string, handler: CliHandler): CliRoute {
  return { method, pattern: apiPattern(path), handler, scoped: false };
}

/** The only routes a token reaches, in Sentry's paths and shapes. */
const CLI_ROUTES: CliRoute[] = [
  unscoped("GET", "", cli.authInfo),
  unscoped("GET", "/organizations", cli.listOrganizations),
  scoped("GET", `/organizations/${ORG}/projects`, cli.listProjects),
  scoped("GET", `/organizations/${ORG}/monitors`, cli.listMonitors),
  scoped("GET", `/projects/${ORG}/${SLUG}/issues`, cli.listIssues),
  scoped("PUT", `/projects/${ORG}/${SLUG}/issues`, cli.updateIssues),
  scoped("GET", `/projects/${ORG}/${SLUG}/events`, cli.listEvents),
  scoped("GET", `/organizations/${ORG}/chunk-upload`, debugFiles.chunkUploadOptions),
  scoped("POST", `/organizations/${ORG}/chunk-upload`, debugFiles.uploadChunks),
  scoped("POST", `/projects/${ORG}/${SLUG}/files/difs/assemble`, debugFiles.assembleDifs),
];

/**
 * Looked up on every request, never cached, so revoking a token or removing
 * its member from the organization takes effect at once.
 */
export async function cliCaller(token: string, deps: ApiDeps): Promise<CliCaller | null> {
  const caller = await deps.cliTokens.caller(await sha256Hex(token));

  if (caller !== null) {
    await deps.cliTokens.touch(caller, deps.now());
  }

  return caller;
}

/**
 * A path this table does not know is a sentry-cli command Zentry has not
 * built (releases, source maps, debug files other than source bundles, and
 * the rest). 501 says so; a 404
 * would make the CLI report a missing release or project instead.
 */
function notBuilt(): Response {
  return Response.json(
    {
      detail:
        "Zentry does not support this sentry-cli command. Supported: info, organizations list, " +
        "projects list, issues list/resolve/mute/unresolve, events list, monitors list, " +
        "debug-files upload of source bundles, and the DSN commands (send-event, " +
        "send-envelope, monitors run).",
    },
    { status: 501 },
  );
}

type Matched = { route: CliRoute; captures: string[] };

/** The route and its path captures, matching each pattern once. */
function matchCli(method: string, pathname: string): Matched | null {
  for (const route of CLI_ROUTES) {
    const captures = route.method === method ? route.pattern.exec(pathname) : null;

    if (captures !== null) {
      return { route, captures: captures.slice(1) };
    }
  }

  return null;
}

export async function dispatchCli(
  request: Request,
  deps: ApiDeps,
  caller: CliCaller,
): Promise<Response> {
  const url = new URL(request.url);

  const matched = matchCli(request.method, url.pathname);

  if (matched === null) {
    return notBuilt();
  }

  const { route, captures } = matched;

  // The token reaches one organization; any other is as unknown as a missing one.
  if (route.scoped && captures[0] !== caller.organization.slug) {
    return notFound();
  }

  const args = route.scoped ? captures.slice(1) : captures;

  return route.handler({ request, url, deps, caller, now: deps.now() }, args);
}
