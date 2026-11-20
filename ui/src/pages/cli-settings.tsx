// Tokens for sentry-cli, one organization each. DESIGN.md §20. A new token
// is shown once, with the line that sets it up; afterwards only its last
// characters are listed, as the Worker keeps nothing else.

import type { ApiCliToken, ApiCliTokenCreated } from "@contract";
import { useState } from "react";
import type { FormEvent, JSX } from "react";

import { Notice } from "~/components/basics";
import { api, ApiFailure } from "~/lib/api";
import { useNow } from "~/lib/clock";
import { timeAgo } from "~/lib/format";
import { useResource } from "~/lib/resource";
import { toast } from "~/lib/toast";

function copy(text: string, what: string): void {
  navigator.clipboard
    .writeText(text)
    .then(() => toast(`${what} copied`))
    .catch((cause: unknown) => toast(cause instanceof Error ? cause.message : "Could not copy"));
}

/** The token, once: the CLI needs nothing else, since the URL and organization are inside it. */
function NewToken({ created, onDone }: { created: ApiCliTokenCreated; onDone: () => void }) {
  const setup = `export SENTRY_AUTH_TOKEN=${created.token}`;

  return (
    <div className="cli-token-new">
      <p>
        Copy the token now: Zentry keeps only a hash of it, so it cannot be shown again. It sends
        sentry-cli to <code>{created.url}</code> for this organization, so no{" "}
        <code>SENTRY_URL</code> or <code>SENTRY_ORG</code> is needed.
      </p>
      <pre className="snippet">{setup}</pre>
      <div className="pairing-actions">
        <button type="button" className="primary" onClick={() => copy(created.token, "Token")}>
          Copy token
        </button>
        <button type="button" onClick={() => copy(setup, "Setup line")}>
          Copy export line
        </button>
        <button type="button" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

type RowProps = { org: string; token: ApiCliToken; now: number; onChanged: () => void };

function TokenRow({ org, token, now, onChanged }: RowProps): JSX.Element {
  const revoke = async (): Promise<void> => {
    if (!window.confirm(`Revoke ${token.name}? Anything using it stops working at once.`)) {
      return;
    }

    try {
      await api.revokeCliToken(org, token.id);
      toast(`${token.name} revoked`);
      onChanged();
    } catch (cause) {
      toast(cause instanceof ApiFailure ? cause.message : "Could not revoke the token");
    }
  };

  const used = token.lastUsedAt === null ? "never used" : `used ${timeAgo(token.lastUsedAt, now)}`;

  return (
    <div className="dsn">
      <strong className="device-name">{token.name}</strong>
      <span className="muted device-facts">
        <code>…{token.hint}</code> · made {timeAgo(token.createdAt, now)} · {used}
      </span>
      <button type="button" className="danger" onClick={() => void revoke()}>
        Revoke
      </button>
    </div>
  );
}

type MakeTokenProps = { org: string; onMade: () => void };

/** The form, or the new token in its place until the member is done with it. */
function MakeToken({ org, onMade }: MakeTokenProps): JSX.Element {
  const [name, setName] = useState("");
  const [created, setCreated] = useState<ApiCliTokenCreated | null>(null);

  const create = async (event: FormEvent): Promise<void> => {
    event.preventDefault();

    try {
      setCreated(await api.createCliToken(org, name.trim()));
      setName("");
      onMade();
    } catch (cause) {
      toast(cause instanceof ApiFailure ? cause.message : "Could not make a token");
    }
  };

  if (created !== null) {
    return <NewToken created={created} onDone={() => setCreated(null)} />;
  }

  return (
    <form className="form-row" onSubmit={(event) => void create(event)}>
      <input
        type="text"
        aria-label="Token name"
        placeholder="What it is for, such as CI"
        maxLength={100}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <button type="submit" className="primary" disabled={name.trim() === ""}>
        Make token
      </button>
    </form>
  );
}

export function CliSettings({ org }: { org: string }): JSX.Element {
  const tokens = useResource(`cli-tokens:${org}`, () => api.cliTokens(org));
  const now = useNow();
  const { reload } = tokens;
  const list = tokens.data?.tokens ?? null;

  return (
    <>
      <header className="topbar">
        <h1>sentry-cli</h1>
      </header>
      <div className="content narrow">
        <section className="panel padded">
          <h2>Make a token</h2>
          <p className="muted">
            sentry-cli can list projects, issues, events and cron monitors, and resolve, mute or
            reopen issues, acting as you in this organization. Releases, source maps and debug files
            are not supported. Commands that use a DSN (send-event, monitors run) need no token.
          </p>
          <MakeToken org={org} onMade={reload} />
        </section>
        <section className="panel padded">
          <h2>Your tokens</h2>
          {list === null ? (
            <Notice loading={tokens.loading} error={tokens.error} />
          ) : list.length === 0 ? (
            <p className="muted">You have no tokens for this organization.</p>
          ) : (
            list.map((token) => (
              <TokenRow key={token.id} org={org} token={token} now={now} onChanged={reload} />
            ))
          )}
        </section>
      </div>
    </>
  );
}
