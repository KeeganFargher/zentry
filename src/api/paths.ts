// Path building blocks shared by the API's two route tables (router.ts for the
// web UI and the app, cli-router.ts for sentry-cli).

export const ORG = String.raw`([\w-]+)`;
export const ID = String.raw`(\d+)`;
export const SLUG = String.raw`([\w-]+)`;

/** `path` under `/api/0`, with or without Sentry's trailing slash. */
export function apiPattern(path: string): RegExp {
  return new RegExp(`^/api/0${path}/?$`);
}
