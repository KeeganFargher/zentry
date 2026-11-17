// The organization's spend limits: the monthly cap, editable by owners, and
// how much of it this month has used. DESIGN.md §6.

import type { ApiOrganizationLimits } from "@contract";
import { useState } from "react";
import type { FormEvent, JSX } from "react";

import { Notice } from "~/components/basics";
import { api, ApiFailure } from "~/lib/api";
import { shortDate } from "~/lib/format";
import { useResource } from "~/lib/resource";
import { toast } from "~/lib/toast";

type Props = { org: string };

type CapProps = Props & { limits: ApiOrganizationLimits; onSaved: () => void };

function Usage({ limits }: { limits: ApiOrganizationLimits }): JSX.Element {
  const used = Math.min(1, limits.monthReceived / limits.maxEventsPerMonth);
  const full = used >= 1;

  return (
    <div className="usage">
      <div className="usage-meter" role="meter" aria-valuenow={Math.round(used * 100)}>
        <span className={full ? "full" : ""} style={{ width: `${used * 100}%` }} />
      </div>
      <p className="muted">
        {limits.monthReceived.toLocaleString()} of {limits.maxEventsPerMonth.toLocaleString()}{" "}
        events since {shortDate(limits.month)} (UTC).
        {full && " Every event is refused until the month ends."}
      </p>
    </div>
  );
}

function MonthlyCap({ org, limits, onSaved }: CapProps): JSX.Element {
  const [cap, setCap] = useState(String(limits.maxEventsPerMonth));

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();

    try {
      await api.updateLimits(org, Number(cap));
      toast("Monthly cap saved");
      onSaved();
    } catch (cause) {
      toast(cause instanceof ApiFailure ? cause.message : "Could not save the monthly cap");
    }
  };

  return (
    <form className="panel padded" onSubmit={(event) => void save(event)}>
      <h2>Monthly event cap</h2>
      <p className="muted">
        The ceiling on the bill. Once this organization&apos;s projects have sent this many events
        in a UTC month, every event is refused until the next month starts. It also sets the
        spike-protection floor, which new thresholds pick up within the hour.
      </p>
      <Usage limits={limits} />
      <div className="form-row">
        <label htmlFor="org-cap">Max events per month</label>
        <input
          id="org-cap"
          type="number"
          min={1}
          required
          disabled={!limits.canEdit}
          value={cap}
          onChange={(event) => setCap(event.target.value)}
        />
      </div>
      {limits.canEdit ? (
        <button type="submit" className="primary">
          Save
        </button>
      ) : (
        <p className="muted">Only an owner can change the monthly cap.</p>
      )}
    </form>
  );
}

/** The limits that are not set here, so the page accounts for all of them. */
function OtherLimits(): JSX.Element {
  return (
    <div className="panel padded">
      <h2>Other limits</h2>
      <ul className="limit-list">
        <li>
          <strong>Per project:</strong> events per hour and spike protection, in each project&apos;s
          settings.
        </li>
        <li>
          <strong>Per DSN key:</strong> a burst limit of 600 events a minute, set in{" "}
          <code>wrangler.jsonc</code> because the Rate Limiting binding is fixed at deploy.
        </li>
        <li>
          <strong>Per issue:</strong> full events stored per hour (100 by default), set by{" "}
          <code>MAX_STORED_PER_GROUP_HOUR</code> in <code>wrangler.jsonc</code>. Events past it are
          counted but not stored.
        </li>
        <li>
          <strong>On the Cloudflare account:</strong> a Workers spending limit, an email alert and a
          WAF rate limiting rule. See README.md, Spend protection.
        </li>
      </ul>
    </div>
  );
}

export function OrganizationSettings({ org }: Props): JSX.Element {
  const limits = useResource(`limits:${org}`, () => api.limits(org));

  if (limits.data === null) {
    return <Notice loading={limits.loading} error={limits.error} />;
  }

  return (
    <>
      <header className="topbar">
        <h1>Spend limits</h1>
      </header>
      <div className="content narrow">
        <MonthlyCap org={org} limits={limits.data} onSaved={limits.reload} />
        <OtherLimits />
      </div>
    </>
  );
}
