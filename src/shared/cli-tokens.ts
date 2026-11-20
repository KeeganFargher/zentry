// What the web UI and the Worker exchange about sentry-cli tokens. DESIGN.md §20.

/** A token as the web UI lists it: never the token itself, only its last characters. */
export type ApiCliToken = {
  id: number;
  name: string;
  /** The token's last four characters, to tell tokens apart. */
  hint: string;
  createdAt: number;
  lastUsedAt: number | null;
};

export type ApiCliTokenList = { tokens: ApiCliToken[] };

/** The reply to making a token. The token is shown only this once. */
export type ApiCliTokenCreated = {
  token: string;
  /** Where the token sends the CLI, already inside the token. */
  url: string;
  cliToken: ApiCliToken;
};
